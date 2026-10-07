// Directory namespaces (SPEC §8): `package.json` `libstylist.namespaces` maps package-relative
// directories to namespaces; a file resolves to the longest directory containing it, else to the
// package's own namespace. The package lookup is cached per directory, never a file's namespace.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, beforeEach, test } from "node:test"

import {
    clearConventionsCache,
    declaresLibstylist,
    findLibstylistPackage,
    namespaceDirOf,
    normalizeNamespaceDir,
    normalizeNamespaces,
    normalizePackageConfig,
    resolvePackageConfig,
} from "../src/conventions/index.js"
import { resolveFileConfig } from "../src/babel/options.js"
import { tagName } from "../src/naming/index.js"
import { packageGroups, packageSheetGroups, sheetGroupName } from "../src/workspace/index.js"

const root = mkdtempSync(join(tmpdir(), "libstylist-namespaces-"))
after(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => clearConventionsCache())

const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
}
const pkg = (dir: string, libstylist: object) => write(`${dir}/package.json`, JSON.stringify({ name: dir, libstylist }))

pkg("accounts", { prefix: "crm", namespace: "core", namespaces: { "src/render": "render", "src/css/render/": "render", "src/render/legacy": { namespace: "legacy", segment: "old", word: "Old" } } })
const at = (rel: string) => join(root, "accounts", rel)

test("a file resolves to the longest namespaces directory containing it, else to the package's namespace", () => {
    const render = resolvePackageConfig(at("src/render/InvitationRow.tsx"))
    assert.deepEqual(render && { ...render.config, subdir: render.subdir, base: render.base.namespace }, {
        prefix: "crm",
        namespace: "render",
        segment: "render",
        word: "Render",
        hashLength: 6,
        subdir: "src/render",
        base: "core",
    })
    assert.equal(tagName(render!.config, ["RenderInvitationRow"]), "crm-render-invitationrow")
    // the longest directory wins over its parent
    const legacy = resolvePackageConfig(at("src/render/legacy/deep/Row.tsx"))
    assert.deepEqual([legacy?.config.namespace, legacy?.config.segment, legacy?.config.word, legacy?.subdir], ["legacy", "old", "Old", "src/render/legacy"])
    // a trailing slash in the key is normalized; sheets resolve like sources
    assert.equal(resolvePackageConfig(at("src/css/render/row.css"))?.config.namespace, "render")
    assert.equal(resolvePackageConfig(at("src/css/accounts.css"))?.config.namespace, "core")
    // the package.json itself, and the package root, are in the base namespace
    const base = resolvePackageConfig(at("package.json"))
    assert.deepEqual([base?.config.namespace, base?.subdir, base?.dir], ["core", null, join(root, "accounts")])
})

test("the transform's per-file config is the effective one", () => {
    const render = resolveFileConfig({}, at("src/render/Row.tsx"))
    assert.deepEqual([render?.prefix, render?.namespace, render?.segment, render?.word], ["crm", "render", "render", "Render"])
    assert.equal(resolveFileConfig({}, at("src/components/Row.tsx"))?.namespace, "core")
    // an explicit namespace option still wins, with naming derived for it
    assert.equal(resolveFileConfig({ namespace: "core" }, at("src/render/Row.tsx"))?.segment, "")
})

test("directories match on segment boundaries: src/renderer is not src/render, nor is src/render.tsx", () => {
    assert.equal(resolvePackageConfig(at("src/renderer/Row.tsx"))?.config.namespace, "core")
    assert.equal(resolvePackageConfig(at("src/render.tsx"))?.config.namespace, "core")
    assert.equal(resolvePackageConfig(at("src/render/Row.tsx"))?.config.namespace, "render")
    const list = normalizeNamespaces({ "src/render": "render" }, normalizePackageConfig({ prefix: "crm", namespace: "core" }))
    assert.equal(namespaceDirOf(list, "src/render"), list[0])
    assert.equal(namespaceDirOf(list, "src/renderx/a.ts"), null)
})

test("the package lookup is cached per directory, never a file's namespace: siblings in either order", () => {
    // render first, then a sibling directory of the base namespace
    assert.equal(resolvePackageConfig(at("src/render/A.tsx"))?.config.namespace, "render")
    assert.equal(resolvePackageConfig(at("src/components/B.tsx"))?.config.namespace, "core")
    assert.equal(resolvePackageConfig(at("src/C.tsx"))?.config.namespace, "core")
    clearConventionsCache()
    // the other way round: a cached `src` must not leak `core` into src/render
    assert.equal(resolvePackageConfig(at("src/C.tsx"))?.config.namespace, "core")
    assert.equal(resolvePackageConfig(at("src/render/A.tsx"))?.config.namespace, "render")
    // one package object serves every file of the package
    assert.equal(findLibstylistPackage(at("src/render/A.tsx")), findLibstylistPackage(at("src/components/B.tsx")))
})

test("clearConventionsCache re-reads an edited package.json", () => {
    pkg("edited", { prefix: "crm", namespace: "core" })
    const file = join(root, "edited", "src", "render", "Row.tsx")
    assert.equal(resolvePackageConfig(file)?.config.namespace, "core")
    pkg("edited", { prefix: "crm", namespace: "core", namespaces: { "src/render": "render" } })
    assert.equal(resolvePackageConfig(file)?.config.namespace, "core", "cached until cleared")
    clearConventionsCache()
    assert.equal(resolvePackageConfig(file)?.config.namespace, "render")
})

