// libstylist.config.mjs: loading, defaults, and strict validation.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { CheckConfigError, DEFAULT_MIN_REASON_LENGTH, findCheckConfig, loadCheckConfig, namingOf, resolveCheckConfig, validateCheckConfig, type RawCheckConfig } from "../src/check/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "check")
const ROOT = join(FIXTURES, "exports")
const WS = join(FIXTURES, "workspace")
/** A design-system-shaped workspace (test/fixtures/monorepo/README.md): the packages, entries and css groups the CONFIG.md example names. */
const MONOREPO = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "monorepo")

const base = (): RawCheckConfig => ({
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
})

/** Validates `mutate(base())` and returns the error message (or "ok"). */
function problem(mutate: (c: Record<string, any>) => void): string {
    const c = base() as Record<string, any>
    mutate(c)
    try {
        validateCheckConfig(c, ROOT)
        return "ok"
    } catch (err) {
        assert.ok(err instanceof CheckConfigError, String(err))
        return err.message
    }
}

test("loadCheckConfig: loads the default export and resolves every path against the file's directory", async () => {
    const config = await loadCheckConfig(join(ROOT, "libstylist.config.mjs"))
    assert.equal(config.root, ROOT)
    assert.equal(config.prefix, "elo")
    assert.equal(config.hashLength, 6)
    assert.equal(config.packages.length, 1)
    const [pkg] = config.packages
    assert.equal(pkg.dir, join(ROOT, "packages", "ui"))
    assert.deepEqual(pkg.entries, { ".": join(ROOT, "packages", "ui", "src", "index.ts") })
    assert.deepEqual({ namespace: pkg.namespace, segment: pkg.segment, word: pkg.word }, { namespace: "core", segment: "", word: "" })
    assert.deepEqual(pkg.naming, { prefix: "elo", namespace: "core", segment: "", word: "", hashLength: 6 })
    assert.equal(config.file, join(ROOT, "libstylist.config.mjs"))
    assert.equal(config.css.dir, join(ROOT, "packages", "css", "src"))
    assert.deepEqual(config.css.unboundSheets, [])
    assert.equal(config.css.registry, null)
    assert.deepEqual(config.css.hostParts, {})
    assert.deepEqual(config.css.partMaps, { ui: "@fx/css" })
    assert.deepEqual(config.exemptions, { budget: { none: Infinity, multi: Infinity, native: Infinity }, minReasonLength: DEFAULT_MIN_REASON_LENGTH })
})

test("validateCheckConfig: defaults for segment/word, budgets, the built registry and host parts", () => {
    const c = validateCheckConfig(
        {
            ...base(),
            packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
            css: { dir: "packages/css/src", registry: "packages/css/dist/stylist-registry.json", hostParts: { "ui:b": "set by the engine  on its iframe", "ui:a": "consumer-composed banner" } },
            exemptions: { budget: { none: 4, multi: 2, native: 0 }, minReasonLength: 20 },
        },
        ROOT,
    )
    assert.equal(c.file, null)
    assert.deepEqual(c.exemptions, { budget: { none: 4, multi: 2, native: 0 }, minReasonLength: 20 })
    // the built registry need not exist yet (check warns, S309); host parts are sorted, reasons normalized
    assert.equal(c.css.registry, join(ROOT, "packages", "css", "dist", "stylist-registry.json"))
    assert.deepEqual(Object.entries(c.css.hostParts), [
        ["ui:a", "consumer-composed banner"],
        ["ui:b", "set by the engine on its iframe"],
    ])
    const player = validateCheckConfig(
        { ...base(), packages: [{ name: "@fx/player", dir: "packages/ui", namespace: "core", segment: "player", entries: { ".": "src/index.ts" }, cssGroup: "ui" }] },
        ROOT,
    )
    assert.deepEqual([player.packages[0].segment, player.packages[0].word], ["player", "Player"])
    // without css.partMaps any package import named like a sheet's part map counts
    assert.equal(validateCheckConfig({ ...base(), css: { dir: "packages/css/src" } }, ROOT).css.partMaps, null)
})

