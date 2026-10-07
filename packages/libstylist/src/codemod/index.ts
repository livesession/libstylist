// `libstylist codemod` — converts a component file to the cx() call API (SPEC §5):
//
// - the `/** @cxScope alert */` pragma → `import { alert as cn } from "<the scope's part-map module>"`
//   (an existing import of that map is reused; a qualified scope — `cx="player-controls:button"` —
//   adds its own named import, `playerControls`)
// - `cx="a b"` / `cx={["a", "b"]}` → `{...cx(cn.a, cn.b)}`; `<Comp cx="p">` → `<Comp {...cx(cn.p)}>`
// - `{...forwardStylist(x)}` and slot receivers `{...(inputCx as …)}` merge into the element's cx()
//   call after its parts (or become `{...cx(x)}`)
// - every raw `data-*` attribute moves into the element's cx() data literal (camelCase keys, string
//   values carried over decoded; `x || undefined` → `x` only when x can't be "" or 0 — known from its
//   shape or its type — else kept as written); a value that renders "false" today keeps rendering it
//   (see `DataTypes`) — except on a libstylist component (`<Button data-testid>`), where a data-*
//   attribute is a prop and stays, as data-in-cx leaves it
// - named slots: `inputCx="field"` → `inputCx={cx(cn.field)}`
// - a class map's `className={cn.x}` (a not-yet-flipped file) → `{...cx(cn.x)}`
// - imports: `cx` added, `forwardStylist` dropped
//
// A conditional cx (`cx={open && "x"}`, `cx={{ x: open }}`) is left untouched and reported: state goes
// into a data-* attribute. Edits are applied to the original text, so formatting is preserved, and the
// codemod is idempotent.
import { isAbsolute } from "node:path"

import { parseSync, traverse, types as t, type NodePath } from "@babel/core"

import { DEV_ATTRS, SLOT_PROP, SVG_GEOMETRY_CX, isLibstylistPackage, resolvePackageConfig } from "../conventions/index.js"
import {
    RUNTIME_MODULES,
    camelRoundTrips,
    dataKeyOf,
    isOwnPackageSpecifier,
    partMapGroup,
    partMapGroups,
    scopeOfExport,
    unwrapNode,
    wrapsComponent,
    type AnyNode,
    type PartMapModules,
    type PartMapRegistry,
} from "../core/index.js"
import { exportName } from "../registry/modules.js"
import { CxGrammarError, collectRefs, findScopePragma, isStaticIR, parseCxAttributeValue, type PartRef } from "./legacy-cx.js"

/** Type facts about one data-attribute value, from the TypeScript checker. */
export interface ValueFacts {
    /** The type is `any`/`unknown`/unresolved — nothing can be promised. */
    unknown: boolean
    /** `false` (or `boolean`) is a possible value: the attribute renders "false" today. */
    canBeFalse: boolean
    /** `undefined` is possible. */
    canBeUndefined: boolean
    /** `null` is possible. */
    canBeNull: boolean
    /** `""`, `0` or `NaN` are possible: `x || undefined` omits them, a bare `x` would not. */
    canBeEmpty: boolean
}

/** Answers type questions about expressions of the file being converted (by source offsets). */
export interface DataTypes {
    facts(start: number, end: number): ValueFacts | null
}

export interface CodemodOptions {
    /** The part-map module of a scope (`alert` → `@livesession/eloquentui-css`), or null when unknown. */
    moduleOf?: (scope: string) => string | null
    /** The registry (for a class map import's scope) and the part-map modules (css group → specifier). */
    registry?: PartMapRegistry | null
    partMaps?: PartMapModules | null
    /** Type facts for data values; without them a value whose type matters is left as written and reported. */
    types?: DataTypes | null
}

/** A data attribute whose value can render "false" today, rewritten so it still does. */
export interface FalseAttribute {
    line: number
    attr: string
    /** The value as written. */
    value: string
    /** The data-literal value it became (or `null` when it was left for a human). */
    rewritten: string | null
}

