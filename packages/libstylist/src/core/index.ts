// The `cx()` call grammar (SPEC §5.2), shared by the Babel transform, the ESLint rules, the checker
// and the codemod. It works on Babel and ESTree (typescript-eslint) nodes; the checker mirrors
// TypeScript nodes into the same shapes. Binding questions (is this callee the runtime `cx`, is this
// identifier a part map) are answered by the caller through `CxEnv`, since every layer resolves
// bindings its own way.
import { PART_RE, SLOT_PROP } from "../conventions/index.js"
import { exportName } from "../registry/modules.js"

/** Minimal structural view of a Babel or ESTree node. */
export interface AnyNode {
    type: string
    [key: string]: any
}

/** Module ids the runtime is imported from (the Vite plugin serves the second as a virtual module). */
export const RUNTIME_MODULES: readonly string[] = ["@livesession/libstylist/runtime", "virtual:libstylist/runtime"]

/** The runtime export whose inline object-literal arguments the transform brands as data. */
export const CX_EXPORT = "cx"
/** The runtime export the transform wraps data literals in. */
export const CX_DATA_EXPORT = "cxData"
/** The key of a part map that lists its component tags, never a part. */
export const PART_MAP_TAGS_KEY = "$tags"

/**
 * `partMaps` option (Babel, Vite, ESLint settings, `css.partMaps` of the checker config): css group →
 * the module specifier its part map is imported from (`{ components: "@livesession/eloquentui-css",
 * player: "@livesession/eloquentui-css/player" }`).
 */
export type PartMapModules = Readonly<Record<string, string>>

/** A part-map import a member argument reads from. */
export interface PartMapRef {
    /** Local binding (`cn` in `import { alert as cn }`). */
    local: string
    /** Imported export name (`alert`, `switchClasses`). */
    exportName: string
    /** Module specifier. */
    module: string
    /** The scope the export stands for, or null when it can't be told (no registry, no match). */
    scope: string | null
}

/** How a layer answers binding questions for the grammar. */
export interface CxEnv {
    /** True when `callee` is the runtime `cx` (an import of it, or a member of a namespace import of the runtime). */
    isCx(callee: AnyNode): boolean
    /** The part map an identifier refers to, or null when it is not a part-map import. */
    partMap(id: AnyNode): PartMapRef | null
    /** True when an identifier is a local holding an object literal (data kept in a variable). Optional. */
    isObjectVariable?(id: AnyNode): boolean
    /**
     * Every expression a local is bound to — its initializer and each plain `=` assignment to it — or
     * `[]` when it is not a plain local (a parameter, an import, a destructured name). Optional: a layer
     * without it (the transform, the checker) doesn't see parts or data routed through locals.
     */
    writesOf?(id: AnyNode): AnyNode[]
}

/** One data attribute of a data literal. */
export type DataEntry =
    | { kind: "key"; node: AnyNode; key: string; attr: string; value: AnyNode }
    | { kind: "spread"; node: AnyNode; argument: AnyNode }

/** Why an argument breaks the grammar. */
export type CxProblem =
    | "string"
    | "conditional-part"
    | "conditional"
    | "computed-member"
    | "tags-member"
    | "invalid-part"
    | "call"
    | "spread"
    | "data-variable"
    | "data-wrapper"
    | "data-key"
    | "data-part"
    | "part-variable"
    | "literal"
    | "other"

/** One classified `cx()` argument. */
export type CxArg =
    | { kind: "part"; node: AnyNode; map: PartMapRef; part: string }
    | { kind: "props"; node: AnyNode }
    | { kind: "data"; node: AnyNode; entries: DataEntry[] }
    | { kind: "nested"; node: AnyNode; args: CxArg[] }
    | { kind: "skip"; node: AnyNode }
    | { kind: "invalid"; node: AnyNode; problem: CxProblem; message: string }

