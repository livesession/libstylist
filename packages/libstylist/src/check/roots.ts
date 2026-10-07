// Root analysis (R1xx): every non-empty render branch of an exported component has exactly one
// identity element — its custom tag, or a native semantic element with its marker — whose cx() call
// receives the component's props and carries the root part its sheet binds. A branch may wrap the identity element
// in plain structure (Button's `<label>`, FilterEditor's indent `<div>`) or in another design-system
// component's children (Button's `<Tooltip>{button}</Tooltip>`, slot identity) as long as exactly one
// descendant carries the identity. A component with no DOM of its own forwards its marker onto a
// delegate (`<Modal elo-modalconfirm {...cx(rest)}>`) whose identity element receives stylist props —
// and passes its own props to the delegate with the marker, like any identity element (R112). A
// component of a libstylist library outside the sources (an app rooting on the design system's
// `<Table crm-accounts {...cx(cn.root, rest)}>`) is such a delegate too, its forwarding assumed — unless
// its library marks it `@libstylistRoot none`: it has no DOM for the marker to reach.
//
// Two facts are tracked separately: whether a component *conforms* (its problems) and whether stylist
// props given to it *reach* the DOM (`forwards`, used for marker forwarding and S307). An unmigrated
// component that spreads `{...rest}` onto a delegate still passes a caller's marker along.
import ts from "typescript"

import { GENERIC_ROOT_TAGS, TAG_RE } from "../conventions/index.js"
import type { Registry } from "../registry/index.js"
import type { ExemptionCategory } from "./config.js"
import type { CxReader } from "./cx.js"
import type { ComponentEntry } from "./exports.js"
import { isIdentityName } from "./migration.js"
import { MAX_ALTS, isElementItem, itemKey, product, short, type Alt, type Alts, type ElementItem, type Item, type RenderEvaluator } from "./render.js"
import type { RuleId } from "./rules.js"
import { exportName } from "../registry/modules.js"
import { rootBindingFor, type RootBinding } from "./sheets.js"
import { jsxAttrName, jsxAttributes, jsxSpreads, jsxTagText, openingOf, unwrapExpr } from "./ts-util.js"

export interface Problem {
    rule: RuleId
    node: ts.Node
    message: string
    /** Exemption categories that allow this problem. */
    waivers: ExemptionCategory[]
}

export interface IdentityHit {
    /** The element carrying the identity (for forwarded markers, the delegate element). */
    el: ts.JsxOpeningLikeElement
    item: ElementItem
    /** `tag`: custom tag; `marker`: marker on a native/third-party element; `forwarded`: marker passed to a delegate. */
    form: "tag" | "marker" | "forwarded"
    /** The identity names the element declares. */
    names: string[]
    /** Every part it carries through its cx() spreads (own and asChild wrappers). */
    parts: Array<{ scope: string; part: string; static: boolean }>
    /** True when stylist props given to the component reach this element's DOM. */
    forwards: boolean
    binding: RootBinding | null
    /** True when it can render as the custom tag itself (a tag root, or a polymorphic union that includes the tag). */
    rendersTag: boolean
    /** The wrapper element around it (`<label>`, a delegate whose children carry it), if any. */
    wrapper: ts.JsxOpeningLikeElement | null
}

export interface RootAnalysis {
    component: ComponentEntry
    /** Every problem, before the exemption is applied. */
    problems: Problem[]
    identities: IdentityHit[]
    /** Non-empty branches seen. */
    branches: number
    /** True when stylist props given to the component reach its DOM in every non-empty branch. */
    forwards: boolean
    /** True when some root (or wrapped descendant) declares an identity name of the prefix — a sign the component was migrated. */
    sawIdentity: boolean
}

interface BranchResult {
    empty: boolean
    /** Stylist props reach the DOM. */
    forwards: boolean
}

interface Ctx {
    component: ComponentEntry
    expected: string
    label: string
    problems: Problem[]
    identities: IdentityHit[]
    branches: number
    sawIdentity: boolean
    /** Wrapper descent results per item key. */
    descents: Map<string, Descent>
}

