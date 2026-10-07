// `@stylist` directives. Package sheets (SPEC §4.1): `@stylist root <ComponentPath> [as <local>]
// [display <kw>];` and `@stylist scope <id>;`, shared by collectSheet (reports) and the plugin (throws,
// removes). Override sheets (SPEC §9.2): `@stylist override <Target> from "<package>" [within
// <AppComponent>];` then `@stylist reset [<part> …];`, read by collectOverrideSheet and stylistOverride().
import type { AtRule, ChildNode, Root } from "postcss"

import { PART_RE } from "../conventions/index.js"
import { DISPLAY_KEYWORDS } from "../stylelint/directives.js"
import { OVERRIDE_GRAMMAR, RESET_GRAMMAR, isGrammarProblem, parseOverrideWords, parseResetWords, type OverrideDirective, type ResetDirective } from "./override-grammar.js"

export { OVERRIDE_GRAMMAR, RESET_GRAMMAR }
export type { OverrideDirective, OverrideTargetRef, ResetDirective } from "./override-grammar.js"

export const DIRECTIVE_NAME = "stylist"

const PATH_RE = /^[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)*$/
/** At-rule names are ASCII case-insensitive: `@STYLIST root …` is a directive too. */
const DIRECTIVE_RE = new RegExp(`^${DIRECTIVE_NAME}$`, "i")
const ROOT_GRAMMAR = "@stylist root <ComponentPath> [as <local>] [display <keyword>];"
const SCOPE_GRAMMAR = "@stylist scope <id>;"

export interface RootDirective {
    /** Dotted export path of the component (`Modal.Header`). */
    component: string
    /** The local class bound to its identity element; `root` by default. */
    local: string
    /** Default `display` for the custom tag (custom elements are `inline` otherwise). */
    display?: string
}

export type StylistDirective =
    | ({ kind: "root" } & RootDirective)
    | { kind: "scope"; scope: string }
    | ({ kind: "override" } & OverrideDirective)
    | ({ kind: "reset" } & ResetDirective)

/** A malformed or misplaced `@stylist` directive. */
export class DirectiveError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "DirectiveError"
    }
}

/** Parses the params of one `@stylist` at-rule. Throws `DirectiveError` on bad grammar. */
export function parseDirective(params: string): StylistDirective {
    const [verb, ...rest] = params.trim().split(/\s+/).filter(Boolean)
    const written = `@stylist ${params.trim()}`
    if (verb === "scope") {
        if (rest.length !== 1 || !PART_RE.test(rest[0])) throw new DirectiveError(`invalid directive "${written}" — expected ${SCOPE_GRAMMAR} with a kebab-case id`)
        return { kind: "scope", scope: rest[0] }
    }
    if (verb === "root") {
        const [component, ...clauses] = rest
        if (!component || !PATH_RE.test(component)) throw new DirectiveError(`invalid directive "${written}" — expected ${ROOT_GRAMMAR} with a dotted PascalCase path`)
        const directive: { kind: "root" } & RootDirective = { kind: "root", component, local: "root" }
        let i = 0
        if (clauses[i] === "as") {
            const local = clauses[i + 1]
            if (!local || !PART_RE.test(local)) throw new DirectiveError(`invalid directive "${written}" — "as" needs a kebab-case local class name`)
            directive.local = local
            i += 2
        }
        if (clauses[i] === "display") {
            const display = clauses[i + 1]
            if (!display || !DISPLAY_KEYWORDS.includes(display)) throw new DirectiveError(`invalid directive "${written}" — "display" needs a keyword, one of: ${DISPLAY_KEYWORDS.join(", ")}`)
            directive.display = display
            i += 2
        }
        if (i !== clauses.length) throw new DirectiveError(`invalid directive "${written}" — expected ${ROOT_GRAMMAR}`)
        return directive
    }
    if (verb === "override") {
        const parsed = parseOverrideWords(rest)
        if (isGrammarProblem(parsed)) throw new DirectiveError(`invalid directive "${written}" — ${parsed.problem}; expected ${OVERRIDE_GRAMMAR}`)
        return { kind: "override", ...parsed }
    }
    if (verb === "reset") {
        const parsed = parseResetWords(rest)
        if (isGrammarProblem(parsed)) throw new DirectiveError(`invalid directive "${written}" — ${parsed.problem}; expected ${RESET_GRAMMAR}`)
        return { kind: "reset", ...parsed }
    }
    throw new DirectiveError(`unknown directive "${written}" — expected ${ROOT_GRAMMAR} or ${SCOPE_GRAMMAR} in a package sheet, ${OVERRIDE_GRAMMAR} and ${RESET_GRAMMAR} in an override sheet`)
}

export interface DirectiveIssue {
    message: string
    node: AtRule
}

export interface SheetDirectives {
    /** The pinned scope, when the sheet has `@stylist scope`. */
    scope?: string
    roots: Array<RootDirective & { node: AtRule }>
    /** Every `@stylist` at-rule, valid or not (the plugin removes them all). */
    nodes: AtRule[]
    errors: DirectiveIssue[]
}

/** The placement problem of a `@stylist` at-rule (it must be a top-level statement), or null. */
function placementProblem(node: AtRule): string | null {
    if (node.parent?.type !== "root") return "@stylist directives must be top-level statements"
    if (node.nodes !== undefined) return "@stylist directives are statements ending with \";\", not blocks"
    return null
}