test("validateCheckConfig: strict — unknown keys, wrong types and bad identifiers are errors", () => {
    assert.equal(problem(() => {}), "ok")
    assert.match(problem((c) => (c.extra = 1)), /unknown key "extra"/)
    assert.match(problem((c) => (c.prefix = "Elo")), /prefix must match/)
    assert.match(problem((c) => (c.hashLength = 2.5)), /hashLength must be a non-negative integer/)
    assert.match(problem((c) => (c.packages = [])), /packages must be a non-empty array/)
    assert.match(problem((c) => (c.packages[0].color = "red")), /packages\[0\]: unknown key "color"/)
    assert.match(problem((c) => (c.packages[0].name = "Not A Name")), /not a valid package name/)
    assert.match(problem((c) => (c.packages[0].namespace = "Core")), /"namespace" must match/)
    assert.match(problem((c) => (c.packages[0].dir = "packages/nope")), /directory .* does not exist/)
    assert.match(problem((c) => (c.packages[0].entries = {})), /entries must be a non-empty object/)
    assert.match(problem((c) => (c.packages[0].entries = { main: "src/index.ts" })), /"main" is not an exports subpath/)
    assert.match(problem((c) => (c.packages[0].entries = { ".": "src/missing.ts" })), /missing\.ts does not exist/)
    assert.match(problem((c) => (c.packages[0].cssGroup = "nope")), /cssGroup "nope".*does not exist/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", unboundSheets: ["ui/nope.css"] })), /"ui\/nope\.css" is not a sheet/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", extra: true })), /css: unknown key "extra"/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", registry: "dist/registry.txt" })), /css\.registry must name the built stylist-registry\.json/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", hostParts: ["ui:a"] })), /hostParts must be an object/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", hostParts: { "ui.a": "a reason long enough" } })), /"ui\.a" is not a "scope:part" reference/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", hostParts: { "ui:a": 1 } })), /hostParts\["ui:a"\] must be a reason string/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", hostParts: { "ui:a": "short" } })), /needs a reason of at least 12 characters/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", partMaps: ["@fx/css"] })), /css\.partMaps must be an object of css group → part-map module specifier/)
    // app-3: a path is never matched against an import specifier — reject it with the alias recipe instead of seeing no part maps
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", partMaps: { ui: "../css/dist/parts" } })), /css\.partMaps\["ui"\] is the path "\.\.\/css\/dist\/parts" — part maps are recognized by their package specifier only/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", partMaps: { ui: "/abs/parts.mjs" } })), /is the path "\/abs\/parts\.mjs"/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", partMaps: { ui: 1 } })), /css\.partMaps\["ui"\] must be a module specifier/)
    assert.match(problem((c) => (c.css = { dir: "packages/css/src", partMaps: { nope: "@fx/css" } })), /css\.partMaps: "nope" is not a css group/)
    assert.match(problem((c) => (c.exemptions = { budget: { none: 1, multi: 1 } })), /budget\.native is missing/)
    assert.match(problem((c) => (c.exemptions = { budget: { none: 1, multi: 1, native: -1 } })), /budget\.native must be a non-negative integer/)
    assert.match(problem((c) => (c.exemptions = { budget: { none: 1, multi: 1, native: 1, other: 1 } })), /unknown key "other"/)
    // the baseline file is gone: the migration ratchet replaced it
    assert.match(problem((c) => (c.baseline = { file: ".libstylist/baseline.json" })), /unknown key "baseline"/)
})

test("validateCheckConfig: duplicates and package.json disagreements are errors", () => {
    const pkg = base().packages[0]
    assert.match(problem((c) => c.packages.push({ ...pkg })), /name "@fx\/ui" is already used/)
    // packages may share a namespace (a workspace of app packages), never a directory or a css group
    assert.match(problem((c) => c.packages.push({ ...pkg, name: "@fx/other" })), /packages\[1\]\.dir ".*packages[\\/]ui" is already used by libstylist config\.packages\[0\]/)
    // packages/ui/package.json declares libstylist.namespace "core"
    assert.match(problem((c) => (c.packages[0].namespace = "app")), /package\.json declares libstylist\.namespace "core"/)
    assert.match(problem((c) => (c.prefix = "app")), /package\.json declares libstylist\.prefix "elo"/)
})

