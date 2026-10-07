// libstylist/cx-args — every argument of a runtime `cx()` call follows the grammar (SPEC §5.2): a
// part-map member (`cn.icon`, `cn["group-label"]`), a props or slot object (an identifier or member
// expression — never data or a part held in a variable), an inline data literal, or a nested `cx()`.
// Parts are never conditional: state and variants travel as data-* attributes. One cx() call per
// element, spread unconditionally; its data literal only where it renders (never in a slot value or on
// a libstylist component, which forward parts and markers only).
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils"

import { classifyCxCall } from "../../core/index.js"
import { unwrap, type AnyRuleContext } from "../ast.js"
import { fileStylist } from "../context.js"
import { createRule } from "../create-rule.js"
import { asAny, cxFile, cxSpreads, rendersLibstylistComponent, writesOfLocal, type CxFile } from "../cx.js"
import { attrName, elementKind, elementName, isSlotAttribute } from "../jsx.js"

type MessageIds = "stateParts" | "invalid" | "fragment" | "nestedData" | "slotData" | "componentData" | "oneCall" | "relativeMap" | "heldCall"

/**
 * The locals a spread argument reads a held cx() result from — `{...attrs}` with `const attrs =
 * cx(cn.icon, { open })` or a conditional of calls (`const attrs = open ? cx(cn.a) : cx(cn.b)`, a
 * conditional part in disguise; any write of the local counts), also as a branch of a conditional or
 * logical value or spread into an object.
 */
function heldCxCalls(context: AnyRuleContext, cx: CxFile, node: TSESTree.Node, depth = 0): TSESTree.Identifier[] {
    if (depth > 8) return []
    const n = unwrap(node)
    if (n.type === AST_NODE_TYPES.Identifier) {
        return writesOfLocal(context, n).some((w) => {
            const write = unwrap(w as unknown as TSESTree.Node)
            return cx.isCxCall(write) || hidesCxCall(cx, write)
        })
            ? [n]
            : []
    }
    if (n.type === AST_NODE_TYPES.ConditionalExpression) return [...heldCxCalls(context, cx, n.consequent, depth + 1), ...heldCxCalls(context, cx, n.alternate, depth + 1)]
    if (n.type === AST_NODE_TYPES.LogicalExpression) return [...heldCxCalls(context, cx, n.left, depth + 1), ...heldCxCalls(context, cx, n.right, depth + 1)]
    if (n.type === AST_NODE_TYPES.ObjectExpression) return n.properties.flatMap((p) => (p.type === AST_NODE_TYPES.SpreadElement ? heldCxCalls(context, cx, p.argument, depth + 1) : []))
    return []
}

/**
 * True when `node` reads a local holding a cx() call with a data literal (`const attrs = cx(cn.icon,
 * { open })`), also as a branch of a conditional or logical value: passed on as an argument or a slot
 * value, the result forwards only its parts and markers — the data renders nothing.
 */
function holdsCxData(context: AnyRuleContext, cx: CxFile, node: TSESTree.Node, depth = 0, held = false): boolean {
    if (depth > 8) return false
    const n = unwrap(node)
    // a call counts only as (a branch of) a local's value — one written in place is the nested/slot check's
    if (cx.isCxCall(n)) return held && classifyCxCall(asAny(n), cx.env).some((a) => a.kind === "data")
    if (n.type === AST_NODE_TYPES.ConditionalExpression) return holdsCxData(context, cx, n.consequent, depth + 1, held) || holdsCxData(context, cx, n.alternate, depth + 1, held)
    if (n.type === AST_NODE_TYPES.LogicalExpression) return holdsCxData(context, cx, n.left, depth + 1, held) || holdsCxData(context, cx, n.right, depth + 1, held)
    if (n.type !== AST_NODE_TYPES.Identifier) return false
    return writesOfLocal(context, n).some((w) => holdsCxData(context, cx, w as unknown as TSESTree.Node, depth + 1, true))
}