/** Identity elements found below a wrapper, per render path (deduplicated); `overflow` when there were too many paths. */
type Descent = { paths: ElementItem[][]; overflow: boolean }

const DATA_ARIA = /^(data|aria)-/
const MAX_DESCENT_DEPTH = 32
/** The reason of an opaque item that stands for too many render paths (not a DOM-less root). */
const OVERFLOW = /more than \d+ render paths/

/** Analyzes component roots; memoized per component, cycle-safe for delegate chains. */
export class RootAnalyzer {
    private readonly memo = new Map<ComponentEntry, RootAnalysis>()
    private readonly inProgress = new Set<ComponentEntry>()
    private readonly fileFacts = new Map<ts.SourceFile, { identities: Set<string>; carriesDefaultRoot: boolean }>()

    constructor(
        private readonly evaluator: RenderEvaluator,
        private readonly registry: Registry,
        private readonly prefix: string,
        private readonly checker: ts.TypeChecker,
        readonly cx: CxReader,
    ) {}

    /** A file's own sheet: the scope most of its part-map members read (cached by the reader). */
    scopeOf(sf: ts.SourceFile): string | null {
        return this.cx.primaryScopeOf(sf)
    }

    /** Analyzes one component. */
    analyze(component: ComponentEntry): RootAnalysis {
        const hit = this.memo.get(component)
        if (hit) return hit
        if (!component.tag) {
            // C002 already reports the path; without a tag there is nothing to check the root against
            const none: RootAnalysis = { component, problems: [], identities: [], branches: 0, forwards: false, sawIdentity: false }
            this.memo.set(component, none)
            return none
        }
        this.inProgress.add(component)
        const ctx: Ctx = {
            component,
            expected: component.tag,
            label: component.path.join("."),
            problems: [],
            identities: [],
            branches: 0,
            sawIdentity: false,
            descents: new Map(),
        }
        const alts = this.evaluator.component(component.impl)
        const results = alts.map((alt) => this.checkAlt(alt, ctx))
        const nonEmpty = results.filter((r) => !r.empty)
        if (!nonEmpty.length) {
            ctx.problems.push({
                rule: "R100",
                node: component.impl,
                message: `${ctx.label} renders nothing in any branch — a component with no DOM of its own is marked \`@libstylistRoot none <reason>\``,
                waivers: ["none"],
            })
        }
        const analysis: RootAnalysis = {
            component,
            problems: ctx.problems,
            identities: ctx.identities,
            branches: ctx.branches,
            forwards: nonEmpty.length > 0 && nonEmpty.every((r) => r.forwards),
            sawIdentity: ctx.sawIdentity,
        }
        this.inProgress.delete(component)
        this.memo.set(component, analysis)
        return analysis
    }

    /** True when stylist props given to `component` reach its DOM (for S307 and marker forwarding). */
    forwards(component: ComponentEntry): boolean {
        if (this.inProgress.has(component)) return true
        return this.analyze(component).forwards
    }

    // --- branches --------------------------------------------------------------------------------

    /**
     * Records a problem. `waivers` are the exemption categories that excuse it — each one only what
     * its category is for: `none` a root with no DOM of its own (nothing, passed-through content, an
     * unknown call, text, a DOM-less third-party wrapper), `multi` unstyled sibling roots, `native` a
     * marker on a generic or third-party host. Everything else is never waivable.
     */
    private add(ctx: Ctx, rule: RuleId, node: ts.Node, message: string, waivers: ExemptionCategory[] = []): void {
        ctx.problems.push({ rule, node, message, waivers })
    }

