// libstylist/no-classname — the design system never emits `class`: no `className`/`*ClassName`
// on any element; the only sanctioned value mid-migration is a counted `legacy(...)` call.
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils"

import { calleeName, isEmptyValue, isRuntimeCallee, propertyKeyName, spreadObjectLiterals, staticString, unwrap } from "../ast.js"
import { createRule } from "../create-rule.js"
import { attrName } from "../jsx.js"
import { recordLegacyUse } from "../legacy-usage.js"

/** `className`, `class` and every `*ClassName` prop (`inputClassName`, `contentClassName`, …). */
export const isClassProp = (name: string): boolean => name === "className" || name === "class" || /^[a-z][A-Za-z0-9]*ClassName$/.test(name)

type Options = [{ allowLegacy?: boolean }]
type MessageIds = "className" | "legacyArgs" | "legacyForbidden" | "passthroughArgs"

/** True for a `legacy(...)` argument that is a literal class name, possibly behind a condition. */
function isLiteralArg(node: TSESTree.Node): boolean {
    const n = unwrap(node)
    if (staticString(n) !== undefined || isEmptyValue(n)) return true
    if (n.type === AST_NODE_TYPES.LogicalExpression && n.operator === "&&") return isLiteralArg(n.right)
    if (n.type === AST_NODE_TYPES.ConditionalExpression) return isLiteralArg(n.consequent) && isLiteralArg(n.alternate)
    return false
}

export default createRule<Options, MessageIds>({
    name: "no-classname",
    meta: {
        type: "problem",
        docs: { description: "Ban `className`, `class` and `*ClassName` props in design-system source — parts go through `cx()`" },
        messages: {
            className:
                "`{{name}}` is not allowed in design-system source: the DS never renders `class`. Style this element with its parts from the sheet's part map, {...cx(cn.icon)}; a parent styles a child's root by spreading cx() on the child, which passes its props to its own cx() call; inner elements are reached through named slots (inputCx={cx(cn.field)}). A literal hook other sheets still target mid-migration goes through `legacy(\"…\")` from @livesession/libstylist/runtime.",
            legacyArgs: "`legacy(...)` takes literal class names only (`\"name\"` or `cond && \"name\"`) — it is a counted, temporary hook, not a className passthrough; a caller's class on the same element goes in as `legacyClassName(className)`.",
            legacyForbidden: "`legacy(...)`/`legacyClassName(...)` are no longer allowed here — this code has finished migrating; replace the hook with a part: {...cx(cn.part)}.",
            passthroughArgs: "`legacyClassName(...)` passes a caller's class prop through (a single identifier or member, e.g. `className`) — literal hooks go through `legacy(\"…\")`.",
        },
        schema: [
            {
                type: "object",
                properties: { allowLegacy: { type: "boolean", description: "Allow `legacy(...)` values (default true; turn off once a family is migrated)." } },
                additionalProperties: false,
            },
        ],
    },
    defaultOptions: [{ allowLegacy: true }],
    create(context, [{ allowLegacy }]) {
        let legacyCount = 0
        // A `const` props object spread into several elements is checked (and counted) once.
        const seen = new Set<TSESTree.Node>()

        /** The node as a `legacyClassName(...)` call from the libstylist runtime, or null. */
        const passthroughCall = (node: TSESTree.Node | null): TSESTree.CallExpression | null =>
            node && node.type === AST_NODE_TYPES.CallExpression && isRuntimeCallee(context, node.callee, "legacyClassName") ? node : null

        /** `legacyClassName` takes exactly one identifier or member: the caller's class prop. */
        const checkPassthrough = (call: TSESTree.CallExpression) => {
            const [arg, ...extra] = call.arguments
            const target = arg && arg.type !== AST_NODE_TYPES.SpreadElement ? unwrap(arg) : null
            const ok = extra.length === 0 && target !== null && (target.type === AST_NODE_TYPES.Identifier || target.type === AST_NODE_TYPES.MemberExpression)
            if (!ok) context.report({ node: call, messageId: "passthroughArgs" })
        }

        /** Reports the class prop unless its value is a well-formed `legacy(...)` call. */
        const check = (node: TSESTree.Node, name: string, value: TSESTree.Node | null) => {
            if (seen.has(node)) return
            seen.add(node)
            const call = value && unwrap(value)
            const passthrough = passthroughCall(call)
            if (passthrough) {
                legacyCount++
                if (!allowLegacy) {
                    context.report({ node: passthrough, messageId: "legacyForbidden" })
                    return
                }
                checkPassthrough(passthrough)
                return
            }
            if (call && call.type === AST_NODE_TYPES.CallExpression && isRuntimeCallee(context, call.callee, "legacy")) {
                legacyCount++
                if (!allowLegacy) {
                    context.report({ node: call, messageId: "legacyForbidden" })
                    return
                }
                for (const arg of call.arguments) {
                    if (arg.type === AST_NODE_TYPES.SpreadElement) {
                        context.report({ node: arg, messageId: "legacyArgs" })
                        continue
                    }
                    // `legacy("icon-wrapper", legacyClassName(className))`: a literal hook plus an unflipped
                    // caller's class on the same element — the pass-through is counted on its own
                    const inner = passthroughCall(unwrap(arg))
                    if (inner) {
                        legacyCount++
                        checkPassthrough(inner)
                    } else if (!isLiteralArg(arg)) context.report({ node: arg, messageId: "legacyArgs" })
                }
                return
            }
            context.report({ node, messageId: "className", data: { name } })
        }

        /** Checks the class keys of the object literals a props expression definitely contributes. */
        const checkObject = (props: TSESTree.Node) => {
            for (const { obj } of spreadObjectLiterals(context, props))
                for (const prop of obj.properties) {
                    if (prop.type !== AST_NODE_TYPES.Property) continue
                    const key = propertyKeyName(prop)
                    if (key !== undefined && isClassProp(key)) check(prop, key, prop.value)
                }
        }

        return {
            JSXAttribute(node) {
                const name = attrName(node)
                if (!isClassProp(name)) return
                const value = node.value?.type === AST_NODE_TYPES.JSXExpressionContainer ? node.value.expression : null
                check(node, name, value && value.type !== AST_NODE_TYPES.JSXEmptyExpression ? value : null)
            },
            JSXSpreadAttribute(node) {
                checkObject(node.argument)
            },
            CallExpression(node) {
                // `React.createElement(type, props)`; DOM `createElement` options never carry class keys.
                if (calleeName(node.callee) === "createElement" && node.arguments.length >= 2) checkObject(node.arguments[1])
            },
            "Program:exit"() {
                recordLegacyUse(context.filename, legacyCount)
            },
        }
    },
})
