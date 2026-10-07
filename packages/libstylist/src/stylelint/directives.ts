// Grammar of the `@stylist` sheet directives (SPEC §4.1; an override sheet's `override` and `reset`,
// SPEC §9.2, through the PostCSS side's parsers) and of the libstylist pseudo-class arguments
// (SPEC §4.2): pure parsers shared by the stylelint rules.
import { PART_RE, PREFIX_RE } from "../conventions/index.js"
import { OVERRIDE_GRAMMAR, RESET_GRAMMAR, isGrammarProblem, parseOverrideWords, parseResetWords, type OverrideTargetRef } from "../postcss/override-grammar.js"

/** Dotted PascalCase export path: `Alert`, `Modal.Header`, `ListCollection.Root`. */
export const COMPONENT_PATH_RE = /^[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)*$/

/** Single-keyword `display` values a root directive may declare. */
export const DISPLAY_KEYWORDS: readonly string[] = [
    "block",
    "contents",
    "flex",
    "flow-root",
    "grid",
    "inline",
    "inline-block",
    "inline-flex",
    "inline-grid",
    "inline-table",
    "list-item",
    "none",
    "table",
    "table-caption",
    "table-cell",
    "table-column",
    "table-column-group",
    "table-footer-group",
    "table-header-group",
    "table-row",
    "table-row-group",
]

export type StylistDirective =
    | { kind: "root"; path: string; local: string; display: string | null }
    | { kind: "scope"; id: string }
    /** An override sheet's target (SPEC §9.2): `within` as written (`render/RenderCart`), or null. */
    | { kind: "override"; target: OverrideTargetRef; from: string; within: string | null }
    /** An override sheet's reset: the parts, none for the whole target sheet. */
    | { kind: "reset"; parts: string[] }

export type DirectiveParse = { ok: true; directive: StylistDirective } | { ok: false; error: string }

const ROOT_USAGE = "@stylist root <ComponentPath> [as <local>] [display <keyword>]"
const SCOPE_USAGE = "@stylist scope <id>"

const fail = (error: string): DirectiveParse => ({ ok: false, error })

/**
 * Parses the params of an `@stylist` at-rule:
 * `root <ComponentPath> [as <local>] [display <keyword>]` or `scope <id>` in a package sheet,
 * `override <Target> from "<package>" [within <AppComponent>]` or `reset [<part> …]` in an override sheet.
 */
export function parseStylistDirective(params: string): DirectiveParse {
    const tokens = params.trim().split(/\s+/).filter(Boolean)
    const [kind, ...rest] = tokens
    if (!kind) return fail(`expected "${ROOT_USAGE}" or "${SCOPE_USAGE}"`)
    if (kind === "override") {
        const parsed = parseOverrideWords(rest)
        if (isGrammarProblem(parsed)) return fail(`${parsed.problem} — expected "${OVERRIDE_GRAMMAR.replace(/;$/, "")}"`)
        const within = parsed.within ? `${parsed.within.namespace ? `${parsed.within.namespace}/` : ""}${parsed.within.path}` : null
        return { ok: true, directive: { kind: "override", target: parsed.target, from: parsed.from, within } }
    }
    if (kind === "reset") {
        const parsed = parseResetWords(rest)
        if (isGrammarProblem(parsed)) return fail(`${parsed.problem} — expected "${RESET_GRAMMAR.replace(/;$/, "")}"`)
        return { ok: true, directive: { kind: "reset", parts: parsed.parts } }
    }
    if (kind === "scope") {
        if (rest.length !== 1) return fail(`expected "${SCOPE_USAGE}"`)
        if (!PART_RE.test(rest[0])) return fail(`scope id "${rest[0]}" must be kebab-case (${PART_RE})`)
        return { ok: true, directive: { kind: "scope", id: rest[0] } }
    }
    if (kind !== "root") return fail(`unknown directive "${kind}" — expected "${ROOT_USAGE}" or "${SCOPE_USAGE}" (an override sheet: "${OVERRIDE_GRAMMAR.replace(/;$/, "")}", "${RESET_GRAMMAR.replace(/;$/, "")}")`)
    const [path, ...clauses] = rest
    if (!path) return fail(`missing component path — expected "${ROOT_USAGE}"`)
    if (!COMPONENT_PATH_RE.test(path)) return fail(`"${path}" is not a component path (dotted PascalCase export path, e.g. "Modal.Header")`)
    let local = "root"
    let display: string | null = null
    let i = 0
    if (clauses[i] === "as") {
        const value = clauses[i + 1]
        if (!value) return fail(`"as" needs a local class name — expected "${ROOT_USAGE}"`)
        if (!PART_RE.test(value)) return fail(`local "${value}" must be a kebab-case part name, written without the dot`)
        local = value
        i += 2
    }
    if (clauses[i] === "display") {
        const value = clauses[i + 1]
        if (!value) return fail(`"display" needs a keyword — expected "${ROOT_USAGE}"`)
        if (!DISPLAY_KEYWORDS.includes(value)) return fail(`"${value}" is not a single-keyword display value (${DISPLAY_KEYWORDS.join(", ")})`)
        display = value
        i += 2
    }
    if (i < clauses.length) {
        const extra = clauses[i]
        if (extra === "as" && display !== null) return fail(`"as" must come before "display" — expected "${ROOT_USAGE}"`)
        if (extra === "as" || extra === "display") return fail(`duplicate "${extra}" clause — expected "${ROOT_USAGE}"`)
        return fail(`unexpected "${extra}" — expected "${ROOT_USAGE}"`)
    }
    return { ok: true, directive: { kind: "root", path, local, display } }
}

