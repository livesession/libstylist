// Override sheets (SPEC §9): an app sheet that restyles a design-system component in plain nested CSS
// with the component's part names. Pass 1 (`collectOverrideSheet`) reads the directives, the classes,
// the `:component()` references and the own keyframes without transforming anything; the registry side
// (`resolveOverrides`, `@livesession/libstylist/registry`) resolves them. Pass 2 (`stylistOverride()`,
// after postcss-nesting) rewrites `.root` to the component's identity, every other class to the target
// sheet's part attribute and a `:component()` of the context to that component's identity, rejects what
// an override may not select (anything whose subject is not the target's own element), scopes a
// `within` sheet, and namespaces its keyframes; `wrapInLayer` puts the result in the overrides cascade
// layer.
import { basename, extname } from "node:path"

import postcss, { type AtRule, type Node, type Plugin, type Result, type Root, type Rule } from "postcss"
import selectorParser from "postcss-selector-parser"

import { DEV_ATTRS, PART_ATTR_PREFIX, PART_RE, PREFIX_RE } from "../conventions/index.js"
import { nearest } from "../eslint/suggest.js"
import type { SheetIssue } from "./collect.js"
import { readOverrideDirectives, type OverrideDirective } from "./directives.js"
import { ANIMATION_PROP_RE, isInsideKeyframes, isKeyframesAtRule, isKeyframesIdent, renameAnimationValue } from "./keyframes.js"
import { assertFlattened } from "./plugin.js"
import { ofSelectors, subjectCompound } from "./reset.js"
import { parseComponentRef, replaceRefs, scanRefs } from "./refs.js"
import { findClassSelectors, isGlobalPseudo, isInsideGlobal, preludeSelectors, replacePreludeSelectors } from "./selectors.js"

export const OVERRIDE_PLUGIN_NAME = "libstylist-override"

const lineOf = (node: Node): number | undefined => node.source?.start?.line

/** The id of an override sheet: its basename without `.css` (it namespaces the sheet's own keyframes). */
export const overrideSheetId = (file: string): string => basename(file, extname(file))

/** The emitted name of an override sheet's own keyframes: `<appPrefix>-override-<sheetId>-<local>`. */
export const overrideKeyframesName = (appPrefix: string, sheetId: string, local: string): string => `${appPrefix}-override-${sheetId}-${local}`

// ─── pass 1 ──────────────────────────────────────────────────────────────────────────────────────

export interface OverrideSheetMeta {
    /** Path of the sheet (reports; its basename is the default id). */
    file: string
    /** The sheet id; defaults to the basename of `file`. */
    id?: string
}

export interface OverrideClassUse {
    /** The class as written (`loader`); `root` included. */
    name: string
    /** The first line it is used on. */
    line?: number
}

/** A `:component()` of the same design system an override sheet uses as context (`:component(Table.Td) .root`). */
export interface OverrideComponentUse {
    /** The argument as written, trimmed (`Table.Td`, `gram/ListCollection`): the plugin's `components` key. */
    arg: string
    /** `ns/Path`'s namespace, or null for the target's namespace. */
    namespace: string | null
    path: string
    /** The first line it is used on. */
    line?: number
}

export interface OverrideSheetInfo {
    file: string
    id: string
    /** The `@stylist override` directive, or null when the sheet has none (then `errors` says so). */
    override: (OverrideDirective & { line?: number }) | null
    /** Every `@stylist reset`, in order; `parts` empty resets the whole target sheet. */
    resets: Array<{ parts: string[]; line?: number }>
    /** Every class used in a selector (rules, nested rules, `@scope`/`@supports selector()` preludes) outside `:global()`, sorted by name. */
    classes: OverrideClassUse[]
    /** Every `:component()` its selectors use, sorted by argument. */
    components: OverrideComponentUse[]
    /** The sheet's own `@keyframes` names, sorted. */
    keyframes: string[]
    /** Parse, sheet-id and directive problems (never thrown). */
    errors: SheetIssue[]
}

/**
 * Pass 1 over an override sheet: its directives, the classes and `:component()` references its
 * selectors use and its own keyframes, read without transforming anything (nested source is fine).
 * Never throws.
 */
