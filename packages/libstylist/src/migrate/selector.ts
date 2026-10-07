// One selector (list) through the migration map: the heart of `libstylist migrate-selectors`.
//
//   .ls-alert__icon           → [_cxclass_elo-or4d4l]                      (a part: (0,1,0) → (0,1,0))
//   .ls-alert                 → [_cxclass_elo-qkqllh]   (--roots identity: elo-alert)
//   div.ls-alert              → elo-alert[_cxclass_elo-qkqllh]            (the div is <elo-alert> now)
//   :global(.ls-alert)        → [_cxclass_elo-qkqllh]                      (nothing left to globalize)
//   [data-component="Tabs"]   → :is(elo-tabs,[elo-tabs])
//   .ls-table .table-td       → … :is(elo-table-td,[elo-table-td])         (an anchored literal hook)
//   .ls-icon.small            → TODO data-size="small" on Icon / Switch    (prop / data / removed / pending)
//
// Edits are offsets into the selector text, so everything the map does not own — comments,
// whitespace, template placeholders, Playwright pseudo-classes — is left exactly as written.
import selectorParser from "postcss-selector-parser"

import { compareSpecificity, formatSpecificity, specificityList, type Specificity } from "../postcss/specificity.js"
import { hasPrefix, isCutShort, isPartialClass, normalizeSelector, unknownHint, type AppliedHooks, type ClassEntry, type HookEntry, type MapIndex } from "./map.js"
import { applyEdits, LineIndex, oneLine, type Edit } from "./text.js"

type Node = selectorParser.Node
type Selector = selectorParser.Selector
type Pseudo = selectorParser.Pseudo

export interface MigrateOptions {
    /** How a root class is written: its part attribute (default, same specificity) or its identity tag / marker. */
    roots: "part" | "identity"
    /** Literal hooks (`icon-wrapper`, `small`): only next to a design-system hook of their scope, everywhere, or never. */
    literals: "anchored" | "all" | "off"
}

export const DEFAULT_OPTIONS: MigrateOptions = { roots: "part", literals: "anchored" }

export type Reason =
    | "class"
    | "root"
    | "literal"
    | "data-component"
    | "data-part"
    | "class-attribute"
    | "ledger"
    | "removed"
    | "unknown"
    | "dynamic"
    | "bem"
    | "unparseable"
    | "keyframes"
    | "keyframes-definition"
    | "composes"
    | "at-rule"
    | "class-usage"
    | "selector-string"
    | "api"
    | "parse-error"
    | "app-hook"
    | "part-map"
    | "attribute-read"

export interface Finding {
    kind: "todo" | "unknown"
    /** Offsets in the analyzed text. */
    start: number
    end: number
    old: string
    suggestion?: string
    reason: Reason
    message: string
}

export interface SelectorRewrite {
    /** The complex selector's range in the analyzed text. */
    start: number
    end: number
    old: string
    new: string
    notes: string[]
}

export interface SelectorAnalysis {
    edits: Edit[]
    output: string
    rewrites: SelectorRewrite[]
    findings: Finding[]
}

export interface SelectorContext {
    index: MapIndex
    options: MigrateOptions
    /** A CSS Modules file: classes outside `:global` were localized by its build. */
    cssModule?: boolean
    /** Keep `:global(…)` wrappers even with no class left inside: they are what marks this sheet as scoped. */
    keepGlobal?: boolean
    /** An enclosing rule switched CSS Modules to global mode (`:global .a { … }`, `:global { … }`). */
    moduleGlobal?: boolean
    /** The enclosing rule's selector (nesting): `&__icon` concatenates onto it. */
    parentSelector?: string
    /** How `&__x` is compiled here (`scss`/`less` concatenate; plain CSS nesting does not). */
    syntax?: "css" | "scss" | "less"
    /** Legacy classes and data-component values the app puts on its own elements (never rewritten: the rule styles those too). */
    applied?: AppliedHooks
}

const isGlobal = (node: Node | undefined): node is Pseudo => node?.type === "pseudo" && node.value.toLowerCase() === ":global"
const INTERPOLATION_RE = /#\{|@\{/

