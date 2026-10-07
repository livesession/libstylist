// A package whose sources are not `src` (an app's settings area, apps/web/app/pages/settings) and whose
// files import each other through a tsconfig alias (`~/*`): `sources` (config or package.json) for
// gen-types and the workspace transform, `typescript.paths` for the checker's and the codemod's program.
// The checker's findings over the fixture are pinned in check-fixtures.test.ts ("sources outside src").
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import ts from "typescript"

import { CheckConfigError, loadCheckConfig, validateCheckConfig, type RawCheckConfig, type RawCheckPackage } from "../src/check/config.js"
import { checkCompilerOptions } from "../src/check/program.js"
import { clearConventionsCache, normalizeSources } from "../src/conventions/index.js"
import { genTagTypes, resolveTypesSources, scanCustomTags } from "../src/typesgen/index.js"
import { loadWorkspace, workspacePackages, workspaceSourcePattern } from "../src/workspace/index.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, "fixtures", "check", "sources")
const WEB = join(FIXTURE, "apps", "web")
const SETTINGS = "app/pages/settings"
// the custom tags the area renders (RenderTeam and RenderTeamLayout put markers on SettingsPage)
const TAGS = ["crm-settings-memberrow", "crm-settings-page"]

const scratchDirs: string[] = []
process.on("exit", () => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** A writable copy of the fixture (real path: the CLI and the registry compare resolved paths), removed on exit. */
function fixtureCopy(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "libstylist-sources-")))
    scratchDirs.push(dir)
    cpSync(FIXTURE, dir, { recursive: true })
    return dir
}

const json = (value: unknown) => JSON.stringify(value, null, 2)
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
const rawConfig = async (root = FIXTURE): Promise<RawCheckConfig> => (await import(pathToFileURL(join(root, "libstylist.config.mjs")).href)).default as RawCheckConfig

/** The fixture's config with its one package changed (`undefined` drops a key). */
const withPackage = (raw: RawCheckConfig, patch: Partial<Record<keyof RawCheckPackage, unknown>>): RawCheckConfig => {
    const pkg: Record<string, unknown> = { ...raw.packages[0], ...patch }
    for (const key of Object.keys(pkg)) if (pkg[key] === undefined) delete pkg[key]
    return { ...raw, packages: [pkg as unknown as RawCheckPackage] }
}

const problem = (raw: unknown, root = FIXTURE): string => {
    try {
        validateCheckConfig(raw, root)
        return "ok"
    } catch (err) {
        assert.ok(err instanceof CheckConfigError, String(err))
        return err.message
    }
}

/** Writes the web package's package.json `libstylist` field. */
const declare = (root: string, libstylist: Record<string, unknown>) => {
    const file = join(root, "apps", "web", "package.json")
    writeFileSync(file, json({ ...readJson(file), libstylist }))
    clearConventionsCache()
}