export function collectOverrideSheet(css: string, meta: OverrideSheetMeta): OverrideSheetInfo {
    const info: OverrideSheetInfo = { file: meta.file, id: meta.id ?? overrideSheetId(meta.file), override: null, resets: [], classes: [], components: [], keyframes: [], errors: [] }
    if (!PART_RE.test(info.id)) {
        info.errors.push({ kind: "scope", message: `the sheet id "${info.id}" (its file name) is not kebab-case — rename the sheet (button.css, table-in-cart.css): the id namespaces its own keyframes` })
    }
    let root: Root
    try {
        root = postcss.parse(css, { from: meta.file })
    } catch (err) {
        info.errors.push({ kind: "parse", message: (err as Error).message, line: (err as { line?: number }).line })
        return info
    }
    const directives = readOverrideDirectives(root)
    for (const e of directives.errors) info.errors.push({ kind: "directive", message: e.message, line: lineOf(e.node) })
    if (directives.override) {
        const { node, ...override } = directives.override
        info.override = { ...override, line: lineOf(node) }
    }
    info.resets = directives.resets.map(r => ({ parts: r.parts, line: lineOf(r.node) }))

    const classes = new Map<string, number | undefined>()
    const components = new Map<string, OverrideComponentUse>()
    const keyframes = new Set<string>()
    root.walkAtRules(at => {
        if (!isKeyframesAtRule(at)) return
        const name = at.params.trim()
        if (isKeyframesIdent(name)) keyframes.add(name)
        else info.errors.push({ kind: "keyframes", message: `@${at.name} ${name}: only plain identifiers can be namespaced`, line: lineOf(at) })
    })
    const readSelector = (selector: string, line: number | undefined) => {
        let ast: selectorParser.Root
        try {
            for (const ref of scanRefs(selector)) {
                // `:cx()` is never allowed (the compile says why); a malformed `:component()` is an error here
                if (ref.kind === "component" && !components.has(ref.arg)) components.set(ref.arg, { arg: ref.arg, ...parseComponentRef(ref.arg, ref), line })
            }
            ast = selectorParser().astSync(replaceRefs(selector, () => "[_]"))
        } catch (err) {
            info.errors.push({ kind: "selector", message: (err as Error).message, line })
            return
        }
        ast.walkClasses(c => {
            if (!isInsideGlobal(c) && !classes.has(c.value)) classes.set(c.value, line)
        })
    }
    root.walk(node => {
        if (node.type === "rule" && !isInsideKeyframes(node)) readSelector(node.selector, lineOf(node))
        else if (node.type === "atrule") for (const { start, end } of preludeSelectors(node)) readSelector(node.params.slice(start, end), lineOf(node))
    })
    info.classes = [...classes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, line]) => ({ name, line }))
    info.components = [...components.values()].sort((a, b) => (a.arg < b.arg ? -1 : a.arg > b.arg ? 1 : 0))
    info.keyframes = [...keyframes].sort()
    return info
}

// ─── pass 2 ──────────────────────────────────────────────────────────────────────────────────────

/** Receives what the plugin produced for the sheet it last processed. */
export interface StylistOverrideSink {
    /** The part names the selectors read, sorted (`.root` of the component form, the identity, is not a part). */
    uses?: string[]
    /** Own keyframes: local → emitted name. */
    keyframes?: Record<string, string>
}

export interface StylistOverrideOptions {
    /** The design system's prefix: its tags and markers are never written in an override (`.root` is). */
    prefix: string
    /** The app's prefix: its tags and markers are never written either (`within` is); own keyframes are named with it. */
    appPrefix: string
    /** What the sheet overrides, for messages: `Button (core, from "@livesession/eloquentui-react")`. */
    label: string
    /** The target sheet's parts: part → part attribute (the registry scope's `parts`). */
    parts: Readonly<Record<string, string>>
    /**
     * The component form's identity tag: `.root` compiles to `:is(<tag>,[<tag>])`, the custom tag and the
     * marker alike. Null in the scope form, where `.root` is the sheet's `root` part.
     */
    identity: string | null
    /** The target sheet's keyframes (local → emitted name): an `animation` may name them by their local name. */
    keyframes?: Readonly<Record<string, string>>
    /** The override sheet's id (its basename), which namespaces its own keyframes. Defaults to the basename of `from`. */
    sheetId?: string
    /** `within`: the app component's tag. Every selector is scoped to that element and its subtree. Null or unset: global. */
    within?: string | null
    /**
     * The `:component()` references the sheet may use as context — an ancestor, a sibling, inside
     * `:has()` or an at-rule prelude, never the element a rule styles: the argument as written → the
     * identity tag of that component of the same design system (`{ "Table.Td": "elo-table-td" }`).
     */
    components?: Readonly<Record<string, string>>
    sink?: StylistOverrideSink
}