    private checkAlt(alt: Alt, ctx: Ctx): BranchResult {
        const inPlace = alt.filter((i) => i.kind !== "portal")
        const portals = alt.filter((i): i is Extract<Item, { kind: "portal" }> => i.kind === "portal")
        if (!inPlace.length) {
            if (!portals.length) return { empty: true, forwards: true }
            const inner = product(portals[0].node, portals.map((p) => p.content))
                .map((a) => this.checkAlt(a, ctx))
                .filter((r) => !r.empty)
            return inner.length ? { empty: false, forwards: inner.every((r) => r.forwards) } : { empty: true, forwards: true }
        }
        ctx.branches++
        const { label, expected } = ctx
        const want = `<${expected}>`

        const roots = inPlace.map((item) => ({ item, names: isElementItem(item) ? this.identityNames(item) : [] }))
        if (roots.some((r) => r.names.length)) ctx.sawIdentity = true
        const ids = roots.filter((r) => r.names.length > 0) as Array<{ item: ElementItem; names: string[] }>
        const others = roots.filter((r) => r.names.length === 0).map((r) => r.item)

        if (ids.length > 1) {
            this.add(ctx, "R104", ids[1].item.el, `${label} renders ${ids.length} identity elements in one branch (${ids.map((x) => describe(x.item)).join(", ")}) — exactly one element names a component`)
            ids.forEach((x) => this.checkIdentity(x.item, x.names, ctx, null))
            return { empty: false, forwards: false }
        }
        if (ids.length === 1) {
            if (others.length) this.siblings(ctx, describe(ids[0].item), others)
            return { empty: false, forwards: this.checkIdentity(ids[0].item, ids[0].names, ctx, null) }
        }

        // no root declares an identity: a wrapper branch carries it below
        const descents = roots.map((r) => ({ item: r.item, descent: isElementItem(r.item) ? this.descend(r.item, ctx) : null }))
        const carriers = descents.filter((c): c is { item: ElementItem; descent: Descent } => !!c.descent && c.descent.paths.some((p) => p.length > 0))
        if (!carriers.length) {
            const unknown = descents.find((c) => c.descent?.overflow)
            if (unknown && isElementItem(unknown.item)) {
                this.add(ctx, "R105", unknown.item.el, `${label}'s root ${describe(unknown.item)} has more than ${MAX_ALTS} render paths below it — the checker can't tell whether it wraps ${want}; simplify the branch or render ${want} at the root`)
                return { empty: false, forwards: false }
            }
            if (inPlace.length > 1) {
                this.add(ctx, "R104", nodeOf(inPlace[0]), `${label} renders ${inPlace.length} roots (${inPlace.map(describe).join(", ")}) and none is ${want} — render one identity element around them`)
                return { empty: false, forwards: false }
            }
            return this.checkNonIdentity(inPlace[0], ctx)
        }
        if (carriers.length > 1) {
            this.add(ctx, "R104", carriers[1].item.el, `${label} renders its identity inside ${carriers.length} sibling roots (${carriers.map((c) => describe(c.item)).join(", ")}) — exactly one element names a component`)
            return { empty: false, forwards: false }
        }
        const carrier = carriers[0]
        const rest = inPlace.filter((i) => i !== carrier.item)
        if (rest.length) this.siblings(ctx, describe(carrier.item), rest)
        return { empty: false, forwards: this.checkWrapper(carrier.item, carrier.descent, ctx) }
    }

    private siblings(ctx: Ctx, root: string, others: Item[]): void {
        this.add(
            ctx,
            "R104",
            nodeOf(others[0]),
            `${ctx.label} renders ${root} next to ${others.length} sibling root${others.length > 1 ? "s" : ""} (${others.map(describe).join(", ")}) — move ${others.length > 1 ? "them" : "it"} inside, or mark \`@libstylistRoot multi <reason>\``,
            ["multi"],
        )
    }

