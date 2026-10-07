// @livesession/libstylist/workspace: the packages of a workspace discovered from its package.json files,
// the registry and the generated part-map modules of a workspace of app packages, one sheet compiled into
// its cascade layer, and the outputs `libstylist build` writes.
import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { CheckConfigError, loadCheckConfig, validateCheckConfig, type RawCheckConfig } from "../src/check/config.js"
import { loadSheets, registryDrift } from "../src/check/sheets.js"
import { partAttr } from "../src/hash/index.js"
import {
    DESIGN_SYSTEM_LAYERS,
    PART_MAP_HEADER,
    WorkspaceError,
    buildWorkspace,
    changedScopes,
    compileSheet,
    dependentSheets,
    expandDirectoryGlob,
    loadWorkspace,
    partMapsFor,
    planWorkspaceOutputs,
    readPnpmWorkspaceGlobs,
    renderPartMapModule,
    resolveLayers,
    runWorkspaceBuild,
    workspaceOf,
    workspacePackages,
    workspaceSheetOwner,
    workspaceSourcePattern,
    writeWorkspaceOutputs,
} from "../src/workspace/index.js"

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "check", "workspace")

const scratchDirs: string[] = []
process.on("exit", () => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** A scratch directory (real path: Vite and the registry compare resolved paths), removed on exit. */
function scratch(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    scratchDirs.push(dir)
    return dir
}

/** A writable copy of the workspace fixture (the build rewrites its hand-written part maps). */
function fixtureCopy(): string {
    const dir = scratch("libstylist-ws-")
    cpSync(FIXTURE, dir, { recursive: true })
    return dir
}

const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
}
const json = (value: unknown) => JSON.stringify(value, null, 2)
const attr = (namespace: string, scope: string, part: string) => partAttr({ prefix: "crm", namespace, scope, part })