const STATE_HINT = "state and variants go through data-* attributes; parts name structure only — write cx(cn.root, { open }) and select .root[data-open] in the sheet"
const SHAPE_HINT = "cx() takes part-map members (cn.icon), props or slot objects (rest, inputCx), one inline data literal ({ size }) and nested cx() calls"

/** Strips TS-only wrappers and parentheses (Babel `ParenthesizedExpression`, ESTree `ChainExpression`). */
export function unwrapNode(node: AnyNode): AnyNode {
    let n = node
    while (
        n &&
        (n.type === "TSAsExpression" ||
            n.type === "TSSatisfiesExpression" ||
            n.type === "TSNonNullExpression" ||
            n.type === "TSTypeAssertion" ||
            n.type === "ParenthesizedExpression" ||
            n.type === "ChainExpression")
    )
        n = n.expression
    return n
}

/** The string value of a string literal or an expression-less template, else undefined. */
export function stringValue(node: AnyNode | null | undefined): string | undefined {
    if (!node) return undefined
    if (node.type === "StringLiteral") return node.value
    if (node.type === "Literal" && typeof node.value === "string") return node.value
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis.map((q: AnyNode) => q.value.cooked ?? q.value.raw).join("")
    return undefined
}

const isStringish = (n: AnyNode) => stringValue(n) !== undefined || n.type === "TemplateLiteral"

/** `null`, `undefined` and `false` — arguments that add nothing (an unset optional slot). */
export function isNothing(node: AnyNode): boolean {
    const n = unwrapNode(node)
    return (
        n.type === "NullLiteral" ||
        (n.type === "Literal" && (n.value === null || n.value === false) && !n.regex) ||
        (n.type === "Identifier" && n.name === "undefined") ||
        (n.type === "BooleanLiteral" && n.value === false)
    )
}

const isMember = (n: AnyNode) => n.type === "MemberExpression" || n.type === "OptionalMemberExpression"
const isObject = (n: AnyNode) => n.type === "ObjectExpression"
const isCall = (n: AnyNode) => n.type === "CallExpression" || n.type === "OptionalCallExpression"

/** The member name of `X.part` / `X["part"]`, or null for a computed non-literal member. */
export function memberPartName(node: AnyNode): string | null {
    if (!node.computed) return node.property.type === "Identifier" ? node.property.name : null
    return stringValue(node.property) ?? null
}

/** `data-` + the key, camelCase → kebab exactly like `element.dataset` (`hasTitle` → `data-has-title`). */
export function dataAttrName(key: string): string {
    return `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

/** The inverse, for codemods: `data-has-title` → `hasTitle`. */
export function dataKeyOf(attr: string): string {
    return attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** True when `dataKeyOf(attr)` maps back to `attr` — a key that can be written as an identifier-style camelCase key. */
export const camelRoundTrips = (attr: string): boolean => dataAttrName(dataKeyOf(attr)) === attr

/** The key of an object property (identifier or string/number literal), or undefined when computed. */
function propertyKey(prop: AnyNode): string | undefined {
    if (prop.computed) return stringValue(prop.key)
    if (prop.key.type === "Identifier") return prop.key.name
    const s = stringValue(prop.key)
    if (s !== undefined) return s
    if ((prop.key.type === "NumericLiteral" || prop.key.type === "Literal") && typeof prop.key.value === "number") return String(prop.key.value)
    return undefined
}

/** Reads a data literal's entries; the first problem found is returned instead. */
function readData(obj: AnyNode, env: CxEnv): { entries: DataEntry[] } | { problem: CxProblem; node: AnyNode; message: string } {
    const entries: DataEntry[] = []
    for (const prop of obj.properties) {
        if (prop.type === "SpreadElement" || prop.type === "RestElement" || prop.type === "SpreadProperty") {
            entries.push({ kind: "spread", node: prop, argument: prop.argument })
            continue
        }
        const method = prop.type === "ObjectMethod" || prop.method || (prop.kind && prop.kind !== "init")
        // the object form of a conditional part (`{ [cn.icon]: open }`): the state goes into the data, not the parts
        if (prop.computed && prop.key && readsPartMember(prop.key, env)) return { problem: "conditional-part", node: prop, message: `conditional part: ${STATE_HINT}` }
        const key = propertyKey(prop)
        if (method || key === undefined) {
            return { problem: "data-key", node: prop, message: "a data literal's keys are identifiers or string literals with a plain value (no computed keys, methods or accessors)" }
        }
        if (key === "data") {
            return {
                problem: "data-wrapper",
                node: prop,
                message: "the inline object literal IS the element's data attributes — drop the `{ data: … }` wrapper and write the keys directly: cx(cn.root, { open })",
            }
        }
        if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(key)) {
            return { problem: "data-key", node: prop, message: `data key "${key}" does not name a data-* attribute — use camelCase (hasTitle → data-has-title) or kebab-case keys` }
        }
        if (prop.value && readsPartMember(prop.value, env)) {
            return {
                problem: "data-part",
                node: prop,
                message: `data value "${key}" reads a part-map member, so it would render the part attribute's name as ${dataAttrName(key)} — parts are cx() arguments (cx(cn.icon)) and never conditional; the data literal carries state only (${STATE_HINT})`,
            }
        }
        entries.push({ kind: "key", node: prop, key, attr: dataAttrName(key), value: prop.value })
    }
    return { entries }
}

