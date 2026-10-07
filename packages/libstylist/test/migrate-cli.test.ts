// `libstylist migrate-selectors` end to end: inputs (files, directories, globs), the default map
// resolution, dry run / --write / --check / --strict / --json, usage errors — and a pass over the
// design system's real migration map (the checkout LIBSTYLIST_DESIGN_SYSTEM names — ./design-system.ts;
// skipped without it, or while its css package is not built).
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { globToRegExp, indexMap, loadMigrationMap, migrateCode, runMigrateSelectorsCli, type MigrateResult } from "../src/migrate/index.js"
import { specificity } from "../src/postcss/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_MAP = join(HERE, "fixtures", "migrate", "map.json")
const CLI = join(HERE, "..", "src", "cli", "index.ts")
/** The design system's real migration map, written by its css build. */
const realMap = () => designSystemPath("packages", "css", "dist", "migration-map.json")
const skipRealMap = skipWithoutDesignSystem || (!existsSync(realMap()) && "packages/css is not built in the design-system checkout")

const CSS = ".ls-alert .ls-alert__icon { color: red }\n.ls-icon.small { a: b }\n"
const TS = 'document.querySelector(".ls-button")\nconst a = <div className="ls-button__content" />\n'

/** A consumer project with the map installed the way the design system publishes it. */
function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "libstylist-migrate-"))
    const pkg = join(dir, "node_modules", "@livesession", "eloquentui-css")
    mkdirSync(join(pkg, "dist"), { recursive: true })
    copyFileSync(FIXTURE_MAP, join(pkg, "dist", "migration-map.json"))
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@livesession/eloquentui-css", exports: { "./migration/ls-to-elo.json": "./dist/migration-map.json" } }))
    writeFileSync(join(pkg, "dist", "legacy.css"), ".ls-alert { a: b }\n")
    mkdirSync(join(dir, "src", "nested"), { recursive: true })
    writeFileSync(join(dir, "src", "app.css"), CSS)
    writeFileSync(join(dir, "src", "nested", "view.tsx"), TS)
    writeFileSync(join(dir, "src", "notes.md"), "# .ls-alert\n")
    mkdirSync(join(dir, "src", "dist"))
    writeFileSync(join(dir, "src", "dist", "built.css"), ".ls-alert { a: b }\n")
    return dir
}

async function cli(args: string[], cwd: string) {
    const out: string[] = []
    const err: string[] = []
    const code = await runMigrateSelectorsCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, cwd)
    return { code, out: out.join("\n"), err: err.join("\n") }
}

