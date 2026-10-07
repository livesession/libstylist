// `cx()` calls in ESTree: runtime-callee and part-map binding resolution for the core grammar,
// the cx() spreads of an element, the file's primary part-map scope, the forwarding predicate's
// bindings and the design-system components an element renders.
import { isAbsolute, resolve } from "node:path"

import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils"

import { isLibstylistPackage } from "../conventions/index.js"
import {
    classifyCxCall,
    partArgs,
    flattenCxArgs,
    isOwnPackageSpecifier,
    isRelativeSpecifier,
    normalizePartMaps,
    resolvePartMap,
    scopeOfExport,
    unwrapNode,
    wrapsComponent,
    type AnyNode,
    type CxArg,
    type CxEnv,
    type PartMapRef,
    type PropsBinding,
    type PropsEnv,
} from "../core/index.js"
import { calleeName, constInit, findVariable, isRuntimeCallee, unwrap, type AnyRuleContext } from "./ast.js"
import { loadRegistry, type FileStylist, type StylistRegistry } from "./context.js"
import { elementKind } from "./jsx.js"

/** Views an ESTree node as the structural node type the `core` grammar works on. */
export const asAny = (node: unknown): AnyNode => node as AnyNode

/** An import of a registry scope's part-map export through a relative/absolute path (never recognized as a part map). */
export interface RelativePartMap {
    local: string
    exportName: string
    module: string
    scope: string
}

/** Everything the rules need to read cx() calls of one file. */
export interface CxFile {
    env: CxEnv
    /** The bindings the forwarding predicate (`carriesProps`) reads. */
    propsEnv: PropsEnv
    registry: StylistRegistry | null
    /** True when `node` is a call of the runtime `cx`. */
    isCxCall(node: TSESTree.Node): node is TSESTree.CallExpression
    /** The part map an identifier is bound to, or null. */
    partMap(id: TSESTree.Node): PartMapRef | null
    /**
     * An identifier imported by a relative/absolute specifier under a registry scope's part-map export
     * name (`import { counter as cn } from "../styles-dist/parts"`): a part map the tooling can't see.
     */
    relativePartMap(id: TSESTree.Node): RelativePartMap | null
}

const cache = new WeakMap<object, CxFile>()

const importedName = (spec: TSESTree.ImportSpecifier): string => (spec.imported.type === AST_NODE_TYPES.Identifier ? spec.imported.name : spec.imported.value)

/** The value import specifier an identifier is bound to, with its declaration. */
function importOf(context: AnyRuleContext, node: TSESTree.Node): { spec: TSESTree.ImportSpecifier; decl: TSESTree.ImportDeclaration } | null {
    if (node.type !== AST_NODE_TYPES.Identifier) return null
    const def = findVariable(context, node)?.defs[0]
    if (!def || def.type !== "ImportBinding" || def.node.type !== AST_NODE_TYPES.ImportSpecifier) return null
    const decl = def.node.parent
    if (decl.type !== AST_NODE_TYPES.ImportDeclaration || decl.importKind === "type" || def.node.importKind === "type") return null
    return { spec: def.node, decl }
}

/** The cx() reading context of the file being linted (one per file, shared by all rules). */
export function cxFile(context: AnyRuleContext, file: FileStylist): CxFile {
    const hit = cache.get(context.sourceCode)
    if (hit) return hit
    const registry = loadRegistry(file.settings, context.cwd)
    const partMaps = normalizePartMaps(file.settings.partMaps, "settings.libstylist.partMaps")
    const partMap = (node: TSESTree.Node): PartMapRef | null => {
        const hit = importOf(context, node)
        return hit ? resolvePartMap((node as TSESTree.Identifier).name, importedName(hit.spec), hit.decl.source.value, registry, partMaps) : null
    }
    const relativePartMap = (node: TSESTree.Node): RelativePartMap | null => {
        const hit = importOf(context, node)
        if (!hit || !registry || !isRelativeSpecifier(hit.decl.source.value)) return null
        const scope = scopeOfExport(importedName(hit.spec), registry)
        return scope ? { local: (node as TSESTree.Identifier).name, exportName: importedName(hit.spec), module: hit.decl.source.value, scope } : null
    }
    const isCx = (callee: AnyNode) => isRuntimeCallee(context, callee as unknown as TSESTree.Node, "cx")
    const writesOf = (id: AnyNode): AnyNode[] => writesOfLocal(context, id as unknown as TSESTree.Node)
    const env: CxEnv = {
        isCx,
        partMap: (id) => partMap(id as unknown as TSESTree.Node),
        isObjectVariable: (id) => {
            const init = constInit(context, id as unknown as TSESTree.Identifier)
            return !!init && unwrap(init).type === AST_NODE_TYPES.ObjectExpression
        },
        writesOf,
    }
    const out: CxFile = {
        env,
        propsEnv: { isCx, bindingOf: (id) => propsBindingOf(context, id as unknown as TSESTree.Node) },
        registry,
        partMap,
        relativePartMap,
        isCxCall: (node): node is TSESTree.CallExpression => node.type === AST_NODE_TYPES.CallExpression && isCx(asAny(node.callee)),
    }
    cache.set(context.sourceCode, out)
    return out
}

