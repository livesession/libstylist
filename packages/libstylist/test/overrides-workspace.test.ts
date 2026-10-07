// Override sheets in a workspace (SPEC §9, docs/CONFIG.md "Overriding the design system"): the fixture
// workspace (./fixtures/overrides/workspace — an app package, and an app whose src/css/overrides holds an
// additive Button override, a Modal override resetting two parts and a Table override within an app
// component) with the fixture design system installed as packages. Covers the config, `libstylist build`
// (the overrides module, the lock sections, the reset report, --check drift when the design system
// changes under an override, the design system's !important warnings, a guard-only reset), override sheets
// never being a package's sheets, `libstylist check` (S310), stylistWorkspace() in dev (the override sheet
// and the design system's aggregate transformed, HMR) and in `vite build` (its guards: imports, resets, the
// bundle's layer order; per-sheet exports wholly reset; `--watch` rebuilds), and the computed style of what
// the build bundles, in Chromium.
import assert from "node:assert/strict"
import { cpSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { after, describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"

import postcss from "postcss"
import { build, createLogger, createServer, type InlineConfig, type Logger, type Plugin, type Rollup, type ViteDevServer } from "vite"

import { runCheck } from "../src/check/index.js"
import { CheckConfigError, validateCheckConfig, type RawCheckConfig } from "../src/check/config.js"
import { partAttr } from "../src/hash/index.js"
import type { Registry } from "../src/registry/index.js"
import { stylistWorkspace } from "../src/vite/index.js"
import {
    DESIGN_SYSTEM_LAYERS,
    PART_MAP_HEADER,
    WorkspaceError,
    buildWorkspace,
    compileSheet,
    loadWorkspace,
    planWorkspaceOutputs,
    runBuildCli,
    runWorkspaceBuild,
    workspaceOf,
    workspaceSheetOwner,
} from "../src/workspace/index.js"
import { computed, differences, launch, type Browser } from "./fixtures/overrides/browser.js"
import { WORKSPACE_FIXTURE, designSystemDir, overridesWorkspace, write } from "./fixtures/overrides/install.js"

const ds = (scope: string, part: string, namespace = "core") => partAttr({ prefix: "ds", namespace, scope, part })
const OVERRIDES = join("apps", "web", "src", "css", "overrides")
const at = (root: string, ...path: string[]) => join(root, ...path)
const read = (file: string) => readFileSync(file, "utf8")

/** The CLI's lines (stdout and stderr, in order) and exit code. */
async function cli(root: string, ...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = []
    const err: string[] = []
    const code = await runBuildCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, { cwd: root })
    return { code, out, err }
}

/** Rewrites the installed design system's published files (registry and stylesheets) as its rebuild would. */
function republish(root: string, edit: (text: string, file: string) => string): void {
    const dist = join(designSystemDir(root), "dist")
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]))
    for (const file of walk(dist)) writeFileSync(file, edit(read(file), file))
}

const registryOf = (root: string): Registry => JSON.parse(read(join(designSystemDir(root), "dist", "stylist-registry.json"))) as Registry

