// libstylist/no-class-query — DOM queries by class (`querySelector(".x")`, `closest(".x")`,
// `getElementsByClassName`) can never match design-system markup, which renders no classes.
import { AST_NODE_TYPES } from "@typescript-eslint/utils"
import selectorParser from "postcss-selector-parser"

import { memberName, resolveString, unwrap } from "../ast.js"
import { createRule } from "../create-rule.js"

type MessageIds = "classSelector" | "byClassName"

const QUERY_METHODS = new Set(["querySelector", "querySelectorAll", "closest", "matches", "webkitMatchesSelector"])

/** Stands in for `${…}` so a template's static shape can still be parsed as a selector. */
const PLACEHOLDER = "libstylistexpr"

/** The first class selector in a selector list, or `null` (also for unparseable strings). */
export function firstClassSelector(selector: string): string | null {
    let found: string | null = null
    try {
        selectorParser((root) => {
            root.walkClasses((c) => {
                found ??= c.value
            })
        }).processSync(selector)
    } catch {
        return null
    }
    return found
}

export default createRule<[], MessageIds>({
    name: "no-class-query",
    meta: {
        type: "problem",
        docs: { description: "Ban DOM queries that select by class" },
        messages: {
            classSelector:
                "`{{method}}` with the class selector `.{{name}}` — design-system markup renders no classes. Select a custom tag or marker (`elo-alert`, `[elo-button]`), a `data-*` attribute, or a part attribute from the part map.",
            byClassName: "`getElementsByClassName` selects by class, which design-system markup never renders — use `querySelectorAll` with a tag, marker, `data-*` or part-attribute selector.",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        return {
            CallExpression(node) {
                const callee = unwrap(node.callee)
                if (callee.type !== AST_NODE_TYPES.MemberExpression) return
                const method = memberName(callee)
                if (method === "getElementsByClassName") {
                    context.report({ node, messageId: "byClassName" })
                    return
                }
                if (!method || !QUERY_METHODS.has(method)) return
                const arg = node.arguments[0]
                if (!arg || arg.type === AST_NODE_TYPES.SpreadElement) return
                const selector = resolveString(context, arg, PLACEHOLDER)
                if (selector === undefined) return
                const name = firstClassSelector(selector)
                if (name !== null) context.report({ node: arg, messageId: "classSelector", data: { method, name: name.split(PLACEHOLDER).join("${…}") } })
            },
        }
    },
})