test("namespaces: keys are package-relative posix directories", () => {
    const bad = (key: string) => {
        try {
            normalizeNamespaceDir(key)
            return "ok"
        } catch (err) {
            return (err as Error).message
        }
    }
    assert.equal(normalizeNamespaceDir("src/render/"), "src/render")
    assert.match(bad("../shared"), /"\.\.\/shared" leaves the package/)
    assert.match(bad("src/../render"), /leaves the package/)
    assert.match(bad("/abs/render"), /is absolute/)
    assert.match(bad("C:/render"), /is absolute/)
    assert.match(bad("src\\render"), /has a backslash/)
    assert.match(bad("src/*/render"), /is a glob/)
    assert.match(bad("src/{a,b}"), /is a glob/)
    assert.match(bad("./src"), /empty or `\.` segment/)
    assert.match(bad("src//render"), /empty or `\.` segment/)
    assert.match(bad("/"), /is absolute|names no directory/)
    assert.match(bad(""), /names no directory/)
})

test("namespaces: values, duplicates and one naming per namespace", () => {
    const base = normalizePackageConfig({ prefix: "crm", namespace: "core" })
    const problem = (raw: unknown) => {
        try {
            normalizeNamespaces(raw, base, "pkg")
            return "ok"
        } catch (err) {
            return (err as Error).message
        }
    }
    assert.equal(problem({ "src/render": "render", "src/css/render": { namespace: "render" } }), "ok")
    // longest first
    assert.deepEqual(
        normalizeNamespaces({ "src/a": "a", "src/a/b/c": "c", "src/a/b": "b" }, base).map((d) => d.dir),
        ["src/a/b/c", "src/a/b", "src/a"],
    )
    assert.match(problem(["src/render"]), /pkg\.namespaces must be an object/)
    assert.match(problem({ "src/render": 1 }), /must be a namespace or \{ namespace, segment\?, word\? \}/)
    assert.match(problem({ "src/render": { namespace: "render", color: "red" } }), /unknown key "color"/)
    assert.match(problem({ "src/render": { namespace: "render", word: 1 } }), /\.word must be a string/)
    assert.match(problem({ "src/render": "Render" }), /"namespace" must match/)
    assert.match(problem({ "src/render": { segment: "render" } }), /"namespace" must match/)
    assert.match(problem({ "src/render": "render", "src/render/": "render" }), /the directory "src\/render" is listed twice/)
    // two directories of one namespace name its tags one way
    assert.match(problem({ "src/render": "render", "src/css/render": { namespace: "render", word: "Rendered" } }), /names namespace "render" with segment "render" and word "Rendered", but namespaces\["src\/render"\] uses segment "render" and word "Render"/)
    // the base namespace can't be renamed by a directory — repeating it as is is fine
    assert.equal(problem({ "src/legacy": "core" }), "ok")
    assert.match(problem({ "src/legacy": { namespace: "core", segment: "legacy" } }), /the base namespace "core" uses segment "" and word ""/)
    assert.deepEqual(normalizeNamespaces(undefined, base), [])
})

test("a malformed namespaces field fails resolution with the package.json path", () => {
    pkg("broken", { prefix: "crm", namespace: "core", namespaces: { "../up": "render" } })
    assert.throws(() => resolvePackageConfig(join(root, "broken", "src", "A.tsx")), /broken[\\/]package\.json\.namespaces: "\.\.\/up" leaves the package/)
})

test("declaresLibstylist: the nearest package.json declares a libstylist prefix", () => {
    pkg("vendor/ds", { prefix: "elo", namespace: "core" })
    write("vendor/ds/dist/index.d.ts", "export {}\n")
    write("vendor/grid/package.json", JSON.stringify({ name: "grid" }))
    write("vendor/grid/index.d.ts", "export {}\n")
    assert.equal(declaresLibstylist(join(root, "vendor/ds/dist/index.d.ts")), true)
    assert.equal(declaresLibstylist(join(root, "vendor/grid/index.d.ts")), false)
    // the nearest package.json decides, even when a parent declares libstylist
    pkg("vendor/ds/nested", {})
    assert.equal(declaresLibstylist(join(root, "vendor/ds/nested/x.d.ts")), false)
})

test("workspace groups: one css group per (package, namespace), named after the package directory", () => {
    write("accounts/src/css/accounts.css", ".root {}")
    write("accounts/src/css/render/row.css", ".root {}")
    write("accounts/src/css/render/deep/cell.css", ".root {}")
    write("accounts/src/css/node_modules/skip.css", ".root {}")
    write("accounts/src/css/.hidden/skip.css", ".root {}")
    const found = findLibstylistPackage(at("src/x.ts"))!
    const grouped = { dir: found.dir, naming: found.base, namespaces: found.namespaces, sheets: [at("src/css")] }
    assert.deepEqual(
        packageGroups(grouped).map((g) => `${g.name} ${g.naming.namespace}`),
        ["accounts core", "accounts.legacy legacy", "accounts.render render"],
    )
    assert.deepEqual(
        packageSheetGroups(grouped).map((g) => [g.name, g.files.map((f) => f.slice(at("").length + 1))]),
        [
            ["accounts", ["src/css/accounts.css"]],
            ["accounts.legacy", []],
            ["accounts.render", ["src/css/render/deep/cell.css", "src/css/render/row.css"]],
        ],
    )
    assert.equal(sheetGroupName("/w/packages/crm-accounts", "render", "core"), "crm-accounts.render")
    assert.equal(sheetGroupName("/w/packages/crm-accounts", "core", "core"), "crm-accounts")
})