describe("sources: the config loader", () => {
    test("absolute source directories; `src` when neither the config nor package.json lists them", async () => {
        const raw = await rawConfig()
        const config = validateCheckConfig(raw, FIXTURE)
        assert.deepEqual(config.packages[0].sources, [join(WEB, SETTINGS)])
        // the default is not required to exist (the fixture package has no src)
        assert.deepEqual(validateCheckConfig(withPackage(raw, { sources: undefined }), FIXTURE).packages[0].sources, [join(WEB, "src")])
        // trailing slashes are dropped, several directories keep their order
        assert.deepEqual(validateCheckConfig(withPackage(raw, { sources: [`${SETTINGS}/team/`, `${SETTINGS}/components`] }), FIXTURE).packages[0].sources, [
            join(WEB, SETTINGS, "team"),
            join(WEB, SETTINGS, "components"),
        ])
    })

    test("malformed sources are errors", async () => {
        const raw = await rawConfig()
        assert.match(problem(withPackage(raw, { sources: SETTINGS })), /^libstylist config\.packages\[0\]\.sources must be a non-empty array of directories/)
        assert.match(problem(withPackage(raw, { sources: [] })), /\.sources must be a non-empty array of directories — sources are package-relative posix directories/)
        assert.match(problem(withPackage(raw, { sources: [1] })), /\.sources: 1 is not a directory/)
        assert.match(problem(withPackage(raw, { sources: ["/abs/app"] })), /\.sources: "\/abs\/app" is absolute/)
        assert.match(problem(withPackage(raw, { sources: ["../other/src"] })), /\.sources: "\.\.\/other\/src" leaves the package/)
        assert.match(problem(withPackage(raw, { sources: ["./app"] })), /\.sources: "\.\/app" has an empty or `\.` segment/)
        assert.match(problem(withPackage(raw, { sources: ["app\\pages"] })), /\.sources: "app\\pages" has a backslash/)
        assert.match(problem(withPackage(raw, { sources: ["app/*"] })), /\.sources: "app\/\*" is a glob/)
        assert.match(problem(withPackage(raw, { sources: ["app", "app/"] })), /\.sources: "app\/" is listed twice/)
        assert.match(problem(withPackage(raw, { sources: ["app", SETTINGS] })), /\.sources: "app\/pages\/settings" nests with "app" \(a file would be read twice\)/)
        assert.match(problem(withPackage(raw, { sources: ["app/missing"] })), /packages\[0\]\.sources "app\/missing": directory .*apps\/web\/app\/missing does not exist/)
        assert.deepEqual(normalizeSources(["src/", "lib"], "x"), ["src", "lib"])
    })

    test("package.json libstylist.sources: the default, and a config value must equal it", async () => {
        const root = fixtureCopy()
        const raw = await rawConfig(root)
        declare(root, { prefix: "crm", namespace: "settings", sources: [`${SETTINGS}/`] })
        // declared there only: the config package takes them (normalized)
        assert.deepEqual(validateCheckConfig(withPackage(raw, { sources: undefined }), root).packages[0].sources, [join(root, "apps", "web", SETTINGS)])
        // declared in both: the same list
        assert.equal(problem(raw, root), "ok")
        assert.match(
            problem(withPackage(raw, { sources: [`${SETTINGS}/team`] }), root),
            /packages\[0\]\.sources is \["app\/pages\/settings\/team"\] but .*apps\/web\/package\.json declares libstylist\.sources \["app\/pages\/settings"\] — list the same directories/,
        )
        declare(root, { prefix: "crm", namespace: "settings", sources: "app" })
        assert.match(problem(raw, root), /apps\/web\/package\.json libstylist\.sources must be a non-empty array of directories/)
    })
})