/** Legacy class tokens anywhere in a text (for texts that can't be parsed as selectors). */
export function legacyTokens(text: string, index: MapIndex): Array<{ value: string; start: number; end: number }> {
    const out: Array<{ value: string; start: number; end: number }> = []
    for (const prefix of index.classPrefixes) {
        const re = new RegExp(`(?<![\\w$-])${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9_-]*`, "g")
        for (const m of text.matchAll(re)) out.push({ value: m[0], start: m.index!, end: m.index! + m[0].length })
    }
    return out.sort((a, b) => a.start - b.start)
}

/** Cheap pre-check: can this text contain anything the map rewrites? */
function mayMatter(text: string, ctx: SelectorContext): boolean {
    const { index, options } = ctx
    if (options.literals === "all" || index.ledger.size > 0) return true
    if (index.classPrefixes.some((p) => text.includes(p))) return true
    if (text.includes("data-component") || text.includes("class")) return true
    if (options.literals !== "off" && (text.includes("_cxclass_") || text.includes(`${index.prefix}-`))) return true
    for (const attr of index.hookAttributes) if (text.includes(`${attr}=`)) return true
    return false
}

/** A selector that can stand where one simple selector stood: a compound as is, anything else as `:is(…)`. */
function spliceable(selector: string, canStartWithType: boolean): string {
    try {
        const root = selectorParser().astSync(selector)
        if (root.nodes.length === 1) {
            const nodes = root.nodes[0].nodes
            const compound = !nodes.some((n) => n.type === "combinator")
            const leadingType = nodes.some((n) => n.type === "tag" || n.type === "universal")
            if (compound && (!leadingType || canStartWithType)) return selector.trim()
        }
    } catch {
        // fall through: wrapping is always valid
    }
    return `:is(${selector.trim()})`
}