/** Result of validating a libstylist pseudo-class argument: null when valid, else the reason. */
export type ArgCheck = string | null

/** `:component(Path)` / `:component(ns/Path)` (SPEC §4.2 rule 2). */
export function checkComponentArg(arg: string): ArgCheck {
    const value = arg.trim()
    if (!value) return "needs a component path, e.g. \":component(Tabs)\" or \":component(player/ControlsBar)\""
    const slash = value.indexOf("/")
    const ns = slash >= 0 ? value.slice(0, slash) : null
    const path = slash >= 0 ? value.slice(slash + 1) : value
    if (ns !== null && !PREFIX_RE.test(ns)) return `"${ns}" is not a namespace (${PREFIX_RE})`
    if (!COMPONENT_PATH_RE.test(path)) return `"${path}" is not a component path (dotted PascalCase export path, e.g. "Modal.Header")`
    return null
}

/** `:cx(scope:part)` (SPEC §4.2 rule 3); `ownScope` flags refs that should be a local class. */
export function checkCxArg(arg: string, ownScope?: string | null): ArgCheck {
    const value = arg.trim()
    if (!value) return "needs a qualified part, e.g. \":cx(player-controls:button)\""
    const colon = value.indexOf(":")
    if (colon < 0) return PART_RE.test(value) ? `a part of this sheet is written ".${value}"; ":cx()" takes "scope:part"` : `expected "scope:part"`
    const scope = value.slice(0, colon)
    const part = value.slice(colon + 1)
    if (!PART_RE.test(scope)) return `scope "${scope}" must be kebab-case`
    if (!PART_RE.test(part)) return `part "${part}" must be kebab-case`
    if (ownScope && scope === ownScope) return `"${value}" is a part of this sheet — write ".${part}"`
    return null
}

/** Splits a selector list on top-level commas (outside parens, brackets and strings). */
export function splitTopLevelCommas(text: string): string[] {
    const parts: string[] = []
    let depth = 0
    let from = 0
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === "\\") {
            i++
            continue
        }
        if (ch === "\"" || ch === "'") {
            const close = text.indexOf(ch, i + 1)
            i = close < 0 ? text.length : close
            continue
        }
        if (ch === "(" || ch === "[") depth++
        else if (ch === ")" || ch === "]") depth--
        else if (ch === "," && depth === 0) {
            parts.push(text.slice(from, i))
            from = i + 1
        }
    }
    parts.push(text.slice(from))
    return parts
}

/** `:global(x)` takes exactly one selector (SPEC §4.2 rule 4). */
export function checkGlobalArg(arg: string): ArgCheck {
    if (!arg.trim()) return "needs a selector"
    const parts = splitTopLevelCommas(arg)
    if (parts.length > 1) return "takes exactly one selector — split the list into separate \":global()\" calls"
    return null
}
