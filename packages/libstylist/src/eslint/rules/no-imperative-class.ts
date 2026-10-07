// libstylist/no-imperative-class — no class manipulation through the DOM API: `classList`,
// `className =` and `setAttribute("class", …)`. The design system renders no classes.
import { AST_NODE_TYPES } from "@typescript-eslint/utils"

import { calleeName, memberName, propertyKeyName, staticString } from "../ast.js"
import { createRule } from "../create-rule.js"

type MessageIds = "classList" | "className" | "attribute"

const ATTRIBUTE_METHODS = new Map<string, number>([
    ["setAttribute", 0],
    ["removeAttribute", 0],
    ["toggleAttribute", 0],
    ["setAttributeNS", 1],
    ["removeAttributeNS", 1],
])

export default createRule<[], MessageIds>({
    name: "no-imperative-class",
    meta: {
        type: "problem",
        docs: { description: "Ban `classList`, `className =` and class-attribute writes through the DOM API" },
        messages: {
            classList: "`classList` works on classes, which the design system never renders — toggle a `data-*` attribute (styled by the sheet) instead.",
            className: "Assigning `className` writes a class, which the design system never renders — set a `data-*` attribute instead.",
            attribute: "`{{method}}(\"{{name}}\")` writes the class attribute, which the design system never renders — use a `data-*` attribute instead.",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        return {
            MemberExpression(node) {
                if (memberName(node) === "classList") context.report({ node: node.property, messageId: "classList" })
            },
            ObjectPattern(node) {
                for (const prop of node.properties) if (prop.type === AST_NODE_TYPES.Property && propertyKeyName(prop) === "classList") context.report({ node: prop, messageId: "classList" })
            },
            AssignmentExpression(node) {
                if (node.left.type === AST_NODE_TYPES.MemberExpression && memberName(node.left) === "className") context.report({ node: node.left, messageId: "className" })
            },
            CallExpression(node) {
                if (node.callee.type !== AST_NODE_TYPES.MemberExpression) return
                const method = calleeName(node.callee)
                const index = method ? ATTRIBUTE_METHODS.get(method) : undefined
                if (index === undefined || !method) return
                const name = staticString(node.arguments[index])
                if (name !== undefined && /^class(name)?$/i.test(name)) context.report({ node, messageId: "attribute", data: { method, name } })
            },
        }
    },
})
