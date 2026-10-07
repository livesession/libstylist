// libstylist/no-dev-attrs — attributes the tooling owns or that were removed: the dev annotations
// (`_cxpart`, `data-react-component`, `data-file-source`), generated part attributes
// (`_cxclass_*`) and the retired hooks `data-component` / `data-part` — as attributes, spread object
// keys and cx() data-literal keys (`{ fileSource }` renders `data-file-source`).
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils"

import { DEV_ATTRS, PART_ATTR_PREFIX } from "../../conventions/index.js"
import { classifyCxCall } from "../../core/index.js"
import { calleeName, propertyKeyName, removeProperty, removeWithLeadingSpace, spreadObjectLiterals, type SpreadObject } from "../ast.js"
import { fileStylist } from "../context.js"
import { createRule } from "../create-rule.js"
import { asAny, cxFile } from "../cx.js"
import { attrName } from "../jsx.js"

type MessageIds = "dev" | "removed" | "part" | "devSelector" | "removedSelector"

const DEV = new Set<string>(Object.values(DEV_ATTRS))
const REMOVED = new Set(["data-component", "data-part"])

type Kind = "dev" | "removed" | "part"

/** Classifies an attribute name the author must not write. */
export function forbiddenAttr(name: string): Kind | null {
    if (DEV.has(name)) return "dev"
    if (REMOVED.has(name)) return "removed"
    if (name.startsWith(PART_ATTR_PREFIX)) return "part"
    return null
}

const SELECTOR = /\[\s*(_cxpart|data-react-component|data-file-source|data-component|data-part)(?=[\s=~|^$*\]])/

export default createRule<[], MessageIds>({
    name: "no-dev-attrs",
    meta: {
        type: "problem",
        docs: { description: "Ban hand-written dev annotations, generated part attributes and the removed data-component/data-part hooks" },
        fixable: "code",
        messages: {
            dev: "`{{name}}` is a dev-only annotation the libstylist transform adds by itself (and strips in production) — don't write it by hand.",
            removed: "`{{name}}` is removed: identity comes from the custom tag or marker, parts come from the part map through cx(). Keep variant/state `data-*` attributes only.",
            part: "`{{name}}` is a part attribute — read it from the sheet's part map and spread it with cx(): {...cx(cn.part)}.",
            devSelector: "Selector on the dev-only `{{name}}` attribute — it does not exist in production builds. Select a tag, marker, data-* variant or a part attribute from the part map.",
            removedSelector: "Selector on the removed `{{name}}` hook — select the custom tag/marker or a part attribute from the part map instead.",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        const cx = cxFile(context, fileStylist(context))
        // A `const` object spread into several elements is reported once, at its property.
        const reported = new Set<TSESTree.Node>()
        const reportName = (node: TSESTree.Node, name: string, removable: boolean) => {
            const kind = forbiddenAttr(name)
            if (!kind || reported.has(node)) return
            reported.add(node)
            context.report({ node, messageId: kind, data: { name }, fix: kind === "dev" && removable ? (fixer) => (node.type === AST_NODE_TYPES.Property ? removeProperty(context, fixer, node) : removeWithLeadingSpace(context, fixer, node)) : null })
        }

        const checkObjects = (objects: SpreadObject[]) => {
            for (const { obj, inline } of objects)
                for (const prop of obj.properties) {
                    if (prop.type !== AST_NODE_TYPES.Property) continue
                    const key = propertyKeyName(prop)
                    if (key !== undefined) reportName(prop, key, inline)
                }
        }

        const checkString = (node: TSESTree.Node, value: string) => {
            const m = SELECTOR.exec(value)
            if (m) context.report({ node, messageId: DEV.has(m[1]) ? "devSelector" : "removedSelector", data: { name: m[1] } })
        }

        return {
            JSXAttribute(node) {
                reportName(node, attrName(node), true)
            },
            JSXSpreadAttribute(node) {
                checkObjects(spreadObjectLiterals(context, node.argument))
            },
            CallExpression(node) {
                // cx() data literals: each key renders `data-<kebab(key)>`
                if (cx.isCxCall(node as TSESTree.Node)) {
                    for (const arg of classifyCxCall(asAny(node), cx.env)) {
                        if (arg.kind !== "data") continue
                        for (const entry of arg.entries) if (entry.kind === "key") reportName(entry.node as unknown as TSESTree.Node, entry.attr, false)
                    }
                    return
                }
                // `React.createElement(type, props)` — the same props, written as an object.
                if (calleeName(node.callee) === "createElement" && node.arguments.length >= 2) checkObjects(spreadObjectLiterals(context, node.arguments[1]))
            },
            Literal(node) {
                if (typeof node.value === "string" && !isModuleSource(node)) checkString(node, node.value)
            },
            TemplateLiteral(node) {
                checkString(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("x"))
            },
        }
    },
})

/** True for module specifiers (`import … from "x"`), which are never selectors. */
export function isModuleSource(node: TSESTree.Literal): boolean {
    const p = node.parent
    if (!p) return false
    return (
        ((p.type === AST_NODE_TYPES.ImportDeclaration || p.type === AST_NODE_TYPES.ExportAllDeclaration || p.type === AST_NODE_TYPES.ExportNamedDeclaration || p.type === AST_NODE_TYPES.ImportExpression) &&
            p.source === node) ||
        p.type === AST_NODE_TYPES.TSExternalModuleReference ||
        (p.type === AST_NODE_TYPES.TSLiteralType && p.parent?.type === AST_NODE_TYPES.TSImportType)
    )
}
