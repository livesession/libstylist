// `libstylist check` over the design-system repository itself (libstylist.config.mjs at the root of the
// checkout LIBSTYLIST_DESIGN_SYSTEM names — see ./design-system.ts; skipped without it): every migrated
// component conforms, the pilot's settled conventions are recognized (wrapper and slot identity, marker
// forwarding, portal member roots, exemptions), and the only errors are the known, reported violations
// below — a new violation, or a fixed one, fails this test until the list is updated.
import assert from "node:assert/strict"
import { test } from "node:test"

import { RULES, burndownReport, runCheck, type CheckResult } from "../src/check/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

const skip = skipWithoutDesignSystem

/**
 * Real violations the checker finds on the current tree, each tracked outside this test as
 * "<rule> <component or scope:part> — <why it is still there>". Keep the list exact: remove an entry
 * with its fix, never add one to make a regression pass, and never weaken a rule to drop one.
 */
const KNOWN_VIOLATIONS: string[] = []

const PILOT = [
    "ai/ThinkingShader",
    "core/Alert",
    "core/Button",
    "core/CopyButton",
    "core/Modal",
    "core/Modal.Body",
    "core/Modal.Footer",
    "core/Modal.Header",
    "core/ModalConfirm",
    "core/ModalConfirm.Footer",
    "core/Popover",
    "core/Switch",
    "core/Tooltip",
    "player/EventRow",
]

/** The check result, computed once per process and only when a gated test runs. */
let cached: Promise<CheckResult> | undefined
const result = () => (cached ??= runCheck({ config: designSystemPath("libstylist.config.mjs") }))

const analysisOf = (r: CheckResult, id: string) => {
    const a = [...r.analyses.values()].find((x) => x.component.id === id)
    assert.ok(a, `no analysis for ${id}`)
    return a
}

test("real repo: every migrated component conforms; the only errors are the known, reported violations", { skip }, async () => {
    const r = await result()
    const known = new Set(KNOWN_VIOLATIONS)
    assert.deepEqual(
        r.findings.filter((f) => RULES[f.rule].scope !== "hard" && !known.has(`${f.rule} ${f.key}`)),
        [],
        "a migrated component has a finding — fix the component (see docs/RULES.md), don't pin it",
    )
    assert.deepEqual(
        r.findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.key}`).sort(),
        [...KNOWN_VIOLATIONS].sort(),
        "the errors changed — fix a new one; remove a fixed one from KNOWN_VIOLATIONS",
    )
    assert.equal(r.stats.packages, 13)
    assert.ok(r.stats.components >= 137, `${r.stats.components} exported components`)
})

test("real repo: the P2 pilot is migrated and recognized through its settled conventions", { skip }, async () => {
    const r = await result()
    const status = new Map(r.components.map((c) => [c.id, c]))
    for (const id of PILOT) assert.equal(status.get(id)?.migrated, true, `${id} is migrated`)

    // Button: the identity stays on the (polymorphic) button in every branch — plain, inside the
    // <label> wrapper, and inside <Tooltip> (slot identity)
    const button = analysisOf(r, "core/Button")
    assert.equal(button.forwards, true)
    const wrappers = new Set(button.identities.map((h) => h.wrapper?.tagName.getText() ?? "none"))
    assert.deepEqual([...wrappers].sort(), ["Tooltip", "label", "none"])

    // ModalConfirm, its Footer and Tooltip own no DOM: they forward their markers onto the delegate
    for (const id of ["core/ModalConfirm", "core/ModalConfirm.Footer", "core/Tooltip"]) {
        assert.deepEqual(analysisOf(r, id).identities.map((h) => h.form), ["forwarded"], id)
    }

    // Popover's portaled panel is a member root bound in popover.css and owned by Popover's file
    const member = r.memberRoots.find((m) => m.tag === "elo-popover-content")
    assert.equal(member?.owner.id, "core/Popover")
    assert.equal(member?.local, "content")

    // the escape hatches in use excuse exactly their category: Switch's hidden form input (multi),
    // Popover's Radix hosts (native), Loader rendering null (none)
    for (const [id, rule] of [["core/Switch", "R104"], ["core/Popover", "R101"], ["core/Loader", "R100"]] as const) {
        assert.ok(analysisOf(r, id).problems.some((p) => p.rule === rule), `${id} has the ${rule} its exemption excuses`)
        assert.deepEqual([...r.findings, ...r.pending].filter((f) => f.component === id), [], `${id}'s exemption excuses all its findings`)
    }
    for (const cat of ["none", "multi", "native"] as const) {
        const { used, budget } = r.stats.exemptions[cat]
        assert.ok(budget === null || used <= budget, `${cat}: ${used} within its budget ${budget}`)
    }
})

test("real repo: burndown counts what is left, consistently with the check result", { skip }, async () => {
    const r = await result()
    const report = burndownReport(r)
    assert.equal(report.components.total, r.stats.components)
    assert.equal(report.components.migrated, r.stats.migrated)
    assert.equal(report.pendingFindings, r.pending.length)
    assert.equal(report.packages.reduce((n, p) => n + p.components, 0), r.stats.components)
    // pending findings only ever belong to components that are not migrated
    const migrated = new Set(r.components.filter((c) => c.migrated).map((c) => c.id))
    assert.deepEqual(r.pending.filter((f) => f.component && migrated.has(f.component)), [])
    // the storybook-only swatch sheet is unbound: never pending
    assert.ok(!report.sheets.pending.includes("packages/css/src/components/color.css"))
})