/**
 * Every expression a plain local (`const`/`let`/`var`, identifier-bound) is written with: its initializer
 * and each `=` assignment. `[]` for anything else — parameters, imports, destructured names (whose value
 * is a property of the written object, not the object).
 */
export function writesOfLocal(context: AnyRuleContext, node: TSESTree.Node): AnyNode[] {
    if (node.type !== AST_NODE_TYPES.Identifier) return []
    const variable = findVariable(context, node)
    if (!variable || !variable.defs.length || !variable.defs.every((d) => d.type === "Variable")) return []
    const out: AnyNode[] = []
    for (const ref of variable.references) {
        if (!ref.isWrite() || !ref.writeExpr) continue
        const parent = ref.identifier.parent
        const direct =
            (parent?.type === AST_NODE_TYPES.VariableDeclarator && parent.id === ref.identifier) ||
            (parent?.type === AST_NODE_TYPES.AssignmentExpression && parent.left === ref.identifier && parent.operator === "=")
        if (direct) out.push(asAny(ref.writeExpr))
    }
    return out
}

const FUNCTIONS = new Set<string>([AST_NODE_TYPES.FunctionDeclaration, AST_NODE_TYPES.FunctionExpression, AST_NODE_TYPES.ArrowFunctionExpression])

/** The object pattern `node` is a direct element of (through a default value), or null. */
function patternOf(name: TSESTree.Node): { pattern: TSESTree.ObjectPattern; rest: boolean; key: string | null } | null {
    let n: TSESTree.Node = name
    if (n.parent?.type === AST_NODE_TYPES.AssignmentPattern && n.parent.left === n) n = n.parent
    const p = n.parent
    if (p?.type === AST_NODE_TYPES.RestElement && p.parent?.type === AST_NODE_TYPES.ObjectPattern) return { pattern: p.parent, rest: true, key: null }
    if (p?.type === AST_NODE_TYPES.Property && p.value === n && p.parent?.type === AST_NODE_TYPES.ObjectPattern) {
        const key = !p.computed && p.key.type === AST_NODE_TYPES.Identifier ? p.key.name : p.key.type === AST_NODE_TYPES.Literal && typeof p.key.value === "string" ? p.key.value : null
        return { pattern: p.parent, rest: false, key }
    }
    return null
}

/** `a.b.c` for an identifier member chain, else null. */
function memberPath(node: TSESTree.Node): string | null {
    const n = unwrap(node)
    if (n.type === AST_NODE_TYPES.Identifier) return n.name
    if (n.type === AST_NODE_TYPES.MemberExpression && !n.computed && n.property.type === AST_NODE_TYPES.Identifier) {
        const object = memberPath(n.object)
        return object ? `${object}.${n.property.name}` : null
    }
    return null
}

/**
 * True when `param` (an element of `fn.params`) is the component's props: `fn`'s first parameter, and
 * `fn` no callback — not an argument of a call, unless it is a component wrapper's first (`memo`,
 * `forwardRef`, `observer`, `Object.assign`), so a `.map((item) => …)` parameter is never the props.
 */
function isPropsParam(fn: TSESTree.Node, param: TSESTree.Node): boolean {
    const params = (fn as TSESTree.FunctionLike).params as TSESTree.Node[]
    if (params[0] !== param) return false
    let child: TSESTree.Node = fn
    let parent = fn.parent
    // through `as`, `satisfies`, `!` and `<T>` wrappers around the function
    while (parent && unwrap(parent) !== parent && (parent as { expression?: TSESTree.Node }).expression === child) {
        child = parent
        parent = parent.parent
    }
    if (parent?.type === AST_NODE_TYPES.CallExpression || parent?.type === AST_NODE_TYPES.NewExpression) {
        const index = (parent.arguments as TSESTree.Node[]).indexOf(child)
        if (index >= 0) return wrapsComponent(calleeName(parent.callee), memberPath(parent.callee), index)
    }
    return true
}