/** True when an expression reads a part-map member (`cn.icon`), directly or through a conditional, logical, binary or template. */
function readsPartMember(node: AnyNode, env: CxEnv): boolean {
    const n = unwrapNode(node)
    if (!n) return false
    if (isMember(n)) return n.object.type === "Identifier" && env.partMap(n.object) !== null
    if (n.type === "ConditionalExpression") return readsPartMember(n.consequent, env) || readsPartMember(n.alternate, env)
    if (n.type === "LogicalExpression" || n.type === "BinaryExpression") return readsPartMember(n.left, env) || readsPartMember(n.right, env)
    if (n.type === "TemplateLiteral") return (n.expressions ?? []).some((e: AnyNode) => readsPartMember(e, env))
    return false
}

/**
 * True when a conditional or logical expression can evaluate to a non-empty object literal
 * (`open ? { open } : { closed: true }`, `open && { open }`): data held in a variable, whichever branch runs.
 */
function holdsData(node: AnyNode, depth = 0): boolean {
    const n = unwrapNode(node)
    if (!n || depth > 8) return false
    if (isObject(n)) return depth > 0 && n.properties.length > 0
    if (n.type === "ConditionalExpression") return holdsData(n.consequent, depth + 1) || holdsData(n.alternate, depth + 1)
    if (n.type === "LogicalExpression") return holdsData(n.left, depth + 1) || holdsData(n.right, depth + 1)
    return false
}

/** True when a conditional's branches name parts (member of a part map, or a string). */
function mentionsParts(node: AnyNode, env: CxEnv): boolean {
    const n = unwrapNode(node)
    if (isStringish(n)) return true
    if (isMember(n) && n.object.type === "Identifier") return env.partMap(n.object) !== null
    if (n.type === "ConditionalExpression") return mentionsParts(n.consequent, env) || mentionsParts(n.alternate, env)
    if (n.type === "LogicalExpression") return mentionsParts(n.left, env) || mentionsParts(n.right, env)
    if (n.type === "ArrayExpression") return n.elements.some((e: AnyNode | null) => !!e && mentionsParts(e, env))
    if (isObject(n)) return false
    return false
}

