// Build-time reset (SPEC §9.5): an override sheet's `@stylist reset` edits the design system's
// stylesheets as the app bundles them — the declarations of every rule whose subject (the last
// compound) is a reset part are removed, except custom properties. A runtime `revert-layer` can only
// roll back to the layers below the override layer (the design system itself), and `all: revert` rolls
// back to the user agent (custom tags turn `inline`, buttons get their UA padding and border back, the
// design system's reset layer is gone): only removing the design system's own declarations is exact.
// Kept by construction: custom properties, the display defaults and every other rule whose subject is
// a component's identity (another component's `:component()` contract for it), rules for descendants,
// `@keyframes`, and the `reset`/`tokens` layers. A rule listing the reset part next to other elements
// keeps them: its selector list is split, and a reset part inside `:is()` is excluded with
// `:where(:not([attr]))` — no specificity change.
import postcss, { type AtRule, type Container, type Declaration, type Node, type Plugin, type Root, type Rule } from "postcss"
import selectorParser from "postcss-selector-parser"

import { isInsideKeyframes } from "./keyframes.js"
import { preludeSelectors } from "./selectors.js"

export const RESET_PLUGIN_NAME = "libstylist-reset"

/** One part of a design-system sheet whose declarations a reset strips. */
export interface ResetTarget {
    /** The design system's prefix (`elo`). */
    prefix: string
    namespace: string
    /** The target sheet: its registry scope. */
    scope: string
    part: string
    /** The part attribute (`_cxclass_elo-wj11dj`). */
    attr: string
    /** `<prefix>:<namespace>/<scope>:<part>` — `elo:core/button:loader`. */
    label: string
    /**
     * The identity tag of the component whose root this part is (`Table.Td`'s `td` → `elo-table-td`),
     * or null. Other components' rules on that identity are reported, and an override rule on `.root`
     * acknowledges a dropped layout declaration.
     */
    tag: string | null
    /** The override sheet that resets it (as reports print it) and the directive's line. */
    sheet: string
    line?: number
    /**
     * True when it comes from a whole reset (`@stylist reset;`): a part with no rule of its own is then
     * no error — only a whole reset that drops nothing for any part is.
     */
    whole?: boolean
}

// ─── subject classification ─────────────────────────────────────────────────────────────────────

/** How a complex selector's subject relates to a set of targets: always one, sometimes one, never. */
export type SubjectMatch = "all" | "some" | "none"

export interface SubjectClass {
    match: SubjectMatch
    /** The target names the subject mentions (the reset attributes to guard for `some`), sorted. */
    names: string[]
}

/** Returns the target name a simple selector is, or null. */
export type SubjectMatcher = (node: selectorParser.Node) => string | null

const IN_PLACE = new Set([":is", ":where", ":matches", ":-webkit-any", ":-moz-any"])
const SUBJECT_FILTERS = new Set([":nth-child", ":nth-last-child"])
const LEGACY_PSEUDO_ELEMENTS = new Set([":before", ":after", ":first-line", ":first-letter"])
const NONE: SubjectClass = { match: "none", names: [] }

const isPseudoElement = (n: selectorParser.Node): boolean => n.type === "pseudo" && (n.value.startsWith("::") || LEGACY_PSEUDO_ELEMENTS.has(n.value.toLowerCase()))

/** The subject compound of a complex selector: its simple selectors after the last combinator. */
export function subjectCompound(complex: selectorParser.Selector): selectorParser.Node[] {
    const out: selectorParser.Node[] = []
    for (const n of complex.nodes) {
        if (n.type === "combinator") out.length = 0
        else if (n.type !== "comment") out.push(n)
    }
    return out
}

/** The attributes a reset guard `:where(:not([a],[b]))` excludes, or null when `n` is not one. */
function guardNames(n: selectorParser.Node): string[] | null {
    if (n.type !== "pseudo" || n.value.toLowerCase() !== ":where" || n.nodes.length !== 1) return null
    const inner = n.nodes[0].nodes.filter(x => x.type !== "comment")
    if (inner.length !== 1 || inner[0].type !== "pseudo" || inner[0].value.toLowerCase() !== ":not") return null
    const names: string[] = []
    for (const arg of inner[0].nodes) {
        const simple = arg.nodes.filter(x => x.type !== "comment")
        if (simple.length !== 1 || simple[0].type !== "attribute" || simple[0].value !== undefined) return null
        names.push(simple[0].attribute.toLowerCase())
    }
    return names
}

/** The selector list of `:nth-child(An+B of S)`, or null without `of`. */
export function ofSelectors(n: selectorParser.Pseudo): selectorParser.Root | null {
    const text = n.nodes.map(String).join(",")
    const of = /(?:^|\s)of\s+([\s\S]+)$/i.exec(text)
    if (!of) return null
    try {
        return selectorParser().astSync(of[1])
    } catch {
        return null
    }
}

const sortedNames = (names: Iterable<string>): string[] => [...new Set(names)].sort()

