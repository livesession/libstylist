// Selector helpers shared by collectSheet, the plugin and the audit.
import postcss, { type AtRule, type Root, type Rule } from "postcss"
import selectorParser from "postcss-selector-parser"

import { isInsideKeyframes } from "./keyframes.js"
import { matchParen, replaceRefs } from "./refs.js"

export const GLOBAL_PSEUDO = ":global"

/** True for a `:global(…)` pseudo-class (pseudo-class names are ASCII case-insensitive). */
export const isGlobalPseudo = (node: selectorParser.Node): node is selectorParser.Pseudo => node.type === "pseudo" && node.value.toLowerCase() === GLOBAL_PSEUDO

/** True when a selector node sits inside `:global(…)`. */
export function isInsideGlobal(node: selectorParser.Node): boolean {
    for (let p = node.parent as selectorParser.Node | undefined; p; p = p.parent as selectorParser.Node | undefined) {
        if (isGlobalPseudo(p)) return true
    }
    return false
}

/** Why a `:global(…)` can't be spliced (empty or a selector list), or undefined when it can. */
export function globalProblem(pseudo: selectorParser.Pseudo): string | undefined {
    const inner = pseudo.nodes.map(n => String(n).trim())
    if (inner.length === 0 || (inner.length === 1 && inner[0] === "")) return ":global() needs a selector"
    if (inner.length > 1) return `:global(${inner.join(", ")}) contains a selector list — write one :global() per selector`
    return undefined
}

/** The selector inside a `:global(…)`, as written. */
export const globalText = (pseudo: selectorParser.Pseudo): string => String(pseudo.nodes[0]).trim()

/**
 * Replaces `:global(x)` with `x`. Whitespace just inside the parentheses is dropped:
 * `.root:global( .hover )` is the compound `.root.hover`, never `.root .hover`.
 */
export function spliceGlobal(pseudo: selectorParser.Pseudo): void {
    const nodes = pseudo.nodes[0].nodes
    if (nodes.length > 0) {
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        first.spaces.before = ""
        first.rawSpaceBefore = ""
        last.spaces.after = ""
        last.rawSpaceAfter = ""
    }
    pseudo.replaceWith(...nodes)
}

/** True for an attribute selector on `class` (`[class~="x"]`): a class selector in disguise. */
export const isClassAttribute = (node: selectorParser.Node): node is selectorParser.Attribute =>
    node.type === "attribute" && node.attribute.toLowerCase() === "class"

/** A selector embedded in an at-rule prelude, as offsets into `params`. */
export interface PreludeSelector {
    start: number
    end: number
}

/**
 * The selectors inside an at-rule prelude: both groups of `@scope (<start>) [to (<end>)]` and
 * every `selector(<s>)` of `@supports`. Empty for every other at-rule.
 */
export function preludeSelectors(at: AtRule): PreludeSelector[] {
    const name = at.name.toLowerCase()
    const params = at.params
    const out: PreludeSelector[] = []
    if (name === "scope") {
        for (let i = 0; i < params.length; i++) {
            if (params[i] !== "(") continue
            const close = matchParen(params, i)
            if (close < 0) break
            out.push({ start: i + 1, end: close })
            i = close
        }
    } else if (name === "supports") {
        for (const m of params.matchAll(/selector\(/gi)) {
            const index = m.index ?? 0
            if (index > 0 && /[\w-]/.test(params[index - 1])) continue
            const open = index + m[0].length - 1
            const close = matchParen(params, open)
            if (close >= 0) out.push({ start: open + 1, end: close })
        }
    }
    return out
}

/** Replaces each prelude selector of `at` with what `replace` returns for it. */
export function replacePreludeSelectors(at: AtRule, replace: (selector: string) => string): string {
    const params = at.params
    let out = ""
    let last = 0
    for (const { start, end } of preludeSelectors(at)) {
        out += params.slice(last, start) + replace(params.slice(start, end))
        last = end
    }
    return out + params.slice(last)
}

export interface ClassSelectorHit {
    /** The selector the hit is in: a rule's selector or an at-rule prelude selector. */
    selector: string
    /** `class` for `.x`, `attribute` for `[class…]`. */
    kind: "class" | "attribute"
    /** The class name (`x`), or the attribute selector as written (`[class~="x"]`). */
    className: string
    line?: number
    node: Rule | AtRule
}

/**
 * Every class selector in a stylesheet — the compiled-CSS audit (SPEC §4.2 rule 7): `.x` and
 * `[class…]`, in rule selectors and in `@scope`/`@supports selector()` preludes, outside
 * `@keyframes`. `:component()`/`:cx()` arguments are not selectors and are skipped.
 */
export function findClassSelectors(input: string | Root): ClassSelectorHit[] {
    const root = typeof input === "string" ? postcss.parse(input) : input
    const hits: ClassSelectorHit[] = []
    const scan = (selector: string, node: Rule | AtRule) => {
        const line = node.source?.start?.line
        selectorParser().astSync(replaceRefs(selector, () => "[_]")).walk(n => {
            if (n.type === "class") hits.push({ selector, kind: "class", className: n.value, line, node })
            else if (isClassAttribute(n)) hits.push({ selector, kind: "attribute", className: String(n).trim(), line, node })
        })
    }
    root.walk(node => {
        if (node.type === "rule" && !isInsideKeyframes(node)) scan(node.selector, node)
        else if (node.type === "atrule") for (const { start, end } of preludeSelectors(node)) scan(node.params.slice(start, end), node)
    })
    return hits
}
