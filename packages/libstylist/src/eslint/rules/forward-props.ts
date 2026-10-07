// libstylist/forward-props — every identity element (a custom tag of the prefix, or an element
// carrying a marker) passes the component's props to its `cx()` call — `{...cx(cn.root, rest)}` — so
// wrappers can pass their marker down and parents and apps can attach parts to it (SPEC §5.4). A
// component that hands its whole props object on (`<Popover elo-tooltip {...rest}>`) forwards them
// already; any other spread (object literals, calls) does not count. "The component's props" is the
// forwarding predicate `carriesProps` the checker's R112 shares: the props parameter, its rest, a named
// slot destructured from it (or aliases of those) — never another prop (`style`), an import or a `let`.
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils"

import { SLOT_PROP } from "../../conventions/index.js"
import { carriesProps, flattenCxArgs } from "../../core/index.js"
import { unwrap } from "../ast.js"
import { fileStylist, rootBinding } from "../context.js"
import { createRule } from "../create-rule.js"
import { asAny, cxFile, cxSpreads, elementBinding, partMapLocal, primaryScope, rendersLibstylistComponent } from "../cx.js"
import { memberText } from "../fix.js"
import { elementName, identityOf, spreads } from "../jsx.js"

type MessageIds = "missing"

export default createRule<[], MessageIds>({
    name: "forward-props",
    meta: {
        type: "problem",
        docs: { description: "Require identity elements to pass the component's props to their `cx()` call" },
        messages: {
            missing:
                "Identity element `{{identity}}` must pass the component's props (its props parameter, rest or named slot) to its cx() call — {{hint}}: it is how wrappers pass their marker down and how parents and apps attach their parts to this component's root.",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        const file = fileStylist(context)
        const { prefix } = file
        if (!prefix) return {}
        const cx = cxFile(context, file)
        const carries = (n: TSESTree.Node) => carriesProps(asAny(n), cx.propsEnv)
        return {
            JSXOpeningElement(node) {
                const identity = identityOf(node, prefix)
                if (!identity) return
                const calls = cxSpreads(cx, node)
                if (calls.some((s) => flattenCxArgs(s.args).some((a) => a.kind === "props" && carries(a.node as unknown as TSESTree.Node)))) return
                // the whole props object handed on (`{...rest}`, `{...props}`)
                if (spreads(node).some((s) => !cx.isCxCall(unwrap(s.argument)) && carries(s.argument))) return
                const name = elementName(node.name)
                const label = identity.kind === "tag" ? `<${identity.name}>` : `<${name} ${identity.name}>`
                context.report({ node: identity.node, messageId: "missing", data: { identity: label, hint: hintFor(node, identity.name) } })
            },
        }

        /** The bound root part as written in this file (`cn.root`, `cn.content`), or a placeholder. */
        function partText(identity: string, fallback: string): string {
            const binding = rootBinding(file, cx.registry, identity, primaryScope(context, cx))
            if (!binding) return fallback
            return memberText(partMapLocal(context, cx, binding.scope) ?? "cn", binding.local)
        }

        /** A named slot (`contentCx`) an enclosing function destructures from its props parameter, or null. */
        function slotOf(node: TSESTree.Node): string | null {
            for (let n: TSESTree.Node | undefined = node.parent; n; n = n.parent) {
                if (n.type !== AST_NODE_TYPES.FunctionDeclaration && n.type !== AST_NODE_TYPES.FunctionExpression && n.type !== AST_NODE_TYPES.ArrowFunctionExpression) continue
                let param: TSESTree.Node | undefined = n.params[0]
                if (param?.type === AST_NODE_TYPES.AssignmentPattern) param = param.left
                if (param?.type !== AST_NODE_TYPES.ObjectPattern) continue
                for (const p of param.properties) {
                    if (p.type === AST_NODE_TYPES.Property && !p.computed && p.key.type === AST_NODE_TYPES.Identifier && SLOT_PROP.test(p.key.name)) return p.key.name
                }
            }
            return null
        }

        /** The call to write: a delegate's marker rides on `cx(rest)`, a member root carries its part and slot, an own root its root part and rest. */
        function hintFor(node: TSESTree.JSXOpeningElement, identity: string): string {
            const name = elementName(node.name)
            const delegate = `a delegate forwards the caller's parts with its marker: <${name} ${identity} {...cx(rest)}>`
            const binding = elementBinding(context, node)
            if (binding.kind === "unresolved" || rendersLibstylistComponent(context, file, node)) return delegate
            // a marker on a third-party host (`<RadixPopover.Content elo-popover-content>`): a member root, whose props object is its slot
            if (binding.kind === "import") return `a member root carries its bound part and the slot that brings the caller's parts: {...cx(${partText(identity, "cn.<part>")}, ${slotOf(node) ?? "contentCx"})}`
            // its own root: a host element or a polymorphic `<As>`
            return `{...cx(${partText(identity, "cn.root")}, rest)}`
        }
    },
})
