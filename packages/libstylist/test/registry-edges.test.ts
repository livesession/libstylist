// Adversarial cases for the registry layer (SPEC §7) plus pass-1 ≡ pass-2 consistency over the
// design system's real stylesheets (read-only; the checkout LIBSTYLIST_DESIGN_SYSTEM names — see
// ./design-system.ts; the real-sheet tests skip without it).
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"

import postcss from "postcss"
import nesting from "postcss-nesting"

import { partAttr } from "../src/hash/index.js"
import { findClassSelectors, stylist, type StylistSink } from "../src/postcss/index.js"
import {
    buildRegistry,
    createResolvers,
    diffLock,
    exportName,
    sameComponent,
    stylistOptions,
    toLock,
    toPartMapModules,
    toSelectorRenameMap,
    type Registry,
    type RegistryGroup,
} from "../src/registry/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

const GROUPS: Record<string, RegistryGroup> = {
    components: { namespace: "core" },
    "app-ui": { namespace: "app" },
    player: { namespace: "player" },
    gram: { namespace: "gram" },
    infinity: { namespace: "inf" },
    ai: { namespace: "ai" },
}

test("registry: `Path` and `Path.Root` name the same identity element", async () => {
    const { registry, errors } = buildRegistry({
        prefix: "elo",
        groups: GROUPS,
        sheets: [
            { file: "gram/list-collection.css", group: "gram", css: "@stylist root ListCollection.Root display flex;\n.root {}" },
            { file: "components/x.css", group: "components", css: ".root :component(gram/ListCollection) > :component(gram/ListCollection.Root) {}" },
        ],
    })
    assert.deepEqual(errors, [])
    const r = createResolvers(registry, "core")
    assert.equal(r.resolveTag("gram", "ListCollection"), "elo-gram-listcollection")
    assert.equal(r.resolveTag("gram", "ListCollection.Root"), "elo-gram-listcollection")
    assert.equal(r.resolveTag("gram", "ListCollection.Item"), undefined)
    assert.equal(sameComponent("A.Root", "A"), true)
    assert.equal(sameComponent("A.Root.Item", "A.Item"), false)
    const { css } = await postcss([nesting(), stylist({ ...stylistOptions(registry, "x", GROUPS), reportGlobals: false })]).process(
        ".root :component(gram/ListCollection) {}",
        { from: "x.css" },
    )
    assert.match(css, /:is\(elo-gram-listcollection,\[elo-gram-listcollection\]\)/)
})

test("registry: error files are listed once; case-insensitive directives and stylelint's display keywords apply", () => {
    const { registry, errors } = buildRegistry({
        prefix: "elo",
        groups: GROUPS,
        sheets: [
            { file: "components/z.css", group: "components", css: "@stylist root Z;\n@stylist root Z.Root;" },
            { file: "components/y.css", group: "components", css: "@STYLIST root Y display inherit;" },
            { file: "components/w.css", group: "components", css: "@Stylist root W display inline-grid;\n.root [class] {}" },
        ],
    })
    // sheet-level problems first (pass 1 reads), then cross-sheet ones
    assert.deepEqual(errors.map(e => [e.code, e.files]), [
        ["invalid-directive", ["components/y.css"]],
        ["invalid-sheet", ["components/w.css"]],
        ["duplicate-tag", ["components/z.css"]],
    ])
    assert.match(errors[1].message, /selects a class/)
    assert.deepEqual(registry.scopes.w.roots, [{ component: "W", local: "root", tag: "elo-w", display: "inline-grid" }])
})

test("registry: two scopes of one group sharing a part-map export name are reported in pass 1", () => {
    const { errors } = buildRegistry({
        prefix: "elo",
        groups: GROUPS,
        sheets: [
            { file: "components/a-b1.css", group: "components", css: ".x {}" },
            { file: "components/a-b-1.css", group: "components", css: ".y {}" },
            // another group's module may reuse the name
            { file: "player/a-b-2.css", group: "player", css: "@stylist scope a-b2;\n.z {}" },
            { file: "gram/a-b-2.css", group: "gram", css: ".z {}" },
        ],
    })
    assert.deepEqual(errors.map(e => [e.code, e.files]), [["duplicate-export", ["components/a-b1.css", "components/a-b-1.css"]]])
    assert.match(errors[0].message, /both export as "aB1" from the components part map/)
})

test("registry: exact SPEC §7 shape (no extra keys) and plain JSON", () => {
    const { registry } = buildRegistry({
        prefix: "elo",
        groups: GROUPS,
        sheets: [{ file: "components/alert.css", group: "components", css: "@stylist root Alert display block;\n.root .icon:global(.x) { animation: k 1s } @keyframes k {}" }],
    })
    assert.deepEqual(Object.keys(registry), ["version", "prefix", "hash", "scopes"])
    assert.deepEqual(Object.keys(registry.hash), ["version", "length"])
    assert.deepEqual(Object.keys(registry.scopes.alert), ["namespace", "group", "file", "roots", "parts", "globals", "keyframes"])
    assert.deepEqual(Object.keys(registry.scopes.alert.roots[0]), ["component", "local", "tag", "display"])
    assert.equal(registry.scopes.alert.parts.icon, "_cxclass_elo-or4d4l")
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(registry))), JSON.stringify(registry))
})

