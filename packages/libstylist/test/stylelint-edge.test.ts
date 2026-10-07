// Edge cases of the libstylist stylelint layer: parse-error reporting, spellings the build ignores,
// compounding through pseudo-classes, masking, positions and AST immutability.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import postcss from "postcss"
import stylelint from "stylelint"
import type { Config, Warning } from "stylelint"

import { maskedClone } from "../src/stylelint/core-wrapper.js"
import { plugins, preset, ruleNames } from "../src/stylelint/index.js"
import { findPseudoCalls, maskOpaque, maskPseudoArgs } from "../src/stylelint/selectors.js"
import { matchesSheet } from "../src/stylelint/util.js"

type Rules = NonNullable<Config["rules"]>

interface Linted {
    warnings: Warning[]
    parseErrors: string[]
    invalid: string[]
    errored: boolean
}

async function lint(code: string, config: Config, codeFilename?: string): Promise<Linted> {
    const { results } = await stylelint.lint({ code, codeFilename, config })
    const [result] = results
    return {
        warnings: result.warnings,
        parseErrors: result.parseErrors.map((w) => w.text),
        invalid: result.invalidOptionWarnings.map((w) => w.text),
        errored: Boolean(result.errored),
    }
}

const withRules = (rules: Rules): Config => ({ plugins: [...plugins], rules })

async function run(rule: string, code: string, settings: unknown = true, codeFilename?: string): Promise<Warning[]> {
    const { warnings, invalid } = await lint(code, withRules({ [rule]: settings } as Rules), codeFilename)
    assert.deepEqual(invalid, [], "no invalid options")
    return warnings.filter((w) => w.rule === rule)
}