/** Specificity of a complex selector as written (`&` and placeholders are neutral on both sides). */
function specificityOf(selector: string): Specificity | null {
    try {
        const s = specificityList(selector.replace(/&/g, "*").replace(/\/\*[\s\S]*?\*\//g, " "))
        return s.length === 1 ? s[0] : null
    } catch {
        return null
    }
}

/** The members of `node`'s compound, `:global(…)` of a single compound flattened into its host compound. */
function compoundOf(node: Node): { members: Node[]; first: boolean } {
    let container = node.parent as Selector
    let anchor: Node = node
    const pseudo = container.parent as Node | undefined
    if (isGlobal(pseudo) && pseudo.nodes.length === 1 && !container.nodes.some((n) => n.type === "combinator")) {
        anchor = pseudo
        container = pseudo.parent as Selector
    }
    const list = container.nodes as Node[]
    const i = list.indexOf(anchor)
    let a = i
    while (a > 0 && list[a - 1].type !== "combinator") a--
    let b = i
    while (b < list.length - 1 && list[b + 1].type !== "combinator") b++
    const members = list.slice(a, b + 1).flatMap((m) => (m === anchor && anchor !== node ? (anchor as Pseudo).nodes[0].nodes : [m])).filter((m) => m.type !== "comment")
    return { members, first: members[0] === node }
}

/** True when a bare `:global` (CSS Modules mode switch) precedes `node` in its top-level selector. */
function afterBareGlobal(node: Node): boolean {
    let top: Node = node
    while (top.parent && top.parent.type !== "root") top = top.parent as Node
    const sel = top as Selector
    const upTo = (() => {
        let n: Node = node
        while (n.parent && n.parent !== sel) n = n.parent as Node
        return (sel.nodes as Node[]).indexOf(n)
    })()
    return sel.nodes.slice(0, upTo).some((n) => isGlobal(n) && n.nodes.length === 0)
}

const insideGlobal = (node: Node): boolean => {
    for (let p = node.parent as Node | undefined; p; p = p.parent as Node | undefined) if (isGlobal(p)) return true
    return false
}

/** The design-system scopes one selector node names: a legacy class, an identity, a part attribute, a data-component value. */
function scopesOf(n: Node, index: MapIndex): string[] {
    const out: Array<string | null | undefined> = []
    if (n.type === "class" && hasPrefix(n.value, index.classPrefixes)) out.push(index.classes.get(n.value)?.scope)
    else if (n.type === "tag") out.push(index.scopeOfIdentity.get(n.value))
    else if (n.type === "attribute") {
        const name = n.attribute.toLowerCase()
        if (name === "data-component") out.push(n.value ? index.dataComponent.get(n.value)?.scope : undefined)
        else if (name === "class") for (const token of (n.value ?? "").split(/\s+/)) out.push(index.classes.get(token)?.scope)
        else out.push(index.scopeOfAttr.get(n.attribute) ?? index.scopeOfIdentity.get(n.attribute))
    }
    return out.filter((s): s is string => Boolean(s))
}

/**
 * The scopes every branch of a nesting parent's selector names — a nested rule sits inside each
 * branch, so only a scope all of them share anchors it. `localized` drops CSS Modules' own classes.
 */
function parentAnchorScopes(parent: string, index: MapIndex, localized: (n: Node) => boolean): Set<string> {
    const branches: Array<Set<string>> = []
    try {
        for (const branch of selectorParser().astSync(parent.replace(/\/\*__elo_expr_\d+__\*\//g, " ")).nodes) {
            const scopes = new Set<string>()
            branch.walk((n) => {
                if (n.type === "class" && localized(n)) return
                for (const s of scopesOf(n, index)) scopes.add(s)
            })
            branches.push(scopes)
        }
    } catch {
        return new Set()
    }
    if (branches.length === 0) return new Set()
    return new Set([...branches[0]].filter((s) => branches.every((b) => b.has(s))))
}

/** The selectors containing `node`, innermost first (`:is(.a .b)` → the `:is` argument, then the outer selector). */
function selectorChain(node: Node): Selector[] {
    const out: Selector[] = []
    for (let p = node.parent as Node | undefined; p; p = p.parent as Node | undefined) if (p.type === "selector") out.push(p as Selector)
    return out
}

/** The child of `container` that holds `node` (or is it). */
function childOf(container: Selector, node: Node): Node {
    let n: Node = node
    while (n.parent && n.parent !== container) n = n.parent as Node
    return n
}

/** Index of the compound holding `child` in `container`: the number of combinators before it. */
function compoundIndex(container: Selector, child: Node): number {
    let k = 0
    for (const n of container.nodes as Node[]) {
        if (n === child) return k
        if (n.type === "combinator") k++
    }
    return k
}

/** The combinator right after compound `k` of `container` (`" "`, `">"`, `"+"`, `"~"`), or undefined. */
function combinatorAfter(container: Selector, k: number): string | undefined {
    let seen = 0
    for (const n of container.nodes as Node[]) {
        if (n.type !== "combinator") continue
        if (seen === k) return n.value.trim() || " "
        seen++
    }
    return undefined
}

/** True when compound `inner` of `container` lies inside (or is) the element of compound `outer`. */
function compoundInside(container: Selector, outer: number, inner: number): boolean {
    if (outer === inner) return true
    if (outer > inner) return false
    const c = combinatorAfter(container, outer)
    return c === " " || c === ">"
}

/**
 * Where `node` sits relative to the element `anchor` selects: "inside" when it is that element or one
 * of its descendants (same compound, or a later compound reached through a descendant / child
 * combinator), "elsewhere" otherwise (an ancestor, a sibling, another branch of a selector list).
 */
function positionOf(anchor: Node, node: Node): "inside" | "elsewhere" {
    const chain = selectorChain(node)
    const container = selectorChain(anchor).find((s) => chain.includes(s))
    if (!container) return "elsewhere"
    const a = childOf(container, anchor)
    const n = childOf(container, node)
    // the same child: two arguments of one pseudo (`:is(.ls-x, .y)`) — alternatives, not an ancestry
    if (a === n) return "elsewhere"
    return compoundInside(container, compoundIndex(container, a), compoundIndex(container, n)) ? "inside" : "elsewhere"
}

/** `data-component` values matching an operator: `[data-component^="Surface"]`. */
function matchingValues(values: Iterable<string>, operator: string, value: string): string[] {
    const test: Record<string, (v: string) => boolean> = {
        "^=": (v) => v.startsWith(value),
        "$=": (v) => v.endsWith(value),
        "*=": (v) => v.includes(value),
        "~=": (v) => v === value,
        "|=": (v) => v === value || v.startsWith(`${value}-`),
        "=": (v) => v === value,
    }
    return [...values].filter(test[operator] ?? (() => false))
}

const MAX_LISTED = 12

/**
 * Ledger entries (selectors the design system itself rewrote) that name one of the legacy classes
 * of `selector` without matching it exactly: the consumer's variant may need the same change.
 */
function ledgerNotes(selector: string, index: MapIndex): string[] {
    if (index.ledger.size === 0) return []
    const classes = new Set(legacyTokens(selector, index).map((t) => t.value))
    const out: string[] = []
    for (const entry of index.ledger.values()) {
        if (!entry.old || !legacyTokens(entry.old, index).some((t) => classes.has(t.value))) continue
        out.push(`the design system rewrote the related selector ${entry.old} → ${entry.kind === "removed" ? "(removed)" : entry.new}${entry.why ? ` (${entry.why})` : ""}: check this one against it`)
        if (out.length === 2) break
    }
    return out
}

/**
 * Rewrites one selector or selector list. `text` is the selector as written (a rule prelude, a
 * querySelector argument, a template with placeholders); the result's offsets index into it.
 */
export function analyzeSelector(text: string, ctx: SelectorContext): SelectorAnalysis {
    const result: SelectorAnalysis = { edits: [], output: text, rewrites: [], findings: [] }
    if (!mayMatter(text, ctx)) return result
    const { index, options } = ctx

    const reportTokens = (reason: Reason, message: string) => {
        for (const t of legacyTokens(text, index)) {
            const known = index.classes.has(t.value) || isPartialClass(index, t.value)
            result.findings.push({ kind: known ? "todo" : "unknown", start: t.start, end: t.end, old: t.value, reason: known ? reason : "unknown", message: known ? message : "not in the migration map" })
        }
    }
    if (INTERPOLATION_RE.test(text)) {
        reportTokens("dynamic", "an interpolated selector — rewrite it by hand with the map's successor")
        return result
    }
    let root: selectorParser.Root
    try {
        root = selectorParser().astSync(text, { lossless: true })
    } catch {
        reportTokens("unparseable", "the selector does not parse — rewrite it by hand with the map's successor")
        return result
    }

    const lines = new LineIndex(text)
    const rangeOf = (node: Node): { start: number; end: number } => {
        const start = node.sourceIndex ?? 0
        const end = node.source?.end ? lines.offset(node.source.end.line, node.source.end.column) + 1 : start + String(node).trim().length
        return { start, end }
    }
    const saneRange = (node: Node, r: { start: number; end: number }): boolean => {
        const s = text.slice(r.start, r.end)
        switch (node.type) {
            case "class":
                return s.startsWith(".")
            case "attribute":
                return s.startsWith("[") && s.endsWith("]")
            case "tag":
                return s.toLowerCase() === node.value.toLowerCase()
            case "pseudo":
                return s.startsWith(":")
            default:
                return s.length > 0
        }
    }

    for (const sel of root.nodes) {
        const real = sel.nodes.filter((n) => n.type !== "comment")
        if (real.length === 0) continue
        const selRange = { start: rangeOf(real[0]).start, end: rangeOf(real[real.length - 1]).end }
        const edits: Edit[] = []
        const notes: string[] = []
        const replaced = new Set<Node>()
        const retagged = new Set<Node>()
        let broken = false
        const edit = (node: Node, replacement: string): boolean => {
            const r = rangeOf(node)
            if (!saneRange(node, r)) {
                broken = true
                return false
            }
            edits.push({ ...r, text: replacement })
            replaced.add(node)
            return true
        }
        const todo = (node: Node, reason: Reason, message: string, suggestion?: string | null, kind: Finding["kind"] = "todo") => {
            const r = rangeOf(node)
            result.findings.push({ kind, ...r, old: text.slice(r.start, r.end), reason, message, ...(suggestion ? { suggestion } : {}) })
        }
        const touchesPlaceholder = (node: Node) => {
            const r = rangeOf(node)
            return /\/\*__elo_expr_\d+__\*\/$/.test(text.slice(0, r.start)) || text.startsWith("/*__elo_expr_", r.end)
        }

        const ledger = index.ledger.size > 0 ? index.ledger.get(normalizeSelector(String(sel))) : undefined
        const finish = () => {
            if (edits.length === 0) return
            const old = text.slice(selRange.start, selRange.end)
            const next = applyEdits(text, edits).slice(selRange.start, selRange.end + edits.reduce((d, e) => d + e.text.length - (e.end - e.start), 0))
            const before = specificityOf(old)
            const after = specificityOf(next)
            const delta = before && after ? compareSpecificity(after, before) : 0
            if (before && after && delta !== 0) {
                notes.push(`specificity ${formatSpecificity(before)} → ${formatSpecificity(after)} (${delta > 0 ? "higher" : "lower"}): check the rules it competes with`)
            }
            if (!ledger) for (const note of ledgerNotes(old, index)) if (!notes.includes(note)) notes.push(note)
            result.edits.push(...edits)
            result.rewrites.push({ ...selRange, old: oneLine(old), new: oneLine(next), notes })
        }

        // ── the ledger: a selector the design system itself rewrote, matched exactly ──────────
        if (ledger) {
            if (ledger.kind === "rewrite" && ledger.new) {
                edits.push({ ...selRange, text: ledger.new })
                notes.push(`the design system rewrote this selector (${ledger.scope}${ledger.why ? `: ${ledger.why}` : ""})`)
            } else {
                result.findings.push({ kind: "todo", ...selRange, old: text.slice(selRange.start, selRange.end), reason: "ledger", message: `the design system removed this selector${ledger.why ? `: ${ledger.why}` : ""}` })
            }
            finish()
            continue
        }

        // ── anchors: the design-system hooks this complex selector (or its nesting parent) names ──
        /** A class the CSS Modules build localized (hashed): the app's own, never a design-system hook. */
        const localized = (node: Node) => Boolean(ctx.cssModule && !ctx.moduleGlobal && !insideGlobal(node) && !afterBareGlobal(node))
        const anchorNodes: Array<{ node: Node; scope: string }> = []
        sel.walk((n) => {
            if (n.type === "class" && localized(n)) return
            for (const scope of scopesOf(n, index)) anchorNodes.push({ node: n, scope })
        })
        const anchors = new Set(anchorNodes.map((a) => a.scope))
        // the nesting parent's hooks: an ancestor of the whole rule, or the element `&` stands for
        const parentScopes = ctx.parentSelector ? parentAnchorScopes(ctx.parentSelector, index, localized) : new Set<string>()
        for (const scope of parentScopes) anchors.add(scope)
        const nestings: Node[] = []
        sel.walk((n) => {
            if (n.type === "nesting") nestings.push(n)
        })
        /**
         * Where `node` sits relative to the nearest hook of one of `scopes`: its element or inside it,
         * elsewhere, or no such hook — or only inside a hook the design system removed (`.ls-color
         * .label`: the swatch's label, not Button's), which anchors nothing: no successor applies there.
         */
        const anchoredAt = (node: Node, scopes: Set<string>): "inside" | "elsewhere" | "removed" | "none" => {
            let found = false
            let removed = false
            for (const a of anchorNodes) {
                if (!scopes.has(a.scope) || a.node === node) continue
                found = true
                if (positionOf(a.node, node) !== "inside") continue
                if (!index.removedScopes.has(a.scope)) return "inside"
                removed = true
            }
            const parents = [...scopes].filter((s) => parentScopes.has(s))
            if (parents.length > 0) {
                found = true
                if (nestings.length === 0 || nestings.some((amp) => amp === node || positionOf(amp, node) === "inside")) {
                    if (parents.some((s) => !index.removedScopes.has(s))) return "inside"
                    removed = true
                }
            }
            return removed ? "removed" : found ? "elsewhere" : "none"
        }

        const retag = (typeNode: Node | undefined, entry: { identity?: string }, what: string): boolean => {
            if (!typeNode || !entry.identity || retagged.has(typeNode)) return false
            if (!edit(typeNode, entry.identity)) return false
            retagged.add(typeNode)
            notes.push(`${what} renders <${entry.identity}> now: ${typeNode.value} → ${entry.identity}`)
            return true
        }
        const genericType = (members: Node[]) => members.find((m) => m.type === "tag" && /^(div|span)$/i.test(m.value))

        const rewriteEntry = (node: Node, entry: ClassEntry) => {
            const { members, first } = compoundOf(node)
            const typeNode = entry.identityKind === "tag" ? genericType(members) : undefined
            const what = entry.component ?? entry.identity ?? "the element"
            if (options.roots === "identity" && entry.identity) {
                if (entry.identityKind === "tag") {
                    // a div / span root is the custom tag — also for a polymorphic component (its other forms are native elements)
                    if (typeNode && !retagged.has(typeNode)) {
                        retag(typeNode, entry, what)
                        edit(node, "")
                    } else if (entry.polymorphic) edit(node, entry.identitySelector ?? `:is(${entry.identity},[${entry.identity}])`)
                    else if (first && !members.some((m) => m !== node && (m.type === "tag" || m.type === "universal"))) edit(node, entry.identity)
                    else edit(node, `:is(${entry.identity})`)
                } else edit(node, entry.identitySelector ?? `[${entry.identity}]`)
                return
            }
            if (!entry.selector) {
                todo(node, "class", "the map has no selector for this class")
                return
            }
            if (edit(node, entry.selector)) retag(typeNode, entry, what)
        }

        const literal = (node: Node, name: string): boolean => {
            const entry = index.literals.get(name)
            if (!entry || options.literals === "off") return false
            // a class CSS Modules localized is the app's own, whatever its name
            if (localized(node)) return false
            const scopes = index.literalScopes.get(name) ?? new Set<string>()
            const at = options.literals === "all" ? "inside" : anchoredAt(node, scopes)
            if (at === "none") return false
            if (at === "removed") {
                todo(node, "literal", "only a design-system hook that was removed (no successor) holds this class here, so none of its successors applies — rewrite the rule by hand")
                return true
            }
            if ((entry.kind === "part" || entry.kind === "tag") && entry.selector && !entry.pending) {
                if (at === "elsewhere") {
                    // the hook is named, but not as this element or an ancestor of it (`.content .ls-button`, `.ls-button + .content`)
                    todo(node, "literal", `the design system printed this class only on or inside its component's element, and this selector puts it elsewhere — rewrite by hand if you meant the design system's: ${entry.replacement}`, entry.selector)
                    return true
                }
                const { members, first } = compoundOf(node)
                const canType = first && !members.some((m) => m !== node && (m.type === "tag" || m.type === "universal"))
                edit(node, spliceable(entry.selector, canType))
                return true
            }
            const pending = entry.pending ? ` (pending ${entry.pending}: the successor is not final yet)` : ""
            todo(node, "literal", `${entry.kind === "removed" ? "removed — " : `${entry.kind} — `}${entry.replacement}${pending}`, entry.selector ?? entry.plannedSelector)
            return true
        }

        /**
         * A legacy class / data-component value the app puts on its own elements too (`className="ls-dropdown"`,
         * `data-component="Sidebar"`): the rule styles the app's element as well, and the successor would
         * stop matching it — a TODO, never a rewrite.
         */
        const appHook = (node: Node, kind: "class" | "data-component", name: string, suggestion?: string | null): boolean => {
            const where = kind === "class" ? ctx.applied?.classes.get(name) : ctx.applied?.dataComponent.get(name)
            if (!where) return false
            const what = kind === "class" ? `the class ${name}` : `data-component="${name}"`
            todo(
                node,
                "app-hook",
                `the app puts ${what} on its own element too (${where}), so this rule styles that element as well — the successor would stop matching it: rename the app's hook here and there, or, if the rule is only for the design system's element, select the successor`,
                suggestion,
            )
            return true
        }

        const classAttribute = (node: selectorParser.Attribute, value: string) => {
            const tokens = value.split(/\s+/).filter(Boolean)
            const legacy = tokens.filter((t) => hasPrefix(t, index.classPrefixes) || index.literals.has(t))
            if (legacy.length === 0 && !hasPrefix(value, index.classPrefixes)) return
            if (node.operator === "~=" && tokens.length === 1) {
                const entry = index.classes.get(tokens[0])
                if (entry && entry.kind !== "removed" && entry.selector) {
                    if (appHook(node, "class", tokens[0], entry.selector)) return
                    edit(node, entry.selector)
                    return
                }
                if (!entry && !index.literals.has(tokens[0])) {
                    todo(node, "unknown", "not in the migration map", null, "unknown")
                    return
                }
            }
            const substring = node.operator && node.operator !== "=" && node.operator !== "~="
            const matches = substring ? [...index.classes.keys()].filter((c) => matchingValues([c], node.operator!, value).length > 0 || (node.operator === "*=" && c.includes(value))) : legacy
            const sels = matches.map((c) => index.classes.get(c)?.selector).filter(Boolean) as string[]
            todo(
                node,
                "class-attribute",
                `the design system renders no class attribute any more${substring ? ` — this matched ${matches.length} legacy classes` : ""}; select the part attribute${sels.length === 1 ? "" : "s"}`,
                sels.length === 0 ? null : node.operator === "=" && !substring ? sels.join("") : sels.length <= MAX_LISTED ? `:is(${sels.join(", ")})` : null,
            )
        }

        sel.walk((node) => {
            if (broken) return
            if (node.type === "class") {
                const name = node.value
                if (hasPrefix(name, index.classPrefixes)) {
                    if (touchesPlaceholder(node) || isCutShort(index, name)) {
                        todo(node, "dynamic", "a legacy class name built from an expression — write the successor selector by hand")
                        return
                    }
                    const entry = index.classes.get(name)
                    if (!entry) {
                        if (!index.literals.has(name)) todo(node, "unknown", `not in the migration map${unknownHint(index, name) || " (another library's class, a typo, or newer than the map)"}`, null, "unknown")
                        else literal(node, name)
                        return
                    }
                    if (entry.kind === "removed") {
                        todo(node, "removed", `${entry.note ?? "the design system has no successor"}${entry.pending ? ` (pending ${entry.pending})` : ""}`)
                        return
                    }
                    if (localized(node)) {
                        // CSS Modules hashed it: it only ever matched the app's own elements (styles["ls-x"]),
                        // never the design system's — rewriting it would change what the rule applies to
                        todo(
                            node,
                            "class",
                            "CSS Modules localized this class, so it never matched the design system — it is the app's own (rename it), unless you meant the design system's element: then select the successor (an attribute, never localized)",
                            entry.selector,
                        )
                        return
                    }
                    if (appHook(node, "class", name, entry.selector)) return
                    rewriteEntry(node, entry)
                    return
                }
                literal(node, name)
                return
            }
            if (node.type === "nesting") {
                const next = node.next()
                if (next && next.type === "tag" && /^[-_a-zA-Z0-9]/.test(next.value) && (next.sourceIndex ?? 0) === rangeOf(node).end && ctx.syntax !== "css") {
                    const parentLegacy = ctx.parentSelector ? legacyTokens(ctx.parentSelector, index) : []
                    if (parentLegacy.length > 0) {
                        const suffix = next.value
                        const candidates = parentLegacy.map((t) => index.classes.get(`${t.value}${suffix}`)).filter((e): e is ClassEntry => Boolean(e?.selector))
                        const r = { start: rangeOf(node).start, end: rangeOf(next).end }
                        result.findings.push({
                            kind: "todo",
                            ...r,
                            old: text.slice(r.start, r.end),
                            reason: "bem",
                            message: `concatenates onto the legacy class ${parentLegacy.map((t) => `.${t.value}`).join(", ")} — a part attribute can't be built by suffixing; write the successor (at the top level or with @at-root)`,
                            ...(candidates.length === 1 ? { suggestion: `@at-root ${candidates[0].selector}` } : {}),
                        })
                    }
                }
                return
            }
            if (node.type !== "attribute") return
            const attr = node.attribute.toLowerCase()
            const value = node.value ?? ""
            if (/__elo_expr_\d+__/.test(value) && (attr === "data-component" || attr === "class" || index.hookAttributes.has(attr))) {
                todo(node, "dynamic", `[${node.attribute}] compares against an interpolated value — write the successor by hand`)
                return
            }
            if (attr === "data-component") {
                if (!node.operator) {
                    todo(node, "data-component", "data-component is gone and every design-system element carried it — select the identities (tags / markers) you mean")
                    return
                }
                if (node.operator !== "=") {
                    const values = matchingValues(index.dataComponent.keys(), node.operator, value)
                    const sels = values.map((v) => index.dataComponent.get(v)!.selector)
                    todo(node, "data-component", `data-component is gone; the values this matched: ${values.join(", ") || "none in the map"}`, sels.length === 1 ? sels[0] : sels.length > 0 && sels.length <= MAX_LISTED ? `:is(${sels.join(", ")})` : null)
                    return
                }
                const entry = index.dataComponent.get(value)
                if (!entry) {
                    todo(node, "unknown", `data-component "${value}" is not in the migration map`, null, "unknown")
                    return
                }
                if (appHook(node, "data-component", value, entry.selector)) return
                const { members } = compoundOf(node)
                const typeNode = entry.identityKind === "tag" ? genericType(members) : undefined
                if (typeNode && !retagged.has(typeNode) && entry.partSelector) {
                    if (edit(node, entry.partSelector)) retag(typeNode, entry, entry.component ?? value)
                } else edit(node, entry.selector)
                return
            }
            if (attr === "class") {
                classAttribute(node, value)
                return
            }
            if (index.hookAttributes.has(attr) && node.operator === "=") {
                const candidates = index.dataPart.get(`[${attr}=${JSON.stringify(value)}]`) ?? []
                if (candidates.length === 0) return
                // a hook of the scope's element or an ancestor of it anchors the value; one named elsewhere only flags it
                const inside = candidates.filter((c) => c.scope && anchoredAt(node, new Set([c.scope])) === "inside")
                const elsewhere = candidates.filter((c) => c.scope && !inside.includes(c) && anchors.has(c.scope) && !index.removedScopes.has(c.scope))
                const pick = (c: HookEntry) => {
                    edit(node, c.selector)
                    if (c.note) notes.push(c.note)
                }
                if (inside.length === 1) pick(inside[0])
                else if (inside.length > 1 || (inside.length === 0 && options.literals === "all" && candidates.length > 1)) {
                    const list = inside.length > 1 ? inside : candidates
                    todo(node, "data-part", `[${attr}="${value}"] was used by several scopes (${list.map((c) => c.part ?? c.scope).join(", ")}) — pick the one you meant`, `:is(${list.map((c) => c.selector).join(", ")})`)
                } else if (inside.length === 0 && options.literals === "all") pick(candidates[0])
                else if (elsewhere.length > 0) {
                    todo(
                        node,
                        "data-part",
                        `[${attr}="${value}"] was a part of ${elsewhere.map((c) => c.part ?? c.scope).join(", ")}, but this selector does not put it inside that component's element — rewrite by hand if you meant it`,
                        elsewhere.length === 1 ? elsewhere[0].selector : `:is(${elsewhere.map((c) => c.selector).join(", ")})`,
                    )
                }
            }
        })

        // ── :global(x) with nothing left to globalize → x ────────────────────────────────────
        sel.walk((node) => {
            if (broken || ctx.keepGlobal || !isGlobal(node) || node.nodes.length !== 1) return
            const inner = node.nodes[0]
            let touched = false
            let classLeft = false
            inner.walk((n) => {
                if (replaced.has(n)) touched = true
                else if (n.type === "class" || n.type === "id") classLeft = true
            })
            const real = inner.nodes.filter((n) => n.type !== "comment")
            if (!touched || classLeft || real.length === 0) return
            const outer = rangeOf(node)
            const first = rangeOf(real[0]).start
            const last = rangeOf(real[real.length - 1]).end
            if (!text.slice(outer.start, first).includes("(") || !text.slice(last, outer.end).includes(")")) return
            edits.push({ start: outer.start, end: first, text: "" }, { start: last, end: outer.end, text: "" })
        })

        if (broken) {
            result.findings.push({
                kind: "todo",
                ...selRange,
                old: text.slice(selRange.start, selRange.end),
                reason: "unparseable",
                message: "could not locate the selector's parts exactly — rewrite it by hand",
            })
            continue
        }
        finish()
    }
    result.output = result.edits.length > 0 ? applyEdits(text, result.edits) : text
    return result
}