/** Classifies one argument of a runtime `cx()` call (SPEC §5.2). */
export function classifyCxArg(input: AnyNode, env: CxEnv): CxArg {
    if (input.type === "SpreadElement") return { kind: "invalid", node: input, problem: "spread", message: `cx() arguments are written out one by one, never spread — ${SHAPE_HINT}` }
    const node = unwrapNode(input)
    if (isNothing(node)) return { kind: "skip", node: input }
    if (isStringish(node)) {
        return {
            kind: "invalid",
            node: input,
            problem: "string",
            message: "string arguments are not parts — read the part from its part map: import { alert as cn } from \"<css package>\" and write cx(cn.icon)",
        }
    }
    if (isObject(node)) {
        const data = readData(node, env)
        if ("problem" in data) return { kind: "invalid", node: data.node, problem: data.problem, message: data.message }
        return { kind: "data", node: input, entries: data.entries }
    }
    if (isMember(node)) {
        const map = node.object.type === "Identifier" ? env.partMap(node.object) : null
        if (!map) return { kind: "props", node: input }
        const part = memberPartName(node)
        if (part === null) return { kind: "invalid", node: input, problem: "computed-member", message: `a part is read by name (${map.local}.icon, ${map.local}["group-label"]) — a computed member hides which part the element carries` }
        if (part === PART_MAP_TAGS_KEY) return { kind: "invalid", node: input, problem: "tags-member", message: `${map.local}.$tags lists component tags, not parts` }
        if (!PART_RE.test(part)) return { kind: "invalid", node: input, problem: "invalid-part", message: `"${part}" is not a part name (parts are kebab-case)` }
        return { kind: "part", node: input, map, part }
    }
    if (node.type === "Identifier") {
        if (env.partMap(node)) return { kind: "invalid", node: input, problem: "other", message: `${node.name} is a whole part map — pass one of its parts (${node.name}.root)` }
        const writes = env.writesOf?.(node) ?? []
        if (writes.some((w) => mentionsParts(w, env))) {
            return {
                kind: "invalid",
                node: input,
                problem: "part-variable",
                message: `${node.name} holds a part: pass the part-map member itself (cx(cn.icon)), never through a variable — a part held in a local can be conditional or reassigned, which parts never are: ${STATE_HINT}`,
            }
        }
        if (env.isObjectVariable?.(node) || writes.some((w) => isObject(unwrapNode(w)) || holdsData(w))) {
            return {
                kind: "invalid",
                node: input,
                problem: "data-variable",
                message: `${node.name} holds an object literal: cx() forwards a variable as props (markers and parts only) and never renders it as data — spread it into the call's data literal: cx(…, { ...${node.name} })`,
            }
        }
        return { kind: "props", node: input }
    }
    if (isCall(node)) {
        if (env.isCx(node.callee)) return { kind: "nested", node: input, args: node.arguments.map((a: AnyNode) => classifyCxArg(a, env)) }
        return { kind: "invalid", node: input, problem: "call", message: `only nested cx() calls are allowed as arguments — ${SHAPE_HINT}` }
    }
    if (node.type === "ConditionalExpression" || node.type === "LogicalExpression") {
        if (mentionsParts(node, env)) return { kind: "invalid", node: input, problem: "conditional-part", message: `conditional part: ${STATE_HINT}` }
        return { kind: "invalid", node: input, problem: "conditional", message: `conditional cx() argument — ${SHAPE_HINT}; state goes into the data literal (${STATE_HINT})` }
    }
    if (node.type === "ArrayExpression") {
        if (mentionsParts(node, env)) return { kind: "invalid", node: input, problem: "conditional-part", message: `write parts as separate arguments, cx(cn.a, cn.b), not an array — and never conditionally: ${STATE_HINT}` }
        return { kind: "invalid", node: input, problem: "other", message: SHAPE_HINT }
    }
    if (node.type === "BooleanLiteral" || node.type === "NumericLiteral" || node.type === "Literal" || node.type === "BigIntLiteral") {
        return { kind: "invalid", node: input, problem: "literal", message: `a literal adds nothing to cx() — ${SHAPE_HINT}` }
    }
    return { kind: "invalid", node: input, problem: "other", message: SHAPE_HINT }
}