describe("unparseable selectors", () => {
    const unparseable = [".root !b {}", ".root:() {}"]

    test("the preset reports them once, as a parse error that fails the run", async () => {
        for (const code of unparseable) {
            for (const config of [preset(), preset({ legacy: true })]) {
                const { parseErrors, errored } = await lint(code, config)
                assert.equal(parseErrors.length, 1, `${code}: ${JSON.stringify(parseErrors)}`)
                assert.match(parseErrors[0], /^Cannot parse selector \(/)
                assert.equal(errored, true, code)
            }
        }
    })

    test("each selector rule reports them on its own, like the core rules do", async () => {
        const rules = [ruleNames.sheetRoot, ruleNames.noIdentitySelectors, ruleNames.selectorMaxType, ruleNames.selectorClassPattern]
        const settings: Record<string, unknown> = { [ruleNames.selectorMaxType]: 0, [ruleNames.selectorClassPattern]: "^[a-z]+$" }
        for (const rule of rules) {
            const { parseErrors, errored } = await lint(".root !b {}", withRules({ [rule]: settings[rule] ?? true } as Rules))
            assert.equal(parseErrors.length, 1, rule)
            assert.equal(errored, true, rule)
        }
    })

    test("masked libstylist syntax is not a parse error", async () => {
        const { parseErrors, errored } = await lint(".root :component(core/Modal.Header) :cx(player-controls:button) {}", preset())
        assert.deepEqual(parseErrors, [])
        assert.equal(errored, false)
    })
})

describe("spellings the build does not recognize", () => {
    const rule = ruleNames.directiveSyntax

    test("directive-syntax flags a mis-cased @stylist and libstylist pseudo-classes", async () => {
        const cases: Array<[string, RegExp, number, number]> = [
            ["@Stylist root Alert;", /Expected "@Stylist" to be written "@stylist"/, 1, 9],
            [".root :Component(Tabs) {}", /Expected ":Component" to be written ":component"/, 7, 17],
            [".root :CX(player-controls:button) {}", /Expected ":CX" to be written ":cx"/, 7, 10],
            [".root:Global(.x) {}", /Expected ":Global" to be written ":global"/, 6, 13],
        ]
        for (const [code, re, column, endColumn] of cases) {
            const warnings = await run(rule, code)
            assert.equal(warnings.length, 1, `${code} → ${warnings.map((w) => w.text).join(" | ")}`)
            assert.match(warnings[0].text, re, code)
            assert.deepEqual([warnings[0].column, warnings[0].endColumn], [column, endColumn], code)
        }
    })

    test("a mis-cased or nested @stylist root does not bind the sheet (the build ignores it)", async () => {
        const options = [true, { requireBinding: true }]
        for (const code of ["@STYLIST root Alert;\n.icon {}", "@media (min-width: 1px) { @stylist root Alert; }\n.icon {}"]) {
            const warnings = await run(ruleNames.sheetRoot, code, options, "/x/alert.css")
            assert.equal(warnings.length, 1, code)
            assert.match(warnings[0].text, /Expected this sheet to be bound/)
        }
        const nestedOnly = await run(ruleNames.sheetRoot, "@Stylist root Alert;\n.icon { .root & {} }")
        assert.equal(nestedOnly.length, 1)
        assert.match(nestedOnly[0].text, /top-level "\.root" rule/)
    })

    test("a mis-cased @stylist scope is not the sheet's scope", async () => {
        assert.equal((await run(rule, "@Stylist scope alert;\n.root :cx(alert:icon) {}", true, "/x/badge.css")).length, 1, "only the casing")
        assert.equal((await run(rule, "@stylist scope alert;\n.root :cx(alert:icon) {}", true, "/x/badge.css")).length, 1, "own-scope ref")
    })
})

describe("libstylist/sheet-root: compounding through pseudo-classes", () => {
    const rule = ruleNames.sheetRoot

    test("rejects .root sharing an element with another part via :is/:where/:not/:nth-child", async () => {
        const bad: Array<[string, string]> = [
            [".root:is(.open) {}", "open"],
            [".root:where(.a, [data-x]) {}", "a"],
            [".open:is(.root) {}", "open"],
            [".icon:not(.root) {}", "icon"],
            [":is(.root.open) .icon {}", "open"],
            [".root:is(.x .open) {}", "open"],
            [".root:nth-child(2 of .open) {}", "open"],
            [".root { &:is(.open) .icon {} }", "open"],
        ]
        for (const [code, other] of bad) {
            const warnings = await run(rule, code)
            assert.equal(warnings.length, 1, `${code} → ${warnings.map((w) => w.text).join(" | ")}`)
            assert.match(warnings[0].text, new RegExp(`Unexpected "\\.root\\.${other}"`), code)
        }
    })

    test("accepts alternatives and qualifiers that never put another part on the root", async () => {
        const ok = [
            ":is(.a, .root) .icon {}",
            ".root:is([data-x], :hover) {}",
            ".root:not([data-open]):where(:focus-visible) {}",
            ".root:is(.root) {}",
            ".root:nth-child(2n + 1) {}",
            ".root:has(.icon) {}",
            ".root:is(:component(Button)) {}",
            ".root:cx(button:root) {}",
        ]
        for (const code of ok) assert.deepEqual(await run(rule, code), [], code)
    })
})

describe("libstylist/sheet-root: unbound sheets", () => {
    test("an unbound entry matches the pinned scope as well as the file", async () => {
        const options = (unbound: string[]) => [true, { requireBinding: true, unbound }]
        const code = "@stylist scope pinned;\n.content {}"
        assert.deepEqual(await run(ruleNames.sheetRoot, code, options(["pinned"]), "/x/other.css"), [])
        assert.deepEqual(await run(ruleNames.sheetRoot, code, options(["pinned"])), [], "stdin with a pinned scope")
        assert.equal((await run(ruleNames.sheetRoot, code, options(["nope"]), "/x/other.css")).length, 1)
    })

    test("matchesSheet", () => {
        assert.equal(matchesSheet("C:\\repo\\css\\components\\color.css", ["components/color.css"]), true)
        assert.equal(matchesSheet("/repo/css/components/color.css", ["olor.css"]), false)
        assert.equal(matchesSheet(undefined, [/color/]), false)
        assert.equal(matchesSheet(undefined, ["x"], "x"), true)
    })
})

describe("masking", () => {
    test("maskPseudoArgs covers calls nested in a masked one exactly once", () => {
        const raw = ".root :global(.b :component(core/X)) .c"
        const masked = maskPseudoArgs(raw, ["component", "cx", "global"])
        assert.equal(masked.length, raw.length)
        assert.equal(masked, ".root :global(_____________________) .c")
        assert.equal(maskOpaque(raw), ".root :global(.b :component(______)) .c")
    })

    test("line breaks survive masking so positions stay aligned", () => {
        const raw = ".root :component(\n  Tabs\n) .x"
        const masked = maskOpaque(raw)
        assert.equal(masked, ".root :component(\n______\n) .x")
    })

    test("findPseudoCalls keeps the spelling as written", () => {
        assert.deepEqual(
            findPseudoCalls(".a:Component(X) :cx(a:b)", ["component", "cx"]).map((c) => [c.name, c.written]),
            [
                ["component", "Component"],
                ["cx", "cx"],
            ],
        )
    })

    test("maskedClone never modifies the linted tree", () => {
        const css = ".root :component(core/Modal.Header) /* c */ .x, .y :cx(a:b) { color: red }"
        const root = postcss.parse(css)
        const { clone, originals } = maskedClone(root, ["component", "cx", "global"])
        assert.equal(root.toString(), css)
        assert.notEqual(clone.toString(), css)
        assert.equal(originals.get(clone.first!), root.first)
    })

    test("a fix run leaves sheets with libstylist syntax byte-identical", async () => {
        const code = ".root {\n    & :component(core/Modal.Header) { margin: 0 }\n    & :cx(player-controls:button):hover { margin: 0 }\n}\n"
        const { results, code: output } = await stylelint.lint({ code, config: preset(), fix: true })
        assert.equal(output, code)
        assert.deepEqual(results[0].warnings, [])
    })
})

describe("wrapped core rules: positions and messages", () => {
    test("positions on multi-line selectors with CRLF line endings and comments", async () => {
        const code = ".root,\r\n/* note */ .x :component(core/Modal.Header) .Bad span {}\r\n"
        const { warnings } = await lint(code, withRules({ [ruleNames.selectorClassPattern]: "^[a-z]+$", [ruleNames.selectorMaxType]: 0 }))
        const byRule = Object.fromEntries(warnings.map((w) => [w.rule, w]))
        const bad = byRule[ruleNames.selectorClassPattern]
        assert.deepEqual([bad.line, bad.column, bad.endLine, bad.endColumn], [2, 45, 2, 49])
        const type = byRule[ruleNames.selectorMaxType]
        assert.equal(type.line, 2)
        assert.match(type.text, /^Expected "\.x :component\(core\/Modal\.Header\) \.Bad span"/, "masked arguments are restored in messages")
    })

    test("ruleNames carry literal types", () => {
        const names: {
            selectorMaxType: "libstylist/selector-max-type"
            selectorClassPattern: "libstylist/selector-class-pattern"
            selectorPseudoClassNoUnknown: "libstylist/selector-pseudo-class-no-unknown"
            selectorPseudoClassDisallowedList: "libstylist/selector-pseudo-class-disallowed-list"
        } = ruleNames
        assert.equal(names.selectorMaxType, "libstylist/selector-max-type")
    })

    test("severity and custom messages apply to the wrapper", async () => {
        const { warnings, errored } = await lint(
            ".root span {}",
            withRules({ [ruleNames.selectorMaxType]: [0, { severity: "warning", message: "no types in %s" }] } as Rules),
        )
        assert.equal(warnings.length, 1)
        assert.equal(warnings[0].severity, "warning")
        assert.equal(warnings[0].text, `no types in .root span (${ruleNames.selectorMaxType})`)
        assert.equal(errored, false)
    })
})

describe("libstylist/no-identity-selectors inside pseudo-classes", () => {
    test("finds identity selectors nested in :is/:not/:where/:has but not in :component()/:cx()", async () => {
        const rule = ruleNames.noIdentitySelectors
        const warnings = await run(rule, ".root:not([_cxclass_elo-abc123]) :where(elo-alert) :has(> [DATA-PART]) :component(Alert) :cx(alert:icon) {}")
        assert.deepEqual(
            warnings.map((w) => [w.column, w.endColumn]),
            [
                [11, 32],
                [41, 50],
                [59, 70],
            ],
        )
    })
})

describe("preset over the SPEC's worked forms", () => {
    test("families, pinned scopes, cross-sheet refs and keyframes are clean in strict mode", async () => {
        const code = `@stylist scope modal;
@stylist root Modal display flex;
@stylist root Modal.Header as header display block;

.root {
    &[data-open] .header { gap: 8px; }
    & > .body :component(core/Tabs) { margin: 0; }
    & :cx(player-controls:button):focus-visible { outline: 0; }
}
.root + .root { margin-top: 8px; }
.header .title { font-size: 15px; }

@keyframes fade-in { 0% { opacity: 0; } 100% { opacity: 1; } }
`
        const { warnings, parseErrors, invalid } = await lint(code, preset({ requireBinding: true }), "/repo/packages/css/src/components/modal.css")
        assert.deepEqual([warnings.map((w) => `${w.rule}: ${w.text}`), parseErrors, invalid], [[], [], []])
    })
})
