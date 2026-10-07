// Smoke run of the stylelint preset over the design system's real source sheets (the checkout
// LIBSTYLIST_DESIGN_SYSTEM names — see ./design-system.ts; skipped without it). It proves the
// rules never crash on real input, report only well-formed, deterministic warnings under the
// preset's own rule names, and prints per-rule counts (the seed for the lint baseline); it does not
// pin those counts, which shrink as sheets migrate.
import assert from "node:assert/strict"
import { join, relative } from "node:path"
import { test } from "node:test"

import stylelint from "stylelint"
import type { Config, LintResult } from "stylelint"

import { preset } from "../src/stylelint/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

const skip = skipWithoutDesignSystem
const cssSrc = () => designSystemPath("packages", "css", "src")

/** Counts warnings per rule across all results. */
function countByRule(results: LintResult[]): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const result of results) for (const w of result.warnings) counts[w.rule] = (counts[w.rule] ?? 0) + 1
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

async function lintSheets(config: Config): Promise<LintResult[]> {
    const { results } = await stylelint.lint({ files: [join(cssSrc(), "**", "*.css")], config })
    return results.sort((a, b) => (a.source ?? "").localeCompare(b.source ?? ""))
}

/** Warnings as comparable strings, per file. */
const fingerprint = (results: LintResult[]): string[] =>
    results.flatMap((r) => r.warnings.map((w) => `${relative(cssSrc(), r.source ?? "")}:${w.line}:${w.column}-${w.endLine}:${w.endColumn} ${w.rule} ${w.text}`))

/** The run is clean of crashes, parse errors and invalid options; every warning is a real, well-placed problem of an enabled rule. */
function assertWellFormed(results: LintResult[], config: Config): void {
    const enabled = new Set(Object.entries(config.rules ?? {}).filter(([, v]) => v !== null).map(([k]) => k))
    enabled.add("--report-needless-disables")
    enabled.add("--report-descriptionless-disables")
    assert.ok(results.length >= 50, `expected the css sheets, got ${results.length}`)
    for (const result of results) {
        const file = relative(designSystemPath(), result.source ?? "")
        assert.deepEqual(result.invalidOptionWarnings, [], `${file}: invalid options`)
        assert.deepEqual(result.parseErrors, [], `${file}: parse errors`)
        for (const w of result.warnings) {
            assert.ok(enabled.has(w.rule), `${file}: warning from a rule the preset doesn't enable: ${JSON.stringify(w)}`)
            assert.ok(w.line > 0 && w.column > 0, `${file}: malformed position ${JSON.stringify(w)}`)
            if (w.endLine !== undefined && w.endColumn !== undefined) {
                assert.ok(w.endLine > w.line || (w.endLine === w.line && w.endColumn >= w.column), `${file}: inverted range ${JSON.stringify(w)}`)
            }
        }
    }
}

test("preset({ legacy: true }) lints every real sheet without crashing, deterministically", { skip }, async (t) => {
    const config = preset({ legacy: true })
    const results = await lintSheets(config)
    assertWellFormed(results, config)
    assert.deepEqual(fingerprint(await lintSheets(preset({ legacy: true }))), fingerprint(results), "a second run reports the same warnings")

    t.diagnostic(`legacy preset over ${results.length} sheets: ${JSON.stringify(countByRule(results))}`)
    for (const result of results) {
        for (const w of result.warnings) t.diagnostic(`${relative(cssSrc(), result.source ?? "")}:${w.line}:${w.column} ${w.rule}`)
    }
})

test("strict preset (target state) also runs cleanly on every real sheet", { skip }, async (t) => {
    const config = preset({ legacy: false, requireBinding: true })
    const results = await lintSheets(config)
    assertWellFormed(results, config)
    t.diagnostic(`strict preset (requireBinding) over ${results.length} sheets: ${JSON.stringify(countByRule(results))}`)
})