// --- the real stylesheets ------------------------------------------------------------------------

const skip = skipWithoutDesignSystem

interface RealSheets {
    sheets: Array<{ file: string; group: string; css: string }>
    registry: Registry
}

/** The real sheets and the registry built from them, read once per process and only when a gated test runs. */
let cached: RealSheets | undefined
function real(): RealSheets {
    if (cached) return cached
    const sheets = Object.keys(GROUPS).flatMap(group =>
        readdirSync(designSystemPath("packages", "css", "src", group))
            .filter(f => f.endsWith(".css"))
            .sort()
            .map(f => ({ file: `packages/css/src/${group}/${f}`, group, css: readFileSync(designSystemPath("packages", "css", "src", group, f), "utf8") })),
    )
    return (cached = { sheets, registry: buildRegistry({ prefix: "elo", groups: GROUPS, sheets }).registry })
}

test("real sheets: pass 1 (registry) ≡ pass 2 (plugin) for every scope; output deterministic and registry-only", { skip }, async t => {
    const { sheets, registry } = real()
    let attrs = 0
    for (const s of sheets) {
        const scope = s.file.split("/").pop()?.replace(/\.css$/, "") as string
        const info = registry.scopes[scope]
        const sink: StylistSink = {}
        const process = (withSink?: StylistSink) =>
            postcss([nesting(), stylist({ ...stylistOptions(registry, scope, GROUPS), sink: withSink, reportGlobals: false })]).process(s.css, { from: designSystemPath(s.file) })
        const out = await process(sink)
        assert.equal((await process()).css, out.css, `${s.file}: output is deterministic`)
        assert.deepEqual(sink.parts, info.parts, `${s.file}: parts`)
        assert.deepEqual(sink.roots, info.roots, `${s.file}: roots`)
        assert.deepEqual(sink.keyframes, info.keyframes, `${s.file}: keyframes`)
        assert.deepEqual(sink.globals, info.globals, `${s.file}: globals`)
        // every emitted part attribute is a value-less registry attribute of this scope
        const own = new Set(Object.values(info.parts))
        for (const m of out.css.matchAll(/\[(_cxclass_[^\]]*)\]/g)) {
            attrs++
            assert.match(m[1], /^_cxclass_elo-[0-9a-z]{6}$/, s.file)
            assert.ok(own.has(m[1]), `${s.file}: ${m[1]} is not one of its parts`)
        }
        // no class selector beyond the legacy :global() hooks, and never a [class] selector
        assert.ok(findClassSelectors(out.root).every(h => h.kind === "class"), s.file)
    }
    t.diagnostic(`${sheets.length} sheets, ${attrs} part-attribute selectors emitted, all from the registry`)
})

test("real sheets: lock, part maps and rename map use the SPEC forms", { skip }, () => {
    const { sheets, registry } = real()
    const lock = toLock(registry)
    for (const [key, value] of Object.entries(lock.parts)) {
        assert.match(key, /^(core|app|player|gram|inf|ai)\/[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/)
        assert.match(value, /^_cxclass_elo-[0-9a-z]{6}$/)
    }
    assert.deepEqual(diffLock(lock, toLock(buildRegistry({ prefix: "elo", groups: GROUPS, sheets: [...sheets].reverse() }).registry)), {
        added: [],
        removed: [],
        changed: [],
        breaking: false,
    })

    for (const group of Object.keys(GROUPS)) {
        const { dts } = toPartMapModules(registry, group)
        assert.doesNotMatch(dts, /: string;/, "literal types only")
    }

    // legacy maps as today's build exports them: root → ls-<scope>, part → ls-<scope>__<part>, keyed by export name
    const legacy = Object.fromEntries(
        Object.entries(registry.scopes).map(([scope, info]) => [
            exportName(scope),
            Object.fromEntries(Object.keys(info.parts).map(part => [part, part === "root" ? `ls-${scope}` : `ls-${scope}__${part}`])),
        ]),
    )
    const rename = toSelectorRenameMap(legacy, registry)
    assert.equal(Object.keys(rename).length, Object.keys(lock.parts).length)
    for (const [from, to] of Object.entries(rename)) {
        assert.match(from, /^\.ls-[a-z0-9-]+(__[a-z0-9-]+)?$/)
        assert.match(to, /^\[_cxclass_elo-[0-9a-z]{6}\]$/)
    }
    assert.equal(rename[".ls-alert"], `[${partAttr({ prefix: "elo", namespace: "core", scope: "alert", part: "root" })}]`)
    assert.equal(rename[".ls-alert__icon"], "[_cxclass_elo-or4d4l]")
})