describe("workspacePackages", () => {
    const LAYERS = { "src/render": "render", "src/css/render": "render" }
    const tree = () => {
        const root = scratch("libstylist-wsp-")
        write(join(root, "pnpm-workspace.yaml"), `# the workspace\npackages:\n  - "packages/*"\n  - 'apps/app' # the app\n  - "!packages/skipped"\n\nonlyBuiltDependencies:\n  - esbuild\n`)
        write(join(root, "packages", "a", "package.json"), json({ name: "@x/a", libstylist: { prefix: "crm", namespace: "core", namespaces: LAYERS } }))
        write(join(root, "packages", "a", "src", "components", "index.ts"), "export {}\n")
        write(join(root, "packages", "a", "src", "render", "index.ts"), "export {}\n")
        write(join(root, "packages", "a", "src", "css", "a-row.css"), ".root { margin: 0; }\n")
        // no render layer and no sheet directory yet
        write(join(root, "packages", "b", "package.json"), json({ name: "@x/b", libstylist: { prefix: "crm", namespace: "core", namespaces: LAYERS } }))
        write(join(root, "packages", "b", "src", "components", "index.ts"), "export {}\n")
        write(join(root, "packages", "plain", "package.json"), json({ name: "@x/plain" }))
        write(join(root, "packages", "skipped", "package.json"), json({ name: "@x/skipped", libstylist: { prefix: "other", namespace: "core" } }))
        write(join(root, "packages", "node_modules", "dep", "package.json"), json({ name: "dep", libstylist: { prefix: "other", namespace: "core" } }))
        write(join(root, "apps", "app", "package.json"), json({ name: "app", libstylist: { prefix: "crm", namespace: "shell", word: "Shell" } }))
        write(join(root, "apps", "app", "src", "components", "index.ts"), "export {}\n")
        return root
    }

    test("reads pnpm-workspace.yaml: every package with a libstylist namespace, its naming as declared, the entries and sheets that exist", () => {
        const root = tree()
        assert.deepEqual(readPnpmWorkspaceGlobs(join(root, "pnpm-workspace.yaml")), ["packages/*", "apps/app", "!packages/skipped"])
        const packages = workspacePackages({ root, prefix: "crm" })
        assert.deepEqual(packages, [
            { name: "app", dir: "apps/app", namespace: "shell", entries: { "./components": "src/components/index.ts" }, sheets: [], word: "Shell" },
            { name: "@x/a", dir: "packages/a", namespace: "core", entries: { "./components": "src/components/index.ts", "./render": "src/render/index.ts" }, sheets: "src/css", namespaces: LAYERS },
            { name: "@x/b", dir: "packages/b", namespace: "core", entries: { "./components": "src/components/index.ts" }, sheets: [], namespaces: LAYERS },
        ])
        // a file: URL of the root works too (`new URL(".", import.meta.url)`)
        assert.deepEqual(workspacePackages({ root: pathToFileURL(`${root}/`), prefix: "crm" }), packages)
        // the checker takes them as they are: a package without a sheet directory has no sheets
        const config = validateCheckConfig({ prefix: "crm", packages, css: { partMaps: partMapsFor(packages, "#css") } }, root)
        assert.deepEqual(config.packages.map((p) => [p.name, p.sheets.length, p.groups.map((g) => g.name).join(" ")]), [
            ["app", 0, "app"],
            ["@x/a", 1, "a a.render"],
            ["@x/b", 0, "b b.render"],
        ])
        assert.deepEqual(config.css.partMaps, { app: "#css", a: "#css", "a.render": "#css", b: "#css", "b.render": "#css" })
    })

    test("include globs, custom entries and sheets; a flow-style workspace file", () => {
        const root = tree()
        const only = workspacePackages({ root, prefix: "crm", include: ["packages/{a,b}"], entries: (pkg) => ({ ".": `src/components/index.ts`, "./x": `${pkg.dir}-missing.ts` }), sheets: "src/render" })
        assert.deepEqual(only.map((p) => [p.dir, p.entries, p.sheets]), [
            ["packages/a", { ".": "src/components/index.ts" }, "src/render"],
            ["packages/b", { ".": "src/components/index.ts" }, []],
        ])
        assert.deepEqual(workspacePackages({ root, prefix: "crm", include: ["packages/**", "!packages/skipped", "!packages/b"] }).map((p) => p.dir), ["packages/a"])
        write(join(root, "pnpm-workspace.yaml"), `packages:\n- packages/b\n- "apps/*"\nonlyBuiltDependencies: []\n`)
        assert.deepEqual(readPnpmWorkspaceGlobs(join(root, "pnpm-workspace.yaml")), ["packages/b", "apps/*"], "a sequence at the key's column")
        write(join(root, "pnpm-workspace.yaml"), `packages: ["apps/*", 'packages/a'] # flow\n`)
        assert.deepEqual(workspacePackages({ root, prefix: "crm" }).map((p) => p.dir), ["apps/app", "packages/a"])
        assert.deepEqual(expandDirectoryGlob(root, "packages/*").sort(), ["packages/a", "packages/b", "packages/plain", "packages/skipped"])
        assert.deepEqual(expandDirectoryGlob(root, "packages/[ab]"), ["packages/a", "packages/b"])
        assert.deepEqual(expandDirectoryGlob(root, "nope/*"), [])
    })

    test("a package of another prefix, a package without entries and a missing workspace file are errors", () => {
        const root = tree()
        assert.throws(() => workspacePackages({ root, prefix: "crm", include: ["packages/*"] }), /packages\/skipped\/package\.json libstylist\.prefix is "other", the workspace's is "crm"/)
        write(join(root, "packages", "c", "package.json"), json({ name: "@x/c", libstylist: { prefix: "crm", namespace: "core" } }))
        assert.throws(() => workspacePackages({ root, prefix: "crm" }), /packages\/c declares a libstylist namespace but has none of its entry files \(src\/components\/index\.ts, src\/render\/index\.ts\)/)
        const bare = scratch("libstylist-wsp-bare-")
        assert.throws(() => workspacePackages({ root: bare, prefix: "crm" }), /pnpm-workspace\.yaml does not exist — pass include globs/)
        write(join(bare, "pnpm-workspace.yaml"), "onlyBuiltDependencies: []\n")
        assert.throws(() => workspacePackages({ root: bare, prefix: "crm" }), /no "packages" key/)
    })

    test("partMapsFor: every css group of every package, raw or validated, to one specifier or a specifier per package", async () => {
        const config = await loadCheckConfig(join(FIXTURE, "libstylist.config.mjs"))
        const expected = { accounts: "#css", "accounts.render": "#css", partners: "#css", "partners.render": "#css" }
        assert.deepEqual(partMapsFor(config.packages, "#css"), expected)
        assert.deepEqual(partMapsFor([{ dir: "packages/accounts", namespace: "core", namespaces: LAYERS }, { dir: "packages/partners", namespace: "core", namespaces: LAYERS }], "#css"), expected)
        assert.deepEqual(partMapsFor([{ dir: "packages/ui", namespace: "core" }], (p) => `@x/${"dir" in p ? p.dir.split("/").pop() : ""}/css`), { ui: "@x/ui/css" })
    })
})

describe("the workspace config: css.lock, css.layers, the default css.registry, empty sheets", () => {
    const raw = (css: Record<string, unknown> = {}): RawCheckConfig => ({
        prefix: "crm",
        packages: [
            { name: "@fx/accounts", dir: "packages/accounts", namespace: "core", namespaces: { "src/render": "render", "src/css/render": "render" }, entries: { "./components": "src/components/index.ts" }, sheets: "src/css" },
        ],
        css: { partMaps: { accounts: "#css", "accounts.render": "#css" }, ...css },
    })
    const problem = (css: Record<string, unknown>): string => {
        try {
            validateCheckConfig(raw(css), FIXTURE)
            return "ok"
        } catch (err) {
            assert.ok(err instanceof CheckConfigError, String(err))
            return err.message
        }
    }

    test("validates css.lock and css.layers; css.registry defaults to the build's output", () => {
        const config = validateCheckConfig(raw({ lock: "stylist.lock.json", registry: "node_modules/.cache/r.json", layers: { statement: ["reset", "app.core", "app.render"], namespaces: { render: "app.render" } } }), FIXTURE)
        assert.equal(config.css.lock, join(FIXTURE, "stylist.lock.json"))
        assert.deepEqual(config.css.layers, { statement: ["reset", "app.core", "app.render"], namespaces: { render: "app.render" } })
        assert.equal(validateCheckConfig(raw(), FIXTURE).css.layers, null)
        // css.registry unset: where libstylist build writes it, for the checker (S309), the codemod and lint
        assert.equal(validateCheckConfig(raw(), FIXTURE).css.registry, join(FIXTURE, "node_modules", ".cache", "libstylist", "stylist-registry.json"))
        assert.match(problem({ lock: "stylist.lock" }), /css\.lock must name the lock file/)
        assert.match(problem({ layers: [] }), /css\.layers must be an object of \{ statement\?, namespaces\? \}/)
        assert.match(problem({ layers: { order: [] } }), /css\.layers: unknown key "order"/)
        assert.match(problem({ layers: { statement: [] } }), /css\.layers\.statement must be a non-empty array of layer names/)
        assert.match(problem({ layers: { statement: ["app core"] } }), /css\.layers\.statement: "app core" is not a layer name/)
        assert.match(problem({ layers: { statement: ["a", "b", "a"] } }), /css\.layers\.statement lists "a" twice/)
        assert.match(problem({ layers: { namespaces: { player: "app" } } }), /css\.layers\.namespaces: "player" is not a namespace of any package \(the namespaces: core, render\)/)
        assert.match(problem({ layers: { namespaces: { core: 1 } } }), /css\.layers\.namespaces\["core"\] must be a layer name/)
        assert.match(problem({ layers: { statement: ["app"], namespaces: { core: "app.core" } } }), /css\.layers\.namespaces\["core"\] is "app\.core", which libstylist config\.css\.layers\.statement does not declare/)
    })

    test("resolveLayers: app.<namespace> after the design system's layers by default; an undeclared layer is an error", async () => {
        const config = await loadCheckConfig(join(FIXTURE, "libstylist.config.mjs"))
        assert.deepEqual(resolveLayers(config), { statement: [...DESIGN_SYSTEM_LAYERS, "app.core", "app.render"], namespaces: { core: "app.core", render: "app.render" } })
        const one = validateCheckConfig(raw({ layers: { statement: ["reset", "app"], namespaces: { core: "app", render: "app" } } }), FIXTURE)
        assert.deepEqual(resolveLayers(one), { statement: ["reset", "app"], namespaces: { core: "app", render: "app" } })
        const partial = validateCheckConfig(raw({ layers: { statement: ["reset", "app.core"] } }), FIXTURE)
        assert.throws(() => resolveLayers(partial), /css\.layers\.statement does not declare "app\.render", the layer of namespace "render"/)
    })
})

describe("the workspace build", () => {
    test("workspaceOf: the fixture's packages, their part-map modules, specifiers, groups and default outputs", async () => {
        const root = fixtureCopy()
        const ws = await loadWorkspace({ root: join(root, "packages", "accounts", "src") })
        assert.equal(ws.root, root)
        assert.deepEqual(ws.packages.map((p) => [p.name, p.module, p.specifier]), [
            ["@fx/accounts", join(root, "packages", "accounts", "src", "css", "index.ts"), "#css"],
            ["@fx/partners", join(root, "packages", "partners", "src", "css", "index.ts"), "#css"],
        ])
        assert.deepEqual(Object.keys(ws.groups), ["accounts", "accounts.render", "partners", "partners.render"])
        assert.equal(ws.lock, join(root, "stylist.lock.json"))
        assert.equal(ws.registry, join(root, "node_modules", ".cache", "libstylist", "stylist-registry.json"))
        assert.equal(workspaceSheetOwner(ws, join(root, "packages", "accounts", "src", "css", "render", "x.css"))?.name, "@fx/accounts")
        assert.equal(workspaceSheetOwner(ws, join(root, "packages", "accounts", "src", "css", ".cache", "x.css")), null)
        assert.equal(workspaceSheetOwner(ws, join(root, "packages", "accounts", "src", "css", "index.ts")), null)
        assert.equal(workspaceSheetOwner(ws, join(root, "packages", "accounts", "src", "x.css")), null)
        const pattern = workspaceSourcePattern(ws)
        assert.ok(pattern.test(`${root}/packages/partners/src/render/RenderPartners.tsx`))
        assert.ok(!pattern.test(`${root}/packages/partners/test/x.tsx`) && !pattern.test(`${root}/vendor/ds/index.js`))
        // a raw config object and a config file path load the same workspace
        assert.deepEqual((await loadWorkspace({ root, config: "libstylist.config.mjs" })).packages.map((p) => p.name), ["@fx/accounts", "@fx/partners"])
        await assert.rejects(loadWorkspace({ root: tmpdir() }), /no libstylist\.config\.mjs found/)
    })

    test("workspaceOf: a css-group package, and a # specifier the package's imports don't point at the module, are errors", async () => {
        const ds = await loadCheckConfig(join(FIXTURE, "..", "exports", "libstylist.config.mjs"))
        assert.throws(() => workspaceOf(ds), /keeps its sheets in a css group \(cssGroup\) — the workspace build compiles packages that list their own sheet directories/)
        const root = fixtureCopy()
        const pkgJson = join(root, "packages", "partners", "package.json")
        const pkg = JSON.parse(readFileSync(pkgJson, "utf8"))
        writeFileSync(pkgJson, json({ ...pkg, imports: { ...pkg.imports, "#css": "./src/styles.ts" } }))
        await assert.rejects(loadWorkspace({ root }), /packages\/partners\/package\.json: imports\["#css"\] is "\.\/src\/styles\.ts", but the build writes @fx\/partners's part maps to packages\/partners\/src\/css\/index\.ts — point it at "\.\/src\/css\/index\.ts"/)
        writeFileSync(pkgJson, json({ ...pkg, imports: { "#css": { types: "./src/css/index.ts", default: "./src/css/index.ts" } } }))
        assert.equal((await loadWorkspace({ root })).packages[1].specifier, "#css")
        delete pkg.imports
        writeFileSync(pkgJson, json(pkg))
        await assert.rejects(loadWorkspace({ root }), /imports @fx\/partners's part maps from "#css", which its "imports" does not declare — add "#css": "\.\/src\/css\/index\.ts"/)
    })

    test("buildWorkspace: the registry is the checker's — same groups, scopes and parts — and every sheet knows its scope", async () => {
        const config = await loadCheckConfig(join(FIXTURE, "libstylist.config.mjs"))
        const build = buildWorkspace(config)
        assert.deepEqual(build.errors, [])
        assert.deepEqual(build.registry, loadSheets(config).registry)
        assert.deepEqual(build.sheets.map((s) => `${s.rel} ${s.group} ${s.scope}`), [
            "packages/accounts/src/css/accounts-list.css accounts accounts-list",
            "packages/accounts/src/css/render-accounts.css accounts render-accounts",
            "packages/accounts/src/css/render/render-accounts-table.css accounts.render render-accounts-table",
            "packages/partners/src/css/partners-card.css partners partners-card",
            "packages/partners/src/css/render/render-partners.css partners.render render-partners",
        ])
        assert.equal(build.registry.scopes["render-accounts-table"].parts.root, attr("render", "render-accounts-table", "root"))
        // in-memory sources replace the files on disk
        const sources = new Map([[build.sheets[0].file, ".root { margin: 0; }\n.extra { gap: 8px; }\n@stylist root AccountsList;\n"]])
        assert.deepEqual(Object.keys(buildWorkspace(config, { sources }).registry.scopes["accounts-list"].parts), ["extra", "root"])
    })

    test("buildWorkspace: two scopes exporting one name from a package's module, or from one specifier, are errors", () => {
        const root = fixtureCopy()
        // `switch` (core) and `switch-classes` (render) both export `switchClasses` from @fx/accounts' #css
        write(join(root, "packages", "accounts", "src", "css", "switch.css"), ".root { margin: 0; }\n")
        write(join(root, "packages", "accounts", "src", "css", "render", "switch-classes.css"), ".root { margin: 0; }\n")
        const own = buildWorkspace(workspaceOfCopy(root))
        assert.deepEqual(
            own.errors.map((e) => e.message),
            [
                `scopes "switch" (packages/accounts/src/css/switch.css) and "switch-classes" (packages/accounts/src/css/render/switch-classes.css) both export as "switchClasses" from @fx/accounts's part-map module — rename one sheet or pin a scope with @stylist scope <id>;`,
            ],
        )
        assert.equal(own.errors[0].code, "duplicate-export")
        // across packages: the transform resolves "#css" over every group mapped to it
        rmSync(join(root, "packages", "accounts", "src", "css", "render", "switch-classes.css"))
        write(join(root, "packages", "partners", "src", "css", "switch-classes.css"), ".root { margin: 0; }\n")
        const shared = buildWorkspace(workspaceOfCopy(root))
        assert.equal(shared.errors.length, 1)
        assert.match(shared.errors[0].message, /both export as "switchClasses" from the "#css" part maps/)
    })

    test("renderPartMapModule: the header, the sheets imported base namespace first, one as-const map per sheet", async () => {
        const config = await loadCheckConfig(join(FIXTURE, "libstylist.config.mjs"))
        const build = buildWorkspace(config)
        const ws = build.workspace
        assert.equal(
            renderPartMapModule(ws, build.registry, ws.packages[0]),
            `${PART_MAP_HEADER}
import "./accounts-list.css"
import "./render-accounts.css"
import "./render/render-accounts-table.css"

/** accounts-list.css */
export const accountsList = {
    root: "${attr("core", "accounts-list", "root")}",
    row: "${attr("core", "accounts-list", "row")}",
    $tags: {
        AccountsList: "crm-accountslist",
    },
} as const

/** render-accounts.css */
export const renderAccounts = {
    root: "${attr("core", "render-accounts", "root")}",
    $tags: {
        RenderAccounts: "crm-renderaccounts",
    },
} as const

/** render/render-accounts-table.css */
export const renderAccountsTable = {
    root: "${attr("render", "render-accounts-table", "root")}",
    $tags: {
        RenderAccountsTable: "crm-render-accountstable",
    },
} as const
`,
        )
        // kebab parts and dotted component paths are quoted; a sheet without roots has empty $tags
        const root = fixtureCopy()
        write(join(root, "packages", "partners", "src", "css", "render", "render-partners.css"), "@stylist root RenderPartners.Item as item;\n\n.item-label { gap: 8px; }\n.item { gap: 8px; }\n")
        write(join(root, "packages", "partners", "src", "css", "partners-card.css"), ".x { gap: 8px; }\n")
        const other = buildWorkspace(workspaceOfCopy(root))
        const text = renderPartMapModule(other.workspace, other.registry, other.workspace.packages[1]) as string
        assert.ok(text.includes(`export const partnersCard = {\n    x: "${attr("core", "partners-card", "x")}",\n    $tags: {},\n} as const`), text)
        assert.ok(text.includes(`    "item-label": "${attr("render", "render-partners", "item-label")}",`), text)
        assert.ok(text.includes(`    $tags: {\n        "RenderPartners.Item": "crm-render-partners-item",\n    },`), text)
    })

    test("compileSheet: nesting, parts and references compiled, wrapped in the namespace's layer; @layer and @import are rejected", async () => {
        const config = await loadCheckConfig(join(FIXTURE, "libstylist.config.mjs"))
        const build = buildWorkspace(config)
        const ws = build.workspace
        const file = join(FIXTURE, "packages", "partners", "src", "css", "render", "render-partners.css")
        const css = `@stylist root RenderPartners display block;\n\n.root {\n    gap: 16px;\n\n    &[data-open] { gap: 8px; }\n}\n\n.root :component(core/PartnersCard) :cx(accounts-list:row) { margin: 0; }\n.root :global(.legacy) { margin: 0; }\n`
        const out = await compileSheet(ws, build.registry, file, css)
        assert.deepEqual([out.scope, out.namespace, out.layer], ["render-partners", "render", "app.render"])
        const root = attr("render", "render-partners", "root")
        assert.equal(
            out.css,
            `@layer reset, tokens, components, utilities, app.core, app.render;
@layer app.render {
:where(crm-render-partners:not([hidden])) {
    display: block;
    unicode-bidi: isolate;
}

[${root}] {
    gap: 16px;
}

[${root}][data-open] { gap: 8px; }

[${root}] :is(crm-partnerscard,[crm-partnerscard]) [${attr("core", "accounts-list", "row")}] { margin: 0; }
[${root}] .legacy { margin: 0; }
}
`,
        )
        assert.deepEqual(out.warnings, ["legacy :global() hooks spliced verbatim: .legacy"])
        const core = await compileSheet(ws, build.registry, join(FIXTURE, "packages", "accounts", "src", "css", "accounts-list.css"), ".root { margin: 0; }\n")
        assert.match(core.css, /^@layer reset, tokens, components, utilities, app\.core, app\.render;\n@layer app\.core \{\n/)
        await assert.rejects(compileSheet(ws, build.registry, file, "@layer app { .root { gap: 0; } }\n"), /render-partners\.css:1:1: @layer — the build wraps every sheet in its namespace's layer/)
        await assert.rejects(compileSheet(ws, build.registry, file, `@import "./other.css";\n.root { gap: 0; }\n`), /render-partners\.css:1:1: @import — a sheet is compiled alone/)
        await assert.rejects(compileSheet(ws, build.registry, file, ".root :cx(accounts-list:nope) { gap: 0; }\n"), /:cx\(accounts-list:nope\) — unknown part/)
        await assert.rejects(compileSheet(ws, build.registry, join(FIXTURE, "vendor", "x.css"), ".root {}\n"), (err: unknown) => err instanceof WorkspaceError && /vendor\/x\.css is not a sheet of the workspace registry/.test(err.message))
    })

    test("changedScopes and dependentSheets: what a changed sheet invalidates", async () => {
        const config = await loadCheckConfig(join(FIXTURE, "libstylist.config.mjs"))
        const before = buildWorkspace(config)
        const list = before.sheets.find((s) => s.scope === "accounts-list")!
        const table = before.sheets.find((s) => s.scope === "render-accounts-table")!
        const sources = new Map([
            [list.file, `${list.css}\n.badge { gap: 8px; }\n`],
            [table.file, `${table.css}\n.root :cx(accounts-list:row) { gap: 0; }\n.root :component(core/AccountsList) { gap: 0; }\n`],
        ])
        const after = buildWorkspace(config, { sources })
        assert.deepEqual([...changedScopes(before.registry, after.registry)], ["accounts-list"])
        assert.deepEqual([...changedScopes(null, after.registry)].length, 5)
        assert.deepEqual(dependentSheets(after, new Set(["accounts-list"]), before.registry), [table.file], "reads a part and a root of the changed scope")
        assert.deepEqual(dependentSheets(after, new Set(["partners-card"])), [])
        assert.deepEqual(dependentSheets(after, new Set()), [])
    })
})

/** The workspace of a fixture copy (the copy's own config file). */
function workspaceOfCopy(root: string) {
    return workspaceOf(validateCheckConfig(fixtureConfig(), root))
}
/** The fixture's config as an object (a copy's config module would be cached by its first import). */
const fixtureConfig = (): RawCheckConfig => {
    const namespaces = { "src/render": "render", "src/css/render": "render" }
    const entries = { "./components": "src/components/index.ts", "./render": "src/render/index.ts" }
    return {
        prefix: "crm",
        packages: [
            { name: "@fx/accounts", dir: "packages/accounts", namespace: "core", namespaces, entries, sheets: "src/css" },
            { name: "@fx/partners", dir: "packages/partners", namespace: "core", namespaces, entries, sheets: ["src/css"] },
        ],
        css: { partMaps: { accounts: "#css", "accounts.render": "#css", partners: "#css", "partners.render": "#css" } },
    }
}

describe("libstylist build outputs", () => {
    test("runWorkspaceBuild: check mode reports the drift and writes only the registry; write mode writes; the checker sees no stale registry", async () => {
        const root = fixtureCopy()
        const config = { ...fixtureConfig(), css: { ...fixtureConfig().css, registry: "dist/stylist-registry.json", lock: "css.lock.json" } }
        const checked = await runWorkspaceBuild({ root, config, check: true })
        assert.deepEqual(checked.problems, [])
        const rel = (files: Array<{ file: string }>) => files.map((o) => o.file.slice(root.length + 1))
        assert.deepEqual(rel(checked.drift), ["packages/accounts/src/css/index.ts", "packages/partners/src/css/index.ts", "css.lock.json"], "the hand-written maps differ from the generated ones")
        assert.deepEqual(rel(checked.written), ["dist/stylist-registry.json"])
        assert.ok(!existsSync(join(root, "css.lock.json")))
        const built = await runWorkspaceBuild({ root, config })
        assert.deepEqual(rel(built.written), ["packages/accounts/src/css/index.ts", "packages/partners/src/css/index.ts", "css.lock.json"])
        assert.ok(readFileSync(join(root, "packages", "accounts", "src", "css", "index.ts"), "utf8").startsWith(PART_MAP_HEADER))
        const lock = JSON.parse(readFileSync(join(root, "css.lock.json"), "utf8"))
        assert.equal(lock.tags["render/RenderAccountsTable"], "crm-render-accountstable")
        assert.equal(lock.parts["core/accounts-list:row"], attr("core", "accounts-list", "row"))
        const again = await runWorkspaceBuild({ root, config, check: true })
        assert.deepEqual([again.drift.length, again.written.length], [0, 0])
        // `libstylist check` reads the registry the build wrote: no S309 drift
        const checker = validateCheckConfig(config, root)
        assert.deepEqual(registryDrift(checker.css.registry as string, loadSheets(checker)), [])
    })

    test("runWorkspaceBuild: a registry or compile problem writes nothing", async () => {
        const root = fixtureCopy()
        write(join(root, "packages", "partners", "src", "css", "accounts-list.css"), ".root { gap: 0; }\n")
        const dup = await runWorkspaceBuild({ root, config: fixtureConfig() })
        assert.equal(dup.problems.length, 1)
        assert.match(dup.problems[0].message, /^\[duplicate-scope\] scope "accounts-list" is declared by packages\/accounts\/src\/css\/accounts-list\.css and packages\/partners\/src\/css\/accounts-list\.css/)
        assert.deepEqual([dup.written.length, existsSync(join(root, "stylist.lock.json"))], [0, false])
        rmSync(join(root, "packages", "partners", "src", "css", "accounts-list.css"))
        write(join(root, "packages", "partners", "src", "css", "layered.css"), "@layer x { .root { gap: 0; } }\n")
        const layered = await runWorkspaceBuild({ root, config: fixtureConfig() })
        assert.deepEqual(layered.problems.map((p) => [p.files, p.message.replace(/@layer —.*/, "@layer")]), [[["packages/partners/src/css/layered.css"], "packages/partners/src/css/layered.css:1:1: @layer"]])
        assert.equal(layered.written.length, 0)
        const skipped = await runWorkspaceBuild({ root, config: fixtureConfig(), compile: false })
        assert.deepEqual(skipped.problems, [])
    })

    test("planWorkspaceOutputs: the lock compares as data and keeps the indentation on disk — a formatter's rewrite is no drift", async () => {
        const root = fixtureCopy()
        await runWorkspaceBuild({ root, config: fixtureConfig() })
        const lockFile = join(root, "stylist.lock.json")
        assert.ok(readFileSync(lockFile, "utf8").startsWith('{\n  "'), "a new lock is indented with 2 spaces")
        // the project's formatter reindents it (4 spaces, CRLF): the committed lock is still current
        writeFileSync(lockFile, `${JSON.stringify(JSON.parse(readFileSync(lockFile, "utf8")), null, 4)}\n`.replace(/\n/g, "\r\n"))
        const checked = await runWorkspaceBuild({ root, config: fixtureConfig(), check: true })
        assert.deepEqual([checked.drift, checked.written], [[], []])
        // a new part rewrites it in the formatter's shape
        const sheet = join(root, "packages", "accounts", "src", "css", "accounts-list.css")
        writeFileSync(sheet, `${readFileSync(sheet, "utf8")}\n.badge { gap: 8px; }\n`)
        const built = await runWorkspaceBuild({ root, config: fixtureConfig() })
        assert.ok(built.written.some((o) => o.kind === "lock"))
        const text = readFileSync(lockFile, "utf8")
        assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 4)}\n`)
        assert.equal(JSON.parse(text).parts["core/accounts-list:badge"], attr("core", "accounts-list", "badge"))
    })

    test("planWorkspaceOutputs: a generated module of a package with no sheet left is removed, a hand-written one is left alone", async () => {
        const root = fixtureCopy()
        await runWorkspaceBuild({ root, config: fixtureConfig() })
        for (const f of ["partners-card.css", "render/render-partners.css"]) rmSync(join(root, "packages", "partners", "src", "css", f))
        const build = buildWorkspace(workspaceOfCopy(root))
        const plan = planWorkspaceOutputs(build, { packages: [build.workspace.packages[1]] })
        assert.deepEqual(plan.map((o) => [o.kind, o.next === null, o.changed]), [
            ["part-map", true, true],
            ["lock", false, true],
            ["registry", false, true],
        ])
        writeWorkspaceOutputs(plan)
        assert.ok(!existsSync(join(root, "packages", "partners", "src", "css", "index.ts")))
        writeFileSync(join(root, "packages", "partners", "src", "css", "index.ts"), "export const handWritten = {}\n")
        assert.deepEqual(planWorkspaceOutputs(build, { packages: [build.workspace.packages[1]] }).map((o) => o.kind), ["lock", "registry"])
    })
})
