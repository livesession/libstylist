// libstylist/tag-name — custom tags and markers follow the tag grammar and stay inside the file's
// package segment (SPEC §2.1): base package → `elo-<name>`, app → `elo-app-…`, and so on.
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils"

import { TAG_RE } from "../../conventions/index.js"
import { isCustomElementName } from "../../naming/index.js"
import { fileStylist } from "../context.js"
import { createRule } from "../create-rule.js"
import { attrName, hasIdentityPrefix } from "../jsx.js"

type Options = [{ allowTags?: string[] }]
type MessageIds = "prefix" | "invalid" | "segment" | "foreignSegment"

export default createRule<Options, MessageIds>({
    name: "tag-name",
    meta: {
        type: "problem",
        docs: { description: "Require custom tags and markers to follow the tag grammar and the file's package segment" },
        messages: {
            prefix: "Custom tag <{{name}}> is outside the project prefix — design-system tags are `{{prefix}}-…` (third-party elements go in the rule's `allowTags`).",
            invalid: "`{{name}}` is not a valid tag: `{{prefix}}[-segment]-name[-member]`, lowercase letters and digits, one hyphen between pieces (`{{pattern}}`).",
            segment: "`{{name}}` is outside this package's segment — {{namespace}} tags start with `{{prefix}}-{{segment}}-`.",
            foreignSegment:
                "`{{name}}` starts with the `{{other}}` segment of another package — base-package tags are `{{prefix}}-<name>`; rename the component so its tag cannot collide with `{{prefix}}-{{other}}-…`.",
        },
        schema: [
            {
                type: "object",
                properties: { allowTags: { type: "array", items: { type: "string" }, description: "Third-party custom elements to ignore." } },
                additionalProperties: false,
            },
        ],
    },
    defaultOptions: [{ allowTags: [] }],
    create(context, [{ allowTags = [] }]) {
        const file = fileStylist(context)
        const { prefix, segment } = file
        if (!prefix) return {}
        const allowed = new Set(allowTags)

        const check = (name: string, node: TSESTree.Node, isElement: boolean) => {
            if (allowed.has(name)) return
            if (!name.startsWith(`${prefix}-`)) {
                if (isElement) context.report({ node, messageId: "prefix", data: { name, prefix } })
                return
            }
            if (!TAG_RE.test(name)) {
                context.report({ node, messageId: "invalid", data: { name, prefix, pattern: TAG_RE.source } })
                return
            }
            if (segment === null) return
            if (segment) {
                if (!name.startsWith(`${prefix}-${segment}-`)) context.report({ node, messageId: "segment", data: { name, prefix, segment, namespace: file.namespace ?? segment } })
                return
            }
            const other = file.segments.find((s) => s && name.startsWith(`${prefix}-${s}-`))
            if (other) context.report({ node, messageId: "foreignSegment", data: { name, prefix, other } })
        }

        return {
            JSXOpeningElement(node) {
                if (node.name.type === AST_NODE_TYPES.JSXIdentifier && isCustomElementName(node.name.name)) check(node.name.name, node.name, true)
            },
            JSXAttribute(node) {
                const name = attrName(node)
                if (hasIdentityPrefix(name, prefix)) check(name, node.name, false)
            },
        }
    },
})