const PSEUDO_ELEMENTS_LEGACY = new Set([":before", ":after", ":first-line", ":first-letter"])
const DEV_ONLY: readonly string[] = Object.values(DEV_ATTRS)
const REMOVED_HOOKS: readonly string[] = ["data-component", "data-part"]

/** A node of a complex selector (anything but a selector). */
type SimpleNode = Exclude<selectorParser.Node, selectorParser.Selector>

const isPseudoElement = (n: selectorParser.Node): boolean => n.type === "pseudo" && (n.value.startsWith("::") || PSEUDO_ELEMENTS_LEGACY.has(n.value.toLowerCase()))

const insideNot = (node: selectorParser.Node): boolean => insidePseudo(node, NOT)

const NOT = new Set([":not"])
/** Pseudo-classes whose arguments are other elements' conditions (or none of the subject's): what they name is context. */
const CONTEXT_PSEUDOS = new Set([":not", ":has"])
const IN_PLACE = new Set([":is", ":where", ":matches", ":-webkit-any", ":-moz-any"])
const SUBJECT_FILTERS = new Set([":nth-child", ":nth-last-child"])
/** The combinators that step into an element's subtree: what follows them stays inside it. */
const INTO = new Set([" ", ">"])

const insidePseudo = (node: selectorParser.Node, names: ReadonlySet<string>): boolean => {
    for (let p = node.parent as selectorParser.Node | undefined; p; p = p.parent as selectorParser.Node | undefined) if (p.type === "pseudo" && names.has(p.value.toLowerCase())) return true
    return false
}

/** The compounds of a complex selector and the combinators between them (`combinators[i]` joins `compounds[i]` to `compounds[i + 1]`; descendant is " "). */
function splitComplex(complex: selectorParser.Selector): { compounds: SimpleNode[][]; combinators: string[] } {
    const compounds: SimpleNode[][] = [[]]
    const combinators: string[] = []
    for (const n of complex.nodes) {
        if (n.type === "combinator") {
            combinators.push(n.value.trim() || " ")
            compounds.push([])
        } else if (n.type !== "comment") compounds[compounds.length - 1].push(n as SimpleNode)
    }
    return { compounds, combinators }
}

/**
 * True when every element a compound matches is `.root` or a part of the target: it has a class of its
 * own, or an in-place pseudo-class (`:is`, `:where`) or a sibling filter (`:nth-child(… of S)`) whose
 * every argument's subject does. A class inside `:not()` or `:has()` names another element.
 */
function namesPart(compound: readonly selectorParser.Node[]): boolean {
    return compound.some(n => {
        if (n.type === "class") return true
        if (n.type !== "pseudo") return false
        const name = n.value.toLowerCase()
        const args = IN_PLACE.has(name) ? n.nodes : SUBJECT_FILTERS.has(name) ? (ofSelectors(n)?.nodes ?? []) : []
        return args.length > 0 && args.every(arg => namesPart(subjectCompound(arg)))
    })
}

/** The placeholder a `:component()` of the context stands as while the selector is parsed and checked. */
const COMPONENT_PLACEHOLDER = ":-libstylist-component-"

/** Parses one simple selector (`:is(a,[a])`) into a detached node. */
const simple = (text: string): SimpleNode => {
    const node = selectorParser().astSync(text).first.first as SimpleNode
    node.remove()
    return node
}

/** `:is(<tag>,[<tag>])` — an identity, custom tag or marker: exactly what `:component()` emits, (0,1,0). */
export const identitySelector = (tag: string): string => `:is(${tag},[${tag}])`

/** The `within` suffix: the app component's identity element itself, or any element inside it — (0,1,0). */
export const withinSelector = (tag: string): string => `:is(${tag},[${tag}],${tag} *,[${tag}] *)`