    /**
     * A wrapper branch: a native element (or a delegate / third-party component) authored by the
     * component, with the identity element among its descendants — exactly one on every render path.
     */
    private checkWrapper(wrapper: ElementItem, descent: Descent, ctx: Ctx): boolean {
        const { label, expected } = ctx
        const desc = describe(wrapper)
        let ok = true
        if (!descent.overflow && descent.paths.some((p) => p.length === 0)) {
            ok = false
            if (wrapper.kind === "delegate" || wrapper.kind === "libstylist-delegate") this.add(ctx, "R106", wrapper.el, `${label} renders ${desc} and only sometimes its own <${expected}> inside it — the identity element must be there in every branch`)
            else this.add(ctx, "R109", wrapper.el, `${label} wraps its identity in ${desc}, but <${expected}> is rendered inside it only on some paths — render it unconditionally, or return the wrapper only when it has the identity inside`)
        }
        if (descent.overflow) {
            ok = false
            this.add(ctx, "R105", wrapper.el, `${label} wraps its identity in ${desc}, whose content has more than ${MAX_ALTS} render paths — the checker can't verify there is exactly one <${expected}> in each`)
        }
        const multiple = descent.paths.find((p) => p.length > 1)
        if (multiple) {
            ok = false
            this.add(ctx, "R104", multiple[1].el, `${label} renders ${multiple.length} identity elements inside ${desc} (${multiple.map(describe).join(", ")}) — exactly one element names a component`)
        }
        const distinct = new Map<string, ElementItem>()
        for (const path of descent.paths) for (const item of path) distinct.set(itemKey(item), item)
        let reach = true
        for (const item of distinct.values()) if (!this.checkIdentity(item, this.identityNames(item), ctx, wrapper.el)) reach = false
        return ok && reach
    }

    /** Identity elements naming this component below `item`, per render path. */
    private descend(item: ElementItem, ctx: Ctx, depth = 0): Descent {
        const key = itemKey(item)
        const cached = ctx.descents.get(key)
        if (cached) return cached
        const result = depth > MAX_DESCENT_DEPTH ? { paths: [[]], overflow: false } : this.descendAlts(item.children(), ctx, depth + 1)
        ctx.descents.set(key, result)
        return result
    }

    private descendAlts(alts: Alts, ctx: Ctx, depth: number): Descent {
        const out = new Map<string, ElementItem[]>()
        let overflow = false
        for (const alt of alts) {
            let acc: ElementItem[][] = [[]]
            for (const item of alt) {
                let sub: Descent
                if (item.kind === "opaque" && OVERFLOW.test(item.reason)) sub = { paths: [[]], overflow: true }
                else if (!isElementItem(item)) sub = { paths: [[]], overflow: false }
                else if (this.identityNames(item).includes(ctx.expected)) sub = { paths: [[item]], overflow: false }
                else sub = this.descend(item, ctx, depth)
                if (sub.overflow) overflow = true
                const next: ElementItem[][] = []
                const seen = new Set<string>()
                for (const a of acc) {
                    for (const b of sub.paths) {
                        const path = [...a, ...b]
                        const k = path.map(itemKey).join(";")
                        if (seen.has(k)) continue
                        seen.add(k)
                        next.push(path)
                    }
                }
                if (next.length > MAX_ALTS) return { paths: [[]], overflow: true }
                acc = next
            }
            for (const path of acc) out.set(path.map(itemKey).join(";"), path)
        }
        return { paths: out.size ? [...out.values()] : [[]], overflow }
    }

    /** A branch whose single root declares no identity and wraps none. */
    private checkNonIdentity(item: Item, ctx: Ctx): BranchResult {
        const { label, expected } = ctx
        const want = `<${expected}>`
        const reach = isElementItem(item) && this.reaches(item)
        const fail: BranchResult = { empty: false, forwards: reach }
        switch (item.kind) {
            case "host": {
                if (GENERIC_ROOT_TAGS.includes(item.tag)) this.add(ctx, "R101", item.el, `${label}'s root is a generic <${item.tag}> — render ${want} instead (div and span roots become the custom tag)`)
                else if (item.tag.includes("-") || item.tag.includes(":")) this.add(ctx, "R103", item.el, `${label}'s root is <${item.tag}>, not ${want}`)
                else this.add(ctx, "R102", item.el, `${label}'s root <${item.tag}> has no marker — write <${item.tag} ${expected}>`)
                return fail
            }
            case "tagvar": {
                this.add(ctx, "R102", item.el, `${label}'s polymorphic root <${item.name}> has no marker — write <${item.name} ${expected}>`)
                this.checkPolymorphic(item, ctx)
                return fail
            }
            case "foreign":
                this.add(
                    ctx,
                    "R105",
                    item.el,
                    `${label}'s root is the third-party component <${item.name}> — render ${want} around it, or put the marker on it (<${item.name} ${expected}>) with \`@libstylistRoot native <reason>\``,
                    ["none"],
                )
                return fail
            case "text":
                this.add(ctx, "R105", item.node, `${label} renders bare text at its root — wrap it in ${want}`, ["none"])
                return fail
            case "opaque":
                this.add(ctx, "R105", item.node, `${label}'s root can't be verified: it ${item.reason} — render ${want} around it, or mark \`@libstylistRoot none <reason>\` when it renders no DOM of its own`, OVERFLOW.test(item.reason) ? [] : ["none"])
                return fail
            case "delegate":
            case "libstylist-delegate": {
                const tag = jsxTagText(item.el.tagName)
                if (item.kind === "libstylist-delegate" && item.domless) this.add(ctx, "R106", item.el, `${label} renders <${tag}> without an identity of its own, and <${tag}> renders no DOM (its library marks it \`@libstylistRoot none\`) — render ${want} around it or inside it`)
                else this.add(ctx, "R106", item.el, `${label} renders <${tag}> without an identity of its own — forward the marker (<${tag} ${expected} {...cx(rest)}>) or render ${want} inside it`)
                return fail
            }
            case "portal":
                return { empty: false, forwards: false }
        }
    }

