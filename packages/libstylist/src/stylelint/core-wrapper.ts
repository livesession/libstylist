// Runs a core stylelint rule over libstylist sheets. The core selector rules misread libstylist
// syntax: `:component(core/Modal.Header)` doesn't parse at all (postcss-selector-parser reads `/`
// as a combinator), `:component(Modal.Header)` has a ".Header" class and `:cx(scope:part)` a
// ":part" pseudo-class. A wrapped rule runs the core rule on a copy of the sheet whose opaque
// arguments are masked with same-length filler, then reports the problems under its own name on
// the original nodes, at the same positions. Selectors the core rule can't parse are reported as
// parse errors, as the core rule would (once per selector across all wrapped rules).
import type { Container, Node as PostcssNode, Root, Rule as PostcssRule } from "postcss"
import stylelint from "stylelint"
import type { Plugin, PostcssResult, Rule, RuleBase } from "stylelint"

import { OPAQUE_PSEUDOS, indexAt, maskPseudoArgs, ruleSelector } from "./selectors.js"
import { PLUGIN_NAMESPACE, reportParseError, ruleUrl } from "./util.js"

const {
    createPlugin,
    utils: { checkAgainstRule, report, ruleMessages },
} = stylelint

export interface CoreWrapperSpec<S, N extends string = string> {
    /** Name of the core rule; the wrapper is `libstylist/<core>`. */
    core: N
    /** Adjusts the secondary options handed to the core rule (e.g. to add ignores). */
    secondary?: (secondary: S | undefined) => S | undefined
    /** Mirrors the core rule's `primaryOptionArray` (its primary option is itself an array). */
    primaryOptionArray?: boolean
    /**
     * Pseudo-classes whose arguments the core rule must not see (masked with same-length filler).
     * @default ["component", "cx"]
     */
    mask?: readonly string[]
}

export interface WrappedRule<N extends string = string> {
    ruleName: `${typeof PLUGIN_NAMESPACE}/${N}`
    rule: Rule
    plugin: Plugin
}

type RawSelector = { value?: string; raw?: string }

/**
 * Deep-clones `root` with the arguments of the `mask` pseudo-classes masked; maps every clone node
 * to its original. The original tree is never modified.
 */
export function maskedClone(root: Root, mask: readonly string[] = OPAQUE_PSEUDOS): { clone: Root; originals: Map<PostcssNode, PostcssNode> } {
    const clone = root.clone()
    const originals = new Map<PostcssNode, PostcssNode>()
    const pair = (original: PostcssNode, copy: PostcssNode) => {
        originals.set(copy, original)
        const kids = (original as Container).nodes
        const copies = (copy as Container).nodes
        if (kids && copies) kids.forEach((kid, i) => pair(kid, copies[i]))
    }
    pair(root, clone)
    const maskText = (text: string) => maskPseudoArgs(text, mask)
    clone.walkRules((rule) => {
        const masked = maskText(rule.selector)
        if (masked !== rule.selector) rule.selector = masked
        const raws = rule.raws as { selector?: RawSelector }
        if (raws.selector) {
            raws.selector = {
                value: raws.selector.value === undefined ? undefined : maskText(raws.selector.value),
                raw: raws.selector.raw === undefined ? undefined : maskText(raws.selector.raw),
            }
        }
    })
    return { clone, originals }
}

/** The double-quoted pieces of a core message (`Expected ".a b" to …` → [".a b"]), for custom `%s` messages. */
const quotedArgs = (text: string): string[] => [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])

/**
 * Puts the original masked arguments back into the quoted selectors of a core message: masking
 * keeps lengths, so a quoted piece found in the masked selector maps 1:1.
 */
export function unmaskMessage(text: string, node: PostcssNode, mask: readonly string[] = OPAQUE_PSEUDOS): string {
    if (node.type !== "rule") return text
    const rule = node as PostcssRule
    const pairs = [ruleSelector(rule), rule.selector]
        .map((original) => [maskPseudoArgs(original, mask), original] as const)
        .filter(([masked, original]) => masked !== original)
    if (pairs.length === 0) return text
    let out = text
    for (const quoted of new Set(quotedArgs(text))) {
        for (const [masked, original] of pairs) {
            const at = masked.indexOf(quoted)
            if (at < 0) continue
            out = out.split(`"${quoted}"`).join(`"${original.slice(at, at + quoted.length)}"`)
            break
        }
    }
    return out
}

/**
 * The state a core rule sees: isolated from the real result (its problems never flag the file,
 * its disables and severities are ours), but validating options when the real config does.
 */
const scratchResult = (result: PostcssResult): PostcssResult =>
    ({
        stylelint: {
            ruleSeverities: {},
            customMessages: {},
            customUrls: {},
            ruleMetadata: {},
            fixersData: {},
            rangesOfComputedEditInfos: [],
            disabledRanges: {},
            config: { validate: result.stylelint.config?.validate ?? true },
        },
    }) as unknown as PostcssResult

/** Builds `libstylist/<core>`: the core rule, run on the masked sheet. */
export function wrapCoreRule<S = Record<string, unknown>, N extends string = string>(spec: CoreWrapperSpec<S, N>): WrappedRule<N> {
    const ruleName: `${typeof PLUGIN_NAMESPACE}/${N}` = `${PLUGIN_NAMESPACE}/${spec.core}`
    const mask = spec.mask ?? OPAQUE_PSEUDOS
    const suffix = ` (${spec.core})`
    const messages = ruleMessages(ruleName, { rejected: (text: string) => text })

    const ruleFunction: RuleBase<unknown, S | undefined> = (primary, secondary, context) => async (root: Root, result) => {
        const options = spec.secondary ? spec.secondary(secondary) : secondary
        const ruleSettings = (options === undefined ? [primary] : [primary, options]) as [unknown] | [unknown, object]
        const { clone, originals } = maskedClone(root, mask)
        // Disables and severities apply to this rule's name; the core rule gets no autofix.
        const settings = { ruleName: spec.core, ruleSettings: ruleSettings as never, root: clone, result: scratchResult(result), context: { ...context, fix: false } }
        await checkAgainstRule(settings, (warning) => {
            const type = (warning as { stylelintType?: string }).stylelintType
            if (type === "invalidOption") {
                result.warn(warning.text.split(`"${spec.core}"`).join(`"${ruleName}"`), { stylelintType: "invalidOption" })
                result.stylelint.stylelintError = true
                return
            }
            const node = (warning.node && originals.get(warning.node)) ?? root
            if (type === "parseError") {
                // The preset turns the core selector rules off, so these wrappers are what reports
                // selectors neither stylelint nor the build can read.
                reportParseError(result, node, warning.text)
                return
            }
            if (type) return
            const index = indexAt(node, warning.line, warning.column)
            const endIndex = warning.endLine !== undefined && warning.endColumn !== undefined ? indexAt(node, warning.endLine, warning.endColumn) : undefined
            const text = unmaskMessage(warning.text.endsWith(suffix) ? warning.text.slice(0, -suffix.length) : warning.text, node, mask)
            const range = index !== undefined && endIndex !== undefined && endIndex >= index ? { index, endIndex } : {}
            report({ ruleName, result, node, message: () => text, messageArgs: quotedArgs(text), ...range })
        })
    }

    const rule: Rule = Object.assign(ruleFunction, {
        ruleName,
        messages,
        meta: { url: ruleUrl(spec.core) },
        ...(spec.primaryOptionArray ? { primaryOptionArray: true } : {}),
    })
    return { ruleName, rule, plugin: createPlugin(ruleName, rule) }
}
