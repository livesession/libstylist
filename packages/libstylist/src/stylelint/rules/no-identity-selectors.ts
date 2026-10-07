// libstylist/no-identity-selectors — identity tags/markers, generated part attributes, dev-only
// attributes, removed data hooks and `class` are never hand-written selectors (SPEC §2.2, §3, §5.5).
import type { Root } from "postcss"
import type parser from "postcss-selector-parser"
import stylelint from "stylelint"
import type { Rule, RuleBase } from "stylelint"

import { DEV_ATTRS, PART_ATTR_PREFIX, PREFIX_RE } from "../../conventions/index.js"
import { inKeyframes, isOpaquePseudo, ruleSelector, tryParseSelector, walkSkipping } from "../selectors.js"
import { DEFAULT_PREFIX, PLUGIN_NAMESPACE, isString, reportParseError, ruleUrl, toArray } from "../util.js"

const {
    createPlugin,
    utils: { report, ruleMessages, validateOptions },
} = stylelint

export const ruleName = `${PLUGIN_NAMESPACE}/no-identity-selectors` as const

export interface NoIdentitySelectorsOptions {
    /** Identity prefixes whose `<prefix>-*` tags and markers are banned. @default "elo" */
    prefix?: string | string[]
    /**
     * Allow the removed `data-component`/`data-part` hooks — only while sheets still carry them
     * mid-migration (the preset's legacy mode). @default false
     */
    allowRemovedHooks?: boolean
}

export const messages = ruleMessages(ruleName, {
    rejected: (selector: string, reason: string) => `Unexpected "${selector}" — ${reason}`,
})

export const meta = { url: ruleUrl("no-identity-selectors") }

const DEV_ONLY: readonly string[] = Object.values(DEV_ATTRS)
const REMOVED_HOOKS: readonly string[] = ["data-component", "data-part"]

const REASONS = {
    identity: "tags and markers carry identity, they are not styling hooks: use \".root\" for this sheet's root or \":component(X)\" for another component",
    part: "part attributes are generated: write the part as a local class (\".part\") or \":cx(scope:part)\"",
    dev: "dev-only attributes are stripped from production builds",
    removed: "data-component/data-part are removed: use \":component(X)\" for components and local classes for parts",
    klass: "the design system never emits class: select parts, \":component(X)\" or data-* attributes",
}

/** Why an attribute name may not be selected, or null when it may. */
export function attributeReason(name: string, prefixes: readonly string[], allowRemovedHooks = false): string | null {
    const attr = name.toLowerCase()
    if (attr.startsWith(PART_ATTR_PREFIX)) return REASONS.part
    if (DEV_ONLY.includes(attr)) return REASONS.dev
    if (!allowRemovedHooks && REMOVED_HOOKS.includes(attr)) return REASONS.removed
    if (attr === "class") return REASONS.klass
    if (prefixes.some((p) => attr.startsWith(`${p}-`))) return REASONS.identity
    return null
}

/** Why a type selector may not be written, or null when it may (only identity tags are banned here). */
export function tagReason(name: string, prefixes: readonly string[]): string | null {
    const tag = name.toLowerCase()
    return prefixes.some((p) => tag.startsWith(`${p}-`)) ? REASONS.identity : null
}

const ruleFunction: RuleBase<boolean, NoIdentitySelectorsOptions | undefined> = (primary, secondary) => (root: Root, result) => {
    const valid = validateOptions(
        result,
        ruleName,
        { actual: primary, possible: [true] },
        { actual: secondary, possible: { prefix: [(v: unknown) => isString(v) && PREFIX_RE.test(v)], allowRemovedHooks: [(v: unknown) => typeof v === "boolean"] }, optional: true },
    )
    if (!valid) return
    const prefixes = secondary?.prefix === undefined ? [DEFAULT_PREFIX] : toArray(secondary.prefix)

    root.walkRules((rule) => {
        if (inKeyframes(rule)) return
        const ast = tryParseSelector(ruleSelector(rule))
        if (typeof ast === "string") {
            reportParseError(result, rule, ast)
            return
        }
        walkSkipping(
            ast,
            (node: parser.Node) => {
                let reason: string | null = null
                if (node.type === "attribute") reason = attributeReason(node.attribute, prefixes, secondary?.allowRemovedHooks === true)
                else if (node.type === "tag") reason = tagReason(node.value, prefixes)
                if (reason === null) return
                const text = node.toString().trim()
                report({ ruleName, result, node: rule, message: messages.rejected, messageArgs: [text, reason], index: node.sourceIndex, endIndex: node.sourceIndex + text.length })
            },
            isOpaquePseudo,
        )
    })
}

export const rule: Rule = Object.assign(ruleFunction, { ruleName, messages, meta })

export default createPlugin(ruleName, rule)
