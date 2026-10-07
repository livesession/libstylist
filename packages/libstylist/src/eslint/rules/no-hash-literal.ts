// libstylist/no-hash-literal — string literals that hard-code a generated part attribute
// (`_cxclass_…`) or a retired `ls-*` class (`.ls-alert`, `ls-alert__icon`). A part-map module the
// workspace build generates (it starts with PART_MAP_HEADER) is where the hashes live: it is skipped.
import type { TSESTree } from "@typescript-eslint/utils"

import { PART_ATTR_PREFIX, PART_MAP_HEADER } from "../../conventions/index.js"
import { createRule } from "../create-rule.js"
import { isModuleSource } from "./no-dev-attrs.js"

type MessageIds = "hash" | "legacyClass"

const HASH = new RegExp(`${PART_ATTR_PREFIX}[a-z0-9-]*`)
const LEGACY_SELECTOR = /\.ls-[a-z0-9][a-z0-9_-]*/
const LEGACY_BEM = /(?<![\w-])ls-[a-z0-9-]*[a-z0-9]__[a-z0-9][a-z0-9_-]*/

/** The offending substring of `value`, and which kind it is. */
export function hashLiteralMatch(value: string): { kind: MessageIds; match: string } | null {
    const hash = HASH.exec(value)
    if (hash) return { kind: "hash", match: hash[0] }
    const legacy = LEGACY_SELECTOR.exec(value) ?? LEGACY_BEM.exec(value)
    return legacy ? { kind: "legacyClass", match: legacy[0] } : null
}

export default createRule<[], MessageIds>({
    name: "no-hash-literal",
    meta: {
        type: "problem",
        docs: { description: "Ban hard-coded part-attribute hashes and retired `ls-*` class names in strings" },
        messages: {
            hash: "Hard-coded part attribute `{{match}}` — hashes are generated. Use the exported part map (`alert.icon`), a custom tag/marker or a `data-*` attribute.",
            legacyClass: "Retired class `{{match}}` — `ls-*` classes no longer exist. Use the part map (`alert.icon`), the custom tag/marker (`elo-alert`, `[elo-button]`) or a `data-*` attribute.",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        if (context.sourceCode.text.startsWith(PART_MAP_HEADER)) return {}
        const check = (node: TSESTree.Node, value: string) => {
            const hit = hashLiteralMatch(value)
            if (hit) context.report({ node, messageId: hit.kind, data: { match: hit.match } })
        }
        return {
            Literal(node) {
                if (typeof node.value === "string" && !isModuleSource(node)) check(node, node.value)
            },
            TemplateElement(node) {
                check(node, node.value.cooked ?? node.value.raw)
            },
        }
    },
})