    /** Validates one identity element; returns whether stylist props reach it. */
    private checkIdentity(item: ElementItem, names: string[], ctx: Ctx, wrapper: ts.JsxOpeningLikeElement | null): boolean {
        const { label, expected } = ctx
        const desc = describe(item)
        ctx.sawIdentity = true
        if (!names.includes(expected)) {
            this.add(ctx, "R103", item.el, `${label}'s identity element is ${desc}, but its tag is <${expected}> (from the export path ${label})`)
            return false
        }
        let form: IdentityHit["form"] = "marker"
        switch (item.kind) {
            case "host":
                if (item.tag === expected) form = "tag"
                else if (GENERIC_ROOT_TAGS.includes(item.tag))
                    this.add(ctx, "R101", item.el, `${label} puts its marker on a generic <${item.tag}> — render <${expected}> instead (a marker never goes on div/span; third-party hosts: \`@libstylistRoot native <reason>\`)`, ["native"])
                break
            case "tagvar":
                this.checkPolymorphic(item, ctx)
                break
            case "foreign":
                this.add(ctx, "R105", item.el, `${label} puts its marker on the third-party component <${item.name}> — allowed only for third-party-managed hosts, marked \`@libstylistRoot native <reason>\``, ["native"])
                break
            case "delegate":
                form = "forwarded"
                if (!this.forwards(item.target))
                    this.add(ctx, "R106", item.el, `${label} forwards ${expected} onto <${jsxTagText(item.el.tagName)}>, but ${item.target.path.join(".")} doesn't pass stylist props to its identity element — the marker never reaches the DOM`)
                break
            case "libstylist-delegate":
                // its library's checker holds it to R112: the marker and parts reach its identity element —
                // unless it has none (`@libstylistRoot none` in its declaration)
                form = "forwarded"
                if (item.domless)
                    this.add(ctx, "R106", item.el, `${label} forwards ${expected} onto <${jsxTagText(item.el.tagName)}>, which renders no DOM (its library marks it \`@libstylistRoot none\`) — the marker never reaches the DOM; render <${expected}> around it or inside it`)
                break
        }
        const elements = [...item.via, item.el]
        const reach = this.reaches(item)
        // R110: the marker is value-less (cx() forwards only "" values)
        for (const el of elements) {
            const attr = jsxAttributes(el).find((a) => jsxAttrName(a) === expected)
            if (attr?.initializer && !isEmptyString(attr.initializer)) {
                this.add(ctx, "R110", attr, `${label}'s marker ${expected} has a value — write it value-less (<${jsxTagText(el.tagName)} ${expected}>); cx() only forwards "" values, so a valued marker never reaches the DOM through a delegate`, [])
            }
        }
        // R112: the identity element's cx() receives the props — a forwarded marker's delegate element too
        // (`<Modal elo-modalconfirm {...cx(rest)}>`: the caller's parts ride on it with the marker)
        if (!elements.some((el) => jsxSpreads(el).some((s) => this.mayForward(s.expression)))) {
            const hint = form === "forwarded" ? `<${jsxTagText(item.el.tagName)} ${expected} {...cx(rest)}>` : `{...cx(${this.rootPartText(item.el.getSourceFile(), expected)}, rest)}`
            this.add(ctx, "R112", item.el, `${label}'s identity element ${desc} doesn't pass the component's props (its props parameter, rest or named slot) to its cx() call (${hint}) — wrappers, parents and apps can't attach markers or parts to it`, [])
        } else {
            const blocked = item.inline.find((site) => !jsxSpreads(site).some((s) => this.mayForward(s.expression)))
            if (blocked) {
                const tag = jsxTagText(blocked.tagName)
                this.add(ctx, "R112", blocked, `${label}'s identity element ${desc} is rendered by <${tag}>, which receives no stylist props — pass them: <${tag} {...cx(rest)}>`, [])
            }
        }
        // R113: the bound root part
        const sf = item.el.getSourceFile()
        const fileScope = this.scopeOf(sf)
        const binding = rootBindingFor(this.registry, expected, fileScope)
        const parts: IdentityHit["parts"] = elements.flatMap((el) => this.cx.partsOf(el).map((p) => ({ scope: p.scope, part: p.part, static: true })))
        const hasCx = elements.some((el) => this.cx.partsOf(el).length > 0)
        if (binding && !parts.some((p) => p.scope === binding.scope && p.part === binding.local) && !this.ambiguousDefault(binding, sf, hasCx)) {
            const why = binding.source === "registry" ? `the ${binding.scope} sheet binds it with @stylist root` : `the ${binding.scope} sheet's root part`
            const map = this.cx.localOf(sf, binding.scope) ?? exportName(binding.scope)
            this.add(ctx, "R113", item.el, `${label}'s identity element ${desc} must carry its root part — add the ${binding.scope} part map's ${binding.local} to its cx() call: {...cx(${memberText(map, binding.local)}, rest)} (${why})`, [])
        }
        const rendersTag = form === "tag" || (item.kind === "tagvar" && !!item.members?.includes(expected))
        ctx.identities.push({ el: item.el, item, form, names, parts, forwards: reach, binding, rendersTag, wrapper })
        return reach
    }