/**
 * Classifies a subject compound against `match` (SPEC §9.5): **all** when a top-level simple selector
 * is a target, or an in-place pseudo-class (`:is`, `:where`, `:matches`, `:-webkit-any`, `:-moz-any`)
 * has only arguments whose subjects are **all**; **some** when an in-place pseudo-class or a subject
 * filter (`:nth-child(… of S)`, `:nth-last-child(… of S)`) has an argument whose subject is **all** or
 * **some** — a subject filter counts siblings, so it is never **all**; **none** otherwise. `:not()`,
 * `:has()`, `:host*` and ancestor compounds never count, and a reset guard (`:where(:not([a]))`)
 * already excludes what it names, so a guarded subject is **none** (the reset is idempotent). `scope`
 * stands for `:scope` and `&` (a rule inside `@scope`): the classification of the scope's start.
 */
export function classifySubject(compound: readonly selectorParser.Node[], match: SubjectMatcher, scope: SubjectClass | null = null): SubjectClass {
    const names = new Set<string>()
    const guarded = new Set<string>()
    let all = false
    let some = false
    const argument = (arg: selectorParser.Selector) => classifySubject(subjectCompound(arg), match, scope)
    for (const n of compound) {
        const hit = match(n)
        if (hit !== null) {
            all = true
            names.add(hit)
            continue
        }
        if (scope && (n.type === "nesting" || (n.type === "pseudo" && n.value.toLowerCase() === ":scope"))) {
            if (scope.match === "all") all = true
            else if (scope.match === "some") some = true
            for (const name of scope.names) names.add(name)
            continue
        }
        if (n.type !== "pseudo") continue
        const guard = guardNames(n)
        if (guard) {
            for (const name of guard) guarded.add(name)
            continue
        }
        const name = n.value.toLowerCase()
        let results: SubjectClass[] = []
        if (IN_PLACE.has(name)) {
            results = n.nodes.map(argument)
            if (results.length > 0 && results.every(r => r.match === "all")) all = true
            else if (results.some(r => r.match !== "none")) some = true
        } else if (SUBJECT_FILTERS.has(name)) {
            results = ofSelectors(n)?.nodes.map(argument) ?? []
            if (results.some(r => r.match !== "none")) some = true
        }
        for (const r of results) for (const x of r.names) names.add(x)
    }
    if (all) return { match: "all", names: sortedNames(names) }
    if (!some) return NONE
    const left = [...names].filter(x => !guarded.has(x))
    return left.length > 0 ? { match: "some", names: sortedNames(left) } : NONE
}

/** A matcher for value-less (or valued) attribute selectors named in `attrs`. */
export const attributeMatcher = (attrs: Iterable<string>): SubjectMatcher => {
    const set = new Set([...attrs].map(a => a.toLowerCase()))
    return n => (n.type === "attribute" && set.has(n.attribute.toLowerCase()) ? n.attribute.toLowerCase() : null)
}

/** A matcher for an identity: its custom tag or its marker attribute (`:is(tag,[tag])` has both). */
export const identityMatcher = (tag: string): SubjectMatcher => {
    const t = tag.toLowerCase()
    return n => ((n.type === "tag" || n.type === "attribute") && (n.type === "tag" ? n.value : n.attribute).toLowerCase() === t ? t : null)
}

/** The guard that excludes elements carrying `attrs` from a subject: `:where(:not([a],[b]))`, (0,0,0). */
export const resetGuard = (attrs: readonly string[]): string => `:where(:not(${attrs.map(a => `[${a}]`).join(",")}))`

/** Appends a reset guard to the subject compound of `complex`, before its pseudo-element if any. */
function appendGuard(complex: selectorParser.Selector, attrs: readonly string[]): void {
    const guard = selectorParser().astSync(resetGuard(attrs)).first.first as Exclude<selectorParser.Node, selectorParser.Selector>
    guard.remove()
    const subject = subjectCompound(complex)
    const pseudoElement = subject.find(isPseudoElement) as typeof guard | undefined
    if (pseudoElement) {
        complex.insertBefore(pseudoElement, guard)
        return
    }
    const last = complex.nodes[complex.nodes.length - 1] as typeof guard
    guard.spaces = { before: "", after: last.spaces.after }
    last.spaces = { ...last.spaces, after: "" }
    complex.insertAfter(last, guard)
}

/** The classification of the start of the nearest `@scope` around `node` (what `:scope` and `&` stand for), or null. */
function scopeStart(node: Node, match: SubjectMatcher): SubjectClass | null {
    for (let p = node.parent as Node | undefined; p; p = p.parent as Node | undefined) {
        if (p.type !== "atrule" || (p as AtRule).name.toLowerCase() !== "scope") continue
        const at = p as AtRule
        if (/^to\b/i.test(at.params.trim())) return null
        const [start] = preludeSelectors(at)
        if (!start) return null
        let list: selectorParser.Root
        try {
            list = selectorParser().astSync(at.params.slice(start.start, start.end))
        } catch {
            return null
        }
        const results = list.nodes.map(s => classifySubject(subjectCompound(s), match))
        const names = results.flatMap(r => r.names)
        if (results.length > 0 && results.every(r => r.match === "all")) return { match: "all", names: sortedNames(names) }
        return results.some(r => r.match !== "none") ? { match: "some", names: sortedNames(names) } : NONE
    }
    return null
}

// ─── the strip ──────────────────────────────────────────────────────────────────────────────────

export interface DroppedDeclaration {
    prop: string
    value: string
    important: boolean
    line?: number
}