test("dry run: exit 0, nothing written, per-file rewrites, the TODO list and a summary", async () => {
    const dir = project()
    try {
        const r = await cli(["src"], dir)
        assert.equal(r.code, 0, r.err)
        assert.equal(readFileSync(join(dir, "src", "app.css"), "utf8"), CSS)
        assert.match(r.out, /map node_modules\/@livesession\/eloquentui-css\/dist\/migration-map\.json \(prefix elo, v1\) · 2 files · dry-run/)
        assert.match(r.out, /src\/app\.css {2}would rewrite 2 selectors · 1 TODO/)
        assert.match(r.out, /1:1 {5}\.ls-alert \.ls-alert__icon\n {10}→ \[_cxclass_elo-aaaaaa\] \[_cxclass_elo-bbbbbb\]/)
        assert.match(r.out, /TODO — needs a decision \(2\)\n {2}src\/app\.css:2:9 {2}\.small {2}→ {2}:is\(elo-icon,\[elo-icon\]\)\[data-size="small"\]/)
        assert.match(r.out, /src\/nested\/view\.tsx:2:27 {2}ls-button__content {2}→ {2}\[_cxclass_elo-dddddd\]/)
        assert.match(r.out, /2 files · 2 would change \(3 rewrites\) · 2 TODOs · 0 unknown · 0 errors — pass --write to apply/)
        assert.doesNotMatch(r.out, /legacy\.css|built\.css/, "node_modules and build output are never walked")
        assert.match((await cli(["src/dist/*.css"], dir)).out, /src\/dist\/built\.css {2}would rewrite 1 selector/, "unless a pattern names them")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("--check fails while anything would change; --write applies; then --check passes and --strict still fails on TODOs", async () => {
    const dir = project()
    try {
        assert.equal((await cli(["--check", "src"], dir)).code, 1)
        const w = await cli(["--write", "src"], dir)
        assert.equal(w.code, 0, w.err)
        assert.match(w.out, /src\/app\.css {2}rewrote 2 selectors/)
        assert.equal(readFileSync(join(dir, "src", "app.css"), "utf8"), "[_cxclass_elo-aaaaaa] [_cxclass_elo-bbbbbb] { color: red }\n[_cxclass_elo-eeeeee].small { a: b }\n")
        assert.equal(readFileSync(join(dir, "src", "nested", "view.tsx"), "utf8"), 'document.querySelector("[_cxclass_elo-cccccc]")\nconst a = <div className="ls-button__content" />\n')
        const again = await cli(["--check", "src"], dir)
        assert.equal(again.code, 0, again.out)
        assert.match(again.out, /0 would change \(0 rewrites\) · 2 TODOs/)
        assert.equal((await cli(["--strict", "src"], dir)).code, 1)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("--json: the machine report", async () => {
    const dir = project()
    try {
        const r = await cli(["--json", "--map", FIXTURE_MAP, "src/**/*.css"], dir)
        assert.equal(r.code, 0)
        const json = JSON.parse(r.out) as MigrateResult
        assert.equal(json.mode, "dry-run")
        assert.deepEqual(json.options, { roots: "part", literals: "anchored" })
        assert.deepEqual(json.summary, { files: 1, changed: 1, rewrites: 2, todos: 1, unknown: 0, errors: 0 })
        assert.equal(json.files[0].file, "src/app.css")
        assert.deepEqual(json.files[0].entries[0], { kind: "rewrite", line: 1, column: 1, old: ".ls-alert .ls-alert__icon", new: "[_cxclass_elo-aaaaaa] [_cxclass_elo-bbbbbb]" })
        assert.deepEqual(
            { ...json.files[0].entries[2], message: undefined },
            { kind: "todo", line: 2, column: 9, reason: "literal", old: ".small", new: ':is(elo-icon,[elo-icon])[data-size="small"]', message: undefined },
        )
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("inputs: globs, directories, explicit files, --ignore; unsupported and unparseable files are errors", async () => {
    const dir = project()
    try {
        writeFileSync(join(dir, "src", "broken.ts"), 'const = ".ls-alert";\n')
        const r = await cli(["--json", "src/**/*.{css,tsx}", "src/notes.md", "src/broken.ts", "--ignore", "src/nested/**", "missing/*.css"], dir)
        const json = JSON.parse(r.out) as MigrateResult
        assert.deepEqual(
            json.files.map((f) => f.file),
            ["src/app.css", "src/broken.ts", "src/notes.md"],
        )
        assert.deepEqual(json.unmatched, ["missing/*.css"])
        assert.match(json.files[1].entries[0].message!, /could not parse/)
        assert.equal(json.files[1].entries[0].line, 1)
        assert.match(json.files[2].entries[0].message!, /not a stylesheet or script/)
        assert.equal(r.code, 0, "a dry run exits 0")
        assert.equal((await cli(["--check", "src/broken.ts"], dir)).code, 1, "--check can't vouch for a file it could not read")
        assert.equal(globToRegExp("src/**/*.{css,tsx}").test("src/a/b/c.tsx"), true)
        assert.equal(globToRegExp("src/**/*.{css,tsx}").test("src/c.css"), true)
        assert.equal(globToRegExp("src/*.css").test("src/a/c.css"), false)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a file that names nothing the map knows is not parsed: a LESS file of mixins is no error without postcss-less", async () => {
    const dir = project()
    try {
        writeFileSync(join(dir, "src", "mixins.less"), ".x { .Transition(all 0.2s); color: @c; }\n")
        writeFileSync(join(dir, "src", "old.ts"), "const = ;\n")
        const r = await cli(["--check", "src/mixins.less", "src/old.ts"], dir)
        assert.equal(r.code, 0, r.out)
        assert.match(r.out, /2 files · 0 would change \(0 rewrites\) · 0 TODOs · 0 unknown · 0 errors/)
        writeFileSync(join(dir, "src", "mixins.less"), ".ls-alert { .Transition(all 0.2s); }\n")
        assert.equal((await cli(["--check", "src/mixins.less"], dir)).code, 1, "with a legacy class in it, the file must be read")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a legacy class the app puts on its own element (in another file) is never rewritten in its selectors", async () => {
    const dir = project()
    try {
        writeFileSync(join(dir, "src", "own.tsx"), 'export const Own = () => <nav className="ls-alert own" data-component="Tabs" />\n')
        writeFileSync(join(dir, "src", "own.css"), ".ls-alert > a { a: b }\n[data-component=\"Tabs\"] { a: b }\n.ls-button { a: b }\n")
        const r = await cli(["--json", "src/own.tsx", "src/own.css"], dir)
        const json = JSON.parse(r.out) as MigrateResult
        const css = json.files.find((f) => f.file === "src/own.css")!
        assert.deepEqual(
            css.entries.map((e) => `${e.kind} ${e.reason ?? ""} ${e.old}${e.new ? ` → ${e.new}` : ""}`),
            ["todo app-hook .ls-alert → [_cxclass_elo-aaaaaa]", 'todo app-hook [data-component="Tabs"] → :is(elo-tabs,[elo-tabs])', "rewrite  .ls-button → [_cxclass_elo-cccccc]"],
        )
        assert.match(css.entries[0].message!, /the app puts the class ls-alert on its own element too \(src\/own\.tsx:1\)/)
        assert.match(css.entries[1].message!, /data-component="Tabs" on its own element too \(src\/own\.tsx:1\)/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("usage errors exit 2 with a message", async () => {
    const dir = project()
    try {
        for (const [args, message] of [
            [[], /pass the files/],
            [["--roots", "tag", "src"], /--roots is part or identity/],
            [["--literals", "some", "src"], /--literals is anchored, all or off/],
            [["--write", "--check", "src"], /exclude each other/],
            [["--frobnicate", "src"], /unknown option --frobnicate/],
            [["--map"], /--map needs a value/],
            [["--map", "nope.json", "src"], /--map nope\.json: no such file/],
            [["nothing-here"], /no file matched/],
        ] as const) {
            const r = await cli([...args], dir)
            assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}`)
            assert.match(r.err, message)
        }
        const bare = mkdtempSync(join(tmpdir(), "libstylist-migrate-nomap-"))
        writeFileSync(join(bare, "a.css"), ".ls-alert {}")
        const r = await cli(["a.css"], bare)
        assert.equal(r.code, 2)
        assert.match(r.err, /no --map given and @livesession\/eloquentui-css\/migration\/ls-to-elo\.json is not installed here/)
        rmSync(bare, { recursive: true, force: true })
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("the libstylist bin dispatches migrate-selectors", () => {
    const dir = project()
    try {
        // spawned from the package (tsx resolves from the working directory), so the map is passed
        const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "migrate-selectors", "--check", "--map", FIXTURE_MAP, join(dir, "src", "app.css")], { encoding: "utf8" })
        assert.equal(r.status, 1, r.stderr)
        assert.match(r.stdout, /would rewrite 2 selectors/)
        const help = spawnSync(process.execPath, ["--import", "tsx", CLI], { encoding: "utf8" })
        assert.match(help.stderr, /migrate-selectors \[--map <file>\]/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("the design system's real map: every class, data-component value and keyframes name migrates, idempotently", { skip: skipRealMap }, async () => {
    const map = loadMigrationMap(realMap())
    const index = indexMap(map)
    const classes = Object.entries(map.classes)
    const css = [
        ...classes.map(([cls]) => `.${cls} .mine { a: b }`),
        ...Object.keys(map.dataComponent ?? {}).map((v) => `[data-component="${v}"] { a: b }`),
        ...Object.keys(map.keyframes ?? {}).map((k) => `.k { animation: ${k} 1s }`),
    ].join("\n")
    const once = await migrateCode(css, "real.css", index)
    const lines = once.output.split("\n")
    classes.forEach(([cls, entry], i) => {
        if (entry.kind === "removed") {
            assert.equal(lines[i], `.${cls} .mine { a: b }`, cls)
            assert.ok(once.entries.some((e) => e.kind === "todo" && e.old === `.${cls}`), `${cls} is a TODO`)
            return
        }
        assert.equal(lines[i], `${entry.selector} .mine { a: b }`, cls)
        assert.match(entry.selector!, /^\[_cxclass_elo-[a-z0-9]+\]$/)
        assert.deepEqual(specificity(`${entry.selector} .mine`), specificity(`.${cls} .mine`), `${cls}: same specificity`)
    })
    assert.doesNotMatch(once.output, /data-component|ls-[a-z-]+ 1s/)
    assert.equal(once.entries.filter((e) => e.kind === "unknown").length, 0)
    const twice = await migrateCode(once.output, "real.css", index)
    assert.equal(twice.output, once.output)
    assert.equal(twice.entries.filter((e) => e.kind === "rewrite").length, 0)
})

// D6: BASE Dropdown rendered <span data-role="label">; the map knows the hook is gone, so an anchored
// selector rewrites to the label part and a read of the attribute is a TODO — never a silent keep
test("the design system's real map: the dropped data-role hook rewrites to its part", { skip: skipRealMap }, async () => {
    const map = loadMigrationMap(realMap())
    const index = indexMap(map)
    const label = map.dataPart?.['[data-role="label"]']?.find((e) => e.scope === "dropdown")?.selector
    assert.match(label ?? "", /^\[_cxclass_elo-[a-z0-9]+\]$/, 'the map has a successor for [data-role="label"]')
    const css = await migrateCode('.ls-dropdown__item span[data-role="label"] { font-weight: 600 }\n.ls-dropdown [data-role="label"] { a: b }\n.my-menu [data-role="label"] { a: b }\n', "role.css", index)
    const lines = css.output.split("\n")
    assert.ok(lines[0].endsWith(`${label} { font-weight: 600 }`) && !lines[0].includes("data-role"), lines[0])
    assert.ok(lines[1].endsWith(`${label} { a: b }`) && !lines[1].includes("data-role"), lines[1])
    assert.equal(lines[2], '.my-menu [data-role="label"] { a: b }', "an unanchored use is the app's own")
    const js = await migrateCode('el.getAttribute("data-role")\n', "role.ts", index)
    assert.ok(js.entries.some((e) => e.kind === "todo"), "reading the attribute is a TODO")
})
