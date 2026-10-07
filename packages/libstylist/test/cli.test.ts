import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "index.ts")

const runCli = (entry: string, args: string[]) => spawnSync(process.execPath, ["--import", "tsx", entry, ...args], { encoding: "utf8" })

// SPEC §3.1 test vector
const HASH_ARGS = ["hash", "elo", "core", "alert", "icon"]
const HASH_OUT = "_cxclass_elo-or4d4l"

test("cli: runs when invoked by its own path", () => {
    const result = runCli(CLI, HASH_ARGS)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), HASH_OUT)
})

// pnpm's node_modules/.bin shims run the CLI through the workspace symlink
// (node_modules/@livesession/libstylist → packages/libstylist); the entry check once compared
// that symlinked argv[1] with the resolved import.meta.url, so every command silently did nothing.
test("cli: runs when invoked through a symlink, and a failing command still fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "libstylist-cli-"))
    try {
        const link = join(dir, "libstylist.ts")
        symlinkSync(CLI, link)
        const result = runCli(link, HASH_ARGS)
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout.trim(), HASH_OUT)
        const failing = runCli(link, ["gen-types", "--check", join(dir, "missing-package")])
        assert.notEqual(failing.status, 0, "gen-types --check on a missing package must not exit 0")
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

// T12: the usage names every option the codemod accepts
test("cli: the usage lists the codemod's --config and --no-types", () => {
    const result = runCli(CLI, [])
    assert.match(`${result.stdout}${result.stderr}`, /codemod \[--write\] \[--config <file>\] \[--no-types\] <file\.tsx\.\.\.>/)
})

// T3: the top-level usage lists every option the subcommands parse
test("cli: the top-level usage lists every migrate-selectors option and hash --length", async () => {
    const { USAGE: MIGRATE_USAGE } = await import("../src/migrate/index.js")
    const result = runCli(CLI, [])
    assert.equal(result.status, 0)
    const usage = result.stderr
    const flags = [...new Set(MIGRATE_USAGE.match(/--[a-z]+/g))]
    assert.ok(flags.length >= 7, flags.join(" "))
    const line = usage.slice(usage.indexOf("migrate-selectors"), usage.indexOf("check [options]"))
    for (const flag of flags) assert.ok(line.includes(flag), `migrate-selectors ${flag} is in the top-level usage`)
    assert.match(usage, /hash <prefix> <ns> <scope> <part> \[--length n\]/)
})

// `libstylist build`: a workspace of app packages (the check fixture's), in a scratch copy — the build
// rewrites its hand-written part maps
const WORKSPACE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "check", "workspace")
const workspaceCopy = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "libstylist-cli-ws-")))
    cpSync(WORKSPACE, dir, { recursive: true })
    return dir
}
// tsx by path: `--import tsx` resolves from the working directory, a scratch copy without node_modules
const TSX = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "tsx", "dist", "loader.mjs")).href
const runIn = (cwd: string, args: string[]) => spawnSync(process.execPath, ["--import", TSX, CLI, ...args], { encoding: "utf8", cwd })

