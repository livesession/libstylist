// libstylist/no-anonymous-container — `document.createElement("div"|"span")` creates an unnamed
// container (portal roots, measuring nodes); create a named custom tag so the DOM says who owns it.
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils"

import { isGenericTag } from "../../naming/index.js"
import { memberName, resolveString, unwrap } from "../ast.js"
import { fileStylist } from "../context.js"
import { createRule } from "../create-rule.js"

type MessageIds = "anonymous"

/** True for `document`, `x.document`, `x.ownerDocument` and a bare `ownerDocument`. */
const isDocument = (node: TSESTree.Node): boolean => {
    const n = unwrap(node)
    if (n.type === AST_NODE_TYPES.Identifier) return n.name === "document" || n.name === "ownerDocument"
    if (n.type === AST_NODE_TYPES.MemberExpression) {
        const name = memberName(n)
        return name === "document" || name === "ownerDocument"
    }
    return false
}

export default createRule<[], MessageIds>({
    name: "no-anonymous-container",
    meta: {
        type: "problem",
        docs: { description: "Ban `document.createElement(\"div\" | \"span\")` — create a named custom tag instead" },
        messages: {
            anonymous: "`{{method}}(\"{{tag}}\")` creates an anonymous container — create a named custom tag (`{{prefix}}-…`, with a `display` default in the sheet) so the DOM shows which component owns it.",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        const prefix = fileStylist(context).prefix ?? "<prefix>"
        return {
            CallExpression(node) {
                const callee = unwrap(node.callee)
                if (callee.type !== AST_NODE_TYPES.MemberExpression || !isDocument(callee.object)) return
                const method = memberName(callee)
                const arg = method === "createElement" ? node.arguments[0] : method === "createElementNS" ? node.arguments[1] : undefined
                if (!arg || arg.type === AST_NODE_TYPES.SpreadElement) return
                const tag = resolveString(context, arg)
                if (tag !== undefined && isGenericTag(tag.toLowerCase())) context.report({ node, messageId: "anonymous", data: { method: `document.${method}`, tag, prefix } })
            },
        }
    },
})
