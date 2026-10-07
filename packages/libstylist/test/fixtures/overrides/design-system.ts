// A small design system for the override and reset tests, built the way the real css build builds
// packages/css: every sheet under design-system/<group>/ → one registry (prefix "ds"), each sheet compiled
// with postcss-nesting + the libstylist plugin, the components group aggregated into styles.css behind
// the design system's layer statement, the gram group into gram.css. No hash is written by hand.
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import postcss from "postcss"
import nesting from "postcss-nesting"

import { collectOverrideSheet, stylist, type OverrideSheetInfo } from "../../../src/postcss/index.js"
import {
    buildRegistry,
    resolveOverrides,
    stylistOptions,
    type OverridePackage,
    type Registry,
    type RegistryGroup,
    type ResolveOverridesResult,
} from "../../../src/registry/index.js"

const HERE = join(dirname(fileURLToPath(import.meta.url)), "design-system")

export const DS_GROUPS: Record<string, RegistryGroup> = { components: { namespace: "core" }, gram: { namespace: "gram" } }

/** The design system's reset and tokens layers, as its aggregate starts. */
export const DS_PREAMBLE = [
    "@layer reset, tokens, components, utilities;",
    "@layer reset {\n  button { margin: 0; padding: 0; }\n  ul { list-style: none; }\n}",
    "@layer tokens {\n  :root { --ds-radius: 4px; }\n}",
].join("\n")

export interface DesignSystem {
    registry: Registry
    /** scope → the sheet compiled alone (flattened, part attributes, display defaults first). */
    compiled: Record<string, string>
    /** The components aggregate (`styles.css`): the preamble, then one `@layer components { … }` per sheet. */
    styles: string
    /** The gram aggregate (`gram.css`). */
    gram: string
}

let cached: Promise<DesignSystem> | null = null

/** Builds the fixture design system once per test process. */
export function designSystem(): Promise<DesignSystem> {
    cached ??= build()
    return cached
}

async function build(): Promise<DesignSystem> {
    const sheets = Object.keys(DS_GROUPS).flatMap(group =>
        readdirSync(join(HERE, group))
            .filter(f => f.endsWith(".css"))
            .sort()
            .map(f => ({ file: `${group}/${f}`, group, css: readFileSync(join(HERE, group, f), "utf8") })),
    )
    const { registry, errors } = buildRegistry({ prefix: "ds", groups: DS_GROUPS, sheets })
    if (errors.length) throw new Error(`fixture design system: ${errors.map(e => e.message).join("\n")}`)
    const compiled: Record<string, string> = {}
    for (const [scope, info] of Object.entries(registry.scopes)) {
        const sheet = sheets.find(s => s.file === info.file)!
        const result = await postcss([nesting(), stylist({ ...stylistOptions(registry, scope, DS_GROUPS), reportGlobals: false })]).process(sheet.css, { from: join(HERE, sheet.file) })
        compiled[scope] = result.css.trim()
    }
    const aggregate = (group: string) =>
        [DS_PREAMBLE, ...Object.entries(registry.scopes).filter(([, s]) => s.group === group).map(([scope]) => `@layer components {\n${compiled[scope]}\n}`)].join("\n\n") + "\n"
    return { registry, compiled, styles: aggregate("components"), gram: aggregate("gram") }
}

/** The fixture's component packages, as `resolvePackage` finds them from an override sheet. */
export const PACKAGES: Record<string, OverridePackage | { error: string }> = {
    "@ds/react": { prefix: "ds", namespace: "core" },
    "@ds/gram": { prefix: "ds", namespace: "gram" },
    "@ds/css": { error: "@ds/css is a css package (it publishes the registry) — name the component package the component is imported from" },
    "@shop/ui": { prefix: "app", namespace: "core" },
    "@other/ui": { prefix: "zz", namespace: "core" },
}

export const resolvePackage = (specifier: string): OverridePackage | { error: string } => PACKAGES[specifier] ?? { error: `${specifier} is not installed where the override sheet is` }

/** The app side: prefix "app", a core and a render namespace, one component in each and `Shared` in both. */
export function appRegistry(): Registry {
    const { registry, errors } = buildRegistry({
        prefix: "app",
        groups: { core: { namespace: "core" }, render: { namespace: "render" } },
        sheets: [
            { file: "src/css/cart.css", group: "core", css: "@stylist root Cart display block;\n.root {}" },
            { file: "src/css/shared.css", group: "core", css: "@stylist root Shared;\n.root {}" },
            { file: "src/css/render/render-cart.css", group: "render", css: "@stylist root RenderCart display block;\n.root {}" },
            { file: "src/css/render/render-shared.css", group: "render", css: "@stylist root Shared;\n.root {}" },
        ],
    })
    if (errors.length) throw new Error(errors.map(e => e.message).join("\n"))
    return registry
}

/** Collects and resolves override sheets (`file` → css) against the fixture design system and app. */
export async function resolveSheets(files: Record<string, string>, app: Registry | null = appRegistry()): Promise<ResolveOverridesResult & { infos: OverrideSheetInfo[] }> {
    const ds = await designSystem()
    const infos = Object.entries(files).map(([file, css]) => collectOverrideSheet(css, { file }))
    return { ...resolveOverrides({ sheets: infos, designSystems: [ds.registry], resolvePackage, app: { prefix: "app", registry: app } }), infos }
}