    /** The identity's bound root part as the file would write it (`cn.root`, `cn.header`), for messages. */
    private rootPartText(sf: ts.SourceFile, tag: string): string {
        const binding = rootBindingFor(this.registry, tag, this.scopeOf(sf))
        if (!binding) return "cn.root"
        return memberText(this.cx.localOf(sf, binding.scope) ?? exportName(binding.scope), binding.local)
    }

    /**
     * The implied `<scope>:root` binding is ambiguous in a file with several identity elements — which
     * one the sheet's root belongs to is not known. As in the ESLint `root-part` rule, nothing is
     * reported when another identity element of the file carries it, or when this one already carries
     * parts; an unused root part is S301's to report.
     */
    private ambiguousDefault(binding: RootBinding, sf: ts.SourceFile, hasCx: boolean): boolean {
        if (binding.source !== "default") return false
        const facts = this.factsOf(sf)
        if (facts.identities.size <= 1) return false
        return facts.carriesDefaultRoot || hasCx
    }

    private factsOf(sf: ts.SourceFile): { identities: Set<string>; carriesDefaultRoot: boolean } {
        const cached = this.fileFacts.get(sf)
        if (cached) return cached
        const scope = this.scopeOf(sf)
        const facts = { identities: new Set<string>(), carriesDefaultRoot: false }
        const visit = (node: ts.Node): void => {
            if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
                const el = openingOf(node)
                const names = this.elementIdentityNames(el)
                for (const n of names) facts.identities.add(n)
                if (names.length && scope && this.cx.partsOf(el).some((p) => p.scope === scope && p.part === "root")) facts.carriesDefaultRoot = true
            }
            ts.forEachChild(node, visit)
        }
        visit(sf)
        this.fileFacts.set(sf, facts)
        return facts
    }

    private checkPolymorphic(item: Extract<ElementItem, { kind: "tagvar" }>, ctx: Ctx): void {
        const { label } = ctx
        if (!item.members) {
            this.add(ctx, "R107", item.el, `${label}'s polymorphic root <${item.name}> has type \`${item.typeText}\` — narrow it to a finite union of string literals ("button" | "a")`)
            return
        }
        const generic = item.members.filter((m) => GENERIC_ROOT_TAGS.includes(m))
        if (generic.length) {
            this.add(
                ctx,
                "R108",
                item.el,
                `${label}'s polymorphic root <${item.name}> can render ${generic.map((g) => `<${g}>`).join(" or ")} — a marker never goes on a generic tag; render those branches as <${ctx.expected}> and drop ${generic.join("/")} from \`${item.typeText}\``,
                ["native"],
            )
        }
    }

    // --- element facts ---------------------------------------------------------------------------

    /** Identity names an element declares: its prefixed custom tag and every prefixed marker (asChild wrappers included). */
    identityNames(item: ElementItem): string[] {
        return [...new Set([...item.via, item.el].flatMap((el) => this.elementIdentityNames(el)))]
    }

    /** The identity names written on one element (its tag when it is a custom tag of the prefix, and its markers). */
    elementIdentityNames(el: ts.JsxOpeningLikeElement): string[] {
        const names: string[] = []
        if (ts.isIdentifier(el.tagName) && isIdentityName(el.tagName.text, this.prefix)) names.push(el.tagName.text)
        for (const attr of jsxAttributes(el)) {
            const name = jsxAttrName(attr)
            if (isIdentityName(name, this.prefix)) names.push(name)
        }
        return names
    }

    /**
     * True when stylist props given to the component reach this element (a spread that may carry them on
     * it and on every inline hop, and a forwarding delegate — a libstylist library's is assumed to forward
     * unless it renders no DOM).
     */
    reaches(item: ElementItem): boolean {
        const own = [...item.via, item.el].some((el) => jsxSpreads(el).some((s) => this.mayForward(s.expression)))
        if (!own) return false
        if (!item.inline.every((site) => jsxSpreads(site).some((s) => this.mayForward(s.expression)))) return false
        if (item.kind === "libstylist-delegate") return !item.domless
        return item.kind === "delegate" ? this.forwards(item.target) : true
    }

    /**
     * True when a spread may pass the component's stylist props on: the forwarding predicate ESLint's
     * `forward-props` shares (`carriesProps`, core) — the props parameter, its rest or a named slot
     * (destructured in the signature or the body, aliased by a `const`, forwarded by a runtime cx()
     * call, or a conditional/object spread over those). Another prop (`style`), a literal, an import, a
     * `let` or any other call passes none.
     */
    mayForward(input: ts.Expression): boolean {
        return this.cx.carriesProps(input)
    }
}

