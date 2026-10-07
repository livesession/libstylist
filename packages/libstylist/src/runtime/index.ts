// The libstylist runtime (SPEC §6): `cx()` and the helpers the transform references. No
// dependencies; bundled per consumer from a virtual module by the Vite plugin.

type Props = Record<string, unknown>

// Read only when a bundler or Node provides it; declared here so the runtime needs no Node types.
declare const process: { env: { NODE_ENV?: string } }

const PART = /^_cxclass_/
const MARKER = /^[a-z][a-z0-9]*-[a-z0-9-]+$/
const DATA_ARIA = /^(data|aria)-/
/** Shared by every copy of the runtime (the Vite plugin bundles one per library build). */
const DATA = Symbol.for("libstylist.cxData")

/**
 * What `cx()` returns and a named slot prop (`inputCx`) carries: part attributes and identity markers
 * (`{ "_cxclass_elo-or4d4l": "", "elo-modalconfirm": "" }`) plus the element's `data-*` attributes.
 * Spread it onto an intrinsic element, a custom tag or a design-system component: every key is
 * hyphenated, so it never collides with a declared prop.
 */
export type CxAttrs = { readonly [attr: `${string}-${string}`]: "" }

/** An inline data literal as written in a `cx()` call: each key becomes `data-<kebab(key)>`. */
export type CxDataRecord = Record<string, string | number | boolean | null | undefined>

/** A data literal branded by the transform (`cxData({ … })`) — rendered as data attributes, never forwarded. */
export interface CxData {
    readonly [DATA]: CxDataRecord
}

/**
 * One `cx()` argument: a part attribute name (a part-map member, `cn.icon`), an object — the props or
 * slot object whose markers and parts are forwarded (`rest`, `inputCx`, another `cx()` result), or an
 * inline data literal (`{ size, open }`) — or nothing (`undefined`, `null`, `false`: an unset slot).
 * TypeScript can't tell a data literal from a props object; the ESLint rules can.
 */
export type CxArg = string | false | null | undefined | CxData | CxDataRecord | object

/**
 * Brands an inline data literal of a `cx()` call. The transform (Babel/Vite plugin) wraps every inline
 * object-literal argument of a runtime `cx()` call in it; authors never call it.
 */
export function cxData(data: CxDataRecord): CxData {
    compiled = true
    return { [DATA]: data }
}

/**
 * Marks this copy of the runtime as serving plugin-compiled code. The transform emits one call at the
 * top of every module with a runtime `cx()` call, so it runs when the module loads, before any render;
 * authors never call it.
 */
export function cxCompiled(): void {
    compiled = true
}

let warned = false
/** A plugin-compiled module was loaded (or a branded literal seen): its data literals are branded, so the heuristic is off. */
let compiled = false

/** A key `cx()` forwards from a props object (`addForwarded`): a part attribute, or a marker that is not `data-*`/`aria-*`, valued `""`. */
const isForwardable = (k: string, v: unknown): boolean => v === "" && (PART.test(k) || (MARKER.test(k) && !DATA_ARIA.test(k)))

/**
 * In development, warns once about an unbranded plain object with only primitive values and no
 * forwardable key — the signature of a data literal compiled without the plugin (it is then forwarded
 * as props and renders nothing). Silent once a plugin-compiled module was loaded by this copy of the
 * runtime, so a props object of primitives (`{ id }`) in a compiled build never trips it. Runs in
 * browsers too: only a known production `NODE_ENV` (bundlers replace the expression) turns it off.
 */
function warnUnbranded(obj: Props): void {
    if (warned || compiled) return
    let env: string | undefined
    try {
        env = process.env.NODE_ENV
    } catch {
        env = undefined // no bundler replacement and no Node `process`: a development page
    }
    if (env === "production") return
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) return
    let keys = 0
    for (const k in obj) {
        const v = obj[k]
        if (v !== null && typeof v === "object") return
        if (typeof v === "function" || typeof v === "symbol") return
        if (isForwardable(k, v)) return
        keys++
    }
    if (keys === 0) return
    warned = true
    console.warn(
        `[libstylist] cx() received a plain object with only primitive values and no markers or parts (${Object.keys(obj).join(", ")}). ` +
            "If it is an inline data literal, this file was compiled without the libstylist Babel/Vite plugin, which brands data literals — " +
            "without it the object is treated as props and no data-* attribute is rendered. Add the plugin to the build (docs/CONFIG.md).",
    )
}

