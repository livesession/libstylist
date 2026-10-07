// Smoke run over the real design-system sources (read-only), with the real stylesheets as the registry:
// every file goes through `libstylist codemod` (in memory; a no-op for files already on the cx() call
// API), then through the transform, and every output must compile, keep its SVG geometry cx, brand
// every data literal and read only registered parts. Runs against the checkout LIBSTYLIST_DESIGN_SYSTEM
// names (./design-system.ts) and skips without it, or while its css package is not built.
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"

import { parseSync, transformSync, traverse, types as t } from "@babel/core"
import { transformWithEsbuild } from "vite"

import { libstylistBabel, type DevMode, type LibstylistFileMetadata } from "../src/babel/index.js"
import { runCodemod } from "../src/codemod/cli.js"
import { resolvePackageConfig } from "../src/conventions/index.js"
import { exportName, type Registry } from "../src/registry/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

const PACKAGES = ["components", "app-ui", "player", "gram", "infinity", "ai"]
/** The css build's registry in the design-system checkout. */
const registryFile = () => designSystemPath("packages", "css", "dist", "stylist-registry.json")
const skip =
    skipWithoutDesignSystem ||
    (!existsSync(registryFile()) && "packages/css/dist is not built in the design-system checkout") ||
    (!PACKAGES.every((p) => existsSync(designSystemPath("packages", p, "src"))) && "a design-system package has no src directory")

const parserPlugins = (file: string): Array<"jsx" | "typescript"> => (file.endsWith(".tsx") ? ["jsx", "typescript"] : ["typescript"])

function stylist(code: string, file: string, registry: Registry, partMaps: Record<string, string>, dev: DevMode) {
    const out = transformSync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: parserPlugins(file) },
        plugins: [[libstylistBabel, { registry, partMaps, dev }]],
    })
    assert.ok(out?.code != null, file)
    return { code: out.code, meta: (out.metadata as { libstylist?: LibstylistFileMetadata }).libstylist }
}

async function assertCompiles(code: string, file: string): Promise<void> {
    const loader = file.endsWith(".tsx") ? "tsx" : "ts"
    await transformWithEsbuild(code, join(tmpdir(), `libstylist-smoke.${loader}`), { loader, jsx: "automatic", tsconfigRaw: {} })
}

describe("smoke: real design-system sources on the cx() call API", { skip }, () => {
    test("codemod → transform: every file converts, compiles, brands its data literals and reads registered parts", async () => {
        const REPO = designSystemPath()
        const CONFIG = join(REPO, "libstylist.config.mjs")
        const config = (await import(CONFIG)).default as { css: { partMaps: Record<string, string> } }
        const registry = JSON.parse(readFileSync(registryFile(), "utf8")) as Registry
        const maps = new Map(Object.entries(config.css.partMaps).map(([group, module]) => [module, group]))
        const partsOf = (group: string) => new Map(Object.entries(registry.scopes).filter(([, s]) => s.group === group))
        const { execSync } = await import("node:child_process")
        const files = execSync(`git -C ${REPO} ls-files ${PACKAGES.map((p) => `packages/${p}/src`).join(" ")}`, { encoding: "utf8" })
            .split("\n")
            .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"))
        assert.ok(files.length > 150, `found ${files.length} files`)
        const results = await runCodemod(files, { cwd: REPO, config: CONFIG })
        let members = 0
        for (const { file, result } of results) {
            assert.ok(resolvePackageConfig(file), `${file} is in a configured package`)
            assert.ok(!result.todo.some((t) => /conditional|not a static part list|no part-map module|NOT IDEMPOTENT/.test(t.message)), `${file}: ${JSON.stringify(result.todo)}`)
            for (const dev of ["runtime", true, false] as const) {
                const { code } = stylist(result.code, file, registry, config.css.partMaps, dev)
                await assertCompiles(code, file)
                assert.ok(!/\scx=(["{])/.test(code.replace(/<(circle|ellipse|radialGradient)\b[^>]*>/g, "")), `${file}: no cx attribute left on non-geometry elements`)
                assert.ok(!/(^|[^\w.])cx\(\{/.test(code), `${file}: every data literal is branded`)
            }
            // every part-map member names a part of its sheet
            const ast = parseSync(result.code, { filename: file, babelrc: false, configFile: false, parserOpts: { plugins: parserPlugins(file) } })!
            const scopes = new Map<string, string>()
            for (const s of ast.program.body) {
                if (s.type !== "ImportDeclaration" || !maps.has(s.source.value)) continue
                const group = maps.get(s.source.value) as string
                for (const spec of s.specifiers) {
                    if (spec.type !== "ImportSpecifier") continue
                    const name = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value
                    const scope = [...partsOf(group).keys()].find((sc) => exportName(sc) === name)
                    assert.ok(scope, `${file}: ${name} is a part map of ${s.source.value}`)
                    scopes.set(spec.local.name, scope)
                }
            }
            traverse(ast, {
                MemberExpression(p) {
                    const n = p.node
                    if (n.object.type !== "Identifier" || !scopes.has(n.object.name)) return
                    const part = !n.computed && n.property.type === "Identifier" ? n.property.name : t.isStringLiteral(n.property) ? n.property.value : null
                    const scope = scopes.get(n.object.name) as string
                    assert.ok(part && Object.prototype.hasOwnProperty.call(registry.scopes[scope].parts, part), `${file}: ${n.object.name}.${part} is a part of ${scope}`)
                    members++
                },
            })
        }
        assert.ok(members > 400, `read ${members} part-map members`)
    })
})
