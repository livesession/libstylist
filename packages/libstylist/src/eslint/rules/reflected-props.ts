// libstylist/reflected-props — React 19 writes a custom element's props through its DOM property
// when the element has one, so an unset `title`/`id`/`tabIndex`/… becomes `title="undefined"` or
// `tabindex="0"` instead of the removed attribute a native element had. On a custom-tag host, such a
// prop with a non-constant value needs `ref={unsetRef({ prop })}` (runtime), which removes the
// attribute whenever the value is unset.
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils"

import { isRuntimeCallee, propertyKeyName, resolveString, unwrap } from "../ast.js"
import { fileStylist } from "../context.js"
import { createRule } from "../create-rule.js"
import { attrName, attributes, elementName, isPrefixedTag } from "../jsx.js"

type MessageIds = "unguarded"

/**
 * React prop names that are also `HTMLElement` properties whose setter can't express "absent":
 * DOMString (`undefined` → "undefined"), long (`undefined` → 0) and the enumerated booleans that
 * serialize `false`. Nullable ones (`role`, `popover`) and plain booleans (`hidden`, `inert`) remove
 * the attribute by themselves; props React names differently from the property (`spellCheck`,
 * `autoCapitalize`) go through setAttribute.
 */
export const REFLECTED_PROPS: readonly string[] = [
    "title", "id", "lang", "dir", "accessKey", "tabIndex", "draggable", "translate",
    "contentEditable", "inputMode", "enterKeyHint", "nonce", "slot", "part",
]

/** True for a value that is set on every render: a literal, a template, or a `const` bound to a string. */
const isConstant = (context: Parameters<typeof resolveString>[0], value: TSESTree.JSXAttribute["value"]): boolean => {
    if (!value || value.type === AST_NODE_TYPES.Literal) return true
    if (value.type !== AST_NODE_TYPES.JSXExpressionContainer) return false
    const e = unwrap(value.expression)
    if (e.type === AST_NODE_TYPES.JSXEmptyExpression) return true
    if (e.type === AST_NODE_TYPES.Literal) return e.value !== null
    if (e.type === AST_NODE_TYPES.TemplateLiteral) return true
    return resolveString(context, e) !== undefined
}

export default createRule<[], MessageIds>({
    name: "reflected-props",
    meta: {
        type: "problem",
        docs: { description: "Require unsetRef() for non-constant DOM-property props (title, id, tabIndex, …) on custom tags" },
        messages: {
            unguarded:
                "`{{name}}` on <{{tag}}> is written through the DOM property under React 19: when it becomes unset the element keeps `{{attr}}=\"undefined\"` (tabindex=\"0\"). Add `ref={unsetRef({ {{name}} })}` from @livesession/libstylist/runtime, or pass a constant.",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        const { prefix } = fileStylist(context)
        if (!prefix) return {}
        /** The prop names an element's `ref={unsetRef({ … })}` covers (lowercased), or null without one. */
        const guarded = (opening: TSESTree.JSXOpeningElement): Set<string> | null => {
            const ref = attributes(opening).find((a) => attrName(a) === "ref")
            if (ref?.value?.type !== AST_NODE_TYPES.JSXExpressionContainer) return null
            const call = unwrap(ref.value.expression)
            if (call.type !== AST_NODE_TYPES.CallExpression || !isRuntimeCallee(context, call.callee, "unsetRef")) return null
            const arg = call.arguments[0] && unwrap(call.arguments[0])
            if (arg?.type !== AST_NODE_TYPES.ObjectExpression) return null
            const names = new Set<string>()
            for (const p of arg.properties) {
                const key = p.type === AST_NODE_TYPES.Property ? propertyKeyName(p) : undefined
                if (key) names.add(key.toLowerCase())
            }
            return names
        }
        return {
            JSXOpeningElement(opening) {
                const tag = elementName(opening.name)
                if (!isPrefixedTag(tag, prefix)) return
                let covered: Set<string> | null | undefined
                for (const attr of attributes(opening)) {
                    const name = attrName(attr)
                    if (!REFLECTED_PROPS.includes(name) || isConstant(context, attr.value)) continue
                    covered ??= guarded(opening)
                    if (covered?.has(name.toLowerCase())) continue
                    context.report({ node: attr, messageId: "unguarded", data: { name, tag, attr: name.toLowerCase() } })
                }
            },
        }
    },
})