/** How an identifier is bound, for `carriesProps` (scope analysis). */
function propsBindingOf(context: AnyRuleContext, node: TSESTree.Node): PropsBinding {
    if (node.type !== AST_NODE_TYPES.Identifier) return { kind: "other" }
    const variable = findVariable(context, node)
    if (!variable || variable.defs.length === 0) return { kind: "unresolved" }
    if (variable.defs.length !== 1) return { kind: "other" }
    const def = variable.defs[0]
    const name = def.name as TSESTree.Node
    if (def.type === "Parameter") {
        let top: TSESTree.Node = name
        if (top.parent?.type === AST_NODE_TYPES.AssignmentPattern && top.parent.left === top) top = top.parent
        if (top.parent && FUNCTIONS.has(top.parent.type)) return isPropsParam(top.parent, top) ? { kind: "param" } : { kind: "other" }
        const hit = patternOf(name)
        if (!hit) return { kind: "other" }
        let param: TSESTree.Node = hit.pattern
        let owner: TSESTree.Node | undefined = hit.pattern.parent
        if (owner?.type === AST_NODE_TYPES.AssignmentPattern && owner.left === hit.pattern) {
            param = owner
            owner = owner.parent
        }
        return owner && FUNCTIONS.has(owner.type) && isPropsParam(owner, param) ? { kind: "pattern", rest: hit.rest, key: hit.key, from: "param" } : { kind: "other" }
    }
    if (def.type === "Variable") {
        const decl = def.node
        if (def.parent?.kind !== "const" || !decl.init) return { kind: "other" }
        if (decl.id === name) return { kind: "const", init: asAny(decl.init) }
        const hit = patternOf(name)
        return hit && decl.id === hit.pattern ? { kind: "pattern", rest: hit.rest, key: hit.key, from: asAny(decl.init) } : { kind: "other" }
    }
    return { kind: "other" }
}

/** The local name the file imports `scope`'s part map under (`cn`), or null. */
export function partMapLocal(context: AnyRuleContext, cx: CxFile, scope: string): string | null {
    for (const s of context.sourceCode.ast.body) {
        if (s.type !== AST_NODE_TYPES.ImportDeclaration) continue
        for (const spec of s.specifiers) if (spec.type === AST_NODE_TYPES.ImportSpecifier && cx.partMap(spec.local)?.scope === scope) return spec.local.name
    }
    return null
}

// --- design-system components ----------------------------------------------------------------

/**
 * True when the element renders a libstylist component — one whose `cx()` forwards only the parts and
 * markers it receives (SPEC §6): its name's root identifier is imported from a relative module or a
 * subpath import of a libstylist package (`import { Button } from "../Button"`, `from "#components"`)
 * or from a package that declares a libstylist `prefix` (`@livesession/eloquentui-react`), or it is a
 * component function defined in this file of a libstylist package. Host elements, other local and
 * parameter bindings (a polymorphic `As`) and third-party components (Radix, which pass `data-*` on to
 * their DOM) are not.
 */
export function rendersLibstylistComponent(context: AnyRuleContext, file: FileStylist, opening: TSESTree.JSXOpeningElement): boolean {
    const binding = elementBinding(context, opening)
    if (binding.kind === "local") return binding.component && !!file.prefix
    const source = binding.kind === "import" ? binding.source : null
    if (source === null) return false
    // a relative module or a subpath import (`#components`) is this package's own
    if (isOwnPackageSpecifier(source)) return !!file.prefix
    const filename = context.filename
    return isAbsolute(filename) && isLibstylistPackage(resolve(filename), source)
}

/** The module a component element's name is imported from (`@radix-ui/react-popover` for `<RadixPopover.Content>`), or null (a host, a local, a parameter or an unresolved name). */
export function componentSource(context: AnyRuleContext, opening: TSESTree.JSXOpeningElement): string | null {
    const b = elementBinding(context, opening)
    return b.kind === "import" ? b.source : null
}

/**
 * True when an expression defines a component function: a function or arrow, through TS wrappers and
 * component wrappers (`memo(…)`, `forwardRef(…)`, `observer(…)`, the root of `Object.assign(…)`).
 */
function isComponentFunction(node: TSESTree.Node, depth = 0): boolean {
    const n = unwrap(node)
    if (n.type === AST_NODE_TYPES.ArrowFunctionExpression || n.type === AST_NODE_TYPES.FunctionExpression) return true
    if (n.type !== AST_NODE_TYPES.CallExpression || depth > 4) return false
    return (n.arguments as TSESTree.Node[]).some((arg, i) => wrapsComponent(calleeName(n.callee), memberPath(n.callee), i) && isComponentFunction(arg, depth + 1))
}