/** A rule that lost its declarations for the reset elements. */
export interface DroppedRule {
    /**
     * The complex selectors whose declarations went, with the reset attributes each subject names and
     * whether the subject is a pseudo-element (its declarations are no contract of the element's layout).
     */
    selectors: Array<{ selector: string; attrs: string[]; pseudoElement: boolean }>
    /** The declarations removed (custom properties never are). */
    declarations: DroppedDeclaration[]
    /** True when nothing was left of the rule (it is gone); false when it kept custom properties or other selectors. */
    removed: boolean
    /** The conditional at-rules around it, outermost first (`@media (prefers-reduced-motion: reduce)`); `@layer` blocks are not conditions. */
    context: string[]
    line?: number
}

/**
 * A complex selector kept for its other elements, with a guard excluding the reset elements: for those,
 * the rule's declarations are dropped as surely as a dropped selector's (a part styled only through a
 * shared `:is()` rule is reset by its guards).
 */
export interface GuardedSelector {
    /** The selector as the design system wrote it. */
    selector: string
    /** The selector with its guard. */
    guarded: string
    /** The reset attributes the guard excludes. */
    attrs: string[]
    /** True when the subject is a pseudo-element (its declarations are no contract of the element's layout). */
    pseudoElement: boolean
    /** The declarations the reset elements lose (custom properties never: a clone before the rule keeps them). */
    declarations: DroppedDeclaration[]
    /** The conditional at-rules around the rule, outermost first. */
    context: string[]
    line?: number
}

/** A rule whose subject is a reset component's identity: another component's rule for it, kept. */
export interface ForeignRule {
    tag: string
    selector: string
    line?: number
}

/** What a reset did to one stylesheet. */
export interface ResetOutcome {
    rules: DroppedRule[]
    guarded: GuardedSelector[]
    foreign: ForeignRule[]
    /** True when the stylesheet changed. */
    changed: boolean
}

