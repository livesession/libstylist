// The PostCSS plugin (SPEC §4.2). Runs on flattened CSS (after postcss-nesting; it listens on
// OnceExit so it can share a pipeline with nesting's Rule visitors) and rewrites every selector —
// rule selectors and the selectors of `@scope`/`@supports selector()` preludes: local classes →
// part attributes, :component()/:cx() → identity/part selectors, :global() spliced, local
// keyframes namespaced, `display` defaults emitted first, then audits that no class survived.
import { basename, extname } from "node:path"

import postcss, { type AtRule, type ChildNode, type Node, type Plugin, type Result, type Root, type Rule } from "postcss"
import selectorParser from "postcss-selector-parser"

import { DEFAULT_HASH_LENGTH, PART_RE, PREFIX_RE, normalizePackageConfig } from "../conventions/index.js"
import { partAttr, partSelector } from "../hash/index.js"
import { splitPath, tagName } from "../naming/index.js"
import { readDirectives } from "./directives.js"
import { displayDefaultDeclarations } from "./display.js"
import { ANIMATION_PROP_RE, isInsideKeyframes, isKeyframesAtRule, isKeyframesIdent, keyframesName, renameAnimationValue } from "./keyframes.js"
import { SelectorRefError, parseComponentRef, parseCxRef, replaceRefs } from "./refs.js"
import {
    findClassSelectors,
    globalProblem,
    globalText,
    isClassAttribute,
    isGlobalPseudo,
    isInsideGlobal,
    preludeSelectors,
    replacePreludeSelectors,
    spliceGlobal,
} from "./selectors.js"

export const PLUGIN_NAME = "libstylist"

/** Tag-naming pieces of a namespace (SPEC §2.1). */
export interface StylistNaming {
    segment: string
    word: string
}

export interface StylistRoot {
    component: string
    local: string
    tag: string
    display?: string
}

/** Receives what the plugin produced for the sheet it last processed. */
export interface StylistSink {
    scope?: string
    /** local → part attribute, for every rewritten class and every root local. */
    parts?: Record<string, string>
    roots?: StylistRoot[]
    /** local → emitted keyframes name. */
    keyframes?: Record<string, string>
    /** `:global()` arguments spliced verbatim (legacy hooks), sorted. */
    globals?: string[]
}

export interface StylistOptions {
    prefix: string
    /** Hash namespace of the sheet's package (`core`, `player`, …). */
    namespace: string
    /** Scope when the sheet has no `@stylist scope`; defaults to the basename of `from`. */
    scope?: string
    hashLength?: number
    /** Tag segment and namespace word per namespace; defaults to SPEC §8 (`segment` = namespace, empty for core). */
    naming?: (namespace: string) => StylistNaming
    /** Resolves `:cx(scope:part)`; undefined is an error. Defaults to hashing `(namespace, scope, part)`. */
    resolvePart?: (scope: string, part: string) => string | undefined
    /** Resolves `:component(ns/Path)` (ns null = own namespace); undefined is an error. Defaults to `tagName()`. */
    resolveTag?: (namespace: string | null, path: string) => string | undefined
    sink?: StylistSink
    /** Emit a PostCSS warning listing spliced `:global()` hooks. @default true */
    reportGlobals?: boolean
}

const PREAMBLE_AT_RULES = new Set(["charset", "import", "namespace"])
/** At-rules postcss-nesting lifts out of rules; any other at-rule stays nested after it runs. */
const NESTING_FLATTENS = new Set(["container", "document", "layer", "media", "starting-style", "supports"])
/** Audit key of `[class…]` selectors spliced from `:global()`. */
const CLASS_ATTR_KEY = "[class]"

/**
 * The libstylist PostCSS plugin. Use it after postcss-nesting:
 * `postcss([nesting(), stylist({ prefix: "elo", namespace: "core", scope: "alert" })])`.
 */
export function stylist(options: StylistOptions): Plugin {
    if (!options || typeof options !== "object") throw new Error("libstylist: stylist() needs options — stylist({ prefix, namespace })")
    if (!PREFIX_RE.test(options.prefix)) throw new Error(`libstylist: invalid prefix "${options.prefix}"`)
    if (!PREFIX_RE.test(options.namespace)) throw new Error(`libstylist: invalid namespace "${options.namespace}"`)
    const { hashLength } = options
    if (hashLength !== undefined && (!Number.isInteger(hashLength) || hashLength < 4 || hashLength > 12)) throw new Error("libstylist: hashLength must be an integer in 4..12")
    return {
        postcssPlugin: PLUGIN_NAME,
        OnceExit(root, { result }) {
            transformSheet(root, result, options)
        },
    }
}
stylist.postcss = true as const

