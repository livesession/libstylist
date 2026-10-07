// Stylesheets through the migration map: every rule selector, `@scope` / `@supports selector()`
// prelude and SCSS `@at-root` goes through analyzeSelector; `animation` / `animation-name` values
// and `@keyframes` names get the new keyframes names; what can't be rewritten (`composes`,
// `@extend`, other at-rule parameters) is reported. Used for .css/.scss/.less files and for the
// CSS inside styled-components / emotion template literals.
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import postcss, { type AtRule, type Declaration, type Node as PostcssNode, type Root, type Rule } from "postcss"

import { ANIMATION_PROP_RE, isInsideKeyframes, isKeyframesAtRule } from "../postcss/keyframes.js"
import { preludeSelectors } from "../postcss/selectors.js"
import { hasPrefix, type AppliedHooks, type MapIndex } from "./map.js"
import { analyzeSelector, legacyTokens, type Finding, type MigrateOptions, type SelectorRewrite } from "./selector.js"
import { maskLineComments, oneLine, shiftEdits, valueTokens, type Edit } from "./text.js"

export type StyleSyntax = "css" | "scss" | "less"

export interface StyleContext {
    index: MapIndex
    options: MigrateOptions
    syntax: StyleSyntax
    cssModule?: boolean
    /** Keep `:global(…)` wrappers (see SelectorContext.keepGlobal). */
    keepGlobal?: boolean
    /** Legacy hooks the app puts on its own elements (see SelectorContext.applied). */
    applied?: AppliedHooks
}

export interface StyleAnalysis {
    edits: Edit[]
    rewrites: SelectorRewrite[]
    findings: Finding[]
}

