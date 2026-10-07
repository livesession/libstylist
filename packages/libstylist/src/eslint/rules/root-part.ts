// libstylist/root-part — the identity element's cx() carries its bound root part (`cn.root`, or the
// family local such as `cn.header`), and reserved root locals appear in no other element's cx().
import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils"

import { classifyCxCall, flattenCxArgs, partArgs, type CxArg } from "../../core/index.js"
import { fileStylist, reservedLocals, rootBinding, type RootBinding } from "../context.js"
import { createRule } from "../create-rule.js"
import { asAny, cxFile, cxSpreads, primaryScope, spreadParts, type CxSpread } from "../cx.js"
import { cxBinding, memberText, prependArg } from "../fix.js"
import { elementName, identityOf, type Identity } from "../jsx.js"

type MessageIds = "missing" | "reserved" | "misplaced" | "addPart"

type PartArg = Extract<CxArg, { kind: "part" }>

interface Entry {
    node: TSESTree.JSXOpeningElement
    identity: Identity
    spreads: CxSpread[]
    parts: PartArg[]
    /** Reads a member of a part map imported by a relative path (cx-args reports it; its root is invisible here). */
    relative: boolean
}

export default createRule<[], MessageIds>({
    name: "root-part",
    meta: {
        type: "problem",
        docs: { description: "Require the identity element's cx() to carry its root part, and keep root parts off every other element" },
        fixable: "code",
        hasSuggestions: true,
        messages: {
            missing: "Identity element `{{identity}}` must carry its root part {{label}} in its cx() call — the sheet's root rules select it (`.{{local}}` → its part attribute).",
            reserved:
                "{{label}} is reserved for the component's identity element (its custom tag or marker) — give this element its own part name, or put the marker on it if it is the component's root.",
            misplaced: "{{label}} is the root part of another identity element — `{{identity}}` is bound to {{expected}}.",
            addPart: "Add {{label}}",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        const file = fileStylist(context)
        const { prefix } = file
        if (!prefix) return {}
        const cx = cxFile(context, file)
        const registry = cx.registry
        const entries: Entry[] = []
        /** cx() calls outside identity elements' spreads, with their parts. */
        const others: Array<{ call: TSESTree.CallExpression; parts: PartArg[] }> = []
        const identitySpreadCalls = new Set<TSESTree.Node>()

        const describe = (e: Entry) => (e.identity.kind === "tag" ? `<${e.identity.name}>` : `<${elementName(e.node.name)} ${e.identity.name}>`)

        /** The local name of an imported part map of `scope`, for fixes and messages. */
        const localOf = (scope: string): string | null => {
            for (const s of context.sourceCode.ast.body) {
                if (s.type !== AST_NODE_TYPES.ImportDeclaration) continue
                for (const spec of s.specifiers) if (spec.type === AST_NODE_TYPES.ImportSpecifier && cx.partMap(spec.local)?.scope === scope) return spec.local.name
            }
            return null
        }
        const labelOf = (b: RootBinding) => {
            const local = localOf(b.scope)
            return local ? `\`${memberText(local, b.local)}\`` : `\`${b.local}\` of the ${b.scope} part map`
        }
        const carries = (parts: PartArg[], b: RootBinding) => parts.some((p) => p.map.scope === b.scope && p.part === b.local)

        return {
            JSXOpeningElement(node) {
                const identity = identityOf(node, prefix)
                if (!identity) return
                const spreads = cxSpreads(cx, node)
                for (const s of spreads) identitySpreadCalls.add(s.call)
                const relative = spreads.some((s) =>
                    flattenCxArgs(s.args).some((a) => {
                        const n = a.node as unknown as TSESTree.Node
                        return a.kind === "props" && n.type === AST_NODE_TYPES.MemberExpression && n.object.type === AST_NODE_TYPES.Identifier && cx.relativePartMap(n.object) !== null
                    }),
                )
                entries.push({ node, identity, spreads, parts: spreadParts(spreads), relative })
            },
            CallExpression(node) {
                if (!cx.isCxCall(node)) return
                // nested calls are covered by their outermost call
                if (node.parent?.type === AST_NODE_TYPES.CallExpression && cx.isCxCall(node.parent)) return
                others.push({ call: node, parts: partArgs(classifyCxCall(asAny(node), cx.env)) })
            },
            "Program:exit"() {
                const fileScope = primaryScope(context, cx)
                const identities = new Set(entries.map((e) => e.identity.name))
                // cx() calls that are not an identity element's own spread: reserved locals are off limits
                for (const o of others) {
                    if (identitySpreadCalls.has(o.call)) continue
                    for (const p of o.parts) {
                        if (reservedLocals(file, registry, p.map.scope, identities, fileScope).has(p.part)) {
                            context.report({ node: p.node as unknown as TSESTree.Node, messageId: "reserved", data: { label: `\`${memberText(p.map.local, p.part)}\`` } })
                        }
                    }
                }
                const bound = entries.map((e) => rootBinding(file, registry, e.identity.name, fileScope))
                // implied roots (`<scope>.root`) that some identity element of the file already carries
                const carried = new Set<string>()
                entries.forEach((e, i) => {
                    const b = bound[i]
                    if (b && b.source === "default" && carries(e.parts, b)) carried.add(`${b.scope}:${b.local}`)
                })
                entries.forEach((e, i) => {
                    const binding = bound[i]
                    if (!binding) return
                    // the implied root is ambiguous in a file with several identity elements: which one the sheet's root belongs to is unknown
                    const ambiguous = binding.source === "default" && identities.size > 1
                    if (ambiguous && carried.has(`${binding.scope}:${binding.local}`)) return
                    const label = labelOf(binding)
                    const data = { identity: describe(e), label, local: binding.local }
                    if (!carries(e.parts, binding)) {
                        if (ambiguous && e.spreads.length && e.parts.length) return
                        // its part map is imported by a path: the root may well be there (cx-args says why it can't be seen)
                        if (e.relative) return
                        const local = localOf(binding.scope)
                        const fix = local
                            ? (fixer: TSESLint.RuleFixer): TSESLint.RuleFix[] | null => {
                                  const member = memberText(local, binding.local)
                                  if (e.spreads.length) return [prependArg(context, fixer, e.spreads[0].call, member)]
                                  const b = cxBinding(context, cx, e.node, fixer)
                                  if (!b) return null
                                  const anchor = e.identity.kind === "tag" ? e.node.name : e.identity.node
                                  return [...b.fixes, fixer.insertTextAfter(anchor, ` {...${b.name}(${member})}`)]
                              }
                            : null
                        const at = e.spreads[0]?.spread ?? e.identity.node
                        if (ambiguous || !fix) context.report({ node: at, messageId: "missing", data, suggest: fix ? [{ messageId: "addPart", data: { label }, fix }] : [] })
                        else context.report({ node: at, messageId: "missing", data, fix })
                    }
                    if (binding.source !== "default" && binding.local !== "root") {
                        for (const p of e.parts) {
                            if (p.part === "root" && p.map.scope === binding.scope) {
                                context.report({ node: p.node as unknown as TSESTree.Node, messageId: "misplaced", data: { label: `\`${memberText(p.map.local, p.part)}\``, identity: describe(e), expected: label } })
                            }
                        }
                    }
                })
            },
        }
    },
})
