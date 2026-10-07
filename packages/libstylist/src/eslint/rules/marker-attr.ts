// libstylist/marker-attr — identity markers (`<button elo-button>`) are value-less, never sit on a
// generic div/span host (that root is the custom tag itself) and never repeat the element's tag.
import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils"

import { isGenericTag } from "../../naming/index.js"
import { removeWithLeadingSpace, staticString } from "../ast.js"
import { fileStylist } from "../context.js"
import { createRule } from "../create-rule.js"
import { attrName, elementName, hasIdentityPrefix, ownerElement } from "../jsx.js"

type MessageIds = "value" | "generic" | "redundant"

const NATIVE_ESCAPE = /@libstylistRoot\s+native\b/

/** True when an enclosing declaration carries the `@libstylistRoot native <reason>` escape hatch. */
export function hasNativeEscape(sourceCode: Readonly<TSESLint.SourceCode>, node: TSESTree.Node): boolean {
    for (const a of sourceCode.getAncestors(node)) {
        if (a.type === AST_NODE_TYPES.Program) continue
        if (sourceCode.getCommentsBefore(a).some((c) => NATIVE_ESCAPE.test(c.value))) return true
    }
    return false
}

/** True for a marker value that already means "value-less" (`""`). */
const isEmptyMarkerValue = (value: TSESTree.JSXAttribute["value"]): boolean => {
    if (!value) return true
    if (value.type === AST_NODE_TYPES.Literal) return value.value === ""
    if (value.type === AST_NODE_TYPES.JSXExpressionContainer && value.expression.type !== AST_NODE_TYPES.JSXEmptyExpression) return staticString(value.expression) === ""
    return false
}

/**
 * True when dropping the value cannot change behavior beyond what the marker contract says: a
 * constant that renders the attribute (a string, `true`, a number). `false`/`null`/`undefined`
 * render no marker at all, so turning them into a value-less (present) marker is not a safe fix.
 */
const isLiteralValue = (value: TSESTree.JSXAttribute["value"]): boolean => {
    if (!value) return true
    if (value.type === AST_NODE_TYPES.Literal) return true
    if (value.type !== AST_NODE_TYPES.JSXExpressionContainer) return false
    const e = value.expression
    if (e.type === AST_NODE_TYPES.JSXEmptyExpression) return true
    if (e.type === AST_NODE_TYPES.Literal) return e.value !== null && e.value !== false && !("regex" in e && e.regex)
    return e.type === AST_NODE_TYPES.TemplateLiteral && e.expressions.length === 0
}

export default createRule<[], MessageIds>({
    name: "marker-attr",
    meta: {
        type: "problem",
        docs: { description: "Require identity markers to be value-less and keep them off generic div/span hosts" },
        fixable: "code",
        messages: {
            value: "Marker `{{name}}` must be written value-less (`<{{element}} {{name}}>`): markers carry identity, not data; the transform normalizes them to \"\".",
            generic: "Marker `{{name}}` on a <{{element}}>: a div/span root renders as the custom tag itself — write `<{{name}}>` instead (with its `display` default in the sheet).",
            redundant: "`<{{name}}>` already carries its identity — drop the `{{name}}` marker.",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        const { prefix } = fileStylist(context)
        if (!prefix) return {}
        return {
            JSXAttribute(node) {
                const name = attrName(node)
                if (!hasIdentityPrefix(name, prefix)) return
                const owner = ownerElement(node)
                const element = elementName(owner.name)
                if (element === name) {
                    context.report({ node, messageId: "redundant", data: { name }, fix: (fixer) => removeWithLeadingSpace(context, fixer, node) })
                    return
                }
                if (isGenericTag(element) && !hasNativeEscape(context.sourceCode, node)) context.report({ node, messageId: "generic", data: { name, element } })
                if (!isEmptyMarkerValue(node.value)) {
                    const fixable = isLiteralValue(node.value)
                    context.report({
                        node,
                        messageId: "value",
                        data: { name, element },
                        fix: fixable ? (fixer) => fixer.removeRange([node.name.range[1], node.range[1]]) : null,
                    })
                }
            },
        }
    },
})