/** The workspace fixture's config as a raw object (paths relative to WS). */
const namespaces = () => ({ "src/render": "render", "src/css/render": "render" })
const entries = { "./components": "src/components/index.ts", "./render": "src/render/index.ts" }
const workspace = (): Record<string, any> => ({
    prefix: "crm",
    packages: [
        { name: "@fx/accounts", dir: "packages/accounts", namespace: "core", namespaces: namespaces(), entries, sheets: "src/css" },
        { name: "@fx/partners", dir: "packages/partners", namespace: "core", namespaces: namespaces(), entries, sheets: ["src/css"] },
    ],
    css: { partMaps: { accounts: "#css", "accounts.render": "#css", partners: "#css", "partners.render": "#css" } },
})
function wsProblem(mutate: (c: Record<string, any>) => void): string {
    const c = workspace()
    mutate(c)
    try {
        validateCheckConfig(c, WS)
        return "ok"
    } catch (err) {
        assert.ok(err instanceof CheckConfigError, String(err))
        return err.message
    }
}

test("validateCheckConfig: a workspace of app packages — shared namespaces, directory namespaces, sheet directories, no css.dir", async () => {
    const config = await loadCheckConfig(join(WS, "libstylist.config.mjs"))
    assert.equal(config.css.dir, null)
    const [accounts, partners] = config.packages
    assert.deepEqual([accounts.namespace, partners.namespace, accounts.cssGroup], ["core", "core", null])
    assert.deepEqual(accounts.sheets, [join(WS, "packages", "accounts", "src", "css")])
    assert.deepEqual(partners.sheets, [join(WS, "packages", "partners", "src", "css")])
    // longest directory first; one css group per namespace, named after the package directory
    assert.deepEqual(
        accounts.namespaces.map((d) => `${d.dir} ${d.config.namespace}/${d.config.segment}/${d.config.word}`),
        ["src/css/render render/render/Render", "src/render render/render/Render"],
    )
    assert.deepEqual(
        [...accounts.groups, ...partners.groups].map((g) => `${g.name} ${g.naming.namespace}`),
        ["accounts core", "accounts.render render", "partners core", "partners.render render"],
    )
    // a file's naming: the longest namespaces directory it sits in, else the package's
    assert.equal(namingOf(accounts, join(accounts.dir, "src", "render", "RenderAccounts.tsx")).segment, "render")
    assert.equal(namingOf(accounts, join(accounts.dir, "src", "renderer", "Row.tsx")).namespace, "core")
    assert.equal(namingOf(accounts, join(accounts.dir, "src", "components", "AccountsList.tsx")).namespace, "core")
    assert.equal(wsProblem(() => {}), "ok")
    // unbound sheets are relative to the config's directory without css.dir
    assert.deepEqual(validateCheckConfig({ ...workspace(), css: { unboundSheets: ["packages/accounts/src/css/render-accounts.css"] } }, WS).css.unboundSheets, ["packages/accounts/src/css/render-accounts.css"])
})