/** True when a spread argument (or a slot value) is a conditional or logical expression with a runtime cx() call among its operands. */
function hidesCxCall(cx: CxFile, node: TSESTree.Node, depth = 0): boolean {
    if (depth > 8) return false
    const n = unwrap(node)
    if (cx.isCxCall(n)) return depth > 0
    if (n.type === AST_NODE_TYPES.ConditionalExpression) return hidesCxCall(cx, n.consequent, depth + 1) || hidesCxCall(cx, n.alternate, depth + 1)
    if (n.type === AST_NODE_TYPES.LogicalExpression) return hidesCxCall(cx, n.left, depth + 1) || hidesCxCall(cx, n.right, depth + 1)
    // an object spreading a conditional cx() call (`{ ...cx(cn.a), ...(open ? cx(cn.b) : {}) }`)
    if (n.type === AST_NODE_TYPES.ObjectExpression) {
        return n.properties.some((p) => p.type === AST_NODE_TYPES.SpreadElement && !cx.isCxCall(unwrap(p.argument)) && hidesCxCall(cx, p.argument, depth + 1))
    }
    return false
}

const TS_WRAPPERS = new Set<string>([AST_NODE_TYPES.TSAsExpression, AST_NODE_TYPES.TSSatisfiesExpression, AST_NODE_TYPES.TSNonNullExpression, AST_NODE_TYPES.TSTypeAssertion])

/** The nearest ancestor that is not a type wrapper around the node (`x as T`, `x!`), and the outermost such wrapper (or the node). */
function outerOf(node: TSESTree.Node): { parent: TSESTree.Node | undefined; child: TSESTree.Node } {
    let child = node
    while (child.parent && TS_WRAPPERS.has(child.parent.type)) child = child.parent
    return { parent: child.parent, child }
}

/**
 * The named slot attribute (`inputCx={…}`) whose value a cx() call is — directly, through type wrappers
 * or as a branch of a conditional or logical value — or null.
 */
function slotOf(call: TSESTree.Node): string | null {
    let n = call
    for (let i = 0; i < 16; i++) {
        const { parent, child } = outerOf(n)
        if (!parent) return null
        if ((parent.type === AST_NODE_TYPES.ConditionalExpression && parent.test !== child) || parent.type === AST_NODE_TYPES.LogicalExpression) {
            n = parent
            continue
        }
        if (parent.type === AST_NODE_TYPES.JSXExpressionContainer && parent.parent?.type === AST_NODE_TYPES.JSXAttribute && isSlotAttribute(parent.parent)) return attrName(parent.parent)
        return null
    }
    return null
}

