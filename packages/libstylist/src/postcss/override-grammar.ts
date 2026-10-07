// The grammar of the override-sheet directives (SPEC §9.2) — `override <Target> from "<package>" [within
// <AppComponent>]` and `reset [<part> …]` — as pure parsers of a directive's words, shared by the PostCSS
// side (./directives.ts, which throws) and the stylelint rules (which report), so both read one grammar.
import { PART_RE } from "../conventions/index.js"
import { parseComponentRef, type ComponentRef } from "./refs.js"

export const OVERRIDE_GRAMMAR = "@stylist override <Component | sheet-id> from \"<package>\" [within <AppComponent>];"
export const RESET_GRAMMAR = "@stylist reset [<part> …];"

const PATH_RE = /^[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)*$/
/** A bare npm package name — scoped or not, never a subpath or a path. */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/

/** What an override sheet names: a design-system component (`Table.Tr`) or one of its sheets (`tooltip`). */
export type OverrideTargetRef = { kind: "component"; path: string } | { kind: "sheet"; scope: string }

export interface OverrideDirective {
    target: OverrideTargetRef
    /** The component package `from` names, without its quotes (`@livesession/eloquentui-react`). */
    from: string
    /** `within [ns/]Path`: the app component the override is scoped to; null for a global override. */
    within: ComponentRef | null
}

export interface ResetDirective {
    /** The parts reset; empty for the whole target sheet (`@stylist reset;`). */
    parts: string[]
}

/** A directive's words that don't parse: why (the callers add the directive and the grammar). */
export interface GrammarProblem {
    problem: string
}

/** Parses the words after `override`; returns the directive, or the problem. */
export function parseOverrideWords(rest: readonly string[]): OverrideDirective | GrammarProblem {
    const bad = (problem: string): GrammarProblem => ({ problem })
    const [target, fromKeyword, specifier, ...clauses] = rest
    if (!target) return bad("missing the component (or sheet id) it overrides")
    let ref: OverrideTargetRef
    if (PATH_RE.test(target)) ref = { kind: "component", path: target }
    else if (PART_RE.test(target)) ref = { kind: "sheet", scope: target }
    else return bad(`"${target}" is neither a component path (dotted PascalCase: "Table.Tr") nor a sheet id (kebab-case: "tooltip")`)
    if (fromKeyword !== "from") return bad(fromKeyword ? `"${fromKeyword}" where "from" belongs` : "missing `from \"<package>\"` (the package the app imports the component from)")
    if (!specifier) return bad("\"from\" needs the quoted package name")
    const quote = specifier[0]
    if ((quote !== "\"" && quote !== "'") || specifier.length < 2 || specifier[specifier.length - 1] !== quote) return bad(`the package is a quoted string: from "${specifier.replace(/^["']|["']$/g, "")}"`)
    const from = specifier.slice(1, -1)
    if (!PACKAGE_NAME_RE.test(from)) {
        const why = from.startsWith(".") || from.startsWith("/") ? "a path" : from.split("/").length > (from.startsWith("@") ? 2 : 1) ? "a subpath" : "not a package name"
        return bad(`"${from}" is ${why} — name the component package itself ("@livesession/eloquentui-react")`)
    }
    let within: ComponentRef | null = null
    if (clauses.length > 0) {
        if (clauses[0] !== "within") return bad(`unexpected "${clauses[0]}"`)
        if (clauses.length !== 2) return bad(clauses.length === 1 ? "\"within\" needs an app component ([ns/]ComponentPath)" : `unexpected "${clauses[2]}"`)
        try {
            within = parseComponentRef(clauses[1])
        } catch {
            return bad(`"within ${clauses[1]}" names no component — [ns/]ComponentPath, dotted PascalCase`)
        }
    }
    return { target: ref, from, within }
}

/** Parses the words after `reset` (part names, none for the whole sheet); returns the directive, or the problem. */
export function parseResetWords(rest: readonly string[]): ResetDirective | GrammarProblem {
    const bad = rest.find(p => !PART_RE.test(p))
    if (bad !== undefined) return { problem: `"${bad.replace(/^\./, "")}" is not a part name${bad.startsWith(".") ? " (write it without the dot)" : " (kebab-case)"}` }
    return { parts: [...rest] }
}

/** True for a parse result that is a problem. */
export const isGrammarProblem = (x: object): x is GrammarProblem => "problem" in x
