// `libstylist check` and `libstylist burndown` through the CLI (exit codes, text/JSON/markdown
// output, --expect-zero), the burndown report, and the built-registry drift warning (S309).
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

import { burndownReport, formatBurndown, resolveCheckConfig, runBurndown, runCheck, type RawCheckConfig } from "../src/check/index.js"
import { loadSheets } from "../src/check/sheets.js"
import { run } from "../src/cli/index.js"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "check")
const config = (name: string) => join(FIXTURES, name, "libstylist.config.mjs")

/** Runs the CLI and captures its output. */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = []
    const err: string[] = []
    const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l) })
    return { code, out: out.join("\n"), err: err.join("\n") }
}

test("cli: the usage lists check and burndown", async () => {
    const { code, err } = await cli()
    assert.equal(code, 0)
    assert.match(err, /check \[options\]/)
    assert.match(err, /burndown \[options\]/)
})

test("check: exit 0 with no errors, 1 on errors (pending work never fails), 2 on bad usage or config", async () => {
    const zero = await cli("check", "--config", config("zero"))
    assert.equal(zero.code, 0, zero.out)
    assert.match(zero.out, /^libstylist check: 0 errors, 0 warnings — 1\/1 components migrated/m)

    const ratchet = await cli("check", "--config", config("ratchet"))
    assert.equal(ratchet.code, 1)
    assert.match(ratchet.out, /packages\/ui\/src\/Older\.tsx:\d+ {2}T201 {2}<elo-older> is the tag of both/)
    assert.match(ratchet.out, /4 errors, 0 warnings — 3\/6 components migrated \(3 pending with 4 findings: libstylist burndown\), 1\/2 sheets flipped/)
    assert.ok(!ratchet.out.includes("core/Old]"), "pending findings are not listed without --pending")

    const pending = await cli("check", "--pending", `--config=${config("ratchet")}`)
    assert.equal(pending.code, 1)
    assert.match(pending.out, /pending \(not migrated yet — not errors\):\n( {2}.*\n)* {2}packages\/ui\/src\/Old\.tsx:\d+ {2}R101 {2}Old's root is a generic <div>/)

    const forwarding = await cli("check", "--config", config("forwarding"))
    assert.equal(forwarding.code, 1)

    assert.equal((await cli("check", "--nope")).code, 2)
    assert.equal((await cli("check", "--config")).code, 2)
    const missing = await cli("check", "--config", join(FIXTURES, "nope", "libstylist.config.mjs"))
    assert.equal(missing.code, 2)
    assert.match(missing.err, /config not found/)
})

test("check --json: findings, pending, stats, component and sheet status, member roots and migration helpers", async () => {
    const { code, out } = await cli("check", "--json", "--config", config("ratchet"))
    assert.equal(code, 1)
    const json = JSON.parse(out)
    assert.deepEqual(Object.keys(json).sort(), ["components", "findings", "legacy", "memberRoots", "pending", "sheets", "stats"])
    assert.deepEqual(json.findings.map((f: { rule: string }) => f.rule).sort(), ["S306", "S306", "S308", "T201"])
    assert.equal(json.pending.length, 4)
    assert.equal(json.stats.migrated, 3)
    assert.deepEqual(json.legacy.calls, { legacy: 1, legacyClassName: 1 })
    assert.deepEqual(
        json.components.filter((c: { migrated: boolean }) => !c.migrated).map((c: { id: string }) => c.id),
        ["core/Old", "core/Older", "core/Older.Root"],
    )
    const members = JSON.parse((await cli("check", "--json", "--config", config("member-roots"))).out).memberRoots
    assert.ok(members.some((m: { tag: string; owner: string }) => m.tag === "elo-pop-content" && m.owner === "core/Pop"))
})

test("burndown: text and markdown reports; --expect-zero fails while anything is pending, passes when the migration is done", async () => {
    const text = await cli("burndown", "--config", config("ratchet"))
    assert.equal(text.code, 0, "without --expect-zero burndown only reports")
    assert.match(text.out, /^libstylist burndown: 3\/6 components migrated \(50%\), 1\/2 sheets flipped, 4 pending findings/)
    assert.match(text.out, /R101 generic root +3/)
    assert.match(text.out, /migration helpers: legacy\(\) 1, legacyClassName\(\) 1, @deprecated class props 2/)
    assert.match(text.out, /status: not zero: 3 components not migrated, 1 sheet not flipped to libstylist, 4 pending findings, 1 legacy\(\) call, 1 legacyClassName\(\) call, 2 @deprecated class props, 4 check errors/)

    const markdown = await cli("burndown", "--format", "markdown", "--config", config("ratchet"))
    assert.equal(markdown.code, 0)
    assert.match(markdown.out, /^## libstylist burndown\n/)
    assert.match(markdown.out, /\| `@fx\/ui` \| 3\/6 \| 1\/2 \| 4 \|/)
    assert.match(markdown.out, /`core\/Old`, `core\/Older`, `core\/Older\.Root`/)

    const failing = await cli("burndown", "--expect-zero", "--config", config("ratchet"))
    assert.equal(failing.code, 1)
    assert.match(failing.err, /--expect-zero: 3 components not migrated/)
    // nothing pending, no helper left, no errors: the final-flip switch passes
    const done = await cli("burndown", "--expect-zero", "--config", config("zero"))
    assert.equal(done.code, 0, done.err)
    assert.match(done.out, /status: zero — the migration is complete/)

    const json = JSON.parse((await cli("burndown", "--json", "--config", config("zero"))).out)
    assert.deepEqual([json.zero, json.blockers, json.components], [true, [], { total: 1, migrated: 1, pending: 0 }])

    assert.equal((await cli("burndown", "--format", "html", "--config", config("zero"))).code, 2)
    assert.equal((await cli("burndown", "--nope")).code, 2)
})

test("runBurndown / burndownReport: per-package counts, pending sheets and blockers from one check result", async () => {
    const { report, result } = await runBurndown({ config: config("ratchet") })
    assert.deepEqual(report.packages, [
        { namespace: "core", name: "@fx/ui", components: 6, migrated: 3, pending: ["core/Old", "core/Older", "core/Older.Root"], pendingFindings: 4, sheets: 2, flippedSheets: 1 },
    ])
    assert.deepEqual(report.sheets, { total: 2, flipped: 1, pending: ["packages/css/src/ui/old.css"] })
    assert.deepEqual(report.hostParts.map((h) => h.part), ["done:engine", "done:inner", "old:nope"])
    assert.equal(report.zero, false)
    // the report can be rebuilt from the same result without re-running the checker
    assert.deepEqual(burndownReport(result), report)
    assert.equal(formatBurndown(report), formatBurndown((await runBurndown({ result })).report))
    // unbound sheets never count as pending
    const zero = (await runBurndown({ config: config("zero") })).report
    assert.deepEqual(zero.sheets, { total: 1, flipped: 1, pending: [] })
})

const tmp = mkdtempSync(join(tmpdir(), "libstylist-check-"))
after(() => rmSync(tmp, { recursive: true, force: true }))

test("S309: the built registry is compared with the sheets — missing, current and stale", async () => {
    const root = join(FIXTURES, "zero")
    const raw = (registry: string): RawCheckConfig => ({
        prefix: "elo",
        packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
        css: { dir: "packages/css/src", registry, unboundSheets: ["ui/swatch.css"] },
    })
    const s309 = async (registry: string) => {
        const r = await runCheck({ config: raw(registry), root })
        assert.equal(r.stats.errors, 0, "drift is a warning, never an error")
        return r.findings.filter((f) => f.rule === "S309").map((f) => `${f.key}: ${f.message}`)
    }

    const missing = await s309(join(tmp, "missing.json"))
    assert.equal(missing.length, 1)
    assert.match(missing[0], /^missing: .*missing\.json does not exist/)

    // what the css build publishes: every sheet's scope, flipped or not (the unflipped, unbound
    // swatch.css included — a registry without it is stale, one with it is current)
    const sheets = loadSheets(await resolveCheckConfig({ config: raw(join(tmp, "x.json")), root }))
    assert.ok(!sheets.flippedScopes.has("swatch") && Object.hasOwn(sheets.registry.scopes, "swatch"), "the fixture has an unflipped sheet")
    const published = sheets.registry
    const current = join(tmp, "current.json")
    writeFileSync(current, JSON.stringify(published))
    assert.deepEqual(await s309(current), [])
    const flippedOnly = join(tmp, "flipped-only.json")
    writeFileSync(flippedOnly, JSON.stringify({ ...published, scopes: Object.fromEntries(Object.entries(published.scopes).filter(([s]) => sheets.flippedScopes.has(s))) }))
    assert.deepEqual(await s309(flippedOnly), ["swatch: sheet swatch is missing from the built registry — rebuild the css package"])

    const stale = join(tmp, "stale.json")
    const badge = published.scopes.badge
    writeFileSync(stale, JSON.stringify({ ...published, scopes: { ...published.scopes, badge: { ...badge, parts: { ...badge.parts, gone: "_cxclass_elo-000000" } }, removed: badge } }))
    assert.deepEqual(
        (await s309(stale)).map((l) => l.split(":")[0]),
        ["badge", "removed"],
    )
    writeFileSync(join(tmp, "broken.json"), "{")
    assert.match((await s309(join(tmp, "broken.json")))[0], /^unreadable: /)
})