describe("typescript.paths: the checker's and the codemod's program", () => {
    test("targets resolve against the config's directory and join the package-name paths", async () => {
        const config = await loadCheckConfig(join(FIXTURE, "libstylist.config.mjs"))
        assert.deepEqual(config.typescript.paths, { "~/*": [join(FIXTURE, "apps", "web", "app", "*")] })
        const options = checkCompilerOptions(config)
        assert.deepEqual(options.paths, {
            "@fx/web/pages/settings/components": [join(WEB, SETTINGS, "components", "index.ts")],
            "@fx/web/pages/settings/team/components": [join(WEB, SETTINGS, "team", "components", "index.ts")],
            "@fx/web/pages/settings/team/render": [join(WEB, SETTINGS, "team", "render", "index.ts")],
            "~/*": [join(FIXTURE, "apps", "web", "app", "*")],
        })
        // the codemod builds its program with these options: the alias resolves to the source
        const from = join(WEB, SETTINGS, "team", "render", "RenderTeam.tsx")
        const hit = ts.resolveModuleName("~/pages/settings/components", from, options, ts.sys).resolvedModule
        assert.equal(hit?.resolvedFileName, join(WEB, SETTINGS, "components", "index.ts"))
        // without the field: the package names only, exactly as before
        const bare = validateCheckConfig({ ...(await rawConfig()), typescript: undefined }, FIXTURE)
        assert.deepEqual(bare.typescript, { paths: {} })
        assert.deepEqual(Object.keys(checkCompilerOptions(bare).paths ?? {}), ["@fx/web/pages/settings/components", "@fx/web/pages/settings/team/components", "@fx/web/pages/settings/team/render"])
        assert.equal(ts.resolveModuleName("~/pages/settings/components", from, checkCompilerOptions(bare), ts.sys).resolvedModule, undefined)
    })

    test("malformed typescript options are errors", async () => {
        const raw = await rawConfig()
        const at = (typescript: unknown) => problem({ ...raw, typescript })
        assert.match(at([]), /libstylist config\.typescript must be an object of \{ paths\? \}/)
        assert.match(at({ baseUrl: "." }), /libstylist config\.typescript: unknown key "baseUrl" \(allowed: paths\)/)
        assert.equal(at({}), "ok")
        assert.match(at({ paths: ["~/*"] }), /typescript\.paths must be an object of alias pattern → target paths \(tsconfig "paths"; targets relative to the config file\)/)
        assert.match(at({ paths: { "": ["x"] } }), /typescript\.paths: an alias pattern must be a non-empty string/)
        assert.match(at({ paths: { "~/*/*": ["x/*"] } }), /typescript\.paths: "~\/\*\/\*" has more than one "\*" — a pattern has at most one/)
        assert.match(at({ paths: { "~/*": "apps/web/app/*" } }), /typescript\.paths\["~\/\*"\] must be a non-empty array of target paths, relative to the config file/)
        assert.match(at({ paths: { "~/*": [] } }), /typescript\.paths\["~\/\*"\] must be a non-empty array of target paths/)
        assert.match(at({ paths: { "~/*": [""] } }), /typescript\.paths\["~\/\*"\]: "" is not a target path/)
        assert.match(at({ paths: { "~/*": ["apps/*/app/*"] } }), /typescript\.paths\["~\/\*"\]: "apps\/\*\/app\/\*" has more than one "\*" — a target has at most one/)
        assert.match(at({ paths: { "@fx/web/pages/settings/components": ["x.ts"] } }), /typescript\.paths: "@fx\/web\/pages\/settings\/components" is an entry of the configured package @fx\/web — its entries resolve it already/)
    })
})

describe("sources: gen-types", () => {
    test("scanCustomTags and genTagTypes read the given directories, else package.json's, else src", () => {
        assert.deepEqual(scanCustomTags(WEB, "crm", [SETTINGS]), TAGS)
        // the app's own root.tsx (<crm-shell>) is outside the sources
        assert.deepEqual(scanCustomTags(WEB, "crm", ["app"]), [...TAGS, "crm-shell"].sort())
        assert.deepEqual(scanCustomTags(WEB, "crm"), [], "src by default, which the package doesn't have")
        assert.deepEqual(scanCustomTags(WEB, "crm", [join(WEB, SETTINGS, "team")]), ["crm-settings-memberrow"], "absolute directories too")
        const out = genTagTypes({ packageDir: WEB, sources: [join(WEB, SETTINGS)] })
        assert.match(out, /^\/\/ Generated by `libstylist gen-types` from the JSX under app\/pages\/settings\/\. Do not edit\.$/m)
        for (const tag of TAGS) assert.match(out, new RegExp(`"${tag}": StylistHostProps`))
        assert.doesNotMatch(out, /crm-shell/)
        // the default header is unchanged
        assert.match(genTagTypes({ packageDir: WEB }), /^\/\/ Generated by `libstylist gen-types` from the JSX under src\/\. Do not edit\.\n[\s\S]*No `crm-\*` custom tags found\./)
        assert.deepEqual(resolveTypesSources(WEB), ["src"])
        assert.deepEqual(resolveTypesSources(WEB, ["lib"]), ["lib"])
    })

    // tsx by path: `--import tsx` resolves from the working directory, a scratch copy without node_modules
    const TSX = pathToFileURL(join(HERE, "..", "node_modules", "tsx", "dist", "loader.mjs")).href
    const CLI = join(HERE, "..", "src", "cli", "index.ts")
    const runIn = (cwd: string, args: string[]) => spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { encoding: "utf8", cwd })
    const tagFile = (root: string) => join(root, "apps", "web", "types", "stylist-tags.gen.d.ts")

    test("cli: gen-types --config scans each package's sources; a directory argument its package.json's", () => {
        const root = fixtureCopy()
        const written = runIn(root, ["gen-types", "--config", "libstylist.config.mjs"])
        assert.equal(written.status, 0, written.stderr)
        const file = readFileSync(tagFile(root), "utf8")
        for (const tag of TAGS) assert.match(file, new RegExp(`"${tag}": StylistHostProps`))
        assert.equal(runIn(root, ["gen-types", "--check", "--config", "libstylist.config.mjs"]).status, 0)
        // without the config the package.json declares no sources: src, which holds no tag — the file is stale
        const stale = runIn(root, ["gen-types", "--check", "apps/web"])
        assert.equal(stale.status, 1)
        assert.match(stale.stderr, /stale {3}.*apps\/web\/types\/stylist-tags\.gen\.d\.ts/)
        // declared in package.json, the directory argument reads it too
        const pkgJson = join(root, "apps", "web", "package.json")
        writeFileSync(pkgJson, json({ ...readJson(pkgJson), libstylist: { prefix: "crm", namespace: "settings", sources: [SETTINGS] } }))
        assert.equal(runIn(root, ["gen-types", "--check", "apps/web"]).status, 0)
        assert.equal(runIn(root, ["gen-types", "--check", "--config", "libstylist.config.mjs"]).status, 0)
    })
})

