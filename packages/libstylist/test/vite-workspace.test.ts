// stylistWorkspace(): the Vite plugins of a workspace of app packages — the JSX transform over the
// packages' sources, their sheets compiled into cascade layers, the dev watcher keeping each package's
// part-map module in step, and the build's guards. Runs on a scratch copy of the check fixture's
// workspace (the plugins rewrite its hand-written part maps).
import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { build, createLogger, createServer, type InlineConfig, type Logger, type Plugin, type Rollup, type ViteDevServer } from "vite"

import { clearConventionsCache } from "../src/conventions/index.js"
import { partAttr } from "../src/hash/index.js"
import { stylist, stylistWorkspace } from "../src/vite/index.js"
import { PART_MAP_HEADER, runWorkspaceBuild } from "../src/workspace/index.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, "fixtures", "check", "workspace")
const attr = (namespace: string, scope: string, part: string) => partAttr({ prefix: "crm", namespace, scope, part })

const scratchDirs: string[] = []
process.on("exit", () => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** A scratch copy of the workspace fixture: a pnpm workspace root, react reachable through node_modules. */
function workspace(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "libstylist-vite-ws-")))
    scratchDirs.push(root)
    cpSync(FIXTURE, root, { recursive: true })
    writeFileSync(join(root, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n`)
    symlinkSync(join(HERE, "..", "node_modules"), join(root, "node_modules"), "dir")
    clearConventionsCache()
    return root
}

const write = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
}

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
 * (Vite's root, a sheet directory the plugin adds) some time after the server is created — its `ready`
 * comes earlier — and a change made before its native watch (inotify, the FSEvents stream) runs is never
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
        root: join(root, "packages", "accounts"),
        logLevel: "silent",
        plugins,
        esbuild: { jsx: "automatic" },
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

describe("stylistWorkspace() plugins", () => {
    test("shape: a pre-enforced transform and css plugin; css: false keeps the transform only", async () => {
        const both = await stylistWorkspace()
        assert.deepEqual(both.map((p) => [p.name, p.enforce]), [
            ["libstylist:workspace", "pre"],
            ["libstylist:workspace-css", "pre"],
        ])
        assert.deepEqual((await stylistWorkspace({ css: false })).map((p) => p.name), ["libstylist:workspace"])
    })

    test("dev: the config found upward from Vite's root, part maps synced at start, sources transformed, sheets compiled into their layers", async () => {
        const root = workspace()
        const logger = recorder()
        const server = await devServer(root, await stylistWorkspace(), { customLogger: logger })
        try {
            // the hand-written part maps are brought to the generated shape when the server starts
            const accountsMap = readFileSync(join(root, "packages", "accounts", "src", "css", "index.ts"), "utf8")
            assert.ok(accountsMap.startsWith(PART_MAP_HEADER), accountsMap)
            assert.ok(readFileSync(join(root, "stylist.lock.json"), "utf8").includes(`"render/RenderAccountsTable": "crm-render-accountstable"`))
            assert.ok(logger.lines.some((l) => /info \[libstylist\] wrote packages\/partners\/src\/css\/index\.ts/.test(l)), logger.lines.join("\n"))

            const list = await server.transformRequest(join(root, "packages", "accounts", "src", "components", "AccountsList.tsx"))
            assert.ok(list?.code.includes(`_cxpart: "row"`), list?.code)
            assert.match(list?.code ?? "", /"data-file-source": "packages\/accounts\/src\/components\/AccountsList\.tsx:\d+"/)
            const render = await server.transformRequest(join(root, "packages", "partners", "src", "render", "RenderPartners.tsx"))
            assert.ok(render?.code.includes(`"data-react-component": "RenderPartners"`), render?.code)

            const sheet = await server.transformRequest(`${join(root, "packages", "partners", "src", "css", "render", "render-partners.css")}?direct`)
            assert.equal(
                sheet?.code,
                `@layer reset, tokens, components, utilities, app.core, app.render;\n@layer app.render {\n:where(crm-render-partners:not([hidden])) { display: block; unicode-bidi: isolate; }\n[${attr("render", "render-partners", "root")}] { gap: 16px; }\n}\n`,
            )
            const core = await server.transformRequest(join(root, "packages", "accounts", "src", "css", "accounts-list.css"))
            assert.ok(core?.code.includes("@layer app.core {"), "the JS module of an imported sheet carries the layered css")
            assert.ok(core?.code.includes(`[${attr("core", "accounts-list", "row")}]`), core?.code)
        } finally {
            await server.close()
        }
    })

    test("dev: an edited sheet rewrites its package's part map, reloads the sheets reading it and reports registry errors", async () => {
        const root = workspace()
        const partnersSheet = join(root, "packages", "partners", "src", "css", "render", "render-partners.css")
        writeFileSync(partnersSheet, "@stylist root RenderPartners display block;\n\n.root { gap: 16px; }\n.root :cx(accounts-list:row) { gap: 0; }\n")
        const server = await devServer(root, await stylistWorkspace())
        try {
            await server.transformRequest(`${partnersSheet}?direct`)
            const accountsMap = join(root, "packages", "accounts", "src", "css", "index.ts")
            const list = join(root, "packages", "accounts", "src", "css", "accounts-list.css")
            const extra = join(root, "packages", "accounts", "src", "css", "render", "render-extra.css")
            await watching(server, dirname(list))
            await watching(server, dirname(extra))
            await edit(server, list, "@stylist root AccountsList;\n\n.root { margin: 0; }\n.row { padding: 4px 8px; }\n.badge { gap: 8px; }\n")
            await until(() => readFileSync(accountsMap, "utf8").includes("badge"), "the accounts part map to gain `badge`")
            await until(() => server.reloaded.some((f) => f.startsWith(partnersSheet)), "the reading sheet to be reloaded")
            assert.ok(!server.reloaded.some((f) => f.includes("accounts-list.css")), "the edited sheet itself is Vite's to reload")

            // a new sheet is imported by its package's map; a removed one is dropped
            write(extra, "@stylist root RenderExtra;\n\n.root { gap: 0; }\n")
            await until(() => readFileSync(accountsMap, "utf8").includes(`import "./render/render-extra.css"`), "the new sheet in the part map")
            rmSync(extra)
            await until(() => !readFileSync(accountsMap, "utf8").includes("render-extra"), "the removed sheet to leave the part map")

            // a registry error reaches the overlay and nothing is written
            const before = readFileSync(accountsMap, "utf8")
            await edit(server, list, "@stylist scope partners-card;\n.root { margin: 0; }\n")
            await until(() => server.sent.some((p) => p.type === "error"), "an overlay error")
            assert.match(server.sent.find((p) => p.type === "error")?.err?.message ?? "", /\[duplicate-scope\] scope "partners-card"/)
            assert.equal(readFileSync(accountsMap, "utf8"), before)
        } finally {
            await server.close()
        }
    })

    test("dev: fixing a registry error catches up on what changed meanwhile in another package — its part map, the reading sheets", async () => {
        const root = workspace()
        const partnersDir = join(root, "packages", "partners", "src", "css")
        const cardSheet = join(partnersDir, "partners-card.css")
        writeFileSync(cardSheet, "@stylist root PartnersCard display block;\n\n.root { padding: 8px; }\n.root :cx(render-partners:root) { gap: 0; }\n")
        const server = await devServer(root, await stylistWorkspace())
        try {
            await server.transformRequest(`${cardSheet}?direct`)
            const renderSheet = join(partnersDir, "render", "render-partners.css")
            await watching(server, dirname(renderSheet))
            await watching(server, join(root, "packages", "accounts", "src", "css", "render"))
            const errors = () => server.sent.filter((p) => p.type === "error").length
            // a duplicate scope in accounts: nothing is written while it stands
            const duplicate = join(root, "packages", "accounts", "src", "css", "render", "accounts-list.css")
            write(duplicate, ".root { gap: 0; }\n")
            await until(() => errors() === 1, "the duplicate scope on the overlay")
            // meanwhile a partners sheet gains a part (the rebuild still errors on the duplicate)
            await edit(server, renderSheet, `${readFileSync(renderSheet, "utf8")}\n.icon { gap: 2px; }\n`)
            await until(() => errors() === 2, "the second errored rebuild")
            const partnersMap = join(partnersDir, "index.ts")
            assert.ok(!readFileSync(partnersMap, "utf8").includes("icon"))
            server.reloaded.length = 0
            rmSync(duplicate)
            await until(() => readFileSync(partnersMap, "utf8").includes(`icon: "${attr("render", "render-partners", "icon")}"`), "the partners part map to gain `icon`")
            await until(() => server.reloaded.some((f) => f.startsWith(cardSheet)), "the sheet reading render-partners to be reloaded")
            assert.deepEqual((await runWorkspaceBuild({ root, check: true })).drift, [])
        } finally {
            await server.close()
        }
    })

    test("dev: a server started with a registry error syncs every package once it is fixed", async () => {
        const root = workspace()
        const duplicate = join(root, "packages", "partners", "src", "css", "accounts-list.css")
        write(duplicate, ".root { gap: 0; }\n")
        const logger = recorder()
        const server = await devServer(root, await stylistWorkspace(), { customLogger: logger })
        try {
            assert.ok(logger.lines.some((l) => /^warn \[libstylist\] \[duplicate-scope\] scope "accounts-list"/.test(l)), logger.lines.join("\n"))
            const maps = ["accounts", "partners"].map((p) => join(root, "packages", p, "src", "css", "index.ts"))
            assert.ok(maps.every((m) => !readFileSync(m, "utf8").startsWith(PART_MAP_HEADER)), "nothing is written at start")
            await watching(server, dirname(duplicate))
            rmSync(duplicate)
            await until(() => maps.every((m) => readFileSync(m, "utf8").startsWith(PART_MAP_HEADER)), "both part maps generated")
            assert.deepEqual((await runWorkspaceBuild({ root, check: true })).drift, [])
        } finally {
            await server.close()
        }
    })

    test("dev: a changed sheet compiles against its own text even before the watcher sees it", async () => {
        const root = workspace()
        const server = await devServer(root, await stylistWorkspace(), { server: { middlewareMode: true, ws: false, watch: null } })
        try {
            const css = server.config.plugins.find((p) => p.name === "libstylist:workspace-css") as Plugin
            const transform = css.transform as (this: unknown, code: string, id: string) => Promise<{ code: string } | null>
            const ctx = { warn: () => {}, error: (m: string) => assert.fail(m) }
            const list = join(root, "packages", "accounts", "src", "css", "accounts-list.css")
            const out = await transform.call(ctx, "@stylist root AccountsList;\n\n.root { margin: 0; }\n.fresh { gap: 8px; }\n", list)
            assert.ok(out?.code.includes(`[${attr("core", "accounts-list", "fresh")}]`), out?.code)
            assert.ok(readFileSync(join(root, "packages", "accounts", "src", "css", "index.ts"), "utf8").includes(`fresh: "${attr("core", "accounts-list", "fresh")}"`), "the part map follows the transformed text")
            // raw and url imports are not stylesheets to compile; files outside the sheet directories are left alone
            assert.equal(await transform.call(ctx, ".x {}", `${list}?raw`), null)
            assert.equal(await transform.call(ctx, ".x {}", join(root, "vendor", "x.css")), null)
        } finally {
            await server.close()
        }
    })

    test("dev: write: false leaves the part maps alone and warns", async () => {
        const root = workspace()
        const logger = recorder()
        const handWritten = readFileSync(join(root, "packages", "accounts", "src", "css", "index.ts"), "utf8")
        const server = await devServer(root, await stylistWorkspace({ write: false }), { customLogger: logger })
        try {
            assert.equal(readFileSync(join(root, "packages", "accounts", "src", "css", "index.ts"), "utf8"), handWritten)
            assert.ok(logger.lines.some((l) => /warn \[libstylist\] stale part maps \(write: false\): packages\/accounts\/src\/css\/index\.ts, packages\/partners\/src\/css\/index\.ts/.test(l)), logger.lines.join("\n"))
        } finally {
            await server.close()
        }
    })

    test("the transform owns the workspace packages' src only: never the workspace root's 3rd-party, include adds more", async () => {
        const root = workspace()
        const source = `import { cx } from "@livesession/libstylist/runtime"\nexport const X = ({ open, ...rest }: { open?: boolean }) => <crm-x {...cx(rest, { open })} />\n`
        const vendor = join(root, "3rd-party", "ds", "src", "X.tsx")
        const app = join(root, "apps", "shell", "src", "X.tsx")
        const own = join(root, "packages", "accounts", "src", "components", "X.tsx")
        // a package's own directory named 3rd-party is the package's code
        const ownThirdParty = join(root, "packages", "accounts", "src", "render", "3rd-party", "RenderSlack.tsx")
        for (const f of [vendor, app, own, ownThirdParty]) write(f, source)
        for (const [options, expected] of [
            [{}, [false, false, true, true]],
            [{ include: /\/apps\/shell\// }, [false, true, true, true]],
            [{ include: /\/3rd-party\// }, [false, false, true, true]],
            [{ exclude: /\/components\// }, [false, false, false, true]],
        ] as const) {
            const [jsx] = await stylistWorkspace({ css: false, ...options })
            await (jsx.configResolved as (c: unknown) => Promise<void>)({ root, command: "serve", logger: recorder(), plugins: [jsx] })
            const transform = jsx.transform as (this: unknown, code: string, id: string) => Promise<{ code: string } | null>
            const ctx = { addWatchFile: () => {} }
            const got = await Promise.all([vendor, app, own, ownThirdParty].map(async (f) => (await transform.call(ctx, source, f)) !== null))
            assert.deepEqual(got, expected, JSON.stringify(options))
        }
    })

    test("css: false (Vitest): validates part-map members against the registry and rebuilds it after a sheet changes", async () => {
        const root = workspace()
        const [jsx] = await stylistWorkspace({ css: false, dev: false })
        await (jsx.configResolved as (c: unknown) => Promise<void>)({ root, command: "serve", logger: recorder(), plugins: [jsx] })
        const transform = jsx.transform as (this: unknown, code: string, id: string) => Promise<{ code: string } | null>
        const ctx = { addWatchFile: () => {} }
        const file = join(root, "packages", "accounts", "src", "components", "Uses.tsx")
        const uses = (part: string) => `import { cx } from "@livesession/libstylist/runtime"\nimport { accountsList as cn } from "#css"\nexport const Uses = () => <span {...cx(cn.${part})} />\n`
        assert.ok(await transform.call(ctx, uses("row"), file))
        await assert.rejects(transform.call(ctx, uses("badge"), file), /unknown part "badge" of cn \(sheet "accounts-list"/)
        const sheet = join(root, "packages", "accounts", "src", "css", "accounts-list.css")
        writeFileSync(sheet, `${readFileSync(sheet, "utf8")}\n.badge { gap: 8px; }\n`)
        ;(jsx.watchChange as (id: string, change: { event: string }) => void)(sheet, { event: "update" })
        assert.ok(await transform.call(ctx, uses("badge"), file), "the registry is rebuilt on the next use")
    })

    test("a second copy of the transform is an error", async () => {
        const root = workspace()
        await assert.rejects(devServer(root, [...(await stylistWorkspace()), ...(await stylistWorkspace())]), /libstylist: the transform is registered 2 times/)
        await assert.rejects(devServer(root, [stylist(), ...(await stylistWorkspace({ css: false }))]), /registered 2 times/)
    })
})

describe("stylistWorkspace() in vite build", () => {
    const entry = (root: string) => {
        const file = join(root, "entry.tsx")
        writeFileSync(file, `export { AccountsList } from "./packages/accounts/src/components/AccountsList"\nexport { RenderPartners } from "./packages/partners/src/render/RenderPartners"\n`)
        return file
    }
    const libBuild = async (root: string) => {
        const result = await build({
            configFile: false,
            root,
            logLevel: "silent",
            plugins: await stylistWorkspace(),
            esbuild: { jsx: "automatic" },
            build: { write: false, minify: false, lib: { entry: entry(root), formats: ["es"], fileName: "index" }, rollupOptions: { external: [/^react($|\/)/] } },
        })
        return ((Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[])[0].output
    }

    test("fails on stale part maps, then bundles the tags and the layered sheets", async () => {
        const root = workspace()
        await assert.rejects(libBuild(root), /libstylist: stale part maps — run `libstylist build` and commit them: packages\/accounts\/src\/css\/index\.ts, packages\/partners\/src\/css\/index\.ts/)
        await runWorkspaceBuild({ root })
        const output = await libBuild(root)
        const chunk = output.find((o): o is Rollup.OutputChunk => o.type === "chunk")
        const css = output.find((o): o is Rollup.OutputAsset => o.type === "asset" && o.fileName.endsWith(".css"))
        assert.ok(chunk && css)
        assert.ok(chunk.code.includes(`"crm-render-partners"`) && chunk.code.includes(attr("core", "accounts-list", "row")), chunk.code)
        assert.ok(!chunk.code.includes("virtual:libstylist"), "the runtime is bundled")
        const text = String(css.source)
        assert.match(text, /@layer reset, tokens, components, utilities, app\.core, app\.render;/)
        assert.ok(text.includes("@layer app.core {") && text.includes("@layer app.render {"), text)
        assert.ok(text.includes(`[${attr("core", "accounts-list", "row")}]`) && text.includes(`[${attr("render", "render-partners", "root")}]`), text)
        assert.doesNotMatch(text, /\.root|\.row/)
    })

    test("fails on a registry error", async () => {
        const root = workspace()
        await runWorkspaceBuild({ root })
        write(join(root, "packages", "partners", "src", "css", "render", "accounts-list.css"), ".root { gap: 0; }\n")
        await assert.rejects(libBuild(root), /libstylist: the workspace registry has errors\n\[duplicate-scope\] scope "accounts-list"/)
    })
})