export default createRule<[], MessageIds>({
    name: "cx-args",
    meta: {
        type: "problem",
        docs: { description: "Require every `cx()` argument to be a part-map member, a props/slot object, an inline data literal or a nested `cx()` — never a conditional part" },
        messages: {
            stateParts:
                "Conditional part — state and variants go through data-* attributes; parts name structure only. Write the state into the call's data literal, cx(cn.root, { open }), and select `.root[data-open]` in the sheet.",
            invalid: "{{message}}",
            fragment: "A cx() spread on <{{element}}> has no element to attach its attributes to — put it on a real element.",
            nestedData: "A data literal in a nested cx() call renders nothing: a cx() result passed on forwards only its parts and markers — move the data into the outer call's literal.",
            slotData:
                "A data literal in a slot value renders nothing: {{slot}} carries only parts and markers into the child — put the state on your own element, or pass it as one of the child's props.",
            componentData:
                "A data literal on <{{element}}> renders nothing: a libstylist component's cx() forwards only the parts and markers it receives — pass the state as one of its props, or put it on your own element.",
            oneCall: "One cx() call per element — merge this call's parts, forwarded props and data into the element's first cx() spread.",
            heldCall:
                "Spread the cx() call on the element itself, not the result held in `{{name}}`: a held call escapes the one-call and conditional-part checks and gets no dev annotations (_cxpart, data-file-source). Move the call here, {...cx(…)} — passing `{{name}}` on as an argument would drop its data (a cx() result forwards only its parts and markers).",
            relativeMap:
                "`{{local}}` is the {{scope}} part map imported by the path \"{{module}}\" — part maps are recognized only through a package specifier, so its members are read as props here (no part check, no _cxpart, no root part). Import it through a package specifier or an alias and list that in partMaps (docs/CONFIG.md).",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        const file = fileStylist(context)
        const cx = cxFile(context, file)
        return {
            CallExpression(node) {
                if (!cx.isCxCall(node)) return
                // an argument of an outer cx() call (a type wrapper around this call is not an outer call)
                const outer = outerOf(node).parent
                const nested = !!outer && cx.isCxCall(outer)
                // the value of a named slot attribute (`inputCx={cx(…)}`, also as a branch of a conditional value)
                const slot = slotOf(node)
                // nested cx() calls are visited on their own
                for (const arg of classifyCxCall(asAny(node), cx.env)) {
                    const at = arg.node as unknown as TSESTree.Node
                    if (nested && arg.kind === "data") context.report({ node: at, messageId: "nestedData" })
                    if (slot && arg.kind === "data") context.report({ node: at, messageId: "slotData", data: { slot } })
                    // a held cx() result with data, passed on as an argument, forwards only its parts and markers
                    if (arg.kind === "props" && holdsCxData(context, cx, at)) context.report({ node: at, messageId: "nestedData" })
                    if (arg.kind === "props") {
                        const n = unwrap(at)
                        const map = n.type === AST_NODE_TYPES.MemberExpression && n.object.type === AST_NODE_TYPES.Identifier ? cx.relativePartMap(n.object) : null
                        if (map) context.report({ node: at, messageId: "relativeMap", data: { local: map.local, scope: map.scope, module: map.module } })
                    }
                    if (arg.kind !== "invalid") continue
                    if (arg.problem === "conditional-part") context.report({ node: at, messageId: "stateParts" })
                    else context.report({ node: at, messageId: "invalid", data: { message: arg.message } })
                }
            },
            JSXSpreadAttribute(node) {
                const opening = node.parent as TSESTree.JSXOpeningElement
                const call = unwrap(node.argument)
                // a conditional spread of cx() calls is a conditional part (or a conditional call) in disguise
                if (!cx.isCxCall(call)) {
                    if (hidesCxCall(cx, node.argument)) context.report({ node, messageId: "stateParts" })
                    // a cx() result held in a local and spread on its own
                    for (const id of heldCxCalls(context, cx, node.argument)) context.report({ node: id, messageId: "heldCall", data: { name: id.name } })
                    return
                }
                const kind = elementKind(opening)
                if (!kind.host && kind.name === "Fragment" && opening.name.type !== AST_NODE_TYPES.JSXNamespacedName) {
                    context.report({ node, messageId: "fragment", data: { element: kind.name } })
                }
                // data on a libstylist component: its cx() forwards parts and markers only
                if (!kind.host && rendersLibstylistComponent(context, file, opening)) {
                    for (const arg of classifyCxCall(asAny(call), cx.env)) {
                        if (arg.kind === "data") context.report({ node: arg.node as unknown as TSESTree.Node, messageId: "componentData", data: { element: elementName(opening.name) } })
                    }
                }
            },
            JSXOpeningElement(node) {
                for (const s of cxSpreads(cx, node).slice(1)) context.report({ node: s.spread, messageId: "oneCall" })
            },
            JSXAttribute(node) {
                // a conditional slot value (`inputCx={open ? cx(cn.a) : undefined}`) is a conditional part on the child's element
                if (!isSlotAttribute(node) || node.value?.type !== AST_NODE_TYPES.JSXExpressionContainer) return
                const e = node.value.expression
                if (e.type !== AST_NODE_TYPES.JSXEmptyExpression && hidesCxCall(cx, e)) context.report({ node, messageId: "stateParts" })
                // a held cx() result with data as the slot value: the slot carries only parts and markers
                if (e.type !== AST_NODE_TYPES.JSXEmptyExpression && holdsCxData(context, cx, e)) context.report({ node: e, messageId: "slotData", data: { slot: attrName(node) } })
            },
        }
    },
})
