// Smoke test over the design system's real dist (read-only; the checkout LIBSTYLIST_DESIGN_SYSTEM names —
// ./design-system.ts — skipped without it, or while its packages/css/dist is not built): override sheets
// written the way an app writes them resolve against the real registry and
// compile, and resets strip the real aggregates — every rule left whose subject is (or may be) a reset
// part keeps custom properties only, a part styled only through shared rules is reset by their guards,
// no output ends in an open statement, a second pass changes nothing, and every rule that names no reset
// part is byte-identical.
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

import postcss from "postcss"
import nesting from "postcss-nesting"
import selectorParser from "postcss-selector-parser"

import { attributeMatcher, classifySubject, collectOverrideSheet, findClassSelectors, formatResetReport, resetCss, resetReports, stylistOverride, subjectCompound, type ResetTarget } from "../src/postcss/index.js"
import { resolveOverrides, type Registry } from "../src/registry/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

/** The css package's build output in the design-system checkout. */
const dist = () => designSystemPath("packages", "css", "dist")
const registryFile = () => join(dist(), "stylist-registry.json")
const skip = skipWithoutDesignSystem || (!existsSync(registryFile()) && "packages/css/dist is not built in the design-system checkout")

const registry = (): Registry => JSON.parse(readFileSync(registryFile(), "utf8")) as Registry
/** The aggregates and the per-sheet files the css package publishes. */
const stylesheets = (): Array<{ file: string; css: string }> => {
    const out: Array<{ file: string; css: string }> = []
    const walk = (dir: string, rel: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}${entry.name}/`)
            else if (entry.name.endsWith(".css")) out.push({ file: `${rel}${entry.name}`, css: readFileSync(join(dir, entry.name), "utf8") })
        }
    }
    walk(dist(), "")
    return out
}

const PACKAGES: Record<string, { prefix: string; namespace: string }> = {
    "@livesession/eloquentui-react": { prefix: "elo", namespace: "core" },
    "@livesession/eloquentui-gram": { prefix: "elo", namespace: "gram" },
}

function resolve(files: Record<string, string>, reg: Registry) {
    const sheets = Object.entries(files).map(([file, css]) => collectOverrideSheet(css, { file }))
    return resolveOverrides({ sheets, designSystems: [reg], resolvePackage: s => PACKAGES[s] ?? { error: "not installed" }, app: { prefix: "crm", registry: null } })
}

const ruleTexts = (css: string, skipAttrs: readonly string[]): string[] => {
    const out: string[] = []
    postcss.parse(css).walkRules(r => {
        if (!skipAttrs.some(a => r.selector.includes(a))) out.push(r.toString())
    })
    return out
}

function assertStripped(css: string, targets: readonly ResetTarget[], file: string): void {
    const match = attributeMatcher(targets.map(t => t.attr))
    postcss.parse(css).walkRules(rule => {
        if (/keyframes$/i.test((rule.parent as postcss.AtRule | undefined)?.name ?? "")) return
        for (const complex of selectorParser().astSync(rule.selector).nodes) {
            // a subject that is (or may be) a reset part keeps custom properties only: the rest is dropped or guarded
            const c = classifySubject(subjectCompound(complex), match)
            if (c.match !== "none") assert.ok(rule.nodes.every(n => n.type !== "decl" || (n as postcss.Declaration).prop.startsWith("--")), `${file}: ${rule.selector} keeps only custom properties`)
        }
    })
}

test("an app's override sheet compiles against the real registry (SPEC §9, the CRM example)", { skip }, async () => {
    const reg = registry()
    if (!reg.scopes.button?.parts.loader) return
    const src = [
        "@stylist override Button from \"@livesession/eloquentui-react\";",
        "@stylist reset loader;",
        ".root {",
        "    border-radius: var(--ls-radius-lg);",
        "    &:focus-visible { outline: 2px solid var(--ls-color-primary-border); outline-offset: 2px; }",
        "}",
        ":root[data-theme=\"dark\"] .root[data-kind=\"secondary\"] { --btn-border: var(--ls-color-divider); }",
        ".loader { display: none; }",
        ".root[data-loading] .loader { display: grid; place-items: center; position: absolute; inset: 0; }",
    ].join("\n")
    const r = resolve({ "apps/crm/app/styles/overrides/button.css": src }, reg)
    assert.deepEqual(r.errors, [])
    const css = (await postcss([nesting(), stylistOverride(r.sheets[0].plugin)]).process(src, { from: "button.css" })).css
    assert.deepEqual(findClassSelectors(css), [])
    assert.match(css, /:root\[data-theme="dark"\] :is\(elo-button,\[elo-button\]\)\[data-kind="secondary"\] \{/)
    assert.ok(css.includes(`:is(elo-button,[elo-button])[data-loading] [${reg.scopes.button.parts.loader}] {`))
    assert.deepEqual(r.lock.resets, { "elo:core/button:loader": reg.scopes.button.parts.loader })
})

test("resets strip the real aggregates exactly, idempotently, leaving every other rule byte-identical", { skip }, () => {
    const reg = registry()
    const sheets = stylesheets()
    const cases: Array<[string, string, (targets: ResetTarget[], reports: ReturnType<typeof resetReports>) => void]> = [
        ["button-loader", "@stylist override Button from \"@livesession/eloquentui-react\";\n@stylist reset loader;", (_, [report]) => {
            assert.ok(report.declarations > 0 && report.stylesheets.includes("styles.css"))
        }],
        ["button-whole", "@stylist override Button from \"@livesession/eloquentui-react\";\n@stylist reset;", (_, reports) => {
            // an Icon passed as Button content keeps the icon slot: the alternative is guarded, not dropped
            assert.ok(reports.some(x => x.guarded.some(g => g.guarded.includes(":is(elo-icon,[elo-icon])"))))
        }],
        ["modal-header", "@stylist override Modal from \"@livesession/eloquentui-react\";\n@stylist reset header;", (_, [report]) => {
            assert.ok(report.layout.some(n => n.prop === "position" && n.value === "relative"), "the close button's containing block is reported")
        }],
        ["table-td", "@stylist override Table from \"@livesession/eloquentui-react\";\n@stylist reset td;", (_, [report]) => {
            assert.ok(report.declarations > 0)
        }],
        // the chevron has no rule of its own: the shared icon-slot rules style it, and their guards reset it
        ["button-chevron", "@stylist override Button from \"@livesession/eloquentui-react\";\n@stylist reset chevron;", (_, [report]) => {
            assert.ok(report.guarded.length > 0 && report.declarations > 0, "counted through its guards")
        }],
        // a sheet wholly reset: its per-sheet file is left with its layer statement alone
        ["tooltip-whole", "@stylist override tooltip from \"@livesession/eloquentui-react\";\n@stylist reset;", () => {}],
    ]
    for (const [id, src, check] of cases) {
        const r = resolve({ [`overrides/${id}.css`]: src }, reg)
        if (r.errors.some(e => e.code === "unknown-part" || e.code === "unknown-target")) continue // the design system moved on; the resolution tests cover the errors
        assert.deepEqual(r.errors, [], id)
        const attrs = r.resets.map(t => t.attr)
        const outcomes = sheets.map(({ file, css }) => {
            const out = resetCss(css, r.resets, { from: file })
            if (out.css !== null) {
                assertStripped(out.css, r.resets, file)
                // a bundler appends the next stylesheet: a statement left last is ended
                assert.match(out.css.trimEnd(), /[;}]$|\*\/$/, `${id}: ${file} ends a statement`)
                assert.equal(resetCss(out.css, r.resets).css, null, `${id}: ${file} is stripped in one pass`)
                assert.deepEqual(ruleTexts(out.css, attrs), ruleTexts(css, attrs), `${id}: ${file} keeps every other rule`)
            }
            return { file, outcome: out.outcome }
        })
        const reports = resetReports(r.resets, outcomes)
        check(r.resets, reports)
        for (const report of reports) {
            // a whole reset may name parts with no own rule (a part only a parent's rule styles): those are empty
            if (!id.endsWith("whole")) assert.equal(report.empty, false, `${id}: ${report.target.label} drops something`)
            assert.ok(formatResetReport(report).length > 0)
        }
    }
})