describe("sources: the workspace", () => {
    test("workspaceSourcePattern: the transform owns the package's sources, not src nor the rest of the app", async () => {
        const ws = await loadWorkspace({ root: FIXTURE })
        const pattern = workspaceSourcePattern(ws)
        assert.ok(pattern.test(`${WEB}/${SETTINGS}/team/render/RenderTeam.tsx`))
        assert.ok(pattern.test(`${WEB}/${SETTINGS}/components/SettingsPage.tsx`))
        assert.ok(!pattern.test(`${WEB}/app/root.tsx`), "the app outside the sources")
        assert.ok(!pattern.test(`${WEB}/src/x.tsx`), "src is no source directory of this package")
        assert.ok(!pattern.test(`${WEB}/${SETTINGS}-old/x.tsx`), "a sibling directory sharing the prefix")
        // the default: <dir>/src, exactly as before
        const bare = await loadWorkspace({ root: FIXTURE, config: withPackage(await rawConfig(), { sources: undefined }) })
        assert.ok(workspaceSourcePattern(bare).test(`${WEB}/src/x.tsx`) && !workspaceSourcePattern(bare).test(`${WEB}/${SETTINGS}/team/render/RenderTeam.tsx`))
    })

    test("workspacePackages passes package.json's sources on; the loader validates them", () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "libstylist-sources-wsp-")))
        scratchDirs.push(root)
        const write = (file: string, text: string) => {
            mkdirSync(dirname(join(root, file)), { recursive: true })
            writeFileSync(join(root, file), text)
        }
        write("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n  - "packages/*"\n')
        write("apps/web/package.json", json({ name: "web", libstylist: { prefix: "crm", namespace: "settings", sources: [SETTINGS] } }))
        write(`apps/web/${SETTINGS}/components/index.ts`, "export {}\n")
        write("packages/a/package.json", json({ name: "@x/a", libstylist: { prefix: "crm", namespace: "core" } }))
        write("packages/a/src/components/index.ts", "export {}\n")
        const packages = workspacePackages({ root, prefix: "crm", entries: (pkg) => (pkg.dir === "apps/web" ? { "./components": `${SETTINGS}/components/index.ts` } : { "./components": "src/components/index.ts" }) })
        assert.deepEqual(
            packages.map((p) => [p.dir, p.sources]),
            [
                ["apps/web", [SETTINGS]],
                ["packages/a", undefined],
            ],
        )
        const config = validateCheckConfig({ prefix: "crm", packages, css: {} }, root)
        assert.deepEqual(config.packages.map((p) => p.sources), [[join(root, "apps", "web", SETTINGS)], [join(root, "packages", "a", "src")]])
    })
})