/** Reads and validates every `@stylist` at-rule of a package sheet: placement, grammar and duplicates. */
export function readDirectives(root: Root): SheetDirectives {
    const out: SheetDirectives = { roots: [], nodes: [], errors: [] }
    root.walkAtRules(DIRECTIVE_RE, node => {
        out.nodes.push(node)
        const placement = placementProblem(node)
        if (placement) {
            out.errors.push({ message: placement, node })
            return
        }
        let directive: StylistDirective
        try {
            directive = parseDirective(node.params)
        } catch (err) {
            out.errors.push({ message: (err as Error).message, node })
            return
        }
        if (directive.kind === "override" || directive.kind === "reset") {
            out.errors.push({
                message: `@stylist ${directive.kind} belongs in an override sheet (the workspace's css.overrides.dir) — a package sheet styles its own components (${ROOT_GRAMMAR})`,
                node,
            })
            return
        }
        if (directive.kind === "scope") {
            if (out.scope !== undefined) out.errors.push({ message: `duplicate @stylist scope ("${out.scope}" and "${directive.scope}")`, node })
            else out.scope = directive.scope
            return
        }
        if (out.roots.some(r => r.component === directive.component)) {
            out.errors.push({ message: `duplicate @stylist root for ${directive.component}`, node })
            return
        }
        const { component, local, display } = directive
        out.roots.push({ component, local, ...(display ? { display } : {}), node })
    })
    return out
}

export interface OverrideDirectiveIssue {
    message: string
    /** The directive at fault, or the sheet (no `@stylist override` at all). */
    node: AtRule | Root
}

export interface OverrideDirectives {
    /** The sheet's `@stylist override`, or null when it has none (an error). */
    override: (OverrideDirective & { node: AtRule }) | null
    /** Every `@stylist reset`, in order (`parts` empty: the whole target sheet). */
    resets: Array<ResetDirective & { node: AtRule }>
    /** Every `@stylist` at-rule, valid or not (the plugin removes them all). */
    nodes: AtRule[]
    errors: OverrideDirectiveIssue[]
}

/** Nodes an override sheet may have before its directives: comments and `@charset`. */
const isPreamble = (node: ChildNode): boolean => node.type === "comment" || (node.type === "atrule" && (node.name.toLowerCase() === "charset" || DIRECTIVE_RE.test(node.name)))

/**
 * Reads and validates the `@stylist` at-rules of an override sheet (SPEC §9.2): exactly one
 * `@stylist override`, first, then any number of `@stylist reset`, all before the first rule — no
 * `root`/`scope` (an override sheet declares no component of its own), no part reset twice, no whole
 * reset next to another reset. A sheet without `@stylist override` is an error unless
 * `requireOverride` is false (the compiler, whose options already say what the sheet overrides).
 * Never throws.
 */
export function readOverrideDirectives(root: Root, { requireOverride = true }: { requireOverride?: boolean } = {}): OverrideDirectives {
    const out: OverrideDirectives = { override: null, resets: [], nodes: [], errors: [] }
    const firstContent = root.nodes.find(n => !isPreamble(n))
    const contentIndex = firstContent ? root.index(firstContent) : Infinity
    const resetParts = new Set<string>()
    let whole: AtRule | null = null
    let parsed = 0
    root.walkAtRules(DIRECTIVE_RE, node => {
        out.nodes.push(node)
        const placement = placementProblem(node)
        if (placement) {
            const nestedReset = node.parent?.type === "rule" && /^reset\b/.test(node.params.trim())
            out.errors.push({ message: nestedReset ? `${placement} — a part reset names the part at the top of the sheet: @stylist reset <part>;` : placement, node })
            return
        }
        if (root.index(node) > contentIndex) {
            out.errors.push({ message: "@stylist directives come first in an override sheet, before any rule", node })
            return
        }
        let directive: StylistDirective
        try {
            directive = parseDirective(node.params)
        } catch (err) {
            out.errors.push({ message: (err as Error).message, node })
            return
        }
        parsed++
        if (directive.kind === "root" || directive.kind === "scope") {
            out.errors.push({ message: `@stylist ${directive.kind} in an override sheet — an override sheet declares no component of its own; it restyles the one its @stylist override names`, node })
            return
        }
        if (directive.kind === "override") {
            if (out.override) out.errors.push({ message: "an override sheet has one @stylist override — one sheet per design-system component (or sheet)", node })
            else if (parsed > 1) out.errors.push({ message: `@stylist override comes first in an override sheet — ${OVERRIDE_GRAMMAR}`, node })
            else out.override = { target: directive.target, from: directive.from, within: directive.within, node }
            return
        }
        if (!out.override && (requireOverride || out.nodes.some(n => n !== node && /^override\b/.test(n.params.trim())))) {
            out.errors.push({ message: `@stylist reset before @stylist override — the sheet starts with ${OVERRIDE_GRAMMAR}`, node })
            return
        }
        if (directive.parts.length === 0) {
            if (whole || resetParts.size > 0) {
                out.errors.push({ message: whole ? "duplicate @stylist reset;" : "@stylist reset; resets the whole target sheet — drop the part resets next to it", node })
                return
            }
            whole = node
        } else {
            if (whole) {
                out.errors.push({ message: "the whole target sheet is reset already (@stylist reset;) — drop this part reset", node })
                return
            }
            const twice = directive.parts.find((p, i) => resetParts.has(p) || directive.parts.indexOf(p) !== i)
            if (twice !== undefined) {
                out.errors.push({ message: `part "${twice}" is reset twice`, node })
                return
            }
            for (const p of directive.parts) resetParts.add(p)
        }
        out.resets.push({ parts: directive.parts, node })
    })
    if (requireOverride && !out.override && out.errors.length === 0) {
        out.errors.push({ message: `an override sheet starts with ${OVERRIDE_GRAMMAR}`, node: root })
    }
    return out
}