function addData(out: Record<string, string>, data: CxDataRecord): void {
    for (const key in data) {
        const v = data[key]
        if (v === undefined || v === null || v === false) continue
        out[`data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = v === true ? "true" : String(v)
    }
}

function addForwarded(out: Record<string, string>, props: Props): void {
    for (const k in props) {
        if (props[k] !== "") continue
        if (PART.test(k) || (MARKER.test(k) && !DATA_ARIA.test(k))) out[k] = ""
    }
}

/**
 * The attributes of one element (SPEC §6): every string argument is a part attribute
 * (`{ [attr]: "" }`); every data literal renders as `data-*` attributes (`hasTitle: true` →
 * `data-has-title="true"`; a number → its string; `false`, `null`, `undefined` → omitted); every
 * other object (props, a slot, another `cx()` result) contributes its identity markers and part
 * attributes (keys `^_cxclass_` or `<prefix>-…` whose value is `""`, never `data-*`/`aria-*`).
 * `undefined`, `null` and `false` add nothing. Returns a fresh object.
 *
 *     <elo-alert {...cx(cn.root, rest, { variant, hasTitle })}>
 */
export function cx(...args: CxArg[]): CxAttrs {
    const out: Record<string, string> = {}
    for (const arg of args) {
        if (!arg) continue
        if (typeof arg === "string") out[arg] = ""
        else if (typeof arg === "object") {
            const data = (arg as Partial<CxData>)[DATA]
            if (data) addData(out, data)
            else {
                warnUnbranded(arg as Props)
                addForwarded(out, arg as Props)
            }
        }
    }
    return out as CxAttrs
}

/**
 * `props` without the identity markers and part attributes `cx(props)` forwards — for a component whose
 * identity element (the root) takes them while its remaining props spread onto an inner element (a text
 * field's native `<input>`), so a caller's parts land on the root only:
 *
 *     <elo-textinput {...cx(cn.root, rest)}><input {...withoutStylist(rest)} /></elo-textinput>
 */
export function withoutStylist<T extends object>(props: T): T {
    const forwarded: object = cx(props)
    const out: Record<string, unknown> = {}
    for (const key in props) {
        if (!(key in forwarded)) out[key] = (props as Record<string, unknown>)[key]
    }
    return out as T
}

/** Normalizes a boolean `true` to `"true"` so custom elements serialize like native ones did. */
export function cxAttr<T>(v: T): T | "true" {
    return (v as unknown) === true ? "true" : v
}

/** Copy of `props` with boolean `data-*`/`aria-*` values normalized — spreads onto custom tags. */
export function hostProps<T extends Props>(props: T | null | undefined): T {
    const out: Props = {}
    if (!props) return out as T
    for (const k in props) {
        const v = props[k]
        out[k] = DATA_ARIA.test(k) && v === true ? "true" : v
    }
    return out as T
}

/**
 * Temporary pass-through of a caller's class name (`className`, `inputClassName`, …) while that caller
 * has not migrated yet: a flipped component keeps accepting the prop so the migration can go
 * component by component with zero visual change. Counted by lint separately from `legacy()`; the
 * final migration state has none (the public `*ClassName` props are removed).
 */
export function legacyClassName(value: string | false | null | undefined): string | undefined {
    return value || undefined
}

/**
 * Temporary, greppable escape hatch for literal class hooks that other (not yet migrated)
 * stylesheets still target during the migration. Joins truthy names; lint counts every use and the
 * final migration state has none.
 */
export function legacy(...names: Array<string | false | null | undefined>): string | undefined {
    const joined = names.filter(Boolean).join(" ")
    return joined || undefined
}

const unsetters = new Map<string, (node: Element | null) => void>()

/**
 * A ref for a custom tag whose DOM-property props may become unset. React 19 writes such props
 * (`title`, `id`, `tabIndex`, …) through the element's property, so dropping one assigns
 * `el.title = undefined` and leaves `title="undefined"` (`tabindex="0"` for tabIndex) where a
 * native element had the attribute removed. Returns undefined while every value is set, otherwise
 * a stable callback (per set of unset names) that removes the unset attributes in the commit that
 * unset them, before paint. React 18, SSR and first renders never need it.
 *
 *     <elo-player-time tabIndex={tabIndex} ref={unsetRef({ tabIndex })}>
 */
export function unsetRef(props: Record<string, unknown>): ((node: Element | null) => void) | undefined {
    const unset: string[] = []
    for (const k in props) if (props[k] == null) unset.push(k.toLowerCase())
    if (unset.length === 0) return undefined
    const key = unset.sort().join(" ")
    let remove = unsetters.get(key)
    if (!remove) {
        remove = (node) => {
            if (node) for (const name of unset) node.removeAttribute(name)
        }
        unsetters.set(key, remove)
    }
    return remove
}
