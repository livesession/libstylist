import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, test } from "node:test"

import { build, createServer, type Plugin, type Rollup } from "vite"

import { clearConventionsCache } from "../src/conventions/index.js"
import { partAttr } from "../src/hash/index.js"
import stylistDefault, { VIRTUAL_RUNTIME_ID, bundleRuntime, mayNeedTransform, stylist, type StylistViteOptions } from "../src/vite/index.js"

const require = createRequire(import.meta.url)

type TransformResult = { code: string; map: { sources: string[]; mappings: string } | null } | null
interface Ctx {
    watched: string[]
    addWatchFile(file: string): void
}

const hooks = (plugin: Plugin) => ({
    resolveId: plugin.resolveId as (id: string) => string | null,
    load: plugin.load as (id: string) => Promise<{ code: string; moduleSideEffects: boolean } | null>,
    transform: plugin.transform as unknown as (this: Ctx, code: string, id: string) => Promise<TransformResult>,
})

const ctx = (): Ctx => ({
    watched: [],
    addWatchFile(file) {
        this.watched.push(file)
    },
})

const part = (scope: string, p: string): string => partAttr({ prefix: "elo", namespace: "core", scope, part: p })

/** Restores an env var, deleting it when it was unset (assigning `undefined` would store the string "undefined"). */
const restoreEnv = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}

const dir = mkdtempSync(join(tmpdir(), "libstylist-vite-"))
mkdirSync(join(dir, "pkg", "src"), { recursive: true })
mkdirSync(join(dir, "pkg", "node_modules", "dep"), { recursive: true })
mkdirSync(join(dir, "plain"), { recursive: true })
writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n")
writeFileSync(join(dir, "pkg", "package.json"), JSON.stringify({ name: "fixture", type: "module", libstylist: { prefix: "elo", namespace: "core" } }))
writeFileSync(join(dir, "plain", "package.json"), JSON.stringify({ name: "plain" }))
clearConventionsCache()
process.on("exit", () => rmSync(dir, { recursive: true, force: true }))

/** Memoizes an async setup so each test awaits it and a failure is reported per test. */
const once = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
    let p: Promise<T> | null = null
    return () => (p ??= fn())
}

const ALERT = `import * as React from "react"
import { alert as cn } from "@livesession/eloquentui-css"
import { cx } from "@livesession/libstylist/runtime"

export function Alert({ title, open, children, ...rest }: { title?: string; open?: boolean; children?: React.ReactNode }) {
    return (
        <elo-alert {...cx(cn.root, rest, { hasTitle: title != null })} {...rest}>
            <span {...cx(cn.icon, { open })}>{children}</span>
        </elo-alert>
    )
}
`

/** The part map the css package would export, served through a Vite alias. */
const CSS_MODULE = `export const alert = ${JSON.stringify({ root: part("alert", "root"), icon: part("alert", "icon") })}\n`
writeFileSync(join(dir, "pkg", "css-classes.mjs"), CSS_MODULE)
const cssAlias = { "@livesession/eloquentui-css": join(dir, "pkg", "css-classes.mjs") }

