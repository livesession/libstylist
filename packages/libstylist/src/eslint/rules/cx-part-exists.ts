// libstylist/cx-part-exists — every member read from a part map names a part of its sheet, and every
// import from a part-map module names a sheet of its groups — checked against the stylist registry
// (`settings.libstylist.registry`). A no-op when no registry is configured or built yet.
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils"

import { PART_MAP_TAGS_KEY, memberPartName, partMapGroups } from "../../core/index.js"
import { exportName } from "../../registry/modules.js"
import { registryScope, scopeParts } from "../context.js"
import { fileStylist } from "../context.js"
import { createRule } from "../create-rule.js"
import { asAny, cxFile } from "../cx.js"
import { IDENT } from "../fix.js"
import { nearest } from "../suggest.js"

type MessageIds = "unknownPart" | "unknownMap" | "replace"

export default createRule<[], MessageIds>({
    name: "cx-part-exists",
    meta: {
        type: "problem",
        docs: { description: "Require every part-map member to name a part of its stylesheet, checked against the stylist registry" },
        hasSuggestions: true,
        messages: {
            unknownPart: "Unknown part \"{{part}}\" of {{map}} (sheet \"{{scope}}\"){{hint}}. Parts are the local classes of the sheet.",
            unknownMap: "\"{{name}}\" is not a part map of {{module}}{{hint}} — every sheet of the group exports its part map under its camelCased scope.",
            replace: "Replace with \"{{replacement}}\"",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        const file = fileStylist(context)
        const cx = cxFile(context, file)
        const registry = cx.registry
        if (!registry) return {}
        if (registry.prefix && file.prefix && registry.prefix !== file.prefix) return {}
        const hintFor = (name: string | null) => (name ? ` — did you mean "${name}"?` : "")
        const partMaps = file.settings.partMaps ?? null

        return {
            ImportDeclaration(node) {
                if (!partMaps || node.importKind === "type") return
                // one module may serve several groups (an app package's `#css`: its core and render groups)
                const groups = partMapGroups(node.source.value, partMaps)
                if (!groups) return
                const names = Object.entries(registry.scopes)
                    .filter(([, s]) => s.group === undefined || groups.includes(s.group))
                    .map(([scope]) => exportName(scope))
                for (const spec of node.specifiers) {
                    if (spec.type !== AST_NODE_TYPES.ImportSpecifier || spec.importKind === "type") continue
                    const name = spec.imported.type === AST_NODE_TYPES.Identifier ? spec.imported.name : spec.imported.value
                    if (names.includes(name)) continue
                    const near = nearest(name, names)
                    context.report({
                        node: spec.imported,
                        messageId: "unknownMap",
                        data: { name, module: node.source.value, hint: hintFor(near) },
                        suggest: near && spec.imported.type === AST_NODE_TYPES.Identifier ? [{ messageId: "replace", data: { replacement: near }, fix: (fixer) => fixer.replaceText(spec.imported, spec.local.name === name ? `${near} as ${name}` : near) }] : [],
                    })
                }
            },
            MemberExpression(node) {
                if (node.object.type !== AST_NODE_TYPES.Identifier) return
                const map = cx.partMap(node.object)
                if (!map?.scope) return
                const part = memberPartName(asAny(node))
                if (part === null || part === PART_MAP_TAGS_KEY) return
                const entry = registryScope(registry, map.scope)
                if (!entry) return
                const parts = scopeParts(entry)
                if (parts.includes(part)) return
                const near = nearest(part, parts)
                const replacement = near ? (IDENT.test(near) ? `${map.local}.${near}` : `${map.local}[${JSON.stringify(near)}]`) : null
                context.report({
                    node: node.property,
                    messageId: "unknownPart",
                    data: { part, map: map.local, scope: map.scope, hint: hintFor(near) },
                    suggest: replacement ? [{ messageId: "replace", data: { replacement }, fix: (fixer) => fixer.replaceText(node as TSESTree.Node, replacement) }] : [],
                })
            },
        }
    },
})