/** Classifies every argument of a `cx()` call. */
export function classifyCxCall(call: AnyNode, env: CxEnv): CxArg[] {
    return call.arguments.map((a: AnyNode) => classifyCxArg(a, env))
}

/** Every argument of a classified call, nested calls flattened (the nested call itself is not included). */
export function flattenCxArgs(args: CxArg[], out: CxArg[] = []): CxArg[] {
    for (const a of args) {
        if (a.kind === "nested") flattenCxArgs(a.args, out)
        else out.push(a)
    }
    return out
}

/** The part arguments of a classified call, nested calls included. */
export const partArgs = (args: CxArg[]): Array<Extract<CxArg, { kind: "part" }>> => flattenCxArgs(args).filter((a): a is Extract<CxArg, { kind: "part" }> => a.kind === "part")

/** True when a classified call forwards a props object (a props/slot argument, nested calls included). */
export const cxForwards = (args: CxArg[]): boolean => flattenCxArgs(args).some((a) => a.kind === "props")

// --- forwarding: the component's own props ------------------------------------------------------

/**
 * How an identifier is bound, as far as forwarding is concerned. Each layer answers it with its own
 * scope analysis (ESLint's scope manager, the TypeScript checker's symbols).
 */
export type PropsBinding =
    /** No binding found (an undeclared global): nothing is provable, so it is not reported. */
    | { kind: "unresolved" }
    /**
     * A function's first parameter bound as a whole identifier (`props`, `function Row(props)`) —
     * never a callback's (`items.map((item) => …)`, see `wrapsComponent`) nor a later parameter.
     */
    | { kind: "param" }
    /**
     * A name bound by an object pattern (not nested): its `...rest` element, or the property `key` it
     * destructures. `from` is `"param"` for a parameter's pattern (`({ size, ...rest })`) or the
     * initializer of a `const` declarator (`const { a, ...rest } = props`).
     */
    | { kind: "pattern"; rest: boolean; key: string | null; from: "param" | AnyNode }
    /** `const x = init` with a plain identifier. */
    | { kind: "const"; init: AnyNode }
    /** Anything else: imports, `let`/`var`, functions, classes, nested or array patterns. */
    | { kind: "other" }

/** Calls that wrap a component function: the function passed is the component itself, not a callback. */
export const COMPONENT_WRAPPERS: ReadonlySet<string> = new Set(["memo", "forwardRef", "observer"])

/**
 * True when a function passed as argument `index` of a call is the component itself — `memo(fn)`,
 * `forwardRef(fn)`, `React.memo(fn)`, `observer(fn)`, or the root of `Object.assign(fn, { … })` —
 * so its first parameter is the component's props. `calleeName` is the callee's identifier or last
 * member name, `calleePath` its dotted member path. Only the first argument is the component: a
 * later one (`memo(fn, (prev, next) => …)`'s comparator) and a function passed to any other call
 * are callbacks (`items.map((item) => …)`) whose parameters are never the component's props.
 */
export function wrapsComponent(calleeName: string | null, calleePath: string | null, index: number): boolean {
    return index === 0 && ((calleeName !== null && COMPONENT_WRAPPERS.has(calleeName)) || calleePath === "Object.assign")
}

/** How a layer answers the binding questions of the forwarding predicate. */
export interface PropsEnv {
    /** True when `callee` is the runtime `cx`. */
    isCx(callee: AnyNode): boolean
    /** How an identifier is bound. */
    bindingOf(id: AnyNode): PropsBinding
}

/**
 * True when an expression may carry the component's stylist props — the markers and parts a wrapper or
 * a caller put on it — so passing it to the identity element's `cx()` call (or spreading it) forwards
 * them (SPEC §5.4). The one predicate ESLint's `forward-props` and the checker's R112/R106/S307 share.
 *
 * Accepted: the first parameter of a function that is not a callback, bound as a whole (`props`), the
 * rest element of its object pattern (`...rest`) or a named slot it destructures (`inputCx`), the same destructured in the body from an
 * accepted object (`const { a, ...rest } = props`), a `const` alias of one, a runtime `cx()` call
 * forwarding one, a named slot read off one (`props.inputCx`), and conditionals, logicals and object
 * spreads over those. Everything else — any other destructured prop (`style`), imports, `let`s,
 * other calls and members — carries none.
 */