/**
 * What a JSX element's name is bound to: a host element, an import (with its module), a local or
 * parameter binding — `component` when it is a function defined in this file (`function Item(props)`,
 * `const Item = memo((props) => …)`), not when it is a polymorphic `As` or any other value — or
 * nothing found.
 */
export function elementBinding(
    context: AnyRuleContext,
    opening: TSESTree.JSXOpeningElement,
): { kind: "host" } | { kind: "import"; source: string } | { kind: "local"; component: boolean } | { kind: "unresolved" } {
    if (elementKind(opening).host) return { kind: "host" }
    let n: TSESTree.JSXTagNameExpression = opening.name
    while (n.type === AST_NODE_TYPES.JSXMemberExpression) n = n.object
    if (n.type !== AST_NODE_TYPES.JSXIdentifier) return { kind: "unresolved" }
    const variable = findJsxVariable(context, n)
    const def = variable?.defs[0]
    if (!def) return { kind: "unresolved" }
    if (def.type !== "ImportBinding") {
        // a member (`<Alert.Icon>`) is judged by the local it is read from
        const single = variable!.defs.length === 1
        const component =
            single &&
            (def.type === "FunctionName" ||
                (def.type === "Variable" && def.parent?.kind === "const" && def.node.id === def.name && !!def.node.init && isComponentFunction(def.node.init)))
        return { kind: "local", component }
    }
    const decl = def.parent as TSESTree.ImportDeclaration | null
    if (!decl || decl.type !== AST_NODE_TYPES.ImportDeclaration || decl.importKind === "type") return { kind: "local", component: false }
    return { kind: "import", source: decl.source.value }
}

/** The variable a JSX identifier refers to (JSX names are references in the scope manager). */
function findJsxVariable(context: AnyRuleContext, id: TSESTree.JSXIdentifier): TSESLint.Scope.Variable | null {
    let scope: TSESLint.Scope.Scope | null = context.sourceCode.getScope(id)
    for (; scope; scope = scope.upper) {
        const v = scope.set.get(id.name)
        if (v) return v
    }
    return null
}

/** One cx() spread on an element, classified. */
export interface CxSpread {
    spread: TSESTree.JSXSpreadAttribute
    call: TSESTree.CallExpression
    args: CxArg[]
}

/** The element's `{...cx(…)}` spreads. */
export function cxSpreads(cx: CxFile, opening: TSESTree.JSXOpeningElement): CxSpread[] {
    const out: CxSpread[] = []
    for (const a of opening.attributes) {
        if (a.type !== AST_NODE_TYPES.JSXSpreadAttribute) continue
        const call = unwrapNode(asAny(a.argument)) as unknown as TSESTree.Node
        if (cx.isCxCall(call)) out.push({ spread: a, call, args: classifyCxCall(asAny(call), cx.env) })
    }
    return out
}

/** Every part argument of an element's cx() spreads (nested calls included). */
export const spreadParts = (spreads: CxSpread[]) => spreads.flatMap((s) => partArgs(s.args))

/** True when some cx() spread passes a props/slot object (the forwarding rule). */
export const spreadForwards = (spreads: CxSpread[]) => spreads.some((s) => flattenCxArgs(s.args).some((a) => a.kind === "props"))

/**
 * The scope most part-map members of the file read — the file's own sheet (the default root binding
 * and bare `rootLocals` resolve against it). Null when the file reads no part map.
 */
export function primaryScope(context: AnyRuleContext, cx: CxFile): string | null {
    const counts = new Map<string, number>()
    const visit = (node: TSESTree.Node): void => {
        if (node.type === AST_NODE_TYPES.MemberExpression && node.object.type === AST_NODE_TYPES.Identifier) {
            const scope = cx.partMap(node.object)?.scope
            if (scope) counts.set(scope, (counts.get(scope) ?? 0) + 1)
        }
        for (const key of context.sourceCode.visitorKeys[node.type] ?? []) {
            const child = (node as unknown as Record<string, unknown>)[key]
            if (Array.isArray(child)) for (const c of child) c && typeof c === "object" && "type" in c && visit(c as TSESTree.Node)
            else if (child && typeof child === "object" && "type" in child) visit(child as TSESTree.Node)
        }
    }
    visit(context.sourceCode.ast)
    let best: string | null = null
    for (const [scope, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = scope
    if (best) return best
    // no member read yet: the first part map the file imports names its sheet
    for (const s of context.sourceCode.ast.body) {
        if (s.type !== AST_NODE_TYPES.ImportDeclaration) continue
        for (const spec of s.specifiers) {
            const scope = spec.type === AST_NODE_TYPES.ImportSpecifier ? cx.partMap(spec.local)?.scope : null
            if (scope) return scope
        }
    }
    return null
}
