// libstylist/directive-syntax — the `@stylist root|scope` directives (SPEC §4.1), an override sheet's
// `@stylist override` and `@stylist reset` (SPEC §9.2: grammar and placement, as the build reads them)
// and the arguments of `:component()`, `:cx()` and `:global()` (SPEC §4.2) are well-formed, and spelled
// in lowercase: the build matches them exactly and would leave `@Stylist` / `:Component()` in the output.
import type { AtRule, Root } from "postcss"
import stylelint from "stylelint"
import type { Rule, RuleBase } from "stylelint"

import { readOverrideDirectives } from "../../postcss/directives.js"
import { checkComponentArg, checkCxArg, checkGlobalArg, parseStylistDirective } from "../directives.js"
import { STYLIST_PSEUDOS, findPseudoCalls, inKeyframes, ruleSelector } from "../selectors.js"
import { DIRECTIVE_AT_RULE, PLUGIN_NAMESPACE, isOverrideSheetRoot, ruleUrl, sheetScope } from "../util.js"

const {
    createPlugin,
    utils: { report, ruleMessages, validateOptions },
} = stylelint

export const ruleName = `${PLUGIN_NAMESPACE}/directive-syntax` as const

export const messages = ruleMessages(ruleName, {
    invalid: (params: string, reason: string) => `Invalid "@stylist ${params}": ${reason}`,
    nested: () => `Unexpected nested "@stylist" directive — directives belong at the top level of the sheet`,
    nestedReset: () => `Unexpected nested "@stylist reset" — a reset names its parts at the top of the override sheet: "@stylist reset <part> …;"`,
    overrideSheet: (reason: string) => `Invalid override sheet directive — ${reason}`,
    block: () => `Unexpected block on "@stylist" — it is a statement ending with ";"`,
    duplicateRoot: (path: string) => `Unexpected second "@stylist root ${path}" — each component is bound once`,
    duplicateScope: () => `Unexpected second "@stylist scope" — a sheet pins one scope id`,
    pseudo: (call: string, reason: string) => `Invalid "${call}": ${reason}`,
    casing: (written: string, expected: string) => `Expected "${written}" to be written "${expected}" — the build only recognizes the lowercase spelling`,
})

export const meta = { url: ruleUrl("directive-syntax") }

const ruleFunction: RuleBase<boolean, undefined> = (primary) => (root: Root, result) => {
    if (!validateOptions(result, ruleName, { actual: primary, possible: [true] })) return

    const roots = new Set<string>()
    let scopeSeen = false
    const overrideSheet = isOverrideSheetRoot(root)
    root.walkAtRules((atRule: AtRule) => {
        if (atRule.name.toLowerCase() !== DIRECTIVE_AT_RULE) return
        const nameEnd = `@${atRule.name}`.length
        if (atRule.name !== DIRECTIVE_AT_RULE) {
            // The build leaves `@Stylist` in the output as an unknown at-rule: it is no directive.
            report({ ruleName, result, node: atRule, message: messages.casing, messageArgs: [`@${atRule.name}`, `@${DIRECTIVE_AT_RULE}`], index: 0, endIndex: nameEnd })
            return
        }
        if (atRule.parent?.type !== "root") {
            const reset = /^\s*reset(?:\s|$)/.test(atRule.params)
            report({ ruleName, result, node: atRule, message: reset ? messages.nestedReset : messages.nested, index: 0, endIndex: nameEnd })
        }
        if (atRule.nodes !== undefined) {
            report({ ruleName, result, node: atRule, message: messages.block, index: 0, endIndex: nameEnd })
        }
        const parsed = parseStylistDirective(atRule.params)
        if (!parsed.ok) {
            report({ ruleName, result, node: atRule, message: messages.invalid, messageArgs: [atRule.params, parsed.error], index: 0, endIndex: nameEnd })
            return
        }
        const { directive } = parsed
        // an override sheet's directives are placed and combined as readOverrideDirectives says (below)
        if (overrideSheet || directive.kind === "override" || directive.kind === "reset") return
        if (directive.kind === "root") {
            if (roots.has(directive.path)) {
                report({ ruleName, result, node: atRule, message: messages.duplicateRoot, messageArgs: [directive.path], index: 0, endIndex: nameEnd })
            }
            roots.add(directive.path)
        } else {
            if (scopeSeen) report({ ruleName, result, node: atRule, message: messages.duplicateScope, index: 0, endIndex: nameEnd })
            scopeSeen = true
        }
    })

    if (overrideSheet) {
        // one @stylist override first, then resets, before any rule; no root/scope; a part reset once —
        // exactly the build's reader. Grammar, casing and nesting are reported above.
        for (const issue of readOverrideDirectives(root).errors) {
            const node = issue.node
            if (node.type === "atrule" && (node.name !== DIRECTIVE_AT_RULE || node.parent?.type !== "root" || node.nodes !== undefined || !parseStylistDirective(node.params).ok)) continue
            const at = node.type === "atrule" ? { index: 0, endIndex: `@${node.name}`.length } : {}
            report({ ruleName, result, node, message: messages.overrideSheet, messageArgs: [issue.message], ...at })
        }
    }

    const ownScope = sheetScope(root)
    root.walkRules((rule) => {
        if (inKeyframes(rule)) return
        const selector = ruleSelector(rule)
        for (const call of findPseudoCalls(selector, STYLIST_PSEUDOS)) {
            if (call.written !== call.name) {
                const nameEnd = call.start + call.written.length + 1
                report({ ruleName, result, node: rule, message: messages.casing, messageArgs: [`:${call.written}`, `:${call.name}`], index: call.start, endIndex: nameEnd })
            }
            let reason: string | null
            if (call.argStart < 0) reason = `":${call.name}" needs a parenthesized argument`
            else if (call.argEnd < 0) reason = "unbalanced parentheses"
            else if (call.name === "component") reason = checkComponentArg(call.arg)
            else if (call.name === "cx") reason = checkCxArg(call.arg, ownScope)
            else reason = checkGlobalArg(call.arg)
            if (reason === null) continue
            const end = call.argEnd >= 0 ? call.argEnd + 1 : call.argStart >= 0 ? selector.length : call.start + call.name.length + 1
            report({ ruleName, result, node: rule, message: messages.pseudo, messageArgs: [selector.slice(call.start, end), reason], index: call.start, endIndex: end })
        }
    })
}

export const rule: Rule = Object.assign(ruleFunction, { ruleName, messages, meta })

export default createPlugin(ruleName, rule)
