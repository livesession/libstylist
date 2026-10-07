// Local keyframes (SPEC §4.2 rule 5): `@keyframes <local>` → `<prefix>-<scope>-<local>`, with
// `animation` / `animation-name` references rewritten to match.
import type { AtRule, Node } from "postcss"

const KEYFRAMES_RE = /^(-[a-z]+-)?keyframes$/i
const KEYFRAMES_NAME_RE = /^-?[_a-zA-Z][\w-]*$/

/** Declarations whose value can name keyframes. */
export const ANIMATION_PROP_RE = /^(-[a-z]+-)?animation(-name)?$/i

/** True for `@keyframes` and its vendor-prefixed forms. */
export const isKeyframesAtRule = (node: Node | undefined): node is AtRule => node?.type === "atrule" && KEYFRAMES_RE.test((node as AtRule).name)

/** True when `node` sits inside a `@keyframes` block (its `from`/`50%` rules are not selectors). */
export function isInsideKeyframes(node: Node): boolean {
    for (let p = node.parent as Node | undefined; p; p = p.parent as Node | undefined) if (isKeyframesAtRule(p)) return true
    return false
}

/** True when a `@keyframes` name is a plain identifier the plugin can namespace. */
export const isKeyframesIdent = (name: string): boolean => KEYFRAMES_NAME_RE.test(name)

/** The emitted name of a local keyframes block. */
export const keyframesName = (prefix: string, scope: string, local: string): string => `${prefix}-${scope}-${local}`

/**
 * Rewrites keyframes references in an `animation`/`animation-name` value. A token is a whole
 * run between whitespace, commas, slashes and parentheses; quoted strings and function names
 * (`steps(`, `var(`) are left alone, custom-property names never match a local name.
 */
export function renameAnimationValue(value: string, names: Readonly<Record<string, string>>): string {
    let out = ""
    let i = 0
    while (i < value.length) {
        const ch = value[i]
        if (ch === "\"" || ch === "'") {
            let j = i + 1
            while (j < value.length && value[j] !== ch) j += value[j] === "\\" ? 2 : 1
            out += value.slice(i, j + 1)
            i = j + 1
            continue
        }
        if (/[\s,()/]/.test(ch)) {
            out += ch
            i++
            continue
        }
        let j = i
        while (j < value.length && !/[\s,()/"']/.test(value[j])) j += value[j] === "\\" ? 2 : 1
        const token = value.slice(i, j)
        const isFunction = value[j] === "("
        out += !isFunction && Object.prototype.hasOwnProperty.call(names, token) ? names[token] : token
        i = j
    }
    return out
}