describe("css.overrides in the config", () => {
    const raw = (overrides: unknown, extra: Record<string, unknown> = {}): RawCheckConfig =>
        ({
            prefix: "app",
            packages: [{ name: "@shop/ui", dir: "packages/shop", namespace: "core", namespaces: { "src/render": "render", "src/css/render": "render" }, entries: { "./components": "src/components/index.ts", "./render": "src/render/index.ts" }, sheets: "src/css" }],
            css: { overrides, ...extra },
        }) as RawCheckConfig

    test("validated: an existing directory, css packages or registry paths, a layer after components and before the namespace layers", async () => {
        const root = await overridesWorkspace()
        const config = validateCheckConfig(raw({ dir: OVERRIDES, registries: ["@ds/css", "vendor/ds/css/dist/stylist-registry.json"] }), root)
        assert.deepEqual(config.css.overrides, { dir: at(root, OVERRIDES), registries: ["@ds/css", at(root, "vendor/ds/css/dist/stylist-registry.json")], layer: "app.overrides" })
        // the default order statement places the overrides layer between the design system's and the app's
        assert.deepEqual(workspaceOf(config).layers.statement, [...DESIGN_SYSTEM_LAYERS, "app.overrides", "app.core", "app.render"])
        assert.deepEqual(workspaceOf(validateCheckConfig(raw({ dir: OVERRIDES, registries: ["@ds/css"], layer: "app.restyle" }), root)).layers.statement, [...DESIGN_SYSTEM_LAYERS, "app.restyle", "app.core", "app.render"])

        const bad: Array<[unknown, Record<string, unknown>, RegExp]> = [
            [{ dir: OVERRIDES }, {}, /css\.overrides\.registries must be a non-empty array/],
            [{ dir: OVERRIDES, registries: [] }, {}, /css\.overrides\.registries must be a non-empty array/],
            [{ dir: OVERRIDES, registries: ["./vendor/ds/css"] }, {}, /"\.\/vendor\/ds\/css" is neither a css package name .* nor a registry \.json path/],
            [{ dir: OVERRIDES, registries: ["@ds/css", "@ds/css"] }, {}, /lists "@ds\/css" twice/],
            [{ dir: "apps/web/src/css/nope", registries: ["@ds/css"] }, {}, /css\.overrides\.dir: directory .* does not exist/],
            [{ dir: OVERRIDES, registries: ["@ds/css"], extra: 1 }, {}, /css\.overrides: unknown key "extra"/],
            [{ dir: OVERRIDES, registries: ["@ds/css"], layer: "a b" }, {}, /css\.overrides\.layer "a b" is not a layer name/],
            [{ dir: OVERRIDES, registries: ["@ds/css"], layer: "components" }, {}, /is a design-system layer/],
            [{ dir: OVERRIDES, registries: ["@ds/css"], layer: "app.core" }, {}, /is a namespace's layer/],
            // override sheets are no package's sheets: never a sheet directory, never above one
            [{ dir: "packages/shop/src/css", registries: ["@ds/css"] }, {}, /css\.overrides\.dir packages\/shop\/src\/css is .*sheets "src\/css" — override sheets are no package's sheets/],
            [{ dir: "packages/shop", registries: ["@ds/css"] }, {}, /css\.overrides\.dir packages\/shop contains .*sheets "src\/css"/],
            // a configured order statement must place it after components and before every namespace's layer
            [{ dir: OVERRIDES, registries: ["@ds/css"] }, { layers: { statement: ["reset", "tokens", "components", "utilities", "app.core", "app.render"] } }, /does not declare "app\.overrides"/],
            [{ dir: OVERRIDES, registries: ["@ds/css"] }, { layers: { statement: ["reset", "app.overrides", "tokens", "components", "utilities", "app.core", "app.render"] } }, /declares "app\.overrides" before the design system's "components" layer/],
            [{ dir: OVERRIDES, registries: ["@ds/css"] }, { layers: { statement: ["reset", "tokens", "components", "utilities", "app.core", "app.overrides", "app.render"] } }, /declares "app\.overrides" after "app\.core" — the app's own components .* must beat a global override/],
        ]
        for (const [overrides, extra, message] of bad) assert.throws(() => validateCheckConfig(raw(overrides, extra), root), (err: Error) => err instanceof CheckConfigError && message.test(err.message), JSON.stringify(overrides))
    })
})

describe("libstylist build with override sheets", () => {
    test("writes the overrides module and the lock's override sections, compiles every sheet, prints what each reset drops; --check is clean after", async () => {
        const root = await overridesWorkspace()
        const first = await cli(root)
        assert.equal(first.code, 0, first.err.join("\n"))
        assert.deepEqual(first.err, [])
        assert.deepEqual(first.out, [
            "wrote   packages/shop/src/css/index.ts",
            "wrote   apps/web/src/css/overrides/index.ts",
            "wrote   stylist.lock.json",
            "wrote   .libstylist/stylist-registry.json",
            "reset   ds:core/modal:frame — 7 declarations in 3 rules (styles.css, components/modal.css)",
            "note    ds:core/modal:frame drops position: relative (styles.css:187) — its descendants may position against it, and its parent may place it; declare it in apps/web/src/css/overrides/modal.css to keep it",
            "note    ds:core/modal:frame drops overflow: hidden (styles.css:188) — its children's layout may rely on it; declare it in apps/web/src/css/overrides/modal.css to keep it",
            // the header's position: relative is re-declared by the override: no note; Chat's rule for Modal.Header stays
            "reset   ds:core/modal:header — 2 declarations in 1 rule (styles.css, components/modal.css); 1 rule of other components still style it",
            "libstylist build: 1 package, 2 sheets, 2 parts, 3 override sheets",
        ])
        assert.equal(read(at(root, OVERRIDES, "index.ts")), `${PART_MAP_HEADER}\nimport "./button.css"\nimport "./modal.css"\nimport "./table-in-cart.css"\n\nexport {}\n`)
        const lock = JSON.parse(read(at(root, "stylist.lock.json")))
        assert.deepEqual(lock.overrides, {
            "ds:core/Button": "ds-button",
            "ds:core/Modal": "ds-modal",
            "ds:core/Table": "ds-table",
            "ds:core/button:loader": ds("button", "loader"),
            "ds:core/modal:frame": ds("modal", "frame"),
            "ds:core/modal:header": ds("modal", "header"),
            "ds:core/table:td": ds("table", "td"),
        })
        assert.deepEqual(lock.resets, { "ds:core/modal:frame": ds("modal", "frame"), "ds:core/modal:header": ds("modal", "header") })
        // the app's own sections are untouched by the overrides
        assert.deepEqual(Object.keys(lock.parts), ["core/cart:root", "render/render-cart:root"])

        const check = await cli(root, "--check")
        assert.equal(check.code, 0, check.err.join("\n"))
        assert.ok(check.out.includes("ok      apps/web/src/css/overrides/index.ts") && check.out.includes("ok      stylist.lock.json"), check.out.join("\n"))

        // a new override sheet makes the committed module and lock stale
        write(at(root, OVERRIDES, "tooltip.css"), `@stylist override tooltip from "@ds/react";\n\n.bubble { padding: 8px; }\n`)
        const stale = await cli(root, "--check")
        assert.equal(stale.code, 1)
        assert.ok(stale.out.includes("stale   apps/web/src/css/overrides/index.ts — run `libstylist build`"), stale.out.join("\n"))
        assert.ok(stale.out.includes(`          + override ds:core/tooltip:bubble ${ds("tooltip", "bubble")}`), stale.out.join("\n"))
    })

    test("--check: a design-system part renamed under an override fails loudly, nothing written; a moved part attribute is lock drift", async () => {
        const root = await overridesWorkspace()
        assert.equal((await cli(root)).code, 0)
        const lock = read(at(root, "stylist.lock.json"))

        // the design system renames Button's loader → spinner (its registry and stylesheets rebuilt)
        const loader = ds("button", "loader")
        const spinner = ds("button", "spinner")
        const published = new Map<string, string>()
        republish(root, (text, file) => {
            published.set(file, text)
            if (!file.endsWith(".json")) return text.split(loader).join(spinner)
            const registry = JSON.parse(text) as Registry
            const parts = { ...registry.scopes.button.parts, spinner }
            delete (parts as Record<string, string>).loader
            registry.scopes.button.parts = Object.fromEntries(Object.entries(parts).sort(([a], [b]) => (a < b ? -1 : 1)))
            return JSON.stringify(registry, null, 2)
        })
        const renamed = await cli(root, "--check")
        assert.equal(renamed.code, 1)
        assert.deepEqual(renamed.err, [
            `error   [unknown-part] apps/web/src/css/overrides/button.css:15: Button (core, from "@ds/react") has no part "loader" Its parts: chevron, children, content, icon, label, root, spinner`,
            "libstylist build: 1 error — nothing written (1 package, 2 sheets, 2 parts, 3 override sheets)",
        ])
        assert.equal(read(at(root, "stylist.lock.json")), lock)

        // the design system moves the Modal header's attribute (a sheet renamed, a hash length changed): the
        // override still resolves by name, and the lock says what moved
        republish(root, (text, file) => published.get(file) ?? text)
        const moved = partAttr({ prefix: "ds", namespace: "core", scope: "dialog", part: "header" })
        republish(root, (text) => text.split(ds("modal", "header")).join(moved))
        const drift = await cli(root, "--check")
        assert.equal(drift.code, 1, drift.err.join("\n"))
        const at_ = drift.out.indexOf("stale   stylist.lock.json — run `libstylist build`")
        assert.ok(at_ >= 0, drift.out.join("\n"))
        assert.deepEqual(drift.out.slice(at_ + 1, at_ + 3), [`          ~ override ds:core/modal:header ${ds("modal", "header")} → ${moved}`, `          ~ reset ds:core/modal:header ${ds("modal", "header")} → ${moved}`])
        assert.match(drift.err.join("\n"), /1 file out of date — run `libstylist build` and commit the result/)
    })

    test("resolution, design-system and reset errors stop the build with the file, the line and the nearest name", async () => {
        const root = await overridesWorkspace()
        const button = at(root, OVERRIDES, "button.css")
        const original = read(button)
        const problems = async () => (await runWorkspaceBuild({ root })).problems.map((p) => p.message)

        writeFileSync(button, original.replace(`"@ds/react"`, `"@ds/reactt"`))
        assert.deepEqual(await problems(), [
            `[unresolved-package] apps/web/src/css/overrides/button.css:2: from "@ds/reactt": "@ds/reactt" is not installed where the sheet is (no node_modules/@ds/reactt above apps/web/src/css/overrides) — did you mean "@ds/react"?`,
        ])
        writeFileSync(button, original.replace(`"@ds/react"`, `"@ds/css"`))
        assert.match((await problems())[0], /\[unresolved-package\] .*button\.css:2: from "@ds\/css": "@ds\/css" is a css package \(it publishes the design system's registry\) — name the component package/)
        writeFileSync(button, original.replace("override Button", "override Buton"))
        assert.match((await problems())[0], /\[unknown-target\] .*button\.css:2: Buton is not a component of namespace "core" \(from "@ds\/react"\) — did you mean "Button"\?/)
        writeFileSync(button, original.replace(".loader", ".loadr"))
        assert.match((await problems())[0], /\[unknown-part\] .*button\.css:15: Button .* has no part "loadr" — did you mean "loader"\?/)
        writeFileSync(button, `${original}\n#save .root { color: red; }\n`)
        assert.equal((await problems())[0], "libstylist-override: apps/web/src/css/overrides/button.css:19:1: [override-selector] \"#save .root\": #save selects one instance — scope with `within`, or give the app component its own part on the design-system component")
        writeFileSync(button, original)

        // two sheets for one design-system sheet
        write(at(root, OVERRIDES, "nested", "modal-2.css"), `@stylist override Modal.Header from "@ds/react";\n.root { color: red; }\n`)
        assert.match((await problems())[0], /\[duplicate-override\] apps\/web\/src\/css\/overrides\/modal\.css and apps\/web\/src\/css\/overrides\/nested\/modal-2\.css both override the modal sheet/)
        rmSync(at(root, OVERRIDES, "nested"), { recursive: true })

        // a reset that drops nothing: the design system moved the tooltip link's styling away
        write(at(root, OVERRIDES, "tooltip.css"), `@stylist override tooltip from "@ds/react";\n@stylist reset link;\n`)
        assert.deepEqual(await problems(), [])
        republish(root, (text, file) => {
            if (!file.endsWith(".css")) return text
            const sheet = postcss.parse(text)
            sheet.walkRules((rule) => {
                if (rule.selector === `[${ds("tooltip", "link")}]`) rule.remove()
            })
            return sheet.toString()
        })
        assert.deepEqual(await problems(), [
            `[empty-reset] apps/web/src/css/overrides/tooltip.css:2: the reset of ds:core/tooltip:link drops nothing — no design-system rule styles that part any more (or only sets custom properties there); remove "link" from @stylist reset`,
        ])
        rmSync(at(root, OVERRIDES, "tooltip.css"))

        // a hand-written module where the generated one goes
        writeFileSync(at(root, OVERRIDES, "index.ts"), `import "./button.css"\n`)
        assert.match((await problems())[0], /\[overrides-index\] apps\/web\/src\/css\/overrides\/index\.ts is not the module libstylist generates there/)
        assert.equal(read(at(root, OVERRIDES, "index.ts")), `import "./button.css"\n`, "never overwritten")
        rmSync(at(root, OVERRIDES, "index.ts"))

        // the design system is not built
        renameSync(join(designSystemDir(root), "dist", "stylist-registry.json"), join(designSystemDir(root), "dist", "registry.bak"))
        assert.deepEqual(await problems(), [`[design-system] css.overrides.registries "@ds/css": dist/stylist-registry.json does not exist in @ds/css — build the design system's css package`])
        // … and a JSX-only build (a test runner's transform) needs none of it
        const ws = await loadWorkspace({ root })
        const jsxOnly = buildWorkspace(ws, { overrides: false })
        assert.deepEqual([jsxOnly.errors, jsxOnly.overrides], [[], null])
        assert.deepEqual(planWorkspaceOutputs(jsxOnly).map((o) => o.kind), ["part-map", "registry"], "neither the overrides module nor the lock: both depend on the overrides")
    })

    test("a declaration a design-system !important of the same element beats is a warning naming the rule and the reset that removes it; a guard-only reset is no empty reset", async () => {
        const root = await overridesWorkspace()
        const button = at(root, OVERRIDES, "button.css")
        writeFileSync(button, `${read(button)}.loader { visibility: visible; }\n`)
        const out = await cli(root)
        assert.equal(out.code, 0, out.err.join("\n"))
        const line = read(button).split("\n").length - 1
        assert.deepEqual(out.err.map((l) => l.replace(/styles\.css:\d+/, "styles.css:N")), [
            `warning apps/web/src/css/overrides/button.css: [important] line ${line}: visibility can't take effect — the design system declares visibility: hidden !important for the same element ([${ds("button", "loader")}][data-hidden], styles.css:N), and an !important of an earlier cascade layer beats every later layer: @stylist reset loader; removes it`,
        ])
        // reset, the design system's !important is gone: no warning
        writeFileSync(button, read(button).replace(`from "@ds/react";\n`, `from "@ds/react";\n@stylist reset loader;\n`))
        assert.deepEqual((await cli(root)).err, [])

        // the tooltip's link-icon has no rule of its own: its reset is made by guards, and reported
        write(at(root, OVERRIDES, "tooltip.css"), `@stylist override tooltip from "@ds/react";\n@stylist reset link-icon;\n\n.link-icon { display: inline-flex; }\n`)
        const guarded = await cli(root)
        assert.equal(guarded.code, 0, guarded.err.join("\n"))
        assert.ok(guarded.out.includes("reset   ds:core/tooltip:link-icon — 3 declarations in 1 rule (styles.css, components/tooltip.css); 1 selector kept for other elements"), guarded.out.join("\n"))
        assert.ok(guarded.out.some((l) => l.startsWith("note    ds:core/tooltip:link-icon drops margin-left: auto")), guarded.out.join("\n"))
        assert.ok(!guarded.out.some((l) => l.startsWith("note    ds:core/tooltip:link-icon drops display")), "re-declared: acknowledged")
    })

    test("override sheets are no package's sheets: an overrides directory inside a package's sheet directory is left out of its registry and part maps", async () => {
        const root = await overridesWorkspace()
        const inside = at(root, "packages", "shop", "src", "css", "overrides")
        cpSync(at(root, OVERRIDES), inside, { recursive: true })
        // the design system installed where the sheets now are
        cpSync(at(root, "apps", "web", "node_modules"), at(root, "packages", "shop", "node_modules"), { recursive: true, verbatimSymlinks: true })
        const config = at(root, "libstylist.config.mjs")
        writeFileSync(config, read(config).replace(`dir: "apps/web/src/css/overrides"`, `dir: "packages/shop/src/css/overrides"`))
        // the package's sheet directory is its own, the overrides directory's .css files are override sheets
        const out = await cli(root)
        assert.equal(out.code, 0, out.err.join("\n"))
        assert.ok(out.out.includes("wrote   packages/shop/src/css/overrides/index.ts"), out.out.join("\n"))
        const map = read(at(root, "packages", "shop", "src", "css", "index.ts"))
        assert.ok(!map.includes("overrides/"), map)
        const ws = await loadWorkspace({ root })
        const built = buildWorkspace(ws)
        assert.deepEqual(Object.keys(built.registry.scopes), ["cart", "render-cart"])
        assert.deepEqual(built.overrides?.sheets.map((s) => s.rel), ["packages/shop/src/css/overrides/button.css", "packages/shop/src/css/overrides/modal.css", "packages/shop/src/css/overrides/table-in-cart.css"])
        assert.equal(workspaceSheetOwner(ws, join(inside, "button.css")), null)
        assert.equal(workspaceSheetOwner(ws, at(root, "packages", "shop", "src", "css", "cart.css"))?.name, "@shop/ui")
        await assert.rejects(compileSheet(ws, built.registry, join(inside, "button.css"), read(join(inside, "button.css"))), (err: Error) => err instanceof WorkspaceError && /is an override sheet \(css\.overrides\.dir\), no package's sheet — compileOverrideSheet/.test(err.message))
    })
})

describe("libstylist check with override sheets", () => {
    test("a clean workspace has no finding; an override sheet that would stop the build is an S310 error at its line", async () => {
        const root = await overridesWorkspace()
        assert.equal((await cli(root)).code, 0)
        const clean = await runCheck({ root })
        assert.deepEqual(clean.findings.map((f) => `${f.rule} ${f.file}:${f.line} ${f.message}`), [])
        assert.deepEqual(clean.pending, [])

        const button = at(root, OVERRIDES, "button.css")
        writeFileSync(button, read(button).replace(".loader", ".loadr"))
        const modal = at(root, OVERRIDES, "modal.css")
        writeFileSync(modal, `${read(modal)}\n.header :component(Button) { color: red; }\n`)
        let broken = await runCheck({ root })
        assert.deepEqual(broken.findings.map((f) => [f.rule, f.severity, f.file, f.line]), [["S310", "error", "apps/web/src/css/overrides/button.css", 15]])
        assert.match(broken.findings[0].message, /\[unknown-part\] .*has no part "loadr" — did you mean "loader"\?/)

        // resolution first, then the compile: the forbidden cross-component hook once button.css resolves
        writeFileSync(button, read(button).replace(".loadr", ".loader"))
        broken = await runCheck({ root })
        assert.deepEqual(broken.findings.map((f) => [f.rule, f.file, f.line]), [["S310", "apps/web/src/css/overrides/modal.css", 15]])
        assert.match(broken.findings[0].message, /\[override-selector\] .*:component\(Button\)/)
    })
})

/** A logger that records what the plugins report. */
function recorder(): Logger & { lines: string[] } {
    const lines: string[] = []
    const base = createLogger("silent")
    const logger = { ...base, lines, info: (m: string) => lines.push(`info ${m}`), warn: (m: string) => lines.push(`warn ${m}`), error: (m: string) => lines.push(`error ${m}`) }
    return logger as Logger & { lines: string[] }
}

/** Waits (polling, up to 10 s: file-watcher events are slow when the test files run in parallel) until `ready()` holds. */
async function until(ready: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 500 && !ready(); i++) await sleep(20)
    assert.ok(ready(), `timed out waiting for ${what}`)
}

/**
 * Waits until the dev server's watcher reports files created in `dir`. The watcher takes in a directory
 * (Vite's root, a directory the plugin adds) some time after the server is created — its `ready` comes
 * earlier — and a change made before its native watch (inotify, the FSEvents stream) runs is never
 * reported. A file that is there when chokidar first reads the directory is taken in silently
 * (`ignoreInitial`), and each later write of it is a `change`: so every attempt creates a probe (no sheet)
 * of a new name, until one's `add` arrives. The probes are removed after.
 */
async function watching(server: ViteDevServer, dir: string): Promise<void> {
    const probes = new Set<string>()
    let seen = false
    const onAdd = (file: string) => {
        if (probes.has(file)) seen = true
    }
    server.watcher.on("add", onAdd)
    try {
        for (let i = 0; i < 50 && !seen; i++) {
            const probe = join(dir, `watch-probe-${process.pid}-${i}.txt`)
            probes.add(probe)
            writeFileSync(probe, "")
            for (let j = 0; j < 10 && !seen; j++) await sleep(20)
        }
        assert.ok(seen, `timed out waiting for the watcher to report changes in ${dir}`)
    } finally {
        server.watcher.off("add", onAdd)
        for (const probe of probes) rmSync(probe, { force: true })
    }
}

/** chokidar's `change` throttle: a path's `change` within this long of its previous one is dropped, not delayed. */
const CHANGE_THROTTLE_MS = 50

/**
 * Rewrites a file the watcher reports: first waits until chokidar's change throttle of that path has run
 * out. chokidar emits one `change` per path per 50 ms and drops the others, so an edit made right after
 * the plugin reacted to the previous edit of the same file is never reported (Vite's own HMR drops it
 * the same way). A test that edits again as soon as the plugin's output shows would hit it every time.
 */
async function edit(server: Spy, file: string, text: string): Promise<void> {
    const last = server.changed.get(file)
    if (last !== undefined) {
        // a margin past the throttle: chokidar's timer that ends it must fire before this one
        const wait = last + CHANGE_THROTTLE_MS + 20 - Date.now()
        if (wait > 0) await sleep(wait)
    }
    writeFileSync(file, text)
}

type Spy = ViteDevServer & { reloaded: string[]; sent: Array<{ type: string; err?: { message: string } }>; changed: Map<string, number> }

async function devServer(root: string, plugins: Plugin[], extra: InlineConfig = {}): Promise<Spy> {
    const { server: serverExtra, ...rest } = extra
    // vite.build() elsewhere in the process sets NODE_ENV=production; a dev server runs without it
    process.env.NODE_ENV = "development"
    const server = await createServer({
        configFile: false,
        root: join(root, "apps", "web"),
        logLevel: "silent",
        plugins,
        // no background transforms of the imports: one still running when the test closes the server adds
        // its file (outside Vite's root) to the closed watcher, which reopens it — and its fs watches keep
        // the test process from exiting
        // a test's own server options add to these, so none of them loses the guard above
        server: { middlewareMode: true, ws: false, fs: { strict: false }, preTransformRequests: false, ...serverExtra },
        optimizeDeps: { noDiscovery: true, include: [] },
        ...rest,
    })
    const spy = server as Spy
    spy.reloaded = []
    spy.sent = []
    spy.changed = new Map()
    server.reloadModule = async (mod) => {
        spy.reloaded.push(mod.file ?? mod.url)
    }
    server.ws.send = ((payload: { type: string }) => {
        spy.sent.push(payload)
    }) as ViteDevServer["ws"]["send"]
    server.watcher.on("change", (file: string) => spy.changed.set(file, Date.now()))
    return spy
}

/** The rules of a stylesheet whose selector names `attr`, as `selector { decls }` lines. */
const rulesNaming = (css: string, attr: string): string[] => {
    const out: string[] = []
    postcss.parse(css).walkRules((rule) => {
        if (rule.selector.includes(attr)) out.push(`${rule.selector} { ${rule.nodes.map(String).join("; ")} }`)
    })
    return out
}

describe("stylistWorkspace() with override sheets", () => {
    test("dev: the override sheet compiles into the overrides layer, the design system's aggregate loses the reset parts, the report is printed", async () => {
        const root = await overridesWorkspace()
        const logger = recorder()
        const server = await devServer(root, await stylistWorkspace(), { customLogger: logger })
        try {
            // the outputs are synced at start, the reset report printed
            assert.ok(read(at(root, OVERRIDES, "index.ts")).startsWith(PART_MAP_HEADER))
            assert.ok(JSON.parse(read(at(root, "stylist.lock.json"))).resets, "the lock has the resets")
            assert.ok(logger.lines.includes("info [libstylist] reset ds:core/modal:header — 2 declarations in 1 rule (styles.css, components/modal.css); 1 rule of other components still style it"), logger.lines.join("\n"))
            assert.ok(logger.lines.some((l) => l.startsWith("warn [libstylist] note ds:core/modal:frame drops position: relative (styles.css:187)")), logger.lines.join("\n"))

            const button = await server.transformRequest(`${at(root, OVERRIDES, "button.css")}?direct`)
            assert.equal(
                button?.code,
                [
                    "@layer reset, tokens, components, utilities, app.overrides, app.core, app.render;",
                    "@layer app.overrides {",
                    "/* Additive: every Button of the app gets a rounder, darker look; the design system's own rules stay. */",
                    "",
                    ":is(ds-button,[ds-button]) {",
                    "    border-radius: 2px;",
                    "    color: rgb(1, 2, 3);",
                    "}",
                    "",
                    ':is(ds-button,[ds-button])[data-size="small"] {',
                    "        --btn-h: 20px;",
                    "    }",
                    ':root[data-theme="dark"] :is(ds-button,[ds-button]) {',
                    "    color: rgb(250, 250, 250);",
                    "}",
                    `:is(ds-button,[ds-button])[data-loading] [${ds("button", "loader")}] {`,
                    "    opacity: 0.5;",
                    "}",
                    "}",
                    "",
                ].join("\n"),
            )
            const scoped = await server.transformRequest(`${at(root, OVERRIDES, "table-in-cart.css")}?direct`)
            assert.ok(scoped?.code.includes(`[${ds("table", "td")}]:is(app-render-cart,[app-render-cart],app-render-cart *,[app-render-cart] *) {`), scoped?.code)

            // the aggregate, reached through the app's node_modules link, as Vite serves it
            const styles = join(designSystemDir(root), "dist", "styles.css")
            const aggregate = (await server.transformRequest(`${styles}?direct`))?.code ?? ""
            assert.ok(aggregate.startsWith("/* libstylist: reset ds:core/modal:frame, ds:core/modal:header (apps/web/src/css/overrides/modal.css) */\n@layer reset, tokens, components, utilities;"), aggregate.slice(0, 200))
            const header = ds("modal", "header")
            assert.deepEqual(rulesNaming(aggregate, header), [], "no rule of the header's own is left")
            assert.deepEqual(rulesNaming(aggregate, "ds-modal-header:not([hidden])"), [":where(ds-modal-header:not([hidden])) { display: block; unicode-bidi: isolate }"], "its display default stays")
            assert.ok(aggregate.includes("> :is(ds-modal-header,[ds-modal-header])"), "Chat's rule for Modal.Header stays")
            assert.deepEqual(rulesNaming(aggregate, ds("modal", "frame")), [], "the frame's rules are gone, the ::after bar included")
            assert.ok(rulesNaming(aggregate, ds("button", "loader")).length > 0, "an additive override strips nothing")
            // the per-sheet file is stripped the same way; a stylesheet of no design system is not touched
            const perSheet = (await server.transformRequest(`${join(designSystemDir(root), "dist", "components", "modal.css")}?direct`))?.code ?? ""
            assert.deepEqual(rulesNaming(perSheet, header), [])
        } finally {
            await server.close()
        }
    })

    test("dev HMR: a new reset reloads the design system's stylesheets served so far; an override error reaches the overlay and keeps the last resets; the overrides module and the lock follow the sheets", async () => {
        const root = await overridesWorkspace()
        const logger = recorder()
        const server = await devServer(root, await stylistWorkspace(), { customLogger: logger })
        const styles = join(designSystemDir(root), "dist", "styles.css")
        const loader = ds("button", "loader")
        const aggregate = async () => (await server.transformRequest(`${styles}?direct`))?.code ?? ""
        try {
            assert.ok(rulesNaming(await aggregate(), loader).length > 0)
            const button = at(root, OVERRIDES, "button.css")
            await watching(server, dirname(button))

            // a reset added: the aggregate served so far is reloaded and loses the loader's rules
            await edit(server, button, read(button).replace(`from "@ds/react";\n`, `from "@ds/react";\n@stylist reset loader;\n`))
            await until(() => server.reloaded.includes(styles), "the aggregate to be reloaded")
            assert.deepEqual(rulesNaming(await aggregate(), loader), [])
            await until(() => logger.lines.some((l) => l.startsWith("info [libstylist] reset ds:core/button:loader — ")), "the report of the new reset")
            await until(() => JSON.parse(read(at(root, "stylist.lock.json"))).resets["ds:core/button:loader"] === loader, "the lock to lock the new reset")

            // an unknown part: the overlay says so, the design system keeps the last good resets
            server.reloaded.length = 0
            await edit(server, button, read(button).replace(".loader", ".loadr"))
            await until(() => server.sent.some((p) => p.type === "error"), "an overlay error")
            assert.match(server.sent.find((p) => p.type === "error")?.err?.message ?? "", /\[unknown-part\] apps\/web\/src\/css\/overrides\/button\.css:\d+: Button \(core, from "@ds\/react"\) has no part "loadr" — did you mean "loader"\?/)
            await assert.rejects(server.transformRequest(`${button}?direct`), /has no part "loadr"/)
            assert.ok(!server.reloaded.includes(styles))
            assert.deepEqual(rulesNaming(await aggregate(), loader), [])

            // fixed: the failed override sheet is reloaded
            await edit(server, button, read(button).replace(".loadr", ".loader"))
            await until(() => server.reloaded.includes(button), "the fixed override sheet to be reloaded")

            // a new override sheet: the overrides module imports it
            write(at(root, OVERRIDES, "tooltip.css"), `@stylist override tooltip from "@ds/react";\n\n.bubble { padding: 8px; }\n`)
            await until(() => read(at(root, OVERRIDES, "index.ts")).includes(`import "./tooltip.css"`), "the new sheet in the overrides module")
            await server.transformRequest(`${at(root, OVERRIDES, "tooltip.css")}?direct`)

            // the design system rebuilt (its registry changed): the override sheets reading it are reloaded
            server.reloaded.length = 0
            const registryFile = join(designSystemDir(root), "dist", "stylist-registry.json")
            const registry = registryOf(root)
            registry.scopes.tooltip.parts = { ...registry.scopes.tooltip.parts, arrow: ds("tooltip", "arrow") }
            await edit(server, registryFile, JSON.stringify(registry, null, 2))
            await until(() => server.reloaded.includes(at(root, OVERRIDES, "tooltip.css")), "the tooltip override to be reloaded")
            assert.ok(!server.reloaded.includes(button), "Button's sheet did not change")
        } finally {
            await server.close()
        }
    })
})

describe("stylistWorkspace() in vite build, and the computed style of what it bundles", () => {
    const libBuild = async (root: string, entry: string, extra: Parameters<typeof stylistWorkspace>[0] = {}) => {
        const file = at(root, "apps", "web", "src", "entry.ts")
        writeFileSync(file, entry)
        const result = await build({
            configFile: false,
            root,
            logLevel: "silent",
            customLogger: recorder(),
            plugins: await stylistWorkspace(extra),
            esbuild: { jsx: "automatic" },
            build: { write: false, minify: false, lib: { entry: file, formats: ["es"], fileName: "index" }, rollupOptions: { external: [/^react($|\/)/] } },
        })
        const output = ((Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[])[0].output
        return String(output.find((o): o is Rollup.OutputAsset => o.type === "asset" && o.fileName.endsWith(".css"))?.source ?? "")
    }
    // the fixture app's entry: the design system's aggregate, the overrides module, a component of the app's
    const MAIN = read(join(WORKSPACE_FIXTURE, "apps", "web", "src", "main.ts"))

    let bundled = ""

    test("fails on a stale overrides module, bundles the stripped aggregate and the overrides layer, guards resets and imports", async () => {
        const root = await overridesWorkspace()
        await assert.rejects(libBuild(root, MAIN), /libstylist: stale part maps — run `libstylist build`/)
        assert.equal((await cli(root)).code, 0)
        write(at(root, OVERRIDES, "tooltip.css"), `@stylist override tooltip from "@ds/react";\n.bubble { padding: 8px; }\n`)
        await assert.rejects(libBuild(root, MAIN), /libstylist: the overrides module is stale — run `libstylist build` and commit it: apps\/web\/src\/css\/overrides\/index\.ts/)
        rmSync(at(root, OVERRIDES, "tooltip.css"))

        bundled = await libBuild(root, MAIN)
        assert.ok(bundled.includes("@layer app.overrides {") && bundled.includes(":is(ds-button,[ds-button])[data-loading]"), bundled)
        // of the reset parts' rules only the override's own are left
        assert.deepEqual(rulesNaming(bundled, ds("modal", "frame")), [`[${ds("modal", "frame")}] { border-radius: 12px }`])
        assert.deepEqual(rulesNaming(bundled, ds("modal", "header")), [`[${ds("modal", "header")}] { position: relative; padding: 12px 16px; color: rgb(7, 8, 9) }`])
        assert.ok(bundled.includes(`[${ds("button", "loader")}][data-spin]`), "what no reset names stays")

        // the design system's CSS is not bundled: the resets would silently do nothing
        await assert.rejects(libBuild(root, `import "./css/overrides"\n`), /\[unbundled-reset\] the build bundles no design-system stylesheet that styles ds:core\/modal:frame \(apps\/web\/src\/css\/overrides\/modal\.css:4\), ds:core\/modal:header \(apps\/web\/src\/css\/overrides\/modal\.css:4\)/)
        // the override sheets are not imported
        await assert.rejects(libBuild(root, `import "@ds/css/styles.css"\n`), /\[overrides-not-imported\] the build bundles the design system but not the override sheets apps\/web\/src\/css\/overrides\/button\.css, .* — import apps\/web\/src\/css\/overrides\/index\.ts once in the app's entry/)
        // a build that must not apply them says so
        const plain = await libBuild(root, `import "@ds/css/styles.css"\n`, { overrides: false })
        assert.ok(rulesNaming(plain, ds("modal", "header")).length > 0, "no reset without overrides")
        // a JS-only build has no CSS of the app's to check
        await libBuild(root, `export const x = 1\n`)
    })

    test("a guard-only reset builds; a sheet wholly reset keeps its layer statement ended, so the next module's first rule survives the concatenation", async () => {
        const root = await overridesWorkspace()
        const tooltip = at(root, OVERRIDES, "tooltip.css")
        write(tooltip, `@stylist override tooltip from "@ds/react";\n@stylist reset link-icon;\n`)
        assert.equal((await cli(root)).code, 0)
        const guarded = await libBuild(root, MAIN)
        assert.ok(guarded.includes(`:where(:not([${ds("tooltip", "link-icon")}]))`), "the shared icon rule is guarded")

        rmSync(tooltip)
        write(at(root, OVERRIDES, "icon.css"), `@stylist override Icon from "@ds/react";\n@stylist reset;\n`)
        assert.equal((await cli(root)).code, 0)
        write(at(root, "apps", "web", "src", "plain.css"), `:root { --probe: 1; }\n.probe { color: red; }\n`)
        // the per-sheet exports: the icon's is left with `@layer components;` alone
        const bundled = await libBuild(root, `import "@ds/css/components/icon.css"\nimport "./plain.css"\nimport "@ds/css/components/modal.css"\nimport "./css/overrides"\n`)
        const sheet = postcss.parse(bundled)
        sheet.walkAtRules("layer", (at_) => assert.ok(!/[@{}:;]/.test(at_.params), `@layer ${at_.params} swallowed the next stylesheet`))
        const probe = sheet.nodes.find((n): n is postcss.Rule => n.type === "rule" && n.selector === ":root")
        assert.equal(probe?.toString(), ":root { --probe: 1; }", bundled.slice(0, 400))
        assert.ok(bundled.includes("@layer components;"), bundled.slice(0, 300))
    })

    test("[layer-order]: a hand-written @layer statement imported before the override sheets without the overrides layer fails the build", async () => {
        const root = await overridesWorkspace()
        assert.equal((await cli(root)).code, 0)
        const globals = at(root, "apps", "web", "src", "globals.css")
        const entry = `import "@ds/css/styles.css"\nimport "./globals.css"\nimport "./css/overrides"\n`
        write(globals, `@layer reset, tokens, components, utilities, app-theme, app.core, app.render;\nbody { margin: 0; }\n`)
        await assert.rejects(
            libBuild(root, entry),
            /libstylist: \[layer-order\] \S+\.css: the bundle declares "app\.overrides" after "app\.core", "app\.render": "@layer reset, tokens, components, utilities, app-theme, app\.core, app\.render" declares them first and does not list "app\.overrides"/,
        )
        write(globals, `@layer reset, tokens, components, utilities, app-theme, app.overrides, app.core, app.render;\nbody { margin: 0; }\n`)
        assert.ok((await libBuild(root, entry)).includes("@layer app.overrides {"))
    })

    test("vite build --watch: an override edit rebuilds with every guard whole, a new reset strips the cached design-system stylesheet", async () => {
        const root = await overridesWorkspace()
        assert.equal((await cli(root)).code, 0)
        const entry = at(root, "apps", "web", "src", "entry.ts")
        writeFileSync(entry, MAIN)
        const outDir = at(root, "out")
        const watcher = (await build({
            configFile: false,
            root,
            logLevel: "silent",
            customLogger: recorder(),
            plugins: await stylistWorkspace(),
            esbuild: { jsx: "automatic" },
            build: { watch: {}, outDir, emptyOutDir: true, minify: false, lib: { entry, formats: ["es"], fileName: "index" }, rollupOptions: { external: [/^react($|\/)/] } },
        })) as unknown as Rollup.RollupWatcher
        const events: Array<{ code: string; error?: string }> = []
        watcher.on("event", (e) => {
            events.push({ code: e.code, error: e.code === "ERROR" ? e.error.message : undefined })
            if (e.code === "BUNDLE_END") void e.result.close()
        })
        const done = (from: number) => events.slice(from).some((e) => e.code === "END" || e.code === "ERROR")
        const css = () => {
            const file = readdirSync(outDir).find((f) => f.endsWith(".css"))
            return file ? read(join(outDir, file)) : ""
        }
        /** Edits a file until the watcher rebuilds (its native stream may start late), then returns the rebuild's errors. */
        const rebuild = async (file: string, text: (n: number) => string): Promise<string[]> => {
            const from = events.length
            for (let n = 0; n < 40 && !done(from); n++) {
                writeFileSync(file, text(n))
                for (let i = 0; i < 25 && !done(from); i++) await sleep(20)
            }
            await until(() => done(from), "a rebuild")
            return events.slice(from).filter((e) => e.code === "ERROR").map((e) => e.error ?? "")
        }
        try {
            await until(() => done(0), "the first build")
            assert.deepEqual(events.filter((e) => e.code === "ERROR"), [])
            const loader = ds("button", "loader")
            assert.ok(rulesNaming(css(), loader).length > 1, "no reset of the loader yet")

            // only button.css changes: the other override sheets and the aggregate are cached, the guards still see them
            const button = at(root, OVERRIDES, "button.css")
            const original = read(button)
            assert.deepEqual(await rebuild(button, (n) => `${original}.children { color: rgb(9, 9, ${n}); }\n`), [])
            assert.match(css(), /color: rgb\(9, 9, \d+\)/)

            // a new reset: the cached aggregate is stripped of it
            assert.deepEqual(await rebuild(button, (n) => `${original.replace(`from "@ds/react";\n`, `from "@ds/react";\n@stylist reset loader;\n`)}/* ${n} */\n`), [])
            assert.deepEqual(rulesNaming(css(), loader), [`:is(ds-button,[ds-button])[data-loading] [${loader}] { opacity: 0.5 }`])
        } finally {
            await watcher.close()
        }
    })

    test("the computed style (Chromium): the override beats a more specific design-system rule; a reset element carries no design-system declaration; within applies inside its component only", async (t) => {
        if (!bundled) return t.skip("the build test did not run")
        const browser = await launch()
        if (typeof browser === "string") return t.skip(browser)
        after(() => browser.close())
        const p = await (browser as Browser).newPage()
        const button = `<button ds-button ${ds("button", "root")} data-size="medium" data-kind="primary" data-theme="fill" id="button">b</button>`
        const frame = (id: string, part: boolean) => `<div ${part ? ds("modal", "frame") : ""} data-bordered id="${id}"></div>`
        const header = `<ds-modal-header ${ds("modal", "header")} id="header">h</ds-modal-header>`
        const td = (id: string) => `<ds-table-td ${ds("table", "td")} id="${id}"></ds-table-td>`
        await p.setContent(`<!doctype html><html><head><style>${bundled}</style></head><body>${button}${frame("frame", true)}${frame("control", false)}${header}<app-render-cart>${td("inside")}</app-render-cart>${td("outside")}</body></html>`)

        // the design system's (0,3,0) [root][data-kind="primary"][data-theme="fill"] sets both: the layer decides
        assert.deepEqual(await computed(p, "button", ["border-top-left-radius", "color"]), { "border-top-left-radius": "2px", color: "rgb(1, 2, 3)" })
        // the reset frame differs from an unstyled control only by what the override declares (the radii,
        // physical and logical): no position, no overflow, no ::after bar of the design system's
        const diff = await differences(p, "frame", "control")
        assert.deepEqual(diff.filter((d) => !/^border-(?:top|bottom|start|end)-(?:left|right|start|end)-radius: 12px ≠ 0px$/.test(d)), [])
        assert.equal(diff.length, 8, diff.join("\n"))
        // the reset header: the override's padding, not the design system's 16px; its re-declared position; its display default
        assert.deepEqual(await computed(p, "header", ["padding-top", "padding-left", "position", "display"]), { "padding-top": "12px", "padding-left": "16px", position: "relative", display: "block" })
        assert.equal((await computed(p, "inside", ["color"])).color, "rgb(4, 5, 6)")
        assert.notEqual((await computed(p, "outside", ["color"])).color, "rgb(4, 5, 6)")
    })
})
