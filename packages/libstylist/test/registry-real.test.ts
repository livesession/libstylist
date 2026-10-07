// Smoke test: collectSheet + buildRegistry over every real stylesheet in packages/css/src of the
// design-system checkout LIBSTYLIST_DESIGN_SYSTEM names (read-only; skipped without it — see
// ./design-system.ts), with the design system's group → namespace table.
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import { collectSheet } from "../src/postcss/index.js"
import { buildRegistry, exportName, toLock, toPartMapModules, type RegistryGroup } from "../src/registry/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

const skip = skipWithoutDesignSystem

const GROUPS: Record<string, RegistryGroup> = {
    components: { namespace: "core" },
    "app-ui": { namespace: "app" },
    player: { namespace: "player" },
    gram: { namespace: "gram" },
    infinity: { namespace: "inf" },
    ai: { namespace: "ai" },
}

interface RealSheet {
    file: string
    group: string
    css: string
}

/** The real sheets, read once per process and only when a gated test runs. */
let cached: RealSheet[] | undefined
const sheets = (): RealSheet[] =>
    (cached ??= Object.keys(GROUPS).flatMap(group =>
        readdirSync(designSystemPath("packages", "css", "src", group))
            .filter(f => f.endsWith(".css"))
            .sort()
            .map(f => ({ file: `packages/css/src/${group}/${f}`, group, css: readFileSync(designSystemPath("packages", "css", "src", group, f), "utf8") })),
    ))

// packages/css/scripts/build.ts camel(), verbatim — today's export names
const LEGACY_RESERVED = new Set(["switch", "default", "new", "class", "case", "do", "if", "in", "for", "var", "let", "const"])
const legacyCamel = (kebab: string) => {
    const name = kebab.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    return LEGACY_RESERVED.has(name) ? `${name}Classes` : name
}

test("real sheets: collectSheet reads every sheet without errors", { skip }, t => {
    let classes = 0
    let globals = 0
    let roots = 0
    for (const s of sheets()) {
        const info = collectSheet(s.css, s)
        assert.deepEqual(info.errors, [], s.file)
        assert.equal(info.scope, s.file.split("/").pop()?.replace(/\.css$/, ""))
        classes += info.classes.length
        globals += info.globals.length
        roots += info.roots.length
    }
    t.diagnostic(`${sheets().length} sheets: ${classes} local classes, ${globals} distinct :global() hooks, ${roots} @stylist root directives`)
})

test("real sheets: registry has zero errors and zero collisions", { skip }, t => {
    const { registry, errors } = buildRegistry({ prefix: "elo", groups: GROUPS, sheets: sheets() })
    assert.deepEqual(errors, [])
    assert.equal(Object.keys(registry.scopes).length, sheets().length)
    const attrs = Object.values(registry.scopes).flatMap(s => Object.values(s.parts))
    assert.equal(new Set(attrs).size, attrs.length, "every part attribute is unique")
    for (const a of attrs) assert.match(a, /^_cxclass_elo-[0-9a-z]{6}$/)
    assert.equal(registry.scopes.alert.parts.icon, "_cxclass_elo-or4d4l")
    assert.equal(registry.scopes["thinking-shader"].namespace, "ai")
    assert.equal(registry.scopes["filter-bar"].namespace, "inf")
    const lock = toLock(registry)
    assert.equal(Object.keys(lock.parts).length, attrs.length)
    t.diagnostic(`${Object.keys(registry.scopes).length} scopes, ${attrs.length} parts, ${Object.keys(lock.tags).length} tags`)
})

test("real sheets: registry is independent of input order", { skip }, () => {
    const a = buildRegistry({ prefix: "elo", groups: GROUPS, sheets: sheets() })
    const b = buildRegistry({ prefix: "elo", groups: GROUPS, sheets: [...sheets()].reverse() })
    assert.equal(JSON.stringify(b.registry), JSON.stringify(a.registry))
})

test("real sheets: part-map modules keep today's export names and evaluate", { skip }, async () => {
    const { registry } = buildRegistry({ prefix: "elo", groups: GROUPS, sheets: sheets() })
    for (const scope of Object.keys(registry.scopes)) assert.equal(exportName(scope), legacyCamel(scope), scope)
    for (const group of Object.keys(GROUPS)) {
        const modules = toPartMapModules(registry, group)
        const esm = await import(`data:text/javascript;base64,${Buffer.from(modules.mjs).toString("base64")}`)
        const cjs: Record<string, unknown> = {}
        new Function("exports", modules.cjs)(cjs)
        const scopes = Object.entries(registry.scopes).filter(([, s]) => s.group === group)
        assert.deepEqual(Object.keys(esm).sort(), scopes.map(([scope]) => exportName(scope)).sort(), group)
        assert.deepEqual({ ...esm }, cjs, group)
        for (const [scope, info] of scopes) {
            assert.deepEqual(esm[exportName(scope)], { ...info.parts, $tags: Object.fromEntries(info.roots.map(r => [r.component, r.tag])) })
            assert.match(modules.dts, new RegExp(`export declare const ${exportName(scope)}: \\{`))
        }
    }
})