export function carriesProps(input: AnyNode, env: PropsEnv, depth = 0): boolean {
    if (depth > 8) return true
    const n = unwrapNode(input)
    if (!n) return false
    if (n.type === "Identifier") {
        if (n.name === "undefined") return false
        const b = env.bindingOf(n)
        switch (b.kind) {
            case "unresolved":
            case "param":
                return true
            case "pattern":
                if (!b.rest && !(b.key !== null && SLOT_PROP.test(b.key))) return false
                return b.from === "param" || carriesProps(b.from, env, depth + 1)
            case "const":
                return carriesProps(b.init, env, depth + 1)
            default:
                return false
        }
    }
    if (isMember(n)) {
        const name = memberPartName(n)
        return name !== null && SLOT_PROP.test(name) && carriesProps(n.object, env, depth + 1)
    }
    // a cx() call forwards its props/slot arguments (its data literal is rendered, never forwarded)
    if (isCall(n)) return env.isCx(n.callee) && n.arguments.some((a: AnyNode) => a.type !== "SpreadElement" && !isObject(unwrapNode(a)) && carriesProps(a, env, depth + 1))
    if (n.type === "ConditionalExpression") return carriesProps(n.consequent, env, depth + 1) || carriesProps(n.alternate, env, depth + 1)
    if (n.type === "LogicalExpression") return (n.operator !== "&&" && carriesProps(n.left, env, depth + 1)) || carriesProps(n.right, env, depth + 1)
    if (isObject(n)) return n.properties.some((p: AnyNode) => (p.type === "SpreadElement" || p.type === "SpreadProperty") && carriesProps(p.argument, env, depth + 1))
    return false
}

// --- part maps ---------------------------------------------------------------------------------

/** The subset of a registry the part-map resolution reads. */
export interface PartMapRegistry {
    scopes: Record<string, { group?: string; namespace?: string; parts?: unknown }>
}

/**
 * A relative or absolute specifier (`./x`, `../x`, `/x`, `C:\x`) — never a part map: the tooling
 * recognizes part maps by their package specifier only (an app exposes its own generated maps under
 * an alias, docs/CONFIG.md).
 */
export const isRelativeSpecifier = (module: string): boolean => module.startsWith(".") || module.startsWith("/") || /^[A-Za-z]:[\\/]/.test(module)
const isRelative = isRelativeSpecifier

/**
 * A module of the importing file's own package: a relative or absolute path, or a subpath import
 * (`#components`, `#css` — the package.json `imports` field, which only ever maps into the package).
 * A subpath import can still be a part-map specifier (`partMaps: { "crm-accounts": "#css" }`).
 */
export const isOwnPackageSpecifier = (module: string): boolean => isRelativeSpecifier(module) || module.startsWith("#")

/**
 * Validates a `partMaps` option (Vite/Babel options, ESLint settings, `css.partMaps`): every value is a
 * package specifier. A relative or absolute path is never matched against an import (imports are
 * compared by specifier), so it would silently turn every part map of that group into a plain object —
 * no `_cxpart`, no part validation, root-part blind. Throws with the alias recipe instead.
 */
