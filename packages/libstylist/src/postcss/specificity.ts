// Selector specificity (Selectors Level 4 §17), used to prove every rewrite keeps the cascade:
// a class and the part attribute replacing it are both (0,1,0). Source-only pseudo-classes are
// counted as what they compile to: `:global(x)` as `x` (spliced verbatim), `:component()` and
// `:cx()` as (0,1,0) (`:is(tag,[tag])` and `[attr]`).
import selectorParser from "postcss-selector-parser"

import { replaceRefs } from "./refs.js"

/** `[ids, classes/attributes/pseudo-classes, types/pseudo-elements]`. */
export type Specificity = readonly [number, number, number]

const ZERO: Specificity = [0, 0, 0]
const ONE_B: Specificity = [0, 1, 0]
const ONE_C: Specificity = [0, 0, 1]

const LEGACY_PSEUDO_ELEMENTS = new Set([":before", ":after", ":first-line", ":first-letter"])
const MAX_OF_ARGUMENTS = new Set([":is", ":matches", ":-webkit-any", ":-moz-any", ":not", ":has"])
const NTH_OF = new Set([":nth-child", ":nth-last-child"])

const add = (x: Specificity, y: Specificity): Specificity => [x[0] + y[0], x[1] + y[1], x[2] + y[2]]

/** Orders two specificities: negative when `x` is lower, positive when higher, 0 when equal. */
export function compareSpecificity(x: Specificity, y: Specificity): number {
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

const maxOf = (list: readonly Specificity[]): Specificity => list.reduce((m, s) => (compareSpecificity(s, m) > 0 ? s : m), ZERO)

/** Formats a specificity as `(a,b,c)`. */
export const formatSpecificity = (s: Specificity): string => `(${s[0]},${s[1]},${s[2]})`

/**
 * The specificity of each complex selector in a selector list, in order. Throws on the nesting
 * selector `&`: flatten with postcss-nesting first.
 */
export function specificityList(selector: string): Specificity[] {
    const neutral = replaceRefs(selector, () => "[_]")
    const root = selectorParser().astSync(neutral)
    return root.nodes.map(complexSpecificity)
}

/** The specificity of a selector; for a list, the highest of its members (as `:is()` computes it). */
export function specificity(selector: string): Specificity {
    return maxOf(specificityList(selector))
}

function complexSpecificity(sel: selectorParser.Selector): Specificity {
    let s = ZERO
    for (const node of sel.nodes) s = add(s, simpleSpecificity(node))
    return s
}

function simpleSpecificity(node: selectorParser.Node): Specificity {
    switch (node.type) {
        case "id":
            return [1, 0, 0]
        case "class":
        case "attribute":
            return ONE_B
        case "tag":
            return ONE_C
        case "pseudo":
            return pseudoSpecificity(node)
        case "nesting":
            throw new Error("specificity: the nesting selector & has no specificity of its own — flatten with postcss-nesting first")
        default:
            // universal, combinator, comment, string
            return ZERO
    }
}

function pseudoSpecificity(node: selectorParser.Pseudo): Specificity {
    const name = node.value.toLowerCase()
    const args = () => node.nodes.map(complexSpecificity)
    if (name.startsWith("::") || LEGACY_PSEUDO_ELEMENTS.has(name)) return name === "::slotted" ? add(ONE_C, maxOf(args())) : ONE_C
    if (name === ":where") return ZERO
    if (name === ":global" || MAX_OF_ARGUMENTS.has(name)) return maxOf(args())
    if (name === ":host" || name === ":host-context") return add(ONE_B, maxOf(args()))
    if (NTH_OF.has(name)) {
        const text = node.nodes.map(String).join(",")
        const of = /(?:^|\s)of\s+([\s\S]+)$/i.exec(text)
        return of ? add(ONE_B, maxOf(specificityList(of[1]))) : ONE_B
    }
    return ONE_B
}