/** The `[code] …` error thrown by the override plugin for a selector it rejects. */
const reject = (node: Rule | AtRule, selector: string, what: string, why: string): Error => node.error(`[override-selector] "${selector.trim()}": ${what} ${why}`)

/** The sorted part list of an override target as the messages print it (`.root` is always addressable in the component form). */
export function overridePartList(parts: Readonly<Record<string, string>>, componentForm: boolean): string[] {
    const names = new Set(Object.keys(parts))
    if (componentForm) names.add("root")
    return [...names].sort()
}

/** The `unknown-part` message: the target has no part `name` — the nearest part and the full list. */
export function unknownPartMessage(label: string, name: string, parts: Readonly<Record<string, string>>, componentForm: boolean): string {
    const list = overridePartList(parts, componentForm)
    const guess = nearest(name, list)
    return `${label} has no part "${name}"${guess ? ` — did you mean "${guess}"?` : ""} Its parts: ${list.join(", ")}`
}

/**
 * The override-sheet PostCSS plugin (pass 2). Use it after postcss-nesting, with the options a resolved
 * override sheet carries (`resolveOverrides(…).sheets[i].plugin`):
 * `postcss([nesting(), stylistOverride(options)])`. Throws a `CssSyntaxError` for anything the sheet may
 * not do: `[unknown-part]`, `[override-selector]`, `[keyframes-clash]`, a directive error.
 */
export function stylistOverride(options: StylistOverrideOptions): Plugin {
    if (!options || typeof options !== "object") throw new Error("libstylist: stylistOverride() needs options — the plugin options of a resolved override sheet")
    if (!PREFIX_RE.test(options.prefix)) throw new Error(`libstylist: invalid design-system prefix "${options.prefix}"`)
    if (!PREFIX_RE.test(options.appPrefix)) throw new Error(`libstylist: invalid app prefix "${options.appPrefix}"`)
    return {
        postcssPlugin: OVERRIDE_PLUGIN_NAME,
        OnceExit(root, { result }) {
            transformOverride(root, result, options)
        },
    }
}
stylistOverride.postcss = true as const

