// libstylist/no-cx-attribute — the removed source API (SPEC §5.2): the `cx` JSX attribute (SVG
// geometry excepted), the `@cxScope` pragma and part-list strings in named slots. Parts are read from
// the sheet's part map and spread with a `cx()` call; `libstylist codemod` converts a file.
import { AST_NODE_TYPES } from "@typescript-eslint/utils"

import { findScopePragma } from "../../core/index.js"
import { exportName } from "../../registry/modules.js"
import { unwrap } from "../ast.js"
import { createRule } from "../create-rule.js"
import { attrName, elementKind, isLegacyCxAttribute, isSlotAttribute, ownerElement } from "../jsx.js"

type MessageIds = "attribute" | "pragma" | "slotValue" | "slotOnHost"

export default createRule<[], MessageIds>({
    name: "no-cx-attribute",
    meta: {
        type: "problem",
        docs: { description: "Ban the removed `cx` attribute, `@cxScope` pragma and part-list slot strings — spread `cx()` calls with part-map members" },
        messages: {
            attribute:
                "The cx attribute was removed: import the sheet's part map (import { alert as cn } from \"<css package>\") and spread a cx() call — {...cx(cn.icon)}. State goes into the call's data literal: {...cx(cn.root, { open })}. `libstylist codemod` converts a file.",
            pragma: "The @cxScope pragma was removed: import the sheet's part map instead — import { {{name}} as cn } from \"<css package>\" — and write {...cx(cn.part)}.",
            slotValue: "Named slot `{{name}}` takes a cx() value: {{name}}={cx(cn.part)} — a part-list string or array is no longer compiled.",
            slotOnHost: "Named slot `{{name}}` on <{{element}}>: slots pass parts to an inner element of a child component, so they only go on component elements — spread cx() on a host element.",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        return {
            Program() {
                for (const comment of context.sourceCode.getAllComments()) {
                    const scope = findScopePragma([comment])
                    if (scope) context.report({ loc: comment.loc, messageId: "pragma", data: { name: exportName(scope) } })
                }
            },
            JSXAttribute(node) {
                if (isLegacyCxAttribute(node)) {
                    context.report({ node, messageId: "attribute" })
                    return
                }
                if (!isSlotAttribute(node)) return
                const name = attrName(node)
                const kind = elementKind(ownerElement(node))
                if (kind.host) {
                    context.report({ node, messageId: "slotOnHost", data: { name, element: kind.name } })
                    return
                }
                const v = node.value
                const e = v && v.type === AST_NODE_TYPES.JSXExpressionContainer ? (v.expression.type === AST_NODE_TYPES.JSXEmptyExpression ? null : unwrap(v.expression)) : v
                if (!e) return
                if (
                    (e.type === AST_NODE_TYPES.Literal && typeof e.value === "string") ||
                    e.type === AST_NODE_TYPES.TemplateLiteral ||
                    e.type === AST_NODE_TYPES.ArrayExpression ||
                    e.type === AST_NODE_TYPES.ObjectExpression
                ) {
                    context.report({ node, messageId: "slotValue", data: { name } })
                }
            },
        }
    },
})