test("cli: build --check fails on drift and still writes the gitignored registry; build writes; build --check passes", () => {
    const dir = workspaceCopy()
    try {
        const registry = join(dir, "node_modules", ".cache", "libstylist", "stylist-registry.json")
        const drift = runIn(dir, ["build", "--check"])
        assert.equal(drift.status, 1, drift.stderr)
        assert.match(drift.stdout, /^stale {3}packages\/accounts\/src\/css\/index\.ts — run `libstylist build`$/m)
        assert.match(drift.stdout, /^stale {3}stylist\.lock\.json/m)
        assert.match(drift.stdout, /^wrote {3}node_modules\/\.cache\/libstylist\/stylist-registry\.json$/m)
        assert.match(drift.stderr, /libstylist build --check: 3 files out of date — run `libstylist build` and commit the result/)
        assert.ok(existsSync(registry) && !existsSync(join(dir, "stylist.lock.json")))

        const built = runIn(join(dir, "packages", "partners"), ["build"])
        assert.equal(built.status, 0, built.stderr)
        assert.match(built.stdout, /^wrote {3}packages\/partners\/src\/css\/index\.ts$/m)
        assert.match(built.stdout, /^ok {6}node_modules\/\.cache\/libstylist\/stylist-registry\.json$/m)
        assert.match(built.stdout, /libstylist build: 2 packages, 5 sheets, 6 parts$/m)
        assert.match(readFileSync(join(dir, "packages", "partners", "src", "css", "index.ts"), "utf8"), /^\/\/ generated by libstylist \(`libstylist build`\)/)

        const clean = runIn(dir, ["build", "--check", "--config", "libstylist.config.mjs"])
        assert.equal(clean.status, 0, clean.stderr)
        assert.doesNotMatch(clean.stdout, /stale/)

        // a removed part is drift again, and a broken sheet writes nothing
        writeFileSync(join(dir, "packages", "accounts", "src", "css", "accounts-list.css"), "@stylist root AccountsList;\n\n.root { margin: 0; }\n")
        assert.equal(runIn(dir, ["build", "--check"]).status, 1)
        writeFileSync(join(dir, "packages", "accounts", "src", "css", "accounts-list.css"), "@layer x { .root { margin: 0; } }\n")
        const broken = runIn(dir, ["build"])
        assert.equal(broken.status, 1)
        assert.match(broken.stderr, /^error {3}packages\/accounts\/src\/css\/accounts-list\.css:1:1: @layer — /m)
        assert.match(broken.stderr, /1 error — nothing written/)

        assert.equal(runIn(dir, ["build", "--nope"]).status, 2)
        const combo = runIn(dir, ["build", "--check", "--watch"])
        assert.equal(combo.status, 2)
        assert.match(combo.stderr, /--check and --watch don't combine/)
        const none = runIn(tmpdir(), ["build"])
        assert.equal(none.status, 1)
        assert.match(none.stderr, /libstylist build: no libstylist\.config\.mjs found/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("cli: build --watch rebuilds a package's part map when a sheet changes, until aborted", async () => {
    const { runBuildCli } = await import("../src/workspace/cli.js")
    const dir = workspaceCopy()
    const out: string[] = []
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) }
    const abort = new AbortController()
    try {
        const index = join(dir, "packages", "accounts", "src", "css", "index.ts")
        const done = runBuildCli(["--watch"], io, { cwd: dir, signal: abort.signal })
        for (let i = 0; i < 100 && !out.some((l) => l.includes("watching")); i++) await sleep(20)
        assert.ok(out.some((l) => /watching 2 sheet directories/.test(l)), out.join("\n"))
        // rewritten until seen: a native watcher can take a moment to start reporting
        const sheet = join(dir, "packages", "accounts", "src", "css", "render", "render-accounts-table.css")
        for (let i = 0; i < 50 && !readFileSync(index, "utf8").includes("cell"); i++) {
            if (i % 10 === 0) writeFileSync(sheet, `@stylist root RenderAccountsTable;\n\n.root { width: 100%; }\n.cell { gap: 8px; }\n/* ${i} */\n`)
            await sleep(20)
        }
        assert.match(readFileSync(index, "utf8"), /cell: "_cxclass_crm-/)
        abort.abort()
        assert.equal(await done, 0)
    } finally {
        abort.abort()
        rmSync(dir, { recursive: true, force: true })
    }
})

test("cli: gen-types --config writes every package of the config", () => {
    const dir = workspaceCopy()
    try {
        const result = runIn(dir, ["gen-types", "--config", "libstylist.config.mjs"])
        assert.equal(result.status, 0, result.stderr)
        // partners renders <crm-partnerscard> and <crm-render-partners>; accounts roots on markers only
        const partners = readFileSync(join(dir, "packages", "partners", "types", "stylist-tags.gen.d.ts"), "utf8")
        assert.match(partners, /"crm-partnerscard": StylistHostProps/)
        assert.match(partners, /"crm-render-partners": StylistHostProps/)
        assert.match(readFileSync(join(dir, "packages", "accounts", "types", "stylist-tags.gen.d.ts"), "utf8"), /No `crm-\*` custom tags found/)
        assert.equal(runIn(dir, ["gen-types", "--check", "--config", "libstylist.config.mjs"]).status, 0)
        const usage = runIn(dir, ["gen-types", "--config"])
        assert.equal(usage.status, 2)
        assert.match(usage.stderr, /usage: libstylist gen-types \[--check\] \[--config <file>\] \[<packageDir\.\.\.>\]/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("cli: the top-level usage lists build and gen-types --config", () => {
    const usage = runCli(CLI, []).stderr
    assert.match(usage, /build \[--config <file>\] \[--check\] \[--watch\]/)
    assert.match(usage, /gen-types \[--check\] \[--config <file>\] \[<packageDir\.\.\.>\]/)
})