const GLOBAL_MODE_RE = /:global(?!\s*\()/i
/** At-rules whose parameters never hold a selector hook (paths, media queries, names). */
const NO_SELECTOR_PARAMS = new Set(["import", "use", "forward", "charset", "namespace", "font-face", "media", "layer", "container", "page", "property", "counter-style", "font-feature-values", "keyframes", "tailwind", "config", "plugin"])

const ruleSelectorText = (rule: Rule): string => (rule.raws.selector as { raw?: string } | undefined)?.raw ?? rule.selector
const startOf = (node: PostcssNode): number | undefined => node.source?.start?.offset

/**
 * Analyzes a parsed stylesheet. `text` is what was parsed (offsets index into it); the caller maps
 * offsets back when the text is a template.
 */
export function analyzeStylesheet(text: string, root: Root, ctx: StyleContext): StyleAnalysis {
    const out: StyleAnalysis = { edits: [], rewrites: [], findings: [] }
    const { index } = ctx
    const addFinding = (f: Omit<Finding, "start" | "end">, start: number, end: number) => out.findings.push({ ...f, start, end })

    const selectorAt = (selector: string, start: number, extra: { parentSelector?: string; moduleGlobal?: boolean } = {}) => {
        if (text.slice(start, start + selector.length) !== selector) {
            for (const t of legacyTokens(selector, index)) addFinding({ kind: "todo", old: t.value, reason: "unparseable", message: "could not locate this selector in the source — rewrite it by hand" }, start, start)
            return
        }
        const a = analyzeSelector(selector, { index, options: ctx.options, cssModule: ctx.cssModule, keepGlobal: ctx.keepGlobal, syntax: ctx.syntax, applied: ctx.applied, ...extra })
        out.edits.push(...shiftEdits(a.edits, start))
        for (const r of a.rewrites) out.rewrites.push({ ...r, start: r.start + start, end: r.end + start })
        for (const f of a.findings) out.findings.push({ ...f, start: f.start + start, end: f.end + start })
    }

    const paramsStart = (at: AtRule): number | undefined => {
        const start = startOf(at)
        if (start === undefined || (at.raws as { params?: unknown }).params) return undefined
        const p = start + 1 + at.name.length + (at.raws.afterName ?? "").length
        return text.startsWith(at.params, p) ? p : undefined
    }

    root.walk((node) => {
        if (node.type === "rule") {
            if (isInsideKeyframes(node)) return
            const start = startOf(node)
            if (start === undefined) return
            const ancestors: Rule[] = []
            for (let p = node.parent; p && p.type !== "root"; p = p.parent as typeof node.parent) if (p.type === "rule") ancestors.push(p as Rule)
            // the text up to `{`: postcss moves a trailing comment (a template placeholder) into raws.between
            selectorAt(ruleSelectorText(node) + (/\/\*/.test(node.raws.between ?? "") ? (node.raws.between ?? "") : ""), start, {
                parentSelector: ancestors[0] ? ruleSelectorText(ancestors[0]) : undefined,
                moduleGlobal: ancestors.some((a) => GLOBAL_MODE_RE.test(ruleSelectorText(a))),
            })
            return
        }
        if (node.type === "atrule") {
            const at = node
            const name = at.name.toLowerCase()
            if (isKeyframesAtRule(at as PostcssNode)) {
                const renamed = index.keyframes.get(at.params.trim())
                const p = paramsStart(at)
                if (renamed && p !== undefined) {
                    const offset = p + at.params.indexOf(at.params.trim())
                    out.edits.push({ start: offset, end: offset + at.params.trim().length, text: renamed })
                    out.rewrites.push({
                        start: offset,
                        end: offset + at.params.trim().length,
                        old: `@${at.name} ${at.params.trim()}`,
                        new: `@${at.name} ${renamed}`,
                        notes: ["a definition under the design system's legacy keyframes name overrode its animation; renamed so it still does"],
                    })
                }
                return
            }
            const p = paramsStart(at)
            if (name === "scope" || name === "supports") {
                if (p === undefined) return
                for (const { start, end } of preludeSelectors(at)) selectorAt(at.params.slice(start, end), p + start)
                return
            }
            if (name === "at-root" && at.params.trim() && !at.params.trim().startsWith("(")) {
                if (p !== undefined) selectorAt(at.params, p)
                return
            }
            if (NO_SELECTOR_PARAMS.has(name)) return
            const tokens = legacyTokens(at.params, index).filter((t) => at.params[t.start - 1] === ".")
            if (tokens.length === 0) return
            const base = p ?? startOf(at) ?? 0
            for (const t of tokens) {
                const entry = index.classes.get(t.value)
                const where = p !== undefined ? { start: base + t.start - 1, end: base + t.end } : { start: base, end: base }
                if (!entry) addFinding({ kind: "unknown", old: `.${t.value}`, reason: "unknown", message: "not in the migration map" }, where.start, where.end)
                else
                    addFinding(
                        {
                            kind: "todo",
                            old: `@${at.name} .${t.value}`,
                            reason: "at-rule",
                            message: name === "extend" ? "a part attribute defined outside this stylesheet can't be extended — select it in the rule instead" : `@${at.name} parameters are not rewritten — replace the class with its successor`,
                            ...(entry.selector ? { suggestion: entry.selector } : {}),
                        },
                        where.start,
                        where.end,
                    )
            }
            return
        }
        if (node.type === "decl") declaration(node)
    })

    function declaration(decl: Declaration) {
        const prop = decl.prop.toLowerCase()
        const isAnimation = ANIMATION_PROP_RE.test(prop)
        if (!isAnimation && prop !== "composes") return
        const start = startOf(decl)
        if (start === undefined) return
        const raw = (decl.raws.value as { raw?: string } | undefined)?.raw ?? decl.value
        const valueStart = start + decl.prop.length + (decl.raws.between ?? "").length
        if (!text.startsWith(raw, valueStart)) return
        if (isAnimation) {
            const edits: Edit[] = []
            for (const token of valueTokens(raw)) {
                if (token.fn) continue
                const renamed = index.keyframes.get(token.value)
                if (renamed) edits.push({ start: valueStart + token.start, end: valueStart + token.end, text: renamed })
                else if (hasPrefix(token.value, index.keyframesPrefixes))
                    addFinding({ kind: "unknown", old: token.value, reason: "unknown", message: "an animation name with the legacy prefix that is not in the migration map" }, valueStart + token.start, valueStart + token.end)
            }
            if (edits.length === 0) return
            out.edits.push(...edits)
            let next = raw
            for (const e of [...edits].sort((a, b) => b.start - a.start)) next = next.slice(0, e.start - valueStart) + e.text + next.slice(e.end - valueStart)
            out.rewrites.push({ start, end: valueStart + raw.length, old: `${decl.prop}: ${oneLine(raw)}`, new: `${decl.prop}: ${oneLine(next)}`, notes: [] })
            return
        }
        // composes: a b from global — CSS Modules can only compose classes
        for (const token of valueTokens(raw)) {
            if (!hasPrefix(token.value, index.classPrefixes)) continue
            const entry = index.classes.get(token.value)
            const where = { start: valueStart + token.start, end: valueStart + token.end }
            if (!entry) addFinding({ kind: "unknown", old: token.value, reason: "unknown", message: "not in the migration map" }, where.start, where.end)
            else
                addFinding(
                    {
                        kind: "todo",
                        old: `composes: ${token.value}`,
                        reason: "composes",
                        message: "CSS Modules can only compose classes, and the design system renders part attributes now — style the element with a rule on the successor, or use the component",
                        ...(entry.selector ? { suggestion: entry.selector } : {}),
                    },
                    where.start,
                    where.end,
                )
        }
    }

    return out
}

// ---------------------------------------------------------------------------------------------
// Parsing: postcss for CSS; postcss-scss / postcss-less when the project has them, else the CSS
// parser over the text with `//` comments masked (same offsets) — interpolation needs the real one.
// ---------------------------------------------------------------------------------------------

export interface StyleParser {
    /** The parsed root and the text its offsets index into (same length as the input). */
    parse(text: string): { root: Root; text: string }
    /** What parsed it, for the report. */
    name: string
    /** True when a SCSS/LESS file is read by the plain CSS parser. */
    fallback: boolean
}

type ParseFn = (css: string, opts?: { from?: string }) => Root
const syntaxPackage: Record<Exclude<StyleSyntax, "css">, string> = { scss: "postcss-scss", less: "postcss-less" }
const cache = new Map<string, ParseFn | null>()

async function loadSyntax(name: string, cwd: string): Promise<ParseFn | null> {
    const key = `${name}\u0000${cwd}`
    if (cache.has(key)) return cache.get(key)!
    let parse: ParseFn | null = null
    for (const from of [join(cwd, "noop.js"), import.meta.url]) {
        try {
            const file = createRequire(from).resolve(name)
            const mod = (await import(pathToFileURL(file).href)) as { parse?: ParseFn; default?: { parse?: ParseFn } }
            parse = mod.parse ?? mod.default?.parse ?? null
            if (parse) break
        } catch {
            // not installed there
        }
    }
    cache.set(key, parse)
    return parse
}

export async function styleParser(syntax: StyleSyntax, cwd: string): Promise<StyleParser> {
    if (syntax === "css") return { name: "postcss", fallback: false, parse: (text) => ({ root: postcss.parse(text), text }) }
    const pkg = syntaxPackage[syntax]
    const parse = await loadSyntax(pkg, cwd)
    if (parse) return { name: pkg, fallback: false, parse: (text) => ({ root: parse(text), text }) }
    return {
        name: `postcss (${pkg} not installed: // comments masked, no interpolation)`,
        fallback: true,
        parse: (text) => {
            if (/#\{|@\{/.test(text)) throw new Error(`interpolation (#{…} / @{…}) needs ${pkg} — install it in the project and run again`)
            const masked = maskLineComments(text)
            return { root: postcss.parse(masked), text: masked }
        },
    }
}