function transformSheet(root: Root, result: Result, opts: StylistOptions): void {
    const { prefix, namespace } = opts
    const hashLength = opts.hashLength ?? DEFAULT_HASH_LENGTH
    const naming = opts.naming ?? ((ns: string) => normalizePackageConfig({ prefix, namespace: ns }))
    const from = result.opts.from ?? root.source?.input.file

    // directives → scope and roots
    const directives = readDirectives(root)
    if (directives.errors.length > 0) {
        const first = directives.errors[0]
        throw first.node.error(first.message)
    }
    const scope = directives.scope ?? opts.scope ?? (from ? basename(from, extname(from)) : undefined)
    if (!scope) throw root.error("no scope — pass `scope`, process with `from`, or pin one with @stylist scope <id>;")
    if (!PART_RE.test(scope)) throw root.error(`scope "${scope}" is not kebab-case — pin one with @stylist scope <id>;`)

    const parts = new Map<string, string>()
    const part = (local: string): string => {
        let attr = parts.get(local)
        if (!attr) {
            attr = partAttr({ prefix, namespace, scope, part: local }, hashLength)
            parts.set(local, attr)
        }
        return attr
    }

    const ownNaming = { prefix, ...naming(namespace) }
    const roots: StylistRoot[] = []
    for (const d of directives.roots) {
        let tag: string
        try {
            tag = tagName(ownNaming, splitPath(d.component))
        } catch (err) {
            throw d.node.error((err as Error).message)
        }
        const clash = roots.find(r => r.tag === tag)
        if (clash) throw d.node.error(`${d.component} and ${clash.component} both map to <${tag}>`)
        part(d.local)
        roots.push({ component: d.component, local: d.local, tag, ...(d.display ? { display: d.display } : {}) })
    }
    for (const node of directives.nodes) node.remove()

    assertFlattened(root)

    // keyframes
    const keyframes = new Map<string, string>()
    root.walkAtRules(at => {
        if (!isKeyframesAtRule(at)) return
        const local = at.params.trim()
        if (!isKeyframesIdent(local)) throw at.error(`@${at.name} ${local} — only plain identifiers can be namespaced`)
        const name = keyframesName(prefix, scope, local)
        keyframes.set(local, name)
        at.params = name
    })

    // selectors: rules, then the selectors inside @scope / @supports selector() preludes
    const resolveTag = (ns: string | null, path: string): string => {
        const tag = opts.resolveTag ? opts.resolveTag(ns, path) : tagName({ prefix, ...naming(ns ?? namespace) }, splitPath(path))
        if (!tag) throw new SelectorRefError(`:component(${ns ? `${ns}/` : ""}${path}) — unknown component`)
        return tag
    }
    const resolvePart = (refScope: string, refPart: string): string => {
        const attr = opts.resolvePart ? opts.resolvePart(refScope, refPart) : partAttr({ prefix, namespace, scope: refScope, part: refPart }, hashLength)
        if (!attr) throw new SelectorRefError(`:cx(${refScope}:${refPart}) — unknown part`)
        return attr
    }
    const globals = new Set<string>()
    // per node: class selectors (`.x`, `[class]`) that came from :global() and may survive the audit
    const allowances = new Map<Rule | AtRule, Map<string, number>>()
    const allow = (node: Rule | AtRule, key: string) => {
        const counts = allowances.get(node) ?? new Map<string, number>()
        counts.set(key, (counts.get(key) ?? 0) + 1)
        allowances.set(node, counts)
    }
    const rewrite = (selector: string, node: Rule | AtRule): string => {
        let input: string
        try {
            input = replaceRefs(selector, ref => {
                if (ref.kind === "component") {
                    const { namespace: ns, path } = parseComponentRef(ref.arg, ref)
                    const tag = resolveTag(ns, path)
                    return `:is(${tag},[${tag}])`
                }
                const { scope: refScope, part: refPart } = parseCxRef(ref.arg, ref)
                return partSelector(resolvePart(refScope, refPart))
            })
        } catch (err) {
            throw node.error((err as Error).message)
        }
        return selectorParser(ast => {
            const globalPseudos: selectorParser.Pseudo[] = []
            const classes: selectorParser.ClassName[] = []
            ast.walk(n => {
                if (isGlobalPseudo(n)) globalPseudos.push(n)
                else if (n.type === "class") classes.push(n)
                else if (n.type === "nesting") throw node.error("& in a flattened selector — run postcss-nesting before libstylist")
                else if (isClassAttribute(n)) {
                    if (isInsideGlobal(n)) allow(node, CLASS_ATTR_KEY)
                    else throw node.error(`${String(n).trim()} selects a class — style a part (.local) instead; legacy hooks go in :global()`)
                }
            })
            for (const p of globalPseudos) {
                const problem = globalProblem(p)
                if (problem) throw node.error(problem)
            }
            for (const c of classes) {
                if (isInsideGlobal(c)) {
                    allow(node, `.${c.value}`)
                    continue
                }
                if (!PART_RE.test(c.value)) throw node.error(`.${c.value} is not a valid part name — local classes are kebab-case; legacy hooks go in :global()`)
                const attr = selectorParser.attribute({ attribute: part(c.value), value: undefined, raws: {} })
                attr.spaces = { ...c.spaces }
                c.replaceWith(attr)
            }
            for (const p of globalPseudos.reverse()) {
                globals.add(globalText(p))
                spliceGlobal(p)
            }
        }).processSync(input)
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

    // keyframes references
    if (keyframes.size > 0) {
        const names = Object.fromEntries(keyframes)
        root.walkDecls(ANIMATION_PROP_RE, decl => {
            const value = renameAnimationValue(decl.value, names)
            if (value !== decl.value) decl.value = value
        })
    }

    // display defaults, first in the sheet (zero specificity)
    const displayRules = roots
        .map(r => ({ tag: r.tag, decls: r.display ? displayDefaultDeclarations(r.display) : [] }))
        .filter(r => r.decls.length > 0)
        .map(r => postcss.rule({ selector: `:where(${r.tag}:not([hidden]))`, raws: { between: " " }, nodes: r.decls.map(([prop, value]) => postcss.decl({ prop, value })) }))
    if (displayRules.length > 0) {
        const anchor = root.nodes.find(n => !isPreamble(n))
        if (anchor) root.insertBefore(anchor, displayRules)
        else root.append(displayRules)
    }

    auditSheet(root, allowances)

    if (globals.size > 0 && opts.reportGlobals !== false) {
        result.warn(`legacy :global() hooks spliced verbatim: ${[...globals].sort().join(", ")}`, { plugin: PLUGIN_NAME, node: root })
    }
    if (opts.sink) {
        opts.sink.scope = scope
        opts.sink.parts = sortedEntries(parts)
        opts.sink.roots = roots
        opts.sink.keyframes = sortedEntries(keyframes)
        opts.sink.globals = [...globals].sort()
    }
}

function isPreamble(node: ChildNode): boolean {
    if (node.type === "comment") return true
    if (node.type !== "atrule") return false
    const name = node.name.toLowerCase()
    return PREAMBLE_AT_RULES.has(name) || (name === "layer" && node.nodes === undefined)
}

/** A map as a plain object with keys in code-unit order (matches the registry's key order). */
const sortedEntries = (map: Map<string, string>): Record<string, string> => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

function hasRuleAncestor(node: Node): boolean {
    for (let p = node.parent as Node | undefined; p; p = p.parent as Node | undefined) if (p.type === "rule") return true
    return false
}

/**
 * Throws on unflattened input: a rule or at-rule inside a rule means postcss-nesting has not run, or
 * that the at-rule is one postcss-nesting leaves nested (`@scope`, `@font-face`, …).
 */
export function assertFlattened(root: Root): void {
    root.walk(node => {
        if (node.type === "rule" && hasRuleAncestor(node)) throw node.error("nested rule — run postcss-nesting before libstylist")
        if (node.type === "atrule" && hasRuleAncestor(node)) {
            throw node.error(
                NESTING_FLATTENS.has(node.name.toLowerCase())
                    ? `nested @${node.name} — run postcss-nesting before libstylist`
                    : `@${node.name} inside a rule is not flattened by postcss-nesting — write it at the top level`,
            )
        }
    })
}

/**
 * SPEC §4.2 rule 7: no class selector (`.x` or `[class…]`, in a rule or an at-rule prelude) may
 * survive, except the ones spliced from `:global()` — counted per node.
 */
function auditSheet(root: Root, allowances: Map<Rule | AtRule, Map<string, number>>): void {
    for (const hit of findClassSelectors(root)) {
        const key = hit.kind === "class" ? `.${hit.className}` : CLASS_ATTR_KEY
        const left = allowances.get(hit.node)
        const n = left?.get(key) ?? 0
        if (left && n > 0) left.set(key, n - 1)
        else throw hit.node.error(`audit: class selector ${hit.kind === "class" ? `.${hit.className}` : hit.className} survived in "${hit.selector}"`)
    }
}