function transformOverride(root: Root, result: Result, opts: StylistOverrideOptions): void {
    const from = result.opts.from ?? root.source?.input.file
    const sheetId = opts.sheetId ?? (from ? overrideSheetId(from) : undefined)
    if (!sheetId || !PART_RE.test(sheetId)) throw root.error(sheetId ? `override sheet id "${sheetId}" is not kebab-case — rename the sheet` : "no sheet id — pass `sheetId`, or process with `from`")
    const componentForm = opts.identity !== null
    const prefixes = [...new Set([opts.prefix, opts.appPrefix])]

    const directives = readOverrideDirectives(root, { requireOverride: false })
    if (directives.errors.length > 0) {
        const first = directives.errors[0]
        throw first.node.error(first.message)
    }
    for (const node of directives.nodes) node.remove()

    root.walkAtRules(at => {
        const name = at.name.toLowerCase()
        if (name === "layer") throw at.error("@layer — the build wraps an override sheet in the overrides layer (css.overrides.layer); remove it")
        if (name === "import") throw at.error("@import — an override sheet is compiled alone; write one sheet per design-system component")
    })
    assertFlattened(root)

    // keyframes: own ones namespaced; `animation` may also name the target sheet's by their local name
    const targetKeyframes = opts.keyframes ?? {}
    const own = new Map<string, string>()
    root.walkAtRules(at => {
        if (!isKeyframesAtRule(at)) return
        const local = at.params.trim()
        if (!isKeyframesIdent(local)) throw at.error(`@${at.name} ${local} — only plain identifiers can be namespaced`)
        if (Object.prototype.hasOwnProperty.call(targetKeyframes, local)) {
            throw at.error(`[keyframes-clash] @${at.name} ${local}: ${opts.label} has keyframes "${local}" too, so "animation: ${local}" would be ambiguous — rename yours`)
        }
        const name = overrideKeyframesName(opts.appPrefix, sheetId, local)
        own.set(local, name)
        at.params = name
    })

    const uses = new Set<string>()
    // a rule's selector styles .root, a part or an element inside one, and is scoped by `within`; an
    // at-rule prelude (`@scope` limits, `@supports selector()` feature queries) only has its classes and
    // `:component()` references rewritten
    const rewrite = (selector: string, node: Rule | AtRule): string => {
        const args: string[] = []
        let parsed: string
        try {
            // `:component()` stands as a placeholder pseudo-class while the selector is checked (its
            // identity would read as a tag or a marker the sheet may not write)
            parsed = replaceRefs(selector, ref => {
                if (ref.kind === "cx") throw reject(node, selector, `:cx(${ref.arg})`, "— an override speaks its target's vocabulary: another sheet's part is that sheet's override")
                if (!opts.components || !Object.prototype.hasOwnProperty.call(opts.components, ref.arg)) {
                    throw node.error(`[unresolved-ref] :component(${ref.arg}) is not resolved against the design system — resolveOverrides() resolves the sheet's :component() references into the plugin's components`)
                }
                args.push(ref.arg)
                return `${COMPONENT_PLACEHOLDER}${args.length - 1}`
            })
        } catch (err) {
            if (err instanceof Error && err.name === "CssSyntaxError") throw err
            throw node.error((err as Error).message)
        }
        const display = (text: string) => text.replace(new RegExp(`${COMPONENT_PLACEHOLDER}(\\d+)`, "g"), (_, i: string) => `:component(${args[Number(i)]})`)
        return selectorParser(ast => {
            for (const complex of ast.nodes) rewriteComplex(complex, node, node.type === "rule", args, display)
        }).processSync(parsed)
    }

    const rewriteComplex = (complex: selectorParser.Selector, node: Rule | AtRule, selects: boolean, args: readonly string[], display: (text: string) => string): void => {
        const text = display(String(complex))
        const classes: selectorParser.ClassName[] = []
        const components: selectorParser.Pseudo[] = []
        complex.walk(n => {
            if (n.type === "pseudo" && n.value.startsWith(COMPONENT_PLACEHOLDER)) {
                components.push(n)
                return
            }
            if (isGlobalPseudo(n)) throw reject(node, text, String(n).trim(), "— :global() is legacy only; an override selects its target's parts")
            if (n.type === "id") throw reject(node, text, `#${n.value}`, "selects one instance — scope with `within`, or give the app component its own part on the design-system component")
            if (n.type === "nesting") throw node.error("& in a flattened selector — run postcss-nesting before libstylist")
            if (n.type === "class") classes.push(n)
            else if (n.type === "attribute") {
                const problem = attributeProblem(n.attribute, prefixes)
                if (problem) throw reject(node, text, String(n).trim(), problem)
            } else if (n.type === "tag" && prefixes.some(p => n.value.toLowerCase().startsWith(`${p}-`))) {
                throw reject(node, text, n.value, "is an identity tag — write .root for the component's identity, :component(X) for another design-system component around it; context in the app goes through `within`")
            }
        })

        const { compounds, combinators } = splitComplex(complex)
        const subject = compounds[compounds.length - 1]
        if (selects) {
            const anchors = classes.filter(c => !insideNot(c))
            if (anchors.length === 0) {
                throw reject(node, text, "the selector", `names no part of ${opts.label} (outside :not()) — every override selector reaches .root or a part, or it would restyle the whole app`)
            }
            // the element a rule styles is .root, a part, or inside one: a compound naming a part that is the
            // subject, or that a descendant or child combinator follows (after one, any combinator stays inside)
            const contained = compounds.some((c, i) => namesPart(c) && (i === compounds.length - 1 || INTO.has(combinators[i])))
            if (!contained) {
                throw reject(node, text, display(subject.map(String).join("").trim()), `is not .root, a part of ${opts.label} or inside one — an override restyles the target's own elements: document context and :component(X) go before .root, and :has(), + and ~ after .root or a part reach elements outside the component`)
            }
            for (const c of components) {
                let top: SimpleNode = c
                while (top.parent && top.parent !== complex) top = top.parent as unknown as SimpleNode
                if (subject.includes(top) && !insidePseudo(c, CONTEXT_PSEUDOS)) {
                    const arg = args[Number(c.value.slice(COMPONENT_PLACEHOLDER.length))]
                    throw reject(node, text, `:component(${arg})`, `is the element this rule styles — another design-system component is restyled in its own override sheet (@stylist override ${arg} …), where this component is context; here it may only be context: before .root or a part, or inside :has()`)
                }
            }
        }

        // `within`: the first compound that is .root or a part is the app component's element or inside it
        let withinAnchor: SimpleNode | null = null
        if (opts.within && selects) {
            const compound = compounds.find(c => namesPart(c)) as SimpleNode[]
            withinAnchor = compound.find(isPseudoElement) ?? compound[compound.length - 1]
        }

        for (const c of components) {
            const replacement = simple(identitySelector(opts.components?.[args[Number(c.value.slice(COMPONENT_PLACEHOLDER.length))]] as string))
            replacement.spaces = { ...c.spaces }
            if (withinAnchor === c) withinAnchor = replacement
            c.replaceWith(replacement)
        }

        for (const c of classes) {
            const name = c.value
            let replacement: SimpleNode
            if (name === "root" && componentForm) {
                replacement = simple(identitySelector(opts.identity as string))
            } else {
                if (!Object.prototype.hasOwnProperty.call(opts.parts, name)) {
                    const message = componentForm || name !== "root"
                        ? unknownPartMessage(opts.label, name, opts.parts, componentForm)
                        : `${opts.label} has no "root" part — in an override of a sheet, .root is that sheet's root part. Its parts: ${overridePartList(opts.parts, false).join(", ")}`
                    throw node.error(`[unknown-part] ${message}`)
                }
                uses.add(name)
                replacement = selectorParser.attribute({ attribute: opts.parts[name], value: undefined, raws: {} })
            }
            replacement.spaces = { ...c.spaces }
            if (withinAnchor === c) withinAnchor = replacement
            c.replaceWith(replacement)
        }

        if (withinAnchor && opts.within) {
            const suffix = simple(withinSelector(opts.within))
            if (isPseudoElement(withinAnchor)) complex.insertBefore(withinAnchor, suffix)
            else {
                // the anchor's trailing whitespace moves after the suffix
                suffix.spaces = { before: "", after: withinAnchor.spaces.after }
                withinAnchor.spaces = { ...withinAnchor.spaces, after: "" }
                complex.insertAfter(withinAnchor, suffix)
            }
        }
    }

    root.walkRules(rule => {
        if (isInsideKeyframes(rule)) return
        const next = rewrite(rule.selector, rule)
        if (next !== rule.selector) rule.selector = next
    })
    root.walkAtRules(at => {
        if (preludeSelectors(at).length === 0) return
        const next = replacePreludeSelectors(at, selector => rewrite(selector, at))
        if (next !== at.params) at.params = next
    })

    const names = { ...targetKeyframes, ...Object.fromEntries(own) }
    if (Object.keys(names).length > 0) {
        root.walkDecls(ANIMATION_PROP_RE, decl => {
            const value = renameAnimationValue(decl.value, names)
            if (value !== decl.value) decl.value = value
        })
    }

    for (const hit of findClassSelectors(root)) throw hit.node.error(`audit: class selector ${hit.kind === "class" ? `.${hit.className}` : hit.className} survived in "${hit.selector}"`)

    if (opts.sink) {
        opts.sink.uses = [...uses].sort()
        opts.sink.keyframes = Object.fromEntries([...own].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    }
}

/** Why an override may not select this attribute, or null when it may (`data-*`, `aria-*`, `role`, `disabled`, …). */
function attributeProblem(name: string, prefixes: readonly string[]): string | null {
    const attr = name.toLowerCase()
    if (attr === "class") return "selects a class — the design system never emits class: write the part as a class (.loader), libstylist turns it into its attribute"
    if (attr.startsWith(PART_ATTR_PREFIX)) return "is a generated part attribute — write the part by name (.loader); hashes change with the design system, names are locked"
    if (DEV_ONLY.includes(attr)) return "is a dev-only attribute, stripped from production builds"
    if (REMOVED_HOOKS.includes(attr)) return "is a removed hook — write .root or the part"
    if (prefixes.some(p => attr.startsWith(`${p}-`))) return "is an identity marker — write .root for the component's identity; context goes through `within`"
    return null
}

/** The layer wrap every compiled workspace sheet gets: the order statement, then the sheet inside its layer. */
export function wrapInLayer(css: string, statement: readonly string[], layer: string): string {
    return `@layer ${statement.join(", ")};\n@layer ${layer} {\n${css.trim()}\n}\n`
}