test("validateCheckConfig: workspace problems — sheets vs cssGroup, directory namespaces, one naming per namespace, overlapping sheets, unknown groups", () => {
    // exactly one of cssGroup and sheets
    assert.match(wsProblem((c) => (c.packages[0].cssGroup = "accounts")), /packages\[0\] needs exactly one of cssGroup .* and sheets/)
    assert.match(wsProblem((c) => delete c.packages[0].sheets), /packages\[0\] needs exactly one of cssGroup .* and sheets/)
    assert.match(wsProblem((c) => (c.packages[0].sheets = [""])), /packages\[0\]\.sheets must be a directory or an array of directories/)
    assert.match(wsProblem((c) => (c.packages[0].sheets = 1)), /packages\[0\]\.sheets must be a directory or an array of directories/)
    // an empty list: a package without sheets yet (git keeps no empty directory) — its groups still exist
    const bare = workspace()
    bare.packages[0].sheets = []
    const noSheets = validateCheckConfig(bare, WS).packages[0]
    assert.deepEqual([noSheets.sheets, noSheets.groups.map((g) => g.name)], [[], ["accounts", "accounts.render"]])
    assert.match(wsProblem((c) => (c.packages[0].sheets = "src/nope")), /packages\[0\]\.sheets "src\/nope": directory .* does not exist/)
    assert.match(wsProblem((c) => (c.packages[0].sheets = "../partners/src/css")), /packages\[0\]\.sheets: "\.\.\/partners\/src\/css" is outside the package/)
    // a cssGroup holds one namespace: directory namespaces need sheet directories
    assert.match(
        wsProblem((c) => {
            delete c.packages[0].sheets
            c.packages[0].cssGroup = "accounts"
            c.css.dir = "packages"
        }),
        /packages\[0\]\.namespaces needs sheets/,
    )
    // no sheet is read twice
    assert.match(wsProblem((c) => (c.packages[0].sheets = ["src/css", "src/css/render"])), /packages\[0\]\.sheets "src\/css\/render" overlaps libstylist config\.packages\[0\]\.sheets "src\/css"/)
    // directory namespaces: validated keys, equal to package.json's
    assert.match(wsProblem((c) => (c.packages[0].namespaces = { "../up": "render" })), /packages\[0\]\.namespaces: "\.\.\/up" leaves the package/)
    assert.match(wsProblem((c) => delete c.packages[0].namespaces), /packages\[0\]\.namespaces is none but .*accounts[\\/]package\.json declares libstylist\.namespaces src\/css\/render → render/)
    assert.match(wsProblem((c) => (c.packages[0].namespaces = { "src/render": "render" })), /packages\[0\]\.namespaces is src\/render → render .* but .*package\.json declares libstylist\.namespaces src\/css\/render → render/)
    // a namespace names tags one way in every package (checked before package.json agreement)
    assert.match(
        wsProblem((c) => (c.packages[1].namespaces = { "src/render": { namespace: "render", word: "Rendered" }, "src/css/render": { namespace: "render", word: "Rendered" } })),
        /packages\[1\] names namespace "render" with segment "render" and word "Rendered", but libstylist config\.packages\[0\] uses segment "render" and word "Render"/,
    )
    assert.match(wsProblem((c) => (c.packages[1].segment = "base")), /packages\[1\] names namespace "core" with segment "base"/)
    // css groups: unique across packages (named after the package directory); part maps name known groups
    assert.match(
        wsProblem((c) => {
            c.packages = [
                { name: "@fx/a", dir: "packages/accounts/src/css/render", namespace: "core", entries: { ".": "render-accounts-table.css" }, sheets: "." },
                { name: "@fx/b", dir: "packages/partners/src/css/render", namespace: "core", entries: { ".": "render-partners.css" }, sheets: "." },
            ]
            c.css = {}
        }),
        /packages\[1\]\.sheets group "render" is already used by libstylist config\.packages\[0\]/,
    )
    assert.match(wsProblem((c) => (c.css.partMaps.nope = "#css")), /css\.partMaps: "nope" is not a css group of any package \(the groups: accounts, accounts\.render, partners, partners\.render\)/)
    assert.match(wsProblem((c) => (c.css.unboundSheets = ["nope.css"])), /css\.unboundSheets: "nope\.css" is not a sheet under .*workspace/)
    // css.dir is optional only while no package keeps its sheets in a css group
    assert.match(problem((c) => delete c.css.dir), /css\.dir is required: libstylist config\.packages\[0\] keeps its sheets in a css group/)
})