export interface CodemodResult {
    code: string
    changed: boolean
    /** Scopes whose part maps the file imports after the conversion. */
    scopes: string[]
    /** Things a human (or agent) must still decide, with 1-based lines. */
    todo: Array<{ line: number; message: string }>
    /** Data attributes that render "false" today (latent footguns, kept as they are). */
    falseAttributes: FalseAttribute[]
}

interface Edit {
    start: number
    end: number
    text: string
}

const DEV = new Set<string>(Object.values(DEV_ATTRS))
const REMOVED_HOOKS = new Set(["data-component", "data-part"])
const IDENT = /^[A-Za-z_$][\w$]*$/
const LEGACY_CX_HELPER = /(^|\/)utils\/cx$/

const importedName = (s: t.ImportSpecifier): string => (s.imported.type === "Identifier" ? s.imported.name : s.imported.value)
const member = (local: string, part: string) => (IDENT.test(part) ? `${local}.${part}` : `${local}[${JSON.stringify(part)}]`)

/** Expressions that can't evaluate to `false`, `""` or `0` by their shape alone. */
function shapeFacts(node: t.Node): ValueFacts | null {
    const n = unwrapNode(node as AnyNode) as t.Node
    const none: ValueFacts = { unknown: false, canBeFalse: false, canBeUndefined: false, canBeNull: false, canBeEmpty: false }
    switch (n.type) {
        case "StringLiteral":
            return { ...none, canBeEmpty: n.value === "" }
        case "TemplateLiteral":
            return { ...none, canBeEmpty: true }
        case "NumericLiteral":
            return { ...none, canBeEmpty: n.value === 0 }
        case "BooleanLiteral":
            return { ...none, canBeFalse: !n.value }
        case "NullLiteral":
            return { ...none, canBeNull: true }
        case "Identifier":
            return n.name === "undefined" ? { ...none, canBeUndefined: true } : null
        case "ConditionalExpression": {
            const a = shapeFacts(n.consequent)
            const b = shapeFacts(n.alternate)
            if (!a || !b) return null
            return { unknown: false, canBeFalse: a.canBeFalse || b.canBeFalse, canBeUndefined: a.canBeUndefined || b.canBeUndefined, canBeNull: a.canBeNull || b.canBeNull, canBeEmpty: a.canBeEmpty || b.canBeEmpty }
        }
        case "UnaryExpression":
            return n.operator === "!" ? { ...none, canBeFalse: true } : null
        case "BinaryExpression":
            // a comparison is a boolean: never "" or 0
            return ["==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "instanceof"].includes(n.operator) ? { ...none, canBeFalse: true } : null
        default:
            return null
    }
}

/** True for an expression that reads the same value twice (identifier or plain member chain). */
function isPure(node: t.Node): boolean {
    const n = unwrapNode(node as AnyNode) as t.Node
    if (n.type === "Identifier") return true
    if (n.type === "MemberExpression" || n.type === "OptionalMemberExpression") return !n.computed && isPure(n.object)
    return false
}

/**
 * Rewrites one component file. `code` is the file text; `filename` picks the parser plugins.
 */
export function codemod(code: string, filename = "file.tsx", options: CodemodOptions = {}): CodemodResult {
    const todo: CodemodResult["todo"] = []
    const falseAttributes: FalseAttribute[] = []
    const ast = parseSync(code, {
        filename,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: filename.endsWith(".ts") ? ["typescript"] : ["jsx", "typescript"] },
    })
    if (!ast) return { code, changed: false, scopes: [], todo, falseAttributes }

    const edits: Edit[] = []
    const src = (node: t.Node) => code.slice(node.start!, node.end!)
    const line = (node: t.Node) => node.loc?.start.line ?? 0
    const body = ast.program.body

    // ---- the pragma and the imports the file already has
    const comments = ast.comments ?? []
    let pragmaScope: string | null = null
    let pragmaComment: t.Comment | null = null
    for (const c of comments) {
        let scope: string | null = null
        try {
            scope = findScopePragma([c])
        } catch {
            scope = null
        }
        if (!scope) continue
        if (pragmaScope && pragmaScope !== scope) todo.push({ line: c.loc?.start.line ?? 0, message: `a second @cxScope pragma (${scope}) — only the first (${pragmaScope}) is converted` })
        else if (!pragmaScope) {
            pragmaScope = scope
            pragmaComment = c
        }
    }

    const imports = body.filter((s): s is t.ImportDeclaration => s.type === "ImportDeclaration")
    /** scope → local of an existing part-map import */
    const mapLocals = new Map<string, string>()
    /** local → scope of every class/part map import (for `className={cn.x}`) */
    const mapByLocal = new Map<string, string>()
    let runtimeImport: t.ImportDeclaration | null = null
    let legacyHelper: string | null = null
    const moduleOf = options.moduleOf ?? (() => null)
    const isPartMapModule = (source: string) => {
        const group = partMapGroup(source, options.partMaps)
        if (group === null) return false
        if (group === undefined) return /-css(\/[a-z0-9-]+)?$/.test(source) // unconfigured: a css package
        return true
    }
    for (const decl of imports) {
        const source = decl.source.value
        if (RUNTIME_MODULES.includes(source) && decl.importKind !== "type") runtimeImport ??= decl
        else if (LEGACY_CX_HELPER.test(source)) {
            const spec = decl.specifiers.find((s): s is t.ImportSpecifier => s.type === "ImportSpecifier" && importedName(s) === "cx")
            if (spec) legacyHelper = spec.local.name
        } else if (isPartMapModule(source) && decl.importKind !== "type") {
            const groups = partMapGroups(source, options.partMaps) ?? null
            for (const spec of decl.specifiers) {
                if (spec.type !== "ImportSpecifier" || spec.importKind === "type") continue
                const scope = scopeOfExport(importedName(spec), options.registry, groups)
                if (!scope) continue
                mapByLocal.set(spec.local.name, scope)
                if (!mapLocals.has(scope)) mapLocals.set(scope, spec.local.name)
            }
        }
    }

    // ---- local names: `cn` for the file's own sheet, the export name for another one
    const taken = new Set<string>()
    traverse(ast, {
        Scopable(p: NodePath<t.Scopable>) {
            for (const name of Object.keys(p.scope.bindings)) taken.add(name)
        },
    })
    // the old class-joining helper imported as `cx` gives its name up once every call of it is converted
    const helperIsCx = legacyHelper === "cx"
    let helperConverted = 0
    const cxTaken = (() => {
        if (!taken.has("cx") || helperIsCx) return false
        const spec = runtimeImport?.specifiers.find((s): s is t.ImportSpecifier => s.type === "ImportSpecifier" && importedName(s) === "cx")
        return !(spec && spec.local.name === "cx")
    })()
    const needed = new Map<string, string>() // scope → local, for maps the file must import
    const localFor = (scope: string): string | null => {
        const existing = mapLocals.get(scope) ?? needed.get(scope)
        if (existing) return existing
        if (!moduleOf(scope)) return null
        let local = scope === pragmaScope ? "cn" : exportName(scope)
        if (taken.has(local)) local = `${exportName(scope)}Parts`
        for (let i = 2; taken.has(local); i++) local = `${exportName(scope)}Parts${i}`
        taken.add(local)
        needed.set(scope, local)
        return local
    }

    let usesCx = false
    let failed = false
    let forwardConverted = 0
    const refText = (ref: PartRef, at: t.Node): string | null => {
        const scope = ref.scope ?? pragmaScope
        if (!scope) {
            todo.push({ line: line(at), message: `cx part "${ref.part}" has no scope (no @cxScope pragma) — import the part map it belongs to and write {...cx(map.${ref.part})}` })
            return null
        }
        const local = localFor(scope)
        if (!local) {
            todo.push({ line: line(at), message: `no part-map module is known for scope "${scope}" — configure css.partMaps (css group → module) in libstylist.config.mjs` })
            return null
        }
        return member(local, ref.part)
    }

    /** Parses a legacy cx/slot attribute into member texts, or null (reported) when it can't be converted. */
    const partsOf = (attr: t.JSXAttribute): string[] | null => {
        let refs: PartRef[]
        try {
            const ir = parseCxAttributeValue(attr.value as never, attr as never)
            if (!isStaticIR(ir)) {
                todo.push({
                    line: line(attr),
                    message: `conditional ${src(attr)} left untouched — parts name structure only: move the state to a data-* attribute (cx(cn.root, { open }), sheet .root[data-open])`,
                })
                return null
            }
            refs = collectRefs(ir)
        } catch (e) {
            if (!(e instanceof CxGrammarError)) throw e
            todo.push({ line: line(attr), message: `${src(attr)} is not a static part list (${e.message}) — left untouched` })
            return null
        }
        const out: string[] = []
        for (const ref of refs) {
            const text = refText(ref, attr)
            if (text === null) return null
            if (!out.includes(text)) out.push(text)
        }
        return out
    }

    /** The data-literal entry of one attribute, or null (reported) when its value can't be decided. */
    const dataEntry = (attr: t.JSXAttribute, name: string): string | null => {
        const key = camelRoundTrips(name) && IDENT.test(dataKeyOf(name)) ? dataKeyOf(name) : JSON.stringify(name.slice("data-".length))
        const entry = (value: string) => (value === key ? key : `${key}: ${value}`)
        const v = attr.value
        if (!v) return entry("true")
        // a JSX attribute string decodes entities and has no escapes: carry its decoded value into a JS string
        if (v.type === "StringLiteral") return entry(JSON.stringify(v.value))
        if (v.type !== "JSXExpressionContainer" || v.expression.type === "JSXEmptyExpression") return entry(src(v))
        const e = v.expression
        const u = unwrapNode(e as AnyNode) as t.Node
        const factsOf = (n: t.Node): ValueFacts | null => shapeFacts(n) ?? options.types?.facts(n.start!, n.end!) ?? null
        // `x || undefined`: the data literal omits a falsy value by itself — unless x can be "" or 0, which it would render
        if (u.type === "LogicalExpression" && u.operator === "||" && unwrapNode(u.right as AnyNode).type === "Identifier" && (unwrapNode(u.right as AnyNode) as t.Identifier).name === "undefined") {
            // no type facts and no telling shape: kept as written, which renders exactly as before
            const f = factsOf(u.left)
            return entry(f && !f.unknown && !f.canBeEmpty ? src(u.left) : src(e))
        }
        const f = factsOf(e)
        if (!f || f.unknown) {
            todo.push({ line: line(attr), message: `${name}={${src(e)}}: its type is unknown — moved as written; if it can be false it rendered "false" before and renders nothing now` })
            return entry(src(e))
        }
        if (!f.canBeFalse) return entry(src(e))
        // renders "false" today: keep rendering exactly that
        let rewritten: string | null = null
        if (!f.canBeUndefined && !f.canBeNull) rewritten = `String(${src(e)})`
        else if (isPure(e)) rewritten = `${src(e)} ${f.canBeNull ? "== null" : "=== undefined"} ? undefined : String(${src(e)})`
        falseAttributes.push({ line: line(attr), attr: name, value: src(e), rewritten })
        if (rewritten === null) {
            todo.push({ line: line(attr), message: `${name}={${src(e)}} renders "false" today and is not a plain read — moved as written (it now renders nothing for false); decide the value` })
            return entry(src(e))
        }
        return entry(rewritten)
    }

    // ---- elements
    const geometry = (el: t.JSXOpeningElement) => {
        const n = el.name
        const last = n.type === "JSXIdentifier" ? n.name : n.type === "JSXMemberExpression" ? n.property.name : n.name.name
        return SVG_GEOMETRY_CX.includes(last) && (n.type !== "JSXIdentifier" || /^[a-z]/.test(n.name))
    }
    const removeWithSpace = (node: t.Node): Edit => {
        let start = node.start!
        while (start > 0 && /\s/.test(code[start - 1])) start--
        return { start, end: node.end!, text: "" }
    }

    // a relative import is a libstylist component when this file belongs to a libstylist package
    const inLibstylistPackage = (() => {
        if (!isAbsolute(filename)) return false
        try {
            return resolvePackageConfig(filename) !== null
        } catch {
            return false
        }
    })()
    /** A function or arrow, through TS wrappers and component wrappers (`memo`, `forwardRef`, `observer`, `Object.assign`'s root). */
    const isComponentFunction = (node: t.Node | null | undefined, depth = 0): boolean => {
        const n = node ? (unwrapNode(node as unknown as AnyNode) as unknown as t.Node) : null
        if (!n) return false
        if (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression") return true
        if (n.type !== "CallExpression" || depth > 4) return false
        const callee = n.callee
        const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" ? callee.property.name : null
        const path = callee.type === "MemberExpression" && callee.object.type === "Identifier" && name ? `${callee.object.name}.${name}` : name
        return n.arguments.some((arg, i) => wrapsComponent(name, path, i) && isComponentFunction(arg, depth + 1))
    }
    /**
     * True when the element renders a libstylist component (as ESLint's data-in-cx decides): its name is
     * imported from a relative module or a subpath import (`#components`) of a libstylist package or from
     * a package declaring a libstylist prefix, or it is a component function defined in this file of a
     * libstylist package (never a polymorphic `As`). A `data-*` attribute there is the component's prop,
     * not the element's data: it stays.
     */
    const rendersLibstylistComponent = (path: NodePath<t.JSXOpeningElement>): boolean => {
        let n: t.JSXOpeningElement["name"] = path.node.name
        while (n.type === "JSXMemberExpression") n = n.object as t.JSXOpeningElement["name"]
        if (n.type !== "JSXIdentifier" || (n === path.node.name && /^[a-z]/.test(n.name))) return false
        const binding = path.scope.getBinding(n.name)
        if (binding && binding.kind !== "module") {
            const node = binding.path.node
            const local =
                (binding.kind === "hoisted" && node.type === "FunctionDeclaration") ||
                (binding.kind === "const" && node.type === "VariableDeclarator" && node.id.type === "Identifier" && isComponentFunction(node.init))
            return local && inLibstylistPackage
        }
        const decl = binding?.kind === "module" ? binding.path.parentPath?.node : null
        if (!decl || decl.type !== "ImportDeclaration" || decl.importKind === "type") return false
        const source = decl.source.value
        // a relative module or a subpath import (`#components`) is this package's own
        if (isOwnPackageSpecifier(source)) return inLibstylistPackage
        return isAbsolute(filename) && isLibstylistPackage(filename, source)
    }

    traverse(ast, {
        JSXOpeningElement(path: NodePath<t.JSXOpeningElement>) {
            const el = path.node
            const component = rendersLibstylistComponent(path)
            const parts: string[] = []
            const forwarded: string[] = []
            const data: string[] = []
            const removed: t.Node[] = []
            const slotEdits: Edit[] = []
            let skip = false
            let elementForwards = 0
            for (const attr of el.attributes) {
                if (attr.type === "JSXSpreadAttribute") {
                    const arg = unwrapNode(attr.argument as AnyNode) as t.Node
                    if (arg.type === "CallExpression" && arg.callee.type === "Identifier" && arg.callee.name === "forwardStylist" && arg.arguments.length === 1) {
                        forwarded.push(src(unwrapNode(arg.arguments[0] as AnyNode) as t.Node))
                        removed.push(attr)
                        elementForwards++
                    } else if ((arg.type === "Identifier" && SLOT_PROP.test(arg.name)) || (arg.type === "MemberExpression" && !arg.computed && arg.property.type === "Identifier" && SLOT_PROP.test(arg.property.name))) {
                        forwarded.push(src(arg))
                        removed.push(attr)
                    }
                    continue
                }
                const name = attr.name.type === "JSXIdentifier" ? attr.name.name : null
                if (!name) continue
                if (name === "cx" && !geometry(el)) {
                    const p = partsOf(attr)
                    if (p === null) skip = true
                    else {
                        parts.push(...p.filter((x) => !parts.includes(x)))
                        removed.push(attr)
                    }
                } else if (SLOT_PROP.test(name) && !(el.name.type === "JSXIdentifier" && /^[a-z]/.test(el.name.name))) {
                    const v = attr.value
                    const e = v && v.type === "JSXExpressionContainer" ? (unwrapNode(v.expression as AnyNode) as t.Node) : (v as t.Node | null)
                    if (e && ["StringLiteral", "TemplateLiteral", "ArrayExpression", "ObjectExpression"].includes(e.type)) {
                        const p = partsOf(attr)
                        if (p === null) skip = true
                        else {
                            usesCx = true
                            slotEdits.push({ start: attr.value!.start!, end: attr.value!.end!, text: `{cx(${p.join(", ")})}` })
                        }
                    }
                } else if (name === "className" && attr.value?.type === "JSXExpressionContainer") {
                    const e = unwrapNode(attr.value.expression as AnyNode) as t.Node
                    const members = e.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === legacyHelper ? e.arguments : [e]
                    const texts: string[] = []
                    for (const m of members) {
                        const n = unwrapNode(m as AnyNode) as t.Node
                        if (n.type === "MemberExpression" && n.object.type === "Identifier" && mapByLocal.has(n.object.name)) texts.push(src(n))
                        else {
                            texts.length = 0
                            break
                        }
                    }
                    if (texts.length) {
                        parts.push(...texts.filter((x) => !parts.includes(x)))
                        removed.push(attr)
                        if (e.type === "CallExpression") helperConverted++
                    } else if ([...mapByLocal.keys()].some((l) => src(attr).includes(`${l}.`) || src(attr).includes(`${l}[`))) {
                        todo.push({ line: line(attr), message: `${src(attr)} is not a plain list of part-map members — convert it by hand: parts go in {...cx(cn.a, cn.b)}, state in the data literal` })
                    }
                } else if (/^data-[a-z0-9]/.test(name)) {
                    // on a libstylist component a data-* attribute is a prop — its cx() would drop a data literal
                    if (component) continue
                    if (DEV.has(name) || REMOVED_HOOKS.has(name)) {
                        todo.push({ line: line(attr), message: `${name} is a tooling-owned or removed attribute — delete it` })
                        continue
                    }
                    const entry = dataEntry(attr, name)
                    if (entry === null) continue
                    data.push(entry)
                    removed.push(attr)
                }
            }
            if (skip) return
            forwardConverted += elementForwards
            edits.push(...slotEdits)
            if (!removed.length) return
            if (cxTaken) {
                failed = true
                todo.push({ line: line(el), message: "`cx` is bound to something other than the runtime cx() in this file — rename it, then run the codemod again" })
                return
            }
            usesCx = true
            const args = [...parts, ...forwarded, ...(data.length ? [`{ ${data.join(", ")} }`] : [])]
            const first = removed.reduce((a, b) => (a.start! < b.start! ? a : b))
            edits.push({ start: first.start!, end: first.end!, text: `{...cx(${args.join(", ")})}` })
            for (const r of removed) if (r !== first) edits.push(removeWithSpace(r))
            // precedence: a moved data attribute that crosses another spread may now lose (or win) against it
            const spreads = el.attributes.filter((a) => a.type === "JSXSpreadAttribute" && !removed.includes(a))
            const isData = (r: t.Node) => r.type === "JSXAttribute" && r.name.type === "JSXIdentifier" && r.name.name.startsWith("data-")
            const crossed = removed.filter((r) => isData(r) && spreads.some((s) => (s.start! - first.start!) * (s.start! - r.start!) < 0))
            if (crossed.length) {
                todo.push({
                    line: line(el),
                    message: `${crossed.map((r) => (r as t.JSXAttribute).name.type === "JSXIdentifier" ? ((r as t.JSXAttribute).name as t.JSXIdentifier).name : "?").join(", ")} moved across ${spreads.map((s) => src(s)).join(", ")} — check which one should win for a key both set`,
                })
            }
        },
    })
    if (helperIsCx) {
        let helperUses = 0
        traverse(ast, {
            Identifier(p: NodePath<t.Identifier>) {
                if (p.node.name === "cx" && p.isReferencedIdentifier() && !p.parentPath.isImportSpecifier()) helperUses++
            },
        })
        const decl = imports.find((d) => LEGACY_CX_HELPER.test(d.source.value))
        if (helperUses > helperConverted || !decl) {
            failed = true
            todo.push({ line: 0, message: "the class-joining helper imported as `cx` is still called — convert its remaining className values by hand (parts in cx(), state in the data literal), then run the codemod again" })
        } else if (decl.specifiers.length === 1) edits.push(removeStatement(code, decl))
        else {
            const spec = decl.specifiers.find((x) => x.local.name === "cx") as t.Node
            const next = code.slice(spec.end!).match(/^\s*,\s*/)
            edits.push(next ? { start: spec.start!, end: spec.end! + next[0].length, text: "" } : { start: code.lastIndexOf(",", spec.start!), end: spec.end!, text: "" })
        }
    }
    if (failed) return { code, changed: false, scopes: [], todo: todo.sort((a, b) => a.line - b.line), falseAttributes }

    // ---- pragma and imports
    if (pragmaComment) edits.push(removeComment(code, pragmaComment))
    // the file's statement style: an import it rewrites or adds ends with `;` when its imports do
    const styleImport = runtimeImport ?? imports.find((d) => d.source.value.startsWith("@livesession/")) ?? imports[0]
    const semi = styleImport && src(styleImport).endsWith(";") ? ";" : ""
    const newImports: string[] = []
    const byModule = new Map<string, string[]>()
    for (const [scope, local] of needed) {
        const module = moduleOf(scope) as string
        const name = exportName(scope)
        byModule.set(module, [...(byModule.get(module) ?? []), local === name ? name : `${name} as ${local}`])
    }
    for (const [module, specs] of byModule) newImports.push(`import { ${specs.join(", ")} } from "${module}"${semi}`)

    let runtimeSpecs: string[] | null = null
    if (runtimeImport) {
        // forwardStylist goes once every use of it was converted
        let forwardUses = 0
        traverse(ast, {
            Identifier(p: NodePath<t.Identifier>) {
                if (p.node.name === "forwardStylist" && p.isReferencedIdentifier() && !p.parentPath.isImportSpecifier()) forwardUses++
            },
        })
        if (forwardUses > forwardConverted) todo.push({ line: line(runtimeImport), message: "forwardStylist is used outside a JSX spread — replace it with cx(props) by hand; its import is kept" })
        const specs = runtimeImport.specifiers
            .filter((s): s is t.ImportSpecifier => s.type === "ImportSpecifier")
            .filter((s) => importedName(s) !== "forwardStylist" || forwardUses > forwardConverted)
            .map((s) => src(s))
        if (usesCx && !specs.some((s) => /^cx(\s|$)/.test(s))) specs.unshift("cx")
        const allNamed = runtimeImport.specifiers.every((s) => s.type === "ImportSpecifier")
        if (allNamed) {
            const text = specs.length ? `import { ${specs.join(", ")} } from "${runtimeImport.source.value}"${semi}` : ""
            if (text !== src(runtimeImport)) {
                if (text) edits.push({ start: runtimeImport.start!, end: runtimeImport.end!, text })
                else edits.push(removeStatement(code, runtimeImport))
            }
        }
        runtimeSpecs = specs
    } else if (usesCx) newImports.push(`import { cx } from "${RUNTIME_MODULES[0]}"${semi}`)

    if (newImports.length) {
        const livesession = imports.filter((d) => d.source.value.startsWith("@livesession/"))
        const anchor = runtimeImport ?? null
        if (anchor && runtimeSpecs && runtimeSpecs.length) edits.push({ start: anchor.start!, end: anchor.start!, text: `${newImports.join("\n")}\n` })
        else if (livesession.length) edits.push({ start: livesession[livesession.length - 1].end!, end: livesession[livesession.length - 1].end!, text: `\n${newImports.join("\n")}` })
        else {
            // a new @livesession group: after the package imports, before the local ones
            const external = imports.filter((d) => !d.source.value.startsWith("."))
            const after = external[external.length - 1]
            if (after) edits.push({ start: after.end!, end: after.end!, text: `\n\n${newImports.join("\n")}` })
            else if (imports.length) edits.push({ start: imports[0].start!, end: imports[0].start!, text: `${newImports.join("\n")}\n\n` })
            else edits.push({ start: 0, end: 0, text: `${newImports.join("\n")}\n\n` })
        }
    }

    const out = applyEdits(code, edits)
    const scopes = [...new Set([...mapLocals.keys(), ...needed.keys()])].sort()
    return { code: out, changed: out !== code, scopes, todo: todo.sort((a, b) => a.line - b.line), falseAttributes }
}

function removeStatement(code: string, node: t.Node): Edit {
    let end = node.end!
    if (code[end] === "\n") end++
    // a statement alone in its import group leaves two blank lines behind: drop one
    const blankBefore = node.start! === 0 || code.slice(0, node.start!).endsWith("\n\n")
    if (blankBefore && code[end] === "\n") end++
    return { start: node.start!, end, text: "" }
}

/**
 * Removes a comment. One standing on its own lines takes its blank-line run with it: the code around
 * it keeps one blank line when either side had one (none when it opened the file), so no run of blank
 * lines is left behind.
 */
function removeComment(code: string, c: t.Comment): Edit {
    let start = c.start!
    let end = c.end!
    while (start > 0 && (code[start - 1] === " " || code[start - 1] === "\t")) start--
    while (end < code.length && (code[end] === " " || code[end] === "\t")) end++
    const ownLine = (start === 0 || code[start - 1] === "\n") && (end === code.length || code[end] === "\n" || code[end] === "\r")
    if (!ownLine) return { start: c.start!, end: c.end!, text: "" }
    const blank = /[ \t]*\r?\n/y
    let after = 0
    for (blank.lastIndex = end; blank.test(code); after++) end = blank.lastIndex
    let before = 0
    while (start > 0 && code[start - 1] === "\n") {
        let s = start - 1
        if (s > 0 && code[s - 1] === "\r") s--
        let lineStart = s
        while (lineStart > 0 && (code[lineStart - 1] === " " || code[lineStart - 1] === "\t")) lineStart--
        // stop at the end of the previous line with content (its newline stays)
        if (lineStart > 0 && code[lineStart - 1] !== "\n") break
        start = lineStart
        before++
    }
    if (start === 0 || end === code.length) return { start, end, text: "" }
    return { start, end, text: before > 0 || after > 1 ? "\n" : "" }
}

function applyEdits(code: string, edits: Edit[]): string {
    let out = code
    const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)
    for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end)
    return out
}
