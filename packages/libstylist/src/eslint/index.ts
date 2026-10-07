// `@livesession/libstylist/eslint` — the per-file lint layer (docs/RULES.md): an ESLint 9 flat-config
// plugin. Rule ids are `libstylist/<rule>`; docs live in docs/RULES.md.
//
//     import tseslint from "typescript-eslint"
//     import libstylist from "@livesession/libstylist/eslint"
//     export default [
//         { files: ["packages/*/src/**/*.tsx"], ...libstylist.configs.recommended, languageOptions: { parser: tseslint.parser },
//           settings: { libstylist: { registry: "packages/css/dist/stylist-registry.json" } } },
//         { files: ["**/*.stories.tsx"], ...libstylist.configs.stories, languageOptions: { parser: tseslint.parser } },
//     ]
//
// The configs set no parser: TypeScript/TSX sources need typescript-eslint's (docs/CONFIG.md, Lint).
import { createRequire } from "node:module"

import type { TSESLint } from "@typescript-eslint/utils"

import cxArgs from "./rules/cx-args.js"
import cxPartExists from "./rules/cx-part-exists.js"
import dataInCx from "./rules/data-in-cx.js"
import forwardProps from "./rules/forward-props.js"
import markerAttr from "./rules/marker-attr.js"
import noAnonymousContainer from "./rules/no-anonymous-container.js"
import noClassQuery from "./rules/no-class-query.js"
import noClassname from "./rules/no-classname.js"
import noCxAttribute from "./rules/no-cx-attribute.js"
import noDevAttrs from "./rules/no-dev-attrs.js"
import noHashLiteral from "./rules/no-hash-literal.js"
import noImperativeClass from "./rules/no-imperative-class.js"
import noLiteralClass from "./rules/no-literal-class.js"
import reflectedProps from "./rules/reflected-props.js"
import rootPart from "./rules/root-part.js"
import tagName from "./rules/tag-name.js"

export { RULES_DOC_URL, createRule, ruleDocsUrl } from "./create-rule.js"
export { clearContextCaches, discoverSegments, fileStylist, loadRegistry, rootBinding } from "./context.js"
export { cxFile, cxSpreads, primaryScope, type CxFile, type CxSpread } from "./cx.js"
export type { FileStylist, LibstylistSettings, RegistryRoot, RegistryScope, RootBinding, StylistRegistry } from "./context.js"
export { legacyUsage, legacyUsageTotal, resetLegacyUsage } from "./legacy-usage.js"
export { DEFAULT_CLASS_HELPERS } from "./rules/no-literal-class.js"

/** Every `libstylist/*` rule, keyed by its id without the plugin prefix. */
export const rules = {
    "no-classname": noClassname,
    "cx-args": cxArgs,
    "cx-part-exists": cxPartExists,
    "no-cx-attribute": noCxAttribute,
    "data-in-cx": dataInCx,
    "no-literal-class": noLiteralClass,
    "no-dev-attrs": noDevAttrs,
    "marker-attr": markerAttr,
    "tag-name": tagName,
    "forward-props": forwardProps,
    "root-part": rootPart,
    "no-imperative-class": noImperativeClass,
    "no-anonymous-container": noAnonymousContainer,
    "no-class-query": noClassQuery,
    "no-hash-literal": noHashLiteral,
    "reflected-props": reflectedProps,
}

/** A `libstylist/*` rule id. */
export type RuleName = keyof typeof rules

/** Rules for story files: no hand-written hooks, hashes or class queries; stories keep their own layout classes. */
export const STORY_RULES: readonly RuleName[] = ["cx-args", "cx-part-exists", "no-cx-attribute", "marker-attr", "no-dev-attrs", "no-class-query", "no-hash-literal"]

export interface LibstylistPlugin {
    meta: { name: string; version: string; namespace: string }
    rules: typeof rules
    configs: {
        /** Every rule as an error — for design-system component source. */
        recommended: TSESLint.FlatConfig.Config
        /** The story-safe subset (see `STORY_RULES`). */
        stories: TSESLint.FlatConfig.Config
    }
}

function readVersion(): string {
    try {
        return (createRequire(import.meta.url)("../../package.json") as { version?: string }).version ?? "0.0.0"
    } catch {
        return "0.0.0"
    }
}

const errors = (names: readonly RuleName[]): TSESLint.FlatConfig.Rules => Object.fromEntries(names.map((n) => [`libstylist/${n}`, "error"]))

const plugin: LibstylistPlugin = {
    meta: { name: "@livesession/libstylist", version: readVersion(), namespace: "libstylist" },
    rules,
    configs: {} as LibstylistPlugin["configs"],
}

plugin.configs.recommended = {
    name: "libstylist/recommended",
    plugins: { libstylist: plugin },
    rules: errors(Object.keys(rules) as RuleName[]),
}

plugin.configs.stories = {
    name: "libstylist/stories",
    plugins: { libstylist: plugin },
    rules: errors(STORY_RULES),
}

export const configs = plugin.configs

export default plugin