/** `cn.icon` or `cn["group-label"]`. */
const memberText = (local: string, part: string): string => (/^[A-Za-z_$][\w$]*$/.test(part) ? `${local}.${part}` : `${local}[${JSON.stringify(part)}]`)

/** True for `""` written as an attribute value (`attr=""` or `attr={""}`). */
function isEmptyString(init: ts.JsxAttributeValue): boolean {
    const e = ts.isJsxExpression(init) ? init.expression && unwrapExpr(init.expression) : init
    return !!e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text === ""
}

/** The node an item points at. */
export function nodeOf(item: Item): ts.Node {
    return isElementItem(item) ? item.el : item.node
}

/** A short description of a root item for messages: `<div>`, `<button elo-button>`, `<Tooltip>`. */
export function describe(item: Item): string {
    switch (item.kind) {
        case "host":
        case "tagvar":
        case "foreign":
        case "delegate":
        case "libstylist-delegate": {
            const name = jsxTagText(item.el.tagName)
            const markers = jsxAttributes(item.el)
                .map(jsxAttrName)
                .filter((n) => /^[a-z][a-z0-9]*-/.test(n) && !DATA_ARIA.test(n) && TAG_RE.test(n))
            return `<${[name, ...markers].join(" ")}>`
        }
        case "text":
            return "text"
        case "opaque":
            return `\`${short(item.node)}\``
        case "portal":
            return "a portal"
    }
}