test("findCheckConfig / resolveCheckConfig: search upward, accept paths, raw objects and validated configs", async () => {
    assert.equal(findCheckConfig(join(ROOT, "packages", "ui", "src")), join(ROOT, "libstylist.config.mjs"))
    const fromPath = await resolveCheckConfig({ config: "libstylist.config.mjs", root: ROOT })
    const fromSearch = await resolveCheckConfig({ root: join(ROOT, "packages", "ui") })
    const fromObject = await resolveCheckConfig({ config: base(), root: ROOT })
    assert.deepEqual(fromSearch, fromPath)
    assert.deepEqual({ ...fromObject, file: fromPath.file }, fromPath)
    assert.equal(await resolveCheckConfig({ config: fromPath }), fromPath)
    await assert.rejects(loadCheckConfig(join(ROOT, "missing.mjs")), /config not found/)
})

// A10/A12: the CONFIG.md checker example, copied as written, validates against a repository laid out like the
// design system (the monorepo fixture: its packages, entries and css groups exist and the package.json configs
// agree), and the key table documents every key the strict loader accepts.
test("the CONFIG.md checker example validates against a design-system-shaped repository, and every loader key is documented", async () => {
    const doc = readFileSync(fileURLToPath(new URL("../docs/CONFIG.md", import.meta.url)), "utf8")
    const section = doc.slice(doc.indexOf("## Conventions checker"), doc.indexOf("## CLI"))
    const block = /```js\n(\/\/ libstylist\.config\.mjs\n[\s\S]*?)```/.exec(section)
    assert.ok(block, "CONFIG.md has a libstylist.config.mjs example in its checker section")
    const dir = mkdtempSync(join(tmpdir(), "libstylist-config-doc-"))
    try {
        const file = join(dir, "libstylist.config.mjs")
        writeFileSync(file, block[1])
        const raw = (await import(pathToFileURL(file).href)).default
        assert.doesNotThrow(() => validateCheckConfig(raw, MONOREPO))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
    const source = readFileSync(fileURLToPath(new URL("../src/check/config.ts", import.meta.url)), "utf8")
    const keysOf = (target: string): string[] => {
        const m = new RegExp(`onlyKeys\\(${target.replace(".", "\\.")}, \\[([^\\]]*)\\]`).exec(source)
        assert.ok(m, `config.ts validates ${target} with onlyKeys`)
        return [...m[1].matchAll(/"([^"]+)"/g)].map((k) => k[1])
    }
    const documented = (key: string): boolean => section.includes(`\`${key}\``) || new RegExp(`^\\s+${key.split(".").pop()}:`, "m").test(block[1])
    for (const key of keysOf("raw")) assert.ok(documented(key), `top-level key ${key} is documented`)
    for (const key of keysOf("ex")) assert.ok(section.includes(`\`exemptions.${key}\``), `exemptions.${key} is in the key table`)
    // every package and css key appears in the example or the key table (packages[].namespaces, packages[].sheets, …)
    const inExample = (key: string): boolean => new RegExp(`\\b${key}:`).test(block[1])
    for (const key of keysOf("p")) assert.ok(inExample(key) || section.includes(`\`packages[].${key}\``), `packages[].${key} is documented`)
    for (const key of keysOf("raw.css")) assert.ok(inExample(key) || section.includes(`\`css.${key}\``), `css.${key} is documented`)
})

// the same example against the real design system: the directories, entries and css groups it names must
// still exist there (the doc describes that repository's layout) — see ./design-system.ts
test("the CONFIG.md checker example validates against the design-system checkout", { skip: skipWithoutDesignSystem }, async () => {
    const doc = readFileSync(fileURLToPath(new URL("../docs/CONFIG.md", import.meta.url)), "utf8")
    const section = doc.slice(doc.indexOf("## Conventions checker"), doc.indexOf("## CLI"))
    const block = /```js\n(\/\/ libstylist\.config\.mjs\n[\s\S]*?)```/.exec(section)
    assert.ok(block, "CONFIG.md has a libstylist.config.mjs example in its checker section")
    const dir = mkdtempSync(join(tmpdir(), "libstylist-config-doc-"))
    try {
        const file = join(dir, "libstylist.config.mjs")
        writeFileSync(file, block[1])
        const raw = (await import(pathToFileURL(file).href)).default
        assert.doesNotThrow(() => validateCheckConfig(raw, designSystemPath()))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