describe("stylist() plugin hooks", () => {
    test("shape: pre-enforced, named, default export", () => {
        const plugin = stylist()
        assert.equal(plugin.name, "libstylist")
        assert.equal(plugin.enforce, "pre")
        assert.equal(stylistDefault, stylist)
    })

    test("serves the runtime as plain ESM from the virtual module", async () => {
        const { resolveId, load } = hooks(stylist())
        assert.equal(VIRTUAL_RUNTIME_ID, "virtual:libstylist/runtime")
        const resolved = resolveId(VIRTUAL_RUNTIME_ID)
        assert.equal(resolved, "\0virtual:libstylist/runtime")
        assert.equal(resolveId("@livesession/libstylist/runtime"), resolved, "author imports share the bundled runtime")
        assert.equal(resolveId("react"), null)
        assert.equal(await load("/some/file.ts"), null)
        const mod = await load(resolved!)
        assert.ok(mod)
        assert.equal(mod.moduleSideEffects, false)
        assert.ok(!/: Record<|type Props/.test(mod.code), "types are stripped")
        const url = `data:text/javascript;base64,${Buffer.from(mod.code).toString("base64")}`
        const rt = (await import(url)) as typeof import("../src/runtime/index.js")
        assert.deepEqual(Object.keys(rt).sort(), ["cx", "cxAttr", "cxCompiled", "cxData", "hostProps", "legacy", "legacyClassName", "unsetRef", "withoutStylist"])
        assert.deepEqual(rt.cx("_cxclass_elo-a", false, rt.cxData({ open: true }), { "elo-x": "" }), { "_cxclass_elo-a": "", "data-open": "true", "elo-x": "" })
    })

    test("transforms configured sources to TSX: helpers join the author's runtime import, data literals are branded", async () => {
        const { transform } = hooks(stylist())
        const file = join(dir, "pkg", "src", "Alert.tsx")
        const out = await transform.call(ctx(), ALERT, `${file}?v=123`)
        assert.ok(out)
        assert.ok(out.code.includes(`import { cx, cxData, hostProps, cxCompiled } from "@livesession/libstylist/runtime";`), out.code)
        assert.ok(out.code.includes(`<elo-alert {...cx(cn.root, rest, cxData({`), "JSX is kept for esbuild")
        const bare = await transform.call(ctx(), `export const x = <elo-alert {...rest} />`, join(dir, "pkg", "src", "Bare.tsx"))
        assert.ok(bare?.code.includes(`import { hostProps } from "virtual:libstylist/runtime";`), bare?.code)
        assert.ok(out.code.includes("title?: string;") && out.code.includes("children?: React.ReactNode;"), "TypeScript is kept for esbuild")
        assert.ok(out.code.includes(`"data-file-source": "pkg/src/Alert.tsx:7"`), "paths are relative to the repo root")
        assert.ok(out.map && out.map.mappings.length > 0)
        assert.deepEqual(out.map.sources, [file])
    })

    test("skips virtual ids, node_modules, other extensions, unconfigured and unrelated files", async () => {
        const { transform } = hooks(stylist())
        const c = ctx()
        assert.equal(await transform.call(c, ALERT, "\0virtual:x.tsx"), null)
        assert.equal(await transform.call(c, ALERT, join(dir, "pkg", "node_modules", "dep", "index.tsx")), null)
        assert.equal(await transform.call(c, ALERT, join(dir, "pkg", "src", "alert.css")), null)
        assert.equal(await transform.call(c, ALERT, join(dir, "pkg", "src", "Alert.mdx")), null)
        assert.equal(await transform.call(c, `export const x = <div data-a />`, join(dir, "pkg", "src", "Plain.tsx")), null, "prefilter")
        assert.equal(await transform.call(c, `export const x = <circle cx={2} />`, join(dir, "pkg", "src", "Svg.tsx")), null, "no change → null")
        assert.equal(await transform.call(c, `export const x = <circle cx={2} />`, join(dir, "plain", "Svg.tsx")), null, "unconfigured, geometry only")
        await assert.rejects(transform.call(c, `export const x = <span cx="a:b" />`, join(dir, "plain", "Bad.tsx")), /the cx attribute was removed/)
        const branded = await transform.call(c, `import { cx } from "@livesession/libstylist/runtime"\nexport const x = cx({ open })`, join(dir, "plain", "attrs.ts"))
        assert.ok(branded?.code.includes("cx(cxData({"), "unconfigured files still get their data literals branded")
    })

    test(".ts sources parse without JSX so angle-bracket casts keep working", async () => {
        const { transform } = hooks(stylist())
        const code = `const tag = "elo-alert"\nexport const n = <number>(<unknown>tag.length)\n`
        assert.equal(await transform.call(ctx(), code, join(dir, "pkg", "src", "cast.ts")), null)
    })

    test("include/exclude narrow the transformed ids", async () => {
        const file = join(dir, "pkg", "src", "Alert.tsx")
        assert.equal(await hooks(stylist({ include: /\/other\// })).transform.call(ctx(), ALERT, file), null)
        assert.equal(await hooks(stylist({ exclude: /Alert\.tsx$/ })).transform.call(ctx(), ALERT, file), null)
    })

    test("a registry path is read, validated against and watched", async () => {
        const regPath = join(dir, "stylist-registry.json")
        writeFileSync(regPath, JSON.stringify({ version: 1, scopes: { alert: { namespace: "core", parts: { root: part("alert", "root"), icon: part("alert", "icon") } } } }))
        const options: StylistViteOptions = { registry: regPath, dev: false }
        const { transform } = hooks(stylist(options))
        const c = ctx()
        const file = join(dir, "pkg", "src", "Alert.tsx")
        assert.ok(await transform.call(c, ALERT, file))
        assert.deepEqual(c.watched, [regPath])
        await assert.rejects(transform.call(c, ALERT.replace("cn.icon", "cn.nope"), file), /unknown part "nope" of cn \(sheet "alert"/)
    })

    test("prefilter", () => {
        assert.ok(mayNeedTransform(`import { cx } from "@livesession/libstylist/runtime"`, undefined))
        assert.ok(mayNeedTransform(`import { cx } from "virtual:libstylist/runtime"`, undefined))
        assert.ok(mayNeedTransform(`import { cx } from "~stylist"`, undefined, "~stylist"))
        assert.ok(mayNeedTransform(`<a cx="x" />`, undefined), "the removed attribute is still transformed, to report it")
        assert.ok(mayNeedTransform(`<a inputCx = {y} />`, undefined))
        assert.ok(mayNeedTransform(`<elo-alert />`, "elo"))
        assert.ok(!mayNeedTransform(`<elo-alert />`, undefined))
        assert.ok(!mayNeedTransform(`const cxData = 1; import "@livesession/eloquentui-css"`, "elo"))
    })
})

describe("vite lib build", () => {
    const libChunk = once(async (): Promise<Rollup.OutputChunk> => {
        writeFileSync(join(dir, "pkg", "src", "index.tsx"), ALERT)
        const result = await build({
            configFile: false,
            root: join(dir, "pkg"),
            logLevel: "silent",
            plugins: [stylist()],
            resolve: { alias: cssAlias },
            esbuild: { jsx: "automatic" },
            build: {
                write: false,
                minify: false,
                lib: { entry: join(dir, "pkg", "src", "index.tsx"), formats: ["es"], fileName: "index" },
                rollupOptions: { external: [/^react($|\/)/] },
            },
        })
        const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[]
        const found = outputs[0].output.find((o): o is Rollup.OutputChunk => o.type === "chunk")
        assert.ok(found)
        return found
    })

    test("bundles the runtime and keeps the NODE_ENV guard", async () => {
        const { code } = await libChunk()
        assert.ok(!code.includes("virtual:libstylist") && !code.includes("@livesession/libstylist"), code)
        assert.match(code, /function cx\(/)
        assert.match(code, /function cxData\(/)
        assert.match(code, /function hostProps\(/)
        assert.ok(!code.includes("forwardStylist"), code)
        assert.ok(code.includes(`process.env.NODE_ENV !== "production"`), "dev guard survives lib mode")
        assert.ok(code.includes(`"${part("alert", "root")}": ""`) || code.includes(`${part("alert", "root")}`), code)
        assert.ok(code.includes(`from "react/jsx-runtime"`))
    })

    test("the built module renders with and without dev attributes", async () => {
        const chunk = await libChunk()
        const jsxRuntimeUrl = pathToFileURL(require.resolve("react/jsx-runtime")).href
        const out = join(dir, "dist-index.mjs")
        writeFileSync(out, chunk.code.replace(/from "react\/jsx-runtime"/g, `from ${JSON.stringify(jsxRuntimeUrl)}`).replace(/import \* as React from "react";?\n/, ""))
        const mod = (await import(pathToFileURL(out).href)) as { Alert: (p: Record<string, unknown>) => unknown }
        const React = require("react") as typeof import("react")
        const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server")
        const prev = process.env.NODE_ENV
        try {
            process.env.NODE_ENV = "development"
            const dev = renderToStaticMarkup(React.createElement(mod.Alert as React.FC, { title: "t", open: true, "data-extra": true } as object))
            assert.ok(dev.startsWith(`<elo-alert ${part("alert", "root")}=""`), dev)
            assert.ok(dev.includes(`data-has-title="true"`) && dev.includes(`data-extra="true"`), dev)
            assert.ok(dev.includes(`<span ${part("alert", "icon")}="" data-open="true" _cxpart="icon"`), dev)
            assert.ok(dev.includes(`data-react-component="Alert"`), dev)
            process.env.NODE_ENV = "production"
            const prod = renderToStaticMarkup(React.createElement(mod.Alert as React.FC, { title: "t" } as object))
            assert.ok(!/_cxpart|data-react-component|data-file-source|\sclass=/.test(prod), prod)
            assert.ok(prod.includes(`<span ${part("alert", "icon")}="">`), prod)
        } finally {
            restoreEnv("NODE_ENV", prev)
        }
    })
})

describe("runtime bundling under the design-system external list", () => {
    // every DS package's vite.config.ts externalizes /^@livesession\//, and Rollup applies `external` before resolveId
    const SOURCE = `import { cx } from "@livesession/libstylist/runtime"

export function Alert({ open, ...rest }: { open?: boolean }) {
    return <elo-alert {...cx("_cxclass_elo-aaaaaa", rest, { open })} />
}
`
    const externals: Array<[string, NonNullable<Rollup.InputOptions["external"]>]> = [
        ["array", ["react", /^react\/jsx-runtime/, /^@livesession\//]],
        ["function", (id: string) => id === "react" || id.startsWith("react/") || id.startsWith("@livesession/")],
        ["regexp", /^(react|@livesession\/)/],
    ]
    for (const [label, external] of externals) {
        test(`author imports of @livesession/libstylist/runtime are bundled (${label} external)`, async () => {
            const entry = join(dir, "pkg", "src", `external-${label}.tsx`)
            writeFileSync(entry, SOURCE)
            const result = await build({
                configFile: false,
                root: join(dir, "pkg"),
                logLevel: "silent",
                plugins: [stylist({ dev: false })],
                esbuild: { jsx: "automatic" },
                build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: "index" }, rollupOptions: { external } },
            })
            const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[]
            const chunks = outputs[0].output.filter((o): o is Rollup.OutputChunk => o.type === "chunk")
            assert.equal(chunks.length, 1, "one chunk: the runtime is inlined, not split")
            const { code } = chunks[0]
            assert.ok(!code.includes("@livesession/libstylist") && !code.includes("virtual:libstylist"), code)
            assert.equal(code.match(/function cx\(/g)?.length, 1, "one copy of the runtime")
            assert.equal(code.match(/function cxData\(/g)?.length, 1)
            assert.match(code, /from "react\/jsx-runtime"/, "other externals stay external")
        })
    }

    test("bundleRuntime keeps the runtime ids internal and defers everything else to the original option", () => {
        const wrapped = bundleRuntime([/^@livesession\//, "react"])
        assert.equal(wrapped("@livesession/libstylist/runtime", undefined, false), false)
        assert.equal(wrapped(VIRTUAL_RUNTIME_ID, undefined, false), false)
        assert.equal(wrapped("\0virtual:libstylist/runtime", undefined, true), false)
        assert.equal(wrapped("@livesession/eloquentui-css", undefined, false), true)
        assert.equal(wrapped("react", undefined, false), true)
        assert.equal(wrapped("react-dom", undefined, false), false)
        const calls: unknown[][] = []
        const fn = bundleRuntime((...args: unknown[]) => {
            calls.push(args)
            return true
        })
        assert.equal(fn("x", "/a.ts", true), true)
        assert.deepEqual(calls, [["x", "/a.ts", true]])
    })

    test("the options hook only wraps an existing external", () => {
        const options = stylist().options as (o: Rollup.InputOptions) => Rollup.InputOptions | null
        assert.equal(options({ input: "a" }), null)
        const out = options({ input: "a", external: [/^@livesession\//] })
        assert.ok(out && typeof out.external === "function")
        assert.equal((out.external as (id: string) => boolean)("@livesession/libstylist/runtime"), false)
    })
})

describe("vite dev server (the storybook dev path)", () => {
    test("serves the virtual runtime to both import forms and folds the dev guard to development", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "libstylist-vite-dev-")))
        try {
            mkdirSync(join(root, "pkg", "src"), { recursive: true })
            writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n")
            writeFileSync(join(root, "pkg", "package.json"), JSON.stringify({ name: "fixture-dev", type: "module", libstylist: { prefix: "elo", namespace: "core" } }))
            symlinkSync(join(process.cwd(), "node_modules"), join(root, "pkg", "node_modules"), "dir")
            writeFileSync(join(root, "pkg", "src", "Alert.tsx"), ALERT)
            writeFileSync(join(root, "pkg", "css-classes.mjs"), CSS_MODULE)
            clearConventionsCache()
            // vite.build() above sets NODE_ENV=production for the whole process; storybook dev runs without it
            const prevEnv = process.env.NODE_ENV
            process.env.NODE_ENV = "development"
            const server = await createServer({
                configFile: false,
                root: join(root, "pkg"),
                logLevel: "silent",
                plugins: [stylist()],
                resolve: { alias: { "@livesession/eloquentui-css": join(root, "pkg", "css-classes.mjs") } },
                esbuild: { jsx: "automatic" },
                server: { middlewareMode: true, watch: null },
                optimizeDeps: { noDiscovery: true, include: [] },
            })
            try {
                const mod = await server.transformRequest("/src/Alert.tsx")
                assert.ok(mod)
                // every libstylist import left in the module, minus installed dependencies: Vite rewrites react's
                // jsx-dev-runtime to an /@fs/…/node_modules/… path, which names libstylist when the checkout's own
                // directory does
                const runtimeImports = [...mod.code.matchAll(/from "([^"]*libstylist[^"]*)"/g)].map((m) => m[1]).filter((s) => !s.includes("/node_modules/"))
                assert.ok(runtimeImports.length >= 1, mod.code)
                assert.deepEqual(new Set(runtimeImports), new Set(["/@id/__x00__virtual:libstylist/runtime"]), "one runtime module for injected and author imports")
                assert.ok(mod.code.includes("cxData("), mod.code)
                assert.ok(!mod.code.includes("process.env.NODE_ENV"), "Vite folds the guard in dev")
                assert.ok(mod.code.includes(`_cxpart: "icon"`) && mod.code.includes(`"data-react-component": "Alert"`), mod.code)
                // the browser asks for /@id/__x00__…, which the dev middleware unwraps to the plugin-resolved id
                const runtime = await server.transformRequest(VIRTUAL_RUNTIME_ID)
                assert.ok(runtime && /export\s*\{[^}]*\bcxData\b/.test(runtime.code), runtime?.code)
            } finally {
                await server.close()
                restoreEnv("NODE_ENV", prevEnv)
            }
        } finally {
            rmSync(root, { recursive: true, force: true })
            clearConventionsCache()
        }
    })
})