export function normalizePartMaps(partMaps: unknown, where = "partMaps"): PartMapModules | null {
    if (partMaps === undefined || partMaps === null) return null
    if (typeof partMaps !== "object" || Array.isArray(partMaps)) throw new Error(`libstylist: ${where} must be an object (css group → part-map module specifier)`)
    for (const [group, specifier] of Object.entries(partMaps as Record<string, unknown>)) {
        if (typeof specifier !== "string" || !specifier) throw new Error(`libstylist: ${where}.${group} must be a module specifier string`)
        if (isRelativeSpecifier(specifier)) {
            throw new Error(
                `libstylist: ${where}.${group} is the path "${specifier}" — part maps are recognized by their package specifier only. ` +
                    `Expose the generated part maps under one (a workspace css package, or an alias: resolve.alias "@app/styles" → parts.mjs, tsconfig paths "@app/styles" → parts.d.ts), ` +
                    `import them from it and set ${where}.${group} to that specifier (docs/CONFIG.md, "Part maps built inside an app")`,
            )
        }
    }
    return partMaps as PartMapModules
}

/**
 * The css groups a module specifier is the part map of — several when one module exports the maps of
 * several groups (an app package's `#css` serves both `crm-accounts` and `crm-accounts.render`; the
 * `#css` of every package of a workspace is one specifier): `undefined` when `partMaps` is not
 * configured (any package specifier may be one), `null` when it is configured and the specifier is not
 * in it. Groups keep the order of `partMaps`.
 */
export function partMapGroups(module: string, partMaps: PartMapModules | null | undefined): string[] | null | undefined {
    if (RUNTIME_MODULES.includes(module) || isRelative(module)) return null
    if (!partMaps) return undefined
    const groups = Object.entries(partMaps)
        .filter(([, specifier]) => specifier === module)
        .map(([group]) => group)
    return groups.length ? groups : null
}

/**
 * The first css group a module specifier is the part map of ({@link partMapGroups}): `undefined` when
 * `partMaps` is not configured, `null` when the specifier is not in it.
 */
export function partMapGroup(module: string, partMaps: PartMapModules | null | undefined): string | null | undefined {
    const groups = partMapGroups(module, partMaps)
    return groups ? groups[0] : groups
}

/** `playerControls` → `player-controls`, `switchClasses` → `switch` (without a registry to match against). */
export function scopeOfExportName(name: string): string {
    const base = name.endsWith("Classes") && name !== "Classes" ? name.slice(0, -"Classes".length) : name
    return base.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/**
 * The scope an imported part-map export stands for: the registry scope whose export name matches
 * (within the module's groups — one or several — when `partMaps` names them), or — without a registry
 * — the kebab-cased export name. `null` when a registry is given and no scope matches.
 */
export function scopeOfExport(name: string, registry: PartMapRegistry | null | undefined, group?: string | readonly string[] | null): string | null {
    if (!registry) return scopeOfExportName(name)
    const groups = (typeof group === "string" ? [group] : (group ?? [])).filter(Boolean)
    for (const [scope, info] of Object.entries(registry.scopes)) {
        if (groups.length && info.group !== undefined && !groups.includes(info.group)) continue
        if (exportName(scope) === name) return scope
    }
    return null
}

/**
 * Resolves an imported binding to a part map: `module` must be a part-map module (`partMaps`, or any
 * package specifier when unconfigured) and, when a registry is given, `exportName` must name one of
 * the scopes of its groups.
 */
export function resolvePartMap(
    local: string,
    imported: string,
    module: string,
    registry: PartMapRegistry | null | undefined,
    partMaps: PartMapModules | null | undefined,
): PartMapRef | null {
    const groups = partMapGroups(module, partMaps)
    if (groups === null) return null
    const scope = scopeOfExport(imported, registry, groups)
    if (registry && scope === null) return null
    return { local, exportName: imported, module, scope }
}

// --- the removed pragma --------------------------------------------------------------------------

const PRAGMA = /@cxScope\s+([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/

/** The scope named by a `@cxScope <id>` pragma among the comments (the removed syntax), or null. */
export function findScopePragma(comments: ReadonlyArray<{ value: string }> | undefined | null): string | null {
    for (const c of comments ?? []) {
        const m = PRAGMA.exec(c.value)
        if (m) return m[1]
    }
    return null
}
