// Cross-sheet references inside selectors (SPEC §4.2 rules 2–3): `:component(ns/Path)` and
// `:cx(scope:part)`. postcss-selector-parser cannot parse `ns/Path` (it reads `/` as a
// combinator) and would read `Modal.Header` as a tag plus a class, so references are found and
// replaced on the raw selector string before any selector parsing.

const PART_SRC = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*"
const COMPONENT_REF_RE = /^(?:([a-z][a-z0-9]*)\/)?([A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*)$/
const CX_REF_RE = new RegExp(`^(${PART_SRC}):(${PART_SRC})$`)
const REF_NAMES = ["component", "cx"] as const

export type SelectorRefKind = (typeof REF_NAMES)[number]

export interface SelectorRef {
    kind: SelectorRefKind
    /** The argument as written, trimmed (`player/PlayerTopBar.Url`, `alert:icon`). */
    arg: string
    /** Offsets of the whole `:kind(arg)` in the selector string. */
    start: number
    end: number
}

export interface ComponentRef {
    /** Namespace named with `ns/Path`, or null for the sheet's own namespace. */
    namespace: string | null
    /** Dotted export path (`Modal.Header`). */
    path: string
}

export interface CxRef {
    scope: string
    part: string
}

/** Error raised for a malformed reference; `ref` points at the offending text. */
export class SelectorRefError extends Error {
    constructor(message: string, readonly ref?: SelectorRef) {
        super(message)
        this.name = "SelectorRefError"
    }
}

/**
 * Finds every `:component(…)` and `:cx(…)` in a selector (names are ASCII case-insensitive, like
 * every pseudo-class), skipping quoted strings and comments.
 */
export function scanRefs(selector: string): SelectorRef[] {
    const refs: SelectorRef[] = []
    let i = 0
    while (i < selector.length) {
        const ch = selector[i]
        if (ch === "\\") {
            i += 2
            continue
        }
        if (ch === "\"" || ch === "'") {
            i = skipString(selector, i)
            continue
        }
        if (ch === "/" && selector[i + 1] === "*") {
            const close = selector.indexOf("*/", i + 2)
            i = close < 0 ? selector.length : close + 2
            continue
        }
        if (ch === ":" && selector[i - 1] !== ":") {
            const kind = REF_NAMES.find(name => selector.slice(i + 1, i + 2 + name.length).toLowerCase() === `${name}(`)
            if (kind) {
                const open = i + 1 + kind.length
                const close = matchParen(selector, open)
                if (close < 0) throw new SelectorRefError(`unterminated :${kind}( in "${selector}"`)
                const arg = selector.slice(open + 1, close).trim()
                refs.push({ kind, arg, start: i, end: close + 1 })
                i = close + 1
                continue
            }
        }
        i++
    }
    return refs
}

/** Replaces every reference with the string `replace` returns (left to right). */
export function replaceRefs(selector: string, replace: (ref: SelectorRef) => string): string {
    const refs = scanRefs(selector)
    if (refs.length === 0) return selector
    let out = ""
    let last = 0
    for (const ref of refs) {
        out += selector.slice(last, ref.start) + replace(ref)
        last = ref.end
    }
    return out + selector.slice(last)
}

/** Parses a `:component()` argument: `Path` or `ns/Path`, `Path` dotted PascalCase. */
export function parseComponentRef(arg: string, ref?: SelectorRef): ComponentRef {
    const m = COMPONENT_REF_RE.exec(arg)
    if (!m) throw new SelectorRefError(`:component(${arg}) — expected ":component(Path)" or ":component(ns/Path)" with a dotted PascalCase path`, ref)
    return { namespace: m[1] ?? null, path: m[2] }
}

/** Parses a `:cx()` argument: `scope:part`, both kebab-case. */
export function parseCxRef(arg: string, ref?: SelectorRef): CxRef {
    const m = CX_REF_RE.exec(arg)
    if (!m) throw new SelectorRefError(`:cx(${arg}) — expected ":cx(scope:part)" with kebab-case scope and part`, ref)
    return { scope: m[1], part: m[2] }
}

function skipString(s: string, start: number): number {
    const quote = s[start]
    let i = start + 1
    while (i < s.length && s[i] !== quote) i += s[i] === "\\" ? 2 : 1
    return i + 1
}

/** The index of the `)` closing the `(` at `open`, skipping strings and escapes; -1 when unterminated. */
export function matchParen(s: string, open: number): number {
    let depth = 0
    let i = open
    while (i < s.length) {
        const ch = s[i]
        if (ch === "\\") {
            i += 2
            continue
        }
        if (ch === "\"" || ch === "'") {
            i = skipString(s, i)
            continue
        }
        if (ch === "(") depth++
        else if (ch === ")" && --depth === 0) return i
        i++
    }
    return -1
}