const isCustomProperty = (node: Node): node is Declaration => node.type === "decl" && (node as Declaration).prop.startsWith("--")
const isOwnDeclaration = (node: Node): node is Declaration => node.type === "decl" && !(node as Declaration).prop.startsWith("--")
const lineOf = (node: Node): number | undefined => node.source?.start?.line
const isRemoteImport = (params: string): boolean => /^\s*(?:url\(\s*)?["']?(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(params)
const isDisplayDefault = (complex: selectorParser.Selector, tag: string): boolean => String(complex).trim() === `:where(${tag}:not([hidden]))`

/** Removes the at-rules a reset emptied, walking up; an emptied `@layer x {}` that first declares `x` becomes `@layer x;`. */
function removeEmptied(container: Container | undefined, root: Root): void {
    let node = container as Node | undefined
    while (node && node.type === "atrule") {
        const at = node as AtRule
        if (!at.nodes || at.nodes.some(n => n.type !== "comment")) return
        const parent = at.parent as Container | undefined
        if (at.name.toLowerCase() === "layer" && at.params.trim() && !layerDeclaredBefore(at, root)) {
            at.replaceWith(postcss.atRule({ name: at.name, params: at.params.trim(), raws: { before: at.raws.before ?? "\n" } }))
        } else at.remove()
        node = parent as Node | undefined
    }
}

/**
 * Ends every block-less at-rule that is the last node of its container with `;`. PostCSS prints the
 * last statement of a stylesheet the way it was parsed — without `;` when the file ended with a `}` —
 * and a bundler concatenates stylesheets with no separator: `@layer reset, tokens, components` left
 * last by a strip would swallow the next stylesheet's first rule into its prelude.
 */
function terminateStatements(root: Root): void {
    const terminate = (container: Container) => {
        const last = container.last
        if (last && last.type === "atrule" && !(last as AtRule).nodes) container.raws.semicolon = true
    }
    terminate(root)
    root.walkAtRules(at => {
        if (at.nodes) terminate(at)
    })
}

/** True when every layer an `@layer` block names is declared by an earlier top-level `@layer`, so removing the block keeps the layer order. */
function layerDeclaredBefore(at: AtRule, root: Root): boolean {
    if (at.parent !== root) return false
    const declared = new Set<string>()
    for (const n of root.nodes) {
        if (n === at) break
        if (n.type === "atrule" && n.name.toLowerCase() === "layer") for (const name of n.params.split(",")) declared.add(name.trim())
    }
    return at.params.split(",").every(name => declared.has(name.trim()))
}

/**
 * Strips the declarations of the reset parts from a design-system stylesheet (SPEC §9.5), in place.
 * Per rule outside `@keyframes` with a declaration other than a custom property, per complex selector,
 * the subject is classified against the reset attributes ({@link classifySubject}): **none** keeps the
 * selector; **some** keeps it with `:where(:not([attr]))` appended to its subject (before a
 * pseudo-element); **all** drops it. A rule left with no selector loses every declaration but its custom
 * properties (and goes when none is left); a rule with kept selectors keeps them, and a clone before it
 * carries the custom properties of its dropped selectors and of its guarded ones as written. At-rules left
 * empty go, and a block-less at-rule left last is ended with `;`. Rule order and every kept selector's
 * specificity are unchanged; a second pass changes nothing. Throws `[reset-import]` on a local `@import`
 * (a bundler inlines it untransformed) and on unflattened input.
 */
export function resetStylesheet(root: Root, targets: readonly ResetTarget[]): ResetOutcome {
    const outcome: ResetOutcome = { rules: [], guarded: [], foreign: [], changed: false }
    if (targets.length === 0) return outcome
    const attrs = sortedNames(targets.map(t => t.attr.toLowerCase()))
    const tags = sortedNames(targets.flatMap(t => (t.tag ? [t.tag.toLowerCase()] : [])))
    const needles = [...attrs, ...tags]
    const isReset = attributeMatcher(attrs)
    const identities = tags.map(tag => ({ tag, match: identityMatcher(tag) }))

    root.walkAtRules(/^import$/i, at => {
        if (!isRemoteImport(at.params)) {
            throw at.error(`[reset-import] @import ${at.params} in a design-system stylesheet while resets are active — the bundler inlines it untransformed; import the design system's flat aggregate (styles.css) instead`)
        }
    })

    const emptied = new Set<Container>()
    root.walkRules(rule => {
        if (isInsideKeyframes(rule)) return
        const scope = rule.parent && rule.parent.type !== "root" ? findScope(rule) : null
        const haystack = `${rule.selector}\u0000${scope?.params ?? ""}`.toLowerCase()
        if (!needles.some(n => haystack.includes(n))) return
        if (rule.nodes.some(n => n.type === "rule" || n.type === "atrule")) throw rule.error("reset: nested rule — a design-system stylesheet is reset flattened (as its build emits it)")
        let ast: selectorParser.Root
        try {
            ast = selectorParser().astSync(rule.selector)
        } catch {
            return
        }
        const line = lineOf(rule)
        const resetScope = scope ? scopeStart(rule, isReset) : null
        type Hit = { complex: selectorParser.Selector; selector: string; attrs: string[]; pseudoElement: boolean }
        const dropped: Hit[] = []
        const guards: Hit[] = []
        for (const complex of ast.nodes) {
            const subject = subjectCompound(complex)
            for (const { tag, match } of identities) {
                if (classifySubject(subject, match, scope ? scopeStart(rule, match) : null).match !== "none" && !isDisplayDefault(complex, tag)) {
                    outcome.foreign.push({ tag, selector: String(complex).trim(), line })
                }
            }
            const c = classifySubject(subject, isReset, resetScope)
            const hit = { complex, selector: String(complex).trim(), attrs: c.names, pseudoElement: subject.some(isPseudoElement) }
            if (c.match === "all") dropped.push(hit)
            else if (c.match === "some") guards.push(hit)
        }
        const own = rule.nodes.filter(isOwnDeclaration)
        // nothing of the reset elements' own look here (or only custom properties): the selectors stay whole
        if ((dropped.length === 0 && guards.length === 0) || own.length === 0) return
        const declarations = own.map(d => ({ prop: d.prop, value: d.value, important: !!d.important, line: lineOf(d) }))
        const context = conditionsOf(rule)
        for (const g of guards) {
            appendGuard(g.complex, g.attrs)
            outcome.guarded.push({ selector: g.selector, guarded: String(g.complex).trim(), attrs: g.attrs, pseudoElement: g.pseudoElement, declarations, context, line })
        }
        let removed = false
        if (dropped.length === ast.nodes.length) {
            for (const d of own) d.remove()
            if (!rule.nodes.some(n => n.type === "decl")) {
                emptied.add(rule.parent as Container)
                rule.remove()
                removed = true
            }
        } else {
            for (const d of dropped) d.complex.remove()
            if (rule.nodes.some(isCustomProperty)) {
                // the reset elements keep the rule's custom properties: dropped selectors and guarded ones as written
                const clone = rule.clone({ selector: [...dropped, ...guards].map(h => h.selector).join(",") })
                clone.each(n => {
                    if (isOwnDeclaration(n)) n.remove()
                })
                rule.before(clone)
            }
            rule.selector = ast.toString().trim()
        }
        if (dropped.length > 0) {
            outcome.rules.push({ selectors: dropped.map(d => ({ selector: d.selector, attrs: d.attrs, pseudoElement: d.pseudoElement })), declarations, removed, context, line })
        }
        outcome.changed = true
    })
    for (const container of emptied) removeEmptied(container, root)
    if (outcome.changed) terminateStatements(root)
    return outcome
}

/** The conditional at-rules around a node, outermost first — what makes two rules with one selector two rules. */
function conditionsOf(node: Node): string[] {
    const out: string[] = []
    for (let p = node.parent as Node | undefined; p; p = p.parent as Node | undefined) {
        if (p.type === "atrule" && (p as AtRule).name.toLowerCase() !== "layer") out.unshift(`@${(p as AtRule).name} ${(p as AtRule).params}`.trim())
    }
    return out
}

function findScope(node: Node): AtRule | null {
    for (let p = node.parent as Node | undefined; p; p = p.parent as Node | undefined) if (p.type === "atrule" && (p as AtRule).name.toLowerCase() === "scope") return p as AtRule
    return null
}

/** The comment a reset stylesheet starts with: which reset targets touched it, and from which override sheets. */
export function resetComment(targets: readonly ResetTarget[]): string {
    const sheets = sortedNames(targets.map(t => t.sheet))
    return `libstylist: reset ${targets.map(t => t.label).join(", ")} (${sheets.join(", ")})`
}

/** The targets an outcome stripped something of (a selector dropped or guarded for them: both take the rule's declarations off them). */
export function touchedTargets(targets: readonly ResetTarget[], outcome: ResetOutcome): ResetTarget[] {
    const hit = new Set<string>()
    for (const r of outcome.rules) for (const s of r.selectors) for (const a of s.attrs) hit.add(a)
    for (const g of outcome.guarded) for (const a of g.attrs) hit.add(a)
    return targets.filter(t => hit.has(t.attr.toLowerCase()))
}

function prependComment(root: Root, text: string): void {
    const comment = postcss.comment({ text })
    const first = root.first
    if (first && first.type === "atrule" && first.name.toLowerCase() === "charset") first.after(comment)
    else root.prepend(comment)
}

export interface ResetCssOptions {
    /** The stylesheet's path (errors, the outcome). */
    from?: string
    /** Start a changed stylesheet with `/* libstylist: reset … *\/`. @default true */
    comment?: boolean
}

export interface ResetCssResult {
    /** The transformed stylesheet, or null when the reset changed nothing (the input stands). */
    css: string | null
    outcome: ResetOutcome
}

/** {@link resetStylesheet} over CSS text — the Vite transform's entry point. No targets: nothing is parsed. */
export function resetCss(css: string, targets: readonly ResetTarget[], options: ResetCssOptions = {}): ResetCssResult {
    if (targets.length === 0) return { css: null, outcome: { rules: [], guarded: [], foreign: [], changed: false } }
    const root = postcss.parse(css, { from: options.from })
    const outcome = resetStylesheet(root, targets)
    if (!outcome.changed) return { css: null, outcome }
    if (options.comment !== false) prependComment(root, resetComment(touchedTargets(targets, outcome)))
    return { css: root.toString(), outcome }
}

export interface StylistResetOptions {
    /** The reset targets of the design system whose stylesheets this pipeline processes. */
    resets: readonly ResetTarget[]
    /** Receives what the reset did to each stylesheet (the reports read it). */
    onOutcome?: (outcome: ResetOutcome, file: string | undefined) => void
    /** Start a changed stylesheet with `/* libstylist: reset … *\/`. @default true */
    comment?: boolean
}

/**
 * The reset as a PostCSS plugin, for pipelines that bundle the design system's CSS without the Vite
 * plugin: `postcss([stylistReset({ resets })])` over `styles.css` and the other aggregates.
 */
export function stylistReset(options: StylistResetOptions): Plugin {
    if (!options || !Array.isArray(options.resets)) throw new Error("libstylist: stylistReset() needs { resets } — the reset targets of the app's override sheets")
    return {
        postcssPlugin: RESET_PLUGIN_NAME,
        OnceExit(root, { result }) {
            const outcome = resetStylesheet(root, options.resets)
            if (outcome.changed && options.comment !== false) prependComment(root, resetComment(touchedTargets(options.resets, outcome)))
            options.onOutcome?.(outcome, result.opts.from ?? root.source?.input.file)
        },
    }
}
stylistReset.postcss = true as const

// ─── layout contracts and the report ────────────────────────────────────────────────────────────

/** `item`: the parent's layout reads it from the element; `container`: the element's children rely on it. */
export type LayoutKind = "item" | "container"

/** Properties a parent's layout reads from its child (`position` counts when not `static`). */
export const LAYOUT_ITEM_PROPS: readonly string[] = [
    "flex", "flex-grow", "flex-shrink", "flex-basis", "order", "align-self", "justify-self", "place-self",
    "grid-area", "grid-row", "grid-row-start", "grid-row-end", "grid-column", "grid-column-start", "grid-column-end",
    "position", "inset", "inset-block", "inset-block-start", "inset-block-end", "inset-inline", "inset-inline-start", "inset-inline-end",
    "top", "right", "bottom", "left", "z-index",
]

/** Properties an element's children rely on (`display` when it establishes a layout, `position` when not `static`). */
export const LAYOUT_CONTAINER_PROPS: readonly string[] = [
    "display", "flex-direction", "flex-flow", "flex-wrap",
    "grid", "grid-template", "grid-template-rows", "grid-template-columns", "grid-template-areas", "grid-auto-rows", "grid-auto-columns", "grid-auto-flow",
    "gap", "row-gap", "column-gap", "align-items", "justify-items", "place-items", "align-content", "justify-content", "place-content",
    "position", "overflow", "overflow-x", "overflow-y", "overflow-block", "overflow-inline",
]

/**
 * Sizes a parent's layout reads from its child by value: a zero minimum (`min-width: 0` lets a flex or
 * grid item shrink below its content — the contract that keeps columns aligned), a size relative to the
 * parent (a percentage, `stretch`), and an `auto` margin (it places the item in a flex or grid parent).
 * Any other size or margin is the element's own look.
 */
export const LAYOUT_ITEM_MINIMA: readonly string[] = ["min-width", "min-height", "min-inline-size", "min-block-size"]
export const LAYOUT_ITEM_SIZES: readonly string[] = ["width", "height", "inline-size", "block-size", "max-width", "max-height", "max-inline-size", "max-block-size"]
export const LAYOUT_ITEM_MARGINS: readonly string[] = [
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "margin-block", "margin-block-start", "margin-block-end", "margin-inline", "margin-inline-start", "margin-inline-end",
]

const LAYOUT_DISPLAY = /^(?:inline-)?(?:flex|grid)$|^contents$|^none$|^(?:inline-)?table(?:-.+)?$/
const ZERO = /^[+-]?0*\.?0+(?:[a-z]+|%)?$/
const RELATIVE_SIZE = /%|^(?:-webkit-|-moz-)?(?:stretch|fill-available|available)$/

/** The layout contracts a declaration takes part in (none for most). */
export function layoutKinds(prop: string, value: string): LayoutKind[] {
    const p = prop.toLowerCase()
    const v = value.trim().toLowerCase()
    if (p === "position") return v === "static" ? [] : ["item", "container"]
    if (p === "display") return v.split(/\s+/).some(k => LAYOUT_DISPLAY.test(k)) ? ["container"] : []
    if (LAYOUT_ITEM_MINIMA.includes(p)) return ZERO.test(v) ? ["item"] : []
    if (LAYOUT_ITEM_SIZES.includes(p)) return RELATIVE_SIZE.test(v) ? ["item"] : []
    if (LAYOUT_ITEM_MARGINS.includes(p)) return /(?:^|\s)auto(?:\s|$)/.test(v) ? ["item"] : []
    const kinds: LayoutKind[] = []
    if (LAYOUT_ITEM_PROPS.includes(p)) kinds.push("item")
    if (LAYOUT_CONTAINER_PROPS.includes(p)) kinds.push("container")
    return kinds
}

/** Shorthand → the longhands it sets, for acknowledging a dropped longhand. */
const LONGHANDS: Readonly<Record<string, readonly string[]>> = {
    flex: ["flex-grow", "flex-shrink", "flex-basis"],
    "flex-flow": ["flex-direction", "flex-wrap"],
    gap: ["row-gap", "column-gap"],
    "place-items": ["align-items", "justify-items"],
    "place-self": ["align-self", "justify-self"],
    "place-content": ["align-content", "justify-content"],
    inset: ["top", "right", "bottom", "left", "inset-block", "inset-inline", "inset-block-start", "inset-block-end", "inset-inline-start", "inset-inline-end"],
    overflow: ["overflow-x", "overflow-y", "overflow-block", "overflow-inline"],
    "grid-area": ["grid-row", "grid-column", "grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end"],
    "grid-row": ["grid-row-start", "grid-row-end"],
    "grid-column": ["grid-column-start", "grid-column-end"],
    "grid-template": ["grid-template-rows", "grid-template-columns", "grid-template-areas"],
    grid: ["grid-template", "grid-template-rows", "grid-template-columns", "grid-template-areas", "grid-auto-rows", "grid-auto-columns", "grid-auto-flow"],
    margin: ["margin-top", "margin-right", "margin-bottom", "margin-left", "margin-block", "margin-block-start", "margin-block-end", "margin-inline", "margin-inline-start", "margin-inline-end"],
    "margin-block": ["margin-block-start", "margin-block-end"],
    "margin-inline": ["margin-inline-start", "margin-inline-end"],
}

/** The layout longhands a shorthand sets (`flex` → `flex-grow`, `flex-shrink`, `flex-basis`); none for a longhand. */
export const longhandsOf = (prop: string): readonly string[] => {
    const p = prop.toLowerCase()
    return Object.prototype.hasOwnProperty.call(LONGHANDS, p) ? LONGHANDS[p] : []
}

/** A value-less attribute that names structure, not state: a part attribute or an identity marker (`[elo-button]`). */
const isStructuralAttribute = (n: selectorParser.Attribute): boolean => {
    const name = n.attribute.toLowerCase()
    return n.value === undefined && !name.startsWith("data-") && !name.startsWith("aria-") && name.includes("-")
}

/**
 * The conditions of a complex selector: every simple selector of its compounds that is not structure —
 * state and variants (`[data-loading]`, `[aria-busy]`, `[disabled]`), pseudo-classes and elements,
 * document context (`:root[data-theme="dark"]`) — normalized (attribute values quoted, whitespace
 * collapsed). Structure is combinators, type and universal selectors, part attributes, identity markers
 * and an `:is()`/`:where()` of structure only (`:is(elo-button,[elo-button])`, what `.root` compiles to).
 * The positions of the conditions are not compared: two selectors are told apart by what they require.
 */
export function selectorConditions(complex: selectorParser.Selector): Set<string> {
    const out = new Set<string>()
    for (const n of complex.nodes) {
        if (n.type === "combinator" || n.type === "comment" || n.type === "tag" || n.type === "universal" || n.type === "nesting") continue
        if (n.type === "attribute") {
            if (!isStructuralAttribute(n)) out.add(`[${n.attribute.toLowerCase()}${n.operator ?? ""}${n.value === undefined ? "" : JSON.stringify(n.value)}${n.insensitive ? " i" : ""}]`)
            continue
        }
        if (n.type === "pseudo" && IN_PLACE.has(n.value.toLowerCase()) && n.nodes.length > 0 && n.nodes.every(arg => selectorConditions(arg).size === 0)) continue
        out.add(String(n).replace(/\s+/g, " ").trim())
    }
    return out
}

const normalizeContext = (context: readonly string[]): string[] => context.map(c => c.replace(/\s+/g, " ").trim())

/**
 * A declaration a compiled override sheet makes for a reset target: its property (with the longhands a
 * shorthand sets), the conditions of the selector ({@link selectorConditions}) and the conditional
 * at-rules around it.
 */
export interface AcknowledgedDeclaration {
    /** Lowercase; a shorthand with its longhands. */
    props: string[]
    conditions: string[]
    /** Outermost first (`@layer` blocks are not conditions). */
    context: string[]
}

/**
 * The declarations a compiled override sheet makes for a reset target — every declaration of a rule
 * whose subject names the target's part attribute or its identity (`.root` compiles to
 * `:is(tag,[tag])`), one entry per complex selector naming it. A dropped layout declaration is
 * acknowledged by one of them only when it holds wherever the design system's did
 * ({@link acknowledges}).
 */
export function acknowledgedDeclarations(css: string | Root, target: Pick<ResetTarget, "attr" | "tag">): AcknowledgedDeclaration[] {
    const root = typeof css === "string" ? postcss.parse(css) : css
    const byAttr = attributeMatcher([target.attr])
    const byTag = target.tag ? identityMatcher(target.tag) : null
    const out: AcknowledgedDeclaration[] = []
    root.walkRules(rule => {
        if (isInsideKeyframes(rule)) return
        let ast: selectorParser.Root
        try {
            ast = selectorParser().astSync(rule.selector)
        } catch {
            return
        }
        const props = new Set<string>()
        rule.each(node => {
            if (node.type !== "decl") return
            const prop = node.prop.toLowerCase()
            props.add(prop)
            for (const longhand of longhandsOf(prop)) props.add(longhand)
        })
        if (props.size === 0) return
        const context = normalizeContext(conditionsOf(rule))
        for (const complex of ast.nodes) {
            const subject = subjectCompound(complex)
            if (classifySubject(subject, byAttr).match === "none" && (byTag === null || classifySubject(subject, byTag).match === "none")) continue
            out.push({ props: [...props].sort(), conditions: [...selectorConditions(complex)].sort(), context })
        }
    })
    return out
}

/**
 * True when an override declaration re-declares `prop` wherever the design-system rule `selector` (in
 * the at-rules `context`) declared it: one entry declares the property with conditions and at-rules
 * that are a subset of the rule's. A re-declaration under a state (`.root[data-loading] .loader {
 * display: flex }`) or a media query does not acknowledge an unconditional `display: none`: every
 * other state lost it.
 */
export function acknowledges(declarations: readonly AcknowledgedDeclaration[], prop: string, selector: string, context: readonly string[]): boolean {
    const p = prop.toLowerCase()
    const candidates = declarations.filter(d => d.props.includes(p))
    if (candidates.length === 0) return false
    let ast: selectorParser.Root
    try {
        ast = selectorParser().astSync(selector)
    } catch {
        return false
    }
    const where = new Set(normalizeContext(context))
    return ast.nodes.every(complex => {
        const conditions = selectorConditions(complex)
        return candidates.some(d => d.context.every(c => where.has(c)) && d.conditions.every(c => conditions.has(c)))
    })
}

/** One design-system stylesheet a reset processed. */
export interface ResetStylesheet {
    /** The stylesheet as reports print it (`styles.css`, `components/button.css`: a path under the design system's dist). */
    file: string
    outcome: ResetOutcome
}

export interface ResetLayoutNote {
    kinds: LayoutKind[]
    prop: string
    value: string
    selector: string
    file: string
    line?: number
}

/** What one reset target dropped across the design system's stylesheets (duplicates across aggregates and per-sheet files counted once). */
export interface ResetReport {
    target: ResetTarget
    /** Unique declarations dropped (conditions + selector + property + value). */
    declarations: number
    /** Unique rules touched (conditions + selector). */
    rules: number
    /** The stylesheets it dropped something from, in input order. */
    stylesheets: string[]
    /** Selectors kept for other elements with a guard excluding this one. */
    guarded: Array<{ file: string; selector: string; guarded: string; line?: number }>
    /** Layout-contract declarations dropped that the override sheet does not re-declare. */
    layout: ResetLayoutNote[]
    /** Other components' rules that still style the element (its identity is their subject). */
    foreign: Array<{ file: string; selector: string; line?: number }>
    /** True when it dropped nothing at all: an `[empty-reset]` error. */
    empty: boolean
}

export interface ResetReportsOptions {
    /** The declarations the target's override sheet makes for it ({@link acknowledgedDeclarations}); none by default. */
    acknowledged?: (target: ResetTarget) => readonly AcknowledgedDeclaration[]
}

/**
 * The report of every reset target over the stylesheets a reset processed (SPEC §9.6). A guarded
 * selector counts like a dropped one: its rule's declarations no longer reach the target.
 */
export function resetReports(targets: readonly ResetTarget[], stylesheets: readonly ResetStylesheet[], options: ResetReportsOptions = {}): ResetReport[] {
    return targets.map(target => {
        const attr = target.attr.toLowerCase()
        const acknowledged = options.acknowledged?.(target) ?? []
        const decls = new Set<string>()
        const rules = new Set<string>()
        const files: string[] = []
        const layout = new Map<string, ResetLayoutNote>()
        const guarded = new Map<string, ResetReport["guarded"][number]>()
        const foreign = new Map<string, ResetReport["foreign"][number]>()
        const count = (file: string, selectors: ReadonlyArray<{ selector: string; pseudoElement: boolean }>, declarations: readonly DroppedDeclaration[], context: string[], line: number | undefined) => {
            const selector = selectors.map(s => s.selector).join(",")
            const ruleKey = [...context, selector].join("\u0000")
            if (!files.includes(file)) files.push(file)
            rules.add(ruleKey)
            // a contract of the element itself: its selectors whose subject is no pseudo-element
            const contract = selectors.filter(s => !s.pseudoElement).map(s => s.selector).join(",")
            for (const d of declarations) {
                const key = `${ruleKey}\u0000${d.prop}\u0000${d.value}${d.important ? "!" : ""}`
                decls.add(key)
                const kinds = contract ? layoutKinds(d.prop, d.value) : []
                if (kinds.length > 0 && !layout.has(key) && !acknowledges(acknowledged, d.prop, contract, context)) {
                    layout.set(key, { kinds, prop: d.prop, value: d.value, selector, file, line: d.line ?? line })
                }
            }
        }
        for (const { file, outcome } of stylesheets) {
            for (const rule of outcome.rules) {
                const own = rule.selectors.filter(s => s.attrs.includes(attr))
                if (own.length > 0) count(file, own, rule.declarations, rule.context, rule.line)
            }
            for (const g of outcome.guarded) {
                if (!g.attrs.includes(attr)) continue
                count(file, [g], g.declarations, g.context, g.line)
                if (!guarded.has(g.guarded)) guarded.set(g.guarded, { file, selector: g.selector, guarded: g.guarded, line: g.line })
            }
            if (target.tag) {
                const tag = target.tag.toLowerCase()
                for (const f of outcome.foreign) if (f.tag === tag && !foreign.has(f.selector)) foreign.set(f.selector, { file, selector: f.selector, line: f.line })
            }
        }
        return {
            target,
            declarations: decls.size,
            rules: rules.size,
            stylesheets: files,
            guarded: [...guarded.values()],
            layout: [...layout.values()],
            foreign: [...foreign.values()],
            empty: decls.size === 0,
        }
    })
}

export interface ResetReportLine {
    /** `reset`: what a target drops; `note`: an unacknowledged layout declaration; `error`: an empty reset. */
    level: "reset" | "note" | "error"
    text: string
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`
const at = (file: string, line: number | undefined): string => (line ? `${file}:${line}` : file)

function layoutReason(note: ResetLayoutNote): string {
    const prop = note.prop.toLowerCase()
    if (prop === "position") return "its descendants may position against it, and its parent may place it"
    if (prop === "display" && note.value.trim().toLowerCase() === "none") return "the design system hides it until a state shows it"
    if (LAYOUT_ITEM_MINIMA.includes(prop)) return "it lets the element shrink below its content in a flex or grid parent"
    if (LAYOUT_ITEM_SIZES.includes(prop)) return "it sizes the element from its parent"
    if (LAYOUT_ITEM_MARGINS.includes(prop)) return "it places the element in its flex or grid parent"
    if (note.kinds.includes("container")) return "its children's layout may rely on it"
    return "its parent's layout may rely on it"
}

/**
 * The lines `libstylist build` prints for one report: one `reset` line and a `note` per unacknowledged
 * layout declaration — or, for a part reset that drops nothing, the `[empty-reset]` error (a part of a
 * whole reset with no rule of its own prints nothing; {@link formatResetReports} judges the whole reset).
 */
export function formatResetReport(report: ResetReport): ResetReportLine[] {
    const { target } = report
    if (report.empty) {
        if (target.whole) return []
        return [{
            level: "error",
            text: `[empty-reset] ${at(target.sheet, target.line)}: the reset of ${target.label} drops nothing — no design-system rule styles that part any more (or only sets custom properties there); remove "${target.part}" from @stylist reset`,
        }]
    }
    const extras = [
        report.guarded.length ? `${plural(report.guarded.length, "selector")} kept for other elements` : "",
        report.foreign.length ? `${plural(report.foreign.length, "rule")} of other components still style it` : "",
    ].filter(Boolean)
    const lines: ResetReportLine[] = [{
        level: "reset",
        text: `${target.label} — ${plural(report.declarations, "declaration")} in ${plural(report.rules, "rule")} (${report.stylesheets.join(", ")})${extras.length ? `; ${extras.join("; ")}` : ""}`,
    }]
    for (const note of report.layout) {
        lines.push({ level: "note", text: `${target.label} drops ${note.prop}: ${note.value} (${at(note.file, note.line)}) — ${layoutReason(note)}; declare it in ${target.sheet} to keep it` })
    }
    return lines
}

/**
 * The lines of every report ({@link formatResetReport}), plus one `[empty-reset]` error per whole reset
 * (`@stylist reset;`) that drops nothing for any part of its sheet.
 */
export function formatResetReports(reports: readonly ResetReport[]): ResetReportLine[] {
    const lines = reports.flatMap(formatResetReport)
    const wholes = new Map<string, ResetReport[]>()
    for (const r of reports) {
        if (!r.target.whole) continue
        const key = `${r.target.sheet}\u0000${r.target.prefix}\u0000${r.target.scope}`
        wholes.set(key, [...(wholes.get(key) ?? []), r])
    }
    for (const group of wholes.values()) {
        if (!group.every(r => r.empty)) continue
        const { target } = group[0]
        lines.push({
            level: "error",
            text: `[empty-reset] ${at(target.sheet, target.line)}: the whole reset of ${target.prefix}:${target.namespace}/${target.scope} drops nothing — no design-system rule styles its parts any more; remove @stylist reset;`,
        })
    }
    return lines
}
