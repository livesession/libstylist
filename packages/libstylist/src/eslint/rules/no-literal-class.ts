// libstylist/no-literal-class — literal class names passed to `className`-like props or to the old
// class-joining helpers (`cx(...)` from utils/cx, clsx, classnames). `legacy(...)` and the runtime
// `cx()` (checked by cx-args) are exempt.
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils"

import { isRuntimeCallee, memberName, propertyKeyName, unwrap } from "../ast.js"
import { createRule } from "../create-rule.js"
import { attrName } from "../jsx.js"
import { isClassProp } from "./no-classname.js"

type Options = [{ helpers?: string[] }]
type MessageIds = "literal"

/** Class-joining helpers whose string arguments are class names. */
export const DEFAULT_CLASS_HELPERS: readonly string[] = ["cx", "clsx", "classnames", "classNames", "cn"]

export default createRule<Options, MessageIds>({
    name: "no-literal-class",
    meta: {
        type: "problem",
        docs: { description: "Ban literal class names in `className` values and class-joining helper calls" },
        messages: {
            literal:
                "Literal class \"{{name}}\": the design system renders no classes. Use a part from the sheet's part map ({...cx(cn.part)}), a `data-*` variant, or `legacy(\"…\")` from @livesession/libstylist/runtime while another sheet still targets the class mid-migration.",
        },
        schema: [
            {
                type: "object",
                properties: { helpers: { type: "array", items: { type: "string" }, description: "Names of class-joining helper functions." } },
                additionalProperties: false,
            },
        ],
    },
    defaultOptions: [{ helpers: [...DEFAULT_CLASS_HELPERS] }],
    create(context, [{ helpers = [...DEFAULT_CLASS_HELPERS] }]) {
        const helperSet = new Set(helpers)

        const isHelperCall = (node: TSESTree.CallExpression): boolean => {
            const callee = unwrap(node.callee)
            return callee.type === AST_NODE_TYPES.Identifier && helperSet.has(callee.name) && !isRuntimeCallee(context, callee, callee.name)
        }

        const report = (node: TSESTree.Node, name: string) => context.report({ node, messageId: "literal", data: { name: name.trim() } })

        /** Reports the literals of an expression that ends up as class names. */
        const walk = (input: TSESTree.Node, inHelper: boolean): void => {
            const n = unwrap(input)
            switch (n.type) {
                case AST_NODE_TYPES.Literal:
                    if (typeof n.value === "string" && n.value.trim()) report(n, n.value)
                    return
                case AST_NODE_TYPES.TemplateLiteral: {
                    const text = n.quasis.map((q) => q.value.cooked ?? q.value.raw).join("${…}")
                    if (n.quasis.some((q) => (q.value.cooked ?? q.value.raw).trim())) report(n, text)
                    for (const e of n.expressions) walk(e, inHelper)
                    return
                }
                case AST_NODE_TYPES.ConditionalExpression:
                    walk(n.consequent, inHelper)
                    walk(n.alternate, inHelper)
                    return
                case AST_NODE_TYPES.LogicalExpression:
                    if (n.operator !== "&&") walk(n.left, inHelper)
                    walk(n.right, inHelper)
                    return
                case AST_NODE_TYPES.BinaryExpression:
                    if (n.operator === "+") {
                        walk(n.left, inHelper)
                        walk(n.right, inHelper)
                    }
                    return
                case AST_NODE_TYPES.ArrayExpression:
                    for (const el of n.elements) if (el && el.type !== AST_NODE_TYPES.SpreadElement) walk(el, inHelper)
                    return
                case AST_NODE_TYPES.ObjectExpression:
                    // clsx/classnames object form: `{ active: cond }` — the keys are class names.
                    if (!inHelper) return
                    for (const prop of n.properties) {
                        if (prop.type !== AST_NODE_TYPES.Property) continue
                        const key = propertyKeyName(prop)
                        if (key !== undefined && key.trim()) report(prop.key, key)
                    }
                    return
                case AST_NODE_TYPES.CallExpression:
                    // Helper calls are visited on their own; `[...].join(" ")` joins class names.
                    if (isHelperCall(n)) return
                    if (n.callee.type === AST_NODE_TYPES.MemberExpression && memberName(n.callee) === "join") walk(n.callee.object, inHelper)
                    return
            }
        }

        return {
            JSXAttribute(node) {
                if (!isClassProp(attrName(node)) || !node.value) return
                if (node.value.type === AST_NODE_TYPES.Literal) walk(node.value, false)
                else if (node.value.type === AST_NODE_TYPES.JSXExpressionContainer && node.value.expression.type !== AST_NODE_TYPES.JSXEmptyExpression) walk(node.value.expression, false)
            },
            CallExpression(node) {
                if (!isHelperCall(node)) return
                for (const arg of node.arguments) if (arg.type !== AST_NODE_TYPES.SpreadElement) walk(arg, true)
            },
        }
    },
})
