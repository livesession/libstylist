import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import stylelint from "stylelint"
import type { Config, Warning } from "stylelint"

import {
    DISALLOWED_PSEUDO_CLASSES,
    checkComponentArg,
    checkCxArg,
    checkGlobalArg,
    localClassPattern,
    parseStylistDirective,
    plugins,
    preset,
    ruleNames,
} from "../src/stylelint/index.js"
import { combineNested, findPseudoCalls, maskOpaque, splitSelectorList } from "../src/stylelint/selectors.js"

type Rules = NonNullable<Config["rules"]>

interface Linted {
    warnings: Warning[]
    invalid: string[]
    errored: boolean
}

async function lint(code: string, config: Config, codeFilename?: string): Promise<Linted> {
    const { results } = await stylelint.lint({ code, codeFilename, config })
    const [result] = results
    return { warnings: result.warnings, invalid: result.invalidOptionWarnings.map((w) => w.text), errored: Boolean(result.errored) }
}

const withRules = (rules: Rules): Config => ({ plugins: [...plugins], rules })

/** Lints `code` with a single rule and returns only that rule's warnings. */
async function run(rule: string, code: string, settings: unknown = true, codeFilename?: string): Promise<Warning[]> {
    const { warnings, invalid } = await lint(code, withRules({ [rule]: settings } as Rules), codeFilename)
    assert.deepEqual(invalid, [], "no invalid options")
    return warnings.filter((w) => w.rule === rule)
}

describe("selector helpers", () => {
    test("findPseudoCalls finds libstylist calls and skips opaque interiors, strings and pseudo-elements", () => {
        const calls = findPseudoCalls('.a :cx(foo:global) :global(.b :component(core/Modal.Header)) [x=":cx(y)"] ::component(z) :component', ["component", "cx", "global"])
        assert.deepEqual(
            calls.map((c) => [c.name, c.arg]),
            [
                ["cx", "foo:global"],
                ["global", ".b :component(core/Modal.Header)"],
                ["component", "core/Modal.Header"],
                ["component", ""],
            ],
        )
        assert.equal(calls[3].argStart, -1)
    })

    test("maskOpaque keeps length and makes the SPEC's ns/Path form parseable", () => {
        const raw = ".root :component(core/Modal.Header) :cx(player-controls:button)"
        const masked = maskOpaque(raw)
        assert.equal(masked.length, raw.length)
        assert.equal(masked, ".root :component(_________________) :cx(______________________)")
    })

    test("splitSelectorList keeps opaque arguments as written", () => {
        assert.deepEqual(splitSelectorList(".a,\n  .b > :component(core/X), .c"), [".a", ".b > :component(core/X)", ".c"])
    })

    test("combineNested resolves & like postcss-nesting", () => {
        assert.equal(combineNested(".root", "&-icon"), ".root-icon")
        assert.equal(combineNested(".root", "& .icon"), ".root .icon")
        assert.equal(combineNested(".root", "> .icon"), ".root > .icon")
        assert.equal(combineNested(".root", ".x &"), ".x .root")
        assert.equal(combineNested(".a .b", ".c&"), ".c:is(.a .b)")
        assert.equal(combineNested(".root", '[data-x="&"] &'), '[data-x="&"] .root')
    })
})

describe("libstylist/sheet-root", () => {
    const rule = ruleNames.sheetRoot

    test("accepts leading roots with attribute/pseudo qualifiers, nesting, @media and directives", async () => {
        const ok = [
            ".root { display: flex } .icon { color: red }",
            ".root[data-x]:hover .icon {}",
            ".root { &[data-x] { & .icon {} } }",
            ".root:not([data-x]) .a {}",
            ".root:global(.minWidth) {}",
            "@media (min-width: 1px) { .root {} }",
            "@stylist root Alert; .icon {}",
            "@stylist root Modal.Header as header; .header .title {}",
            ".root + .root {} .root ~ .root .icon {}",
            ":is(.root)[data-open] .content {}",
            ".a :global(.root) {}",
            ".root :component(core/Modal.Header) {}",
            ".root :cx(player-controls:button) {}",
            "@keyframes spin { from { opacity: 0 } to { opacity: 1 } }",
            ":root { --x: 1 }",
            ".icon {}",
        ]
        for (const code of ok) assert.deepEqual(await run(rule, code), [], code)
    })

    test("rejects .root as a descendant or after another compound", async () => {
        const bad = [".root {} .x .root {}", ".root {} .x > .root {}", ".root {} .icon + .root {}", ".root {} .x:has(.root) {}", ".root {} .x :is(.root) {}", ".root { .x & {} }", ".root {} .x { & .root {} }"]
        for (const code of bad) {
            const warnings = await run(rule, code)
            assert.equal(warnings.length, 1, code)
            assert.match(warnings[0].text, /Expected "\.root" to lead/, code)
        }
    })

    test("rejects .root compounded with another part", async () => {
        for (const code of [".root.open {}", ".open.root {}", ".root { &.open {} }", ".root { &[data-x].open .icon {} }"]) {
            const warnings = await run(rule, code)
            assert.equal(warnings.length, 1, code)
            assert.match(warnings[0].text, /Unexpected "\.root\.open"/, code)
        }
    })

    test("reports a violation once, where it first appears", async () => {
        const warnings = await run(rule, ".x .root { color: red; & .icon { color: blue } &:hover .content {} }")
        assert.equal(warnings.length, 1)
        assert.equal(warnings[0].line, 1)
        assert.equal(warnings[0].column, 1)
    })

    test("a bound sheet needs a top-level .root rule or a directive", async () => {
        const warnings = await run(rule, ".icon { .root & { color: red } }")
        assert.equal(warnings.length, 1)
        assert.match(warnings[0].text, /Expected a top-level "\.root" rule or an "@stylist root" directive/)
        assert.deepEqual(await run(rule, "@stylist root Alert; .icon { .root & { color: red } }"), [])
    })

    test("requireBinding flags sheets with parts but no binding, except unbound ones", async () => {
        const code = ".content { color: red }"
        assert.deepEqual(await run(rule, code), [])
        const flagged = await run(rule, code, [true, { requireBinding: true }], "/repo/packages/css/src/components/popover.css")
        assert.equal(flagged.length, 1)
        assert.match(flagged[0].text, /Expected this sheet to be bound/)
        for (const unbound of ["popover", "popover.css", "components/popover.css", /popover/]) {
            assert.deepEqual(await run(rule, code, [true, { requireBinding: true, unbound: [unbound] }], "/repo/packages/css/src/components/popover.css"), [], String(unbound))
        }
        assert.deepEqual(await run(rule, "@import url(x.css); :root { --a: 1 } html { color: red }", [true, { requireBinding: true }]), [])
    })

    test("validates its options", async () => {
        const { invalid } = await lint(".root {}", withRules({ [rule]: [true, { bogus: true }] } as Rules))
        assert.equal(invalid.length, 1)
    })
})

describe("libstylist/directive-syntax", () => {
    const rule = ruleNames.directiveSyntax

    test("parseStylistDirective follows SPEC §4.1", () => {
        assert.deepEqual(parseStylistDirective("root Alert"), { ok: true, directive: { kind: "root", path: "Alert", local: "root", display: null } })
        assert.deepEqual(parseStylistDirective("root Modal.Header as header display block"), {
            ok: true,
            directive: { kind: "root", path: "Modal.Header", local: "header", display: "block" },
        })
        assert.deepEqual(parseStylistDirective("  scope  text-input "), { ok: true, directive: { kind: "scope", id: "text-input" } })
        for (const bad of ["", "bind Alert", "root", "root alert", "root Alert as", "root Alert as Header", "root Alert display", "root Alert display flexy", "root Alert display inline flex", "root Alert display block as x", "root Alert as a as b", "scope", "scope Text_Input", "scope a b"]) {
            assert.equal(parseStylistDirective(bad).ok, false, bad)
        }
    })

    test("pseudo-class argument grammar (SPEC §4.2)", () => {
        assert.equal(checkComponentArg("Tabs"), null)
        assert.equal(checkComponentArg(" player/ControlsBar "), null)
        assert.equal(checkComponentArg("core/Modal.Header"), null)
        assert.notEqual(checkComponentArg("tabs"), null)
        assert.notEqual(checkComponentArg("Player/X"), null)
        assert.notEqual(checkComponentArg(""), null)
        assert.equal(checkCxArg("player-controls:button"), null)
        assert.match(checkCxArg("button") ?? "", /written "\.button"/)
        assert.match(checkCxArg("alert:icon", "alert") ?? "", /write "\.icon"/)
        assert.notEqual(checkCxArg("a:B"), null)
        assert.equal(checkGlobalArg(".a :is(.b, .c)"), null)
        assert.notEqual(checkGlobalArg(".a, .b"), null)
        assert.notEqual(checkGlobalArg(" "), null)
    })

    test("accepts well-formed directives and calls", async () => {
        const code = [
            "@stylist root Modal display block;",
            "@stylist root Modal.Header as header display flex;",
            "@stylist root ListCollection.Root;",
            "@stylist scope modal;",
            ".root :component(Tabs) :component(player/ControlsBar) {}",
            ".root :cx(player-controls:button) {}",
            ".root :global(.icon-wrapper) {}",
            ".root:global(:is(.a, .b)) {}",
        ].join("\n")
        assert.deepEqual(await run(rule, code), [])
    })

    test("rejects malformed directives", async () => {
        const cases: Array<[string, RegExp]> = [
            ["@stylist;", /Invalid "@stylist "/],
            ["@stylist bind Alert;", /unknown directive "bind"/],
            ["@stylist root alert;", /not a component path/],
            ["@stylist root Alert as Header;", /kebab-case part name/],
            ["@stylist root Alert display flexy;", /not a single-keyword display value/],
            ["@stylist root Alert display block as x;", /"as" must come before "display"/],
            ["@stylist scope a b;", /expected "@stylist scope <id>"/],
            ["@media (min-width: 1px) { @stylist root Alert; }", /nested "@stylist"/],
            [".root { @stylist root Alert; }", /nested "@stylist"/],
            ["@stylist root Alert { color: red }", /Unexpected block/],
            ["@stylist root Alert;\n@stylist root Alert display block;", /second "@stylist root Alert"/],
            ["@stylist scope a;\n@stylist scope b;", /second "@stylist scope"/],
        ]
        for (const [code, re] of cases) {
            const warnings = await run(rule, code)
            assert.equal(warnings.length, 1, `${code} → ${warnings.map((w) => w.text).join(" | ")}`)
            assert.match(warnings[0].text, re, code)
        }
    })

    test("rejects malformed :component(), :cx() and :global()", async () => {
        const cases: Array<[string, RegExp, number]> = [
            [".root :component(tabs) {}", /Invalid ":component\(tabs\)"/, 7],
            [".root :component() {}", /needs a component path/, 7],
            [".root :component {}", /needs a parenthesized argument/, 7],
            [".root :cx(button) {}", /":cx\(\)" takes "scope:part"/, 7],
            [".root :global(.a, .b) {}", /takes exactly one selector/, 7],
            [".root :global() {}", /needs a selector/, 7],
        ]
        for (const [code, re, column] of cases) {
            const warnings = await run(rule, code)
            assert.equal(warnings.length, 1, code)
            assert.match(warnings[0].text, re, code)
            assert.equal(warnings[0].column, column, code)
        }
    })

    test("flags :cx() refs to the sheet's own scope (file name or pinned scope)", async () => {
        assert.equal((await run(rule, ".root :cx(alert:icon) {}", true, "/x/alert.css")).length, 1)
        assert.equal((await run(rule, "@stylist scope alert;\n.root :cx(alert:icon) {}")).length, 1)
        assert.equal((await run(rule, ".root :cx(alert:icon) {}", true, "/x/badge.css")).length, 0)
    })
})

describe("libstylist/no-identity-selectors", () => {
    const rule = ruleNames.noIdentitySelectors

    test("rejects identity tags/markers, part attributes, dev attributes, removed hooks and class", async () => {
        const cases: Array<[string, RegExp]> = [
            ["elo-alert {}", /"elo-alert" — tags and markers carry identity/],
            [".root elo-button {}", /"elo-button"/],
            [".root:not(ELO-X) {}", /"ELO-X"/],
            ["[elo-button] {}", /"\[elo-button\]" — tags and markers/],
            ["[_cxclass_elo-or4d4l] {}", /part attributes are generated/],
            ['[_cxpart="icon"] {}', /dev-only attributes/],
            ["[data-react-component] {}", /dev-only attributes/],
            ["[data-file-source] {}", /dev-only attributes/],
            ['.root [data-component="Tabs"] {}', /data-component\/data-part are removed/],
            ['[data-part="header"] {}', /data-component\/data-part are removed/],
            ['[class~="x"] {}', /never emits class/],
            ["[CLASS] {}", /never emits class/],
            ['.root :global([data-component="Tabs"]) {}', /data-component\/data-part are removed/],
        ]
        for (const [code, re] of cases) {
            const warnings = await run(rule, code)
            assert.equal(warnings.length, 1, code)
            assert.match(warnings[0].text, re, code)
        }
    })

    test("reports the exact selector range", async () => {
        const [warning] = await run(rule, '.root [data-component="Tabs"] .x {}')
        assert.equal(warning.column, 7)
        assert.equal(warning.endColumn, 30)
    })

    test("accepts variant attributes, :component(), :cx(), other prefixes and keyframes", async () => {
        const ok = [
            '.root[data-kind="primary"][aria-expanded="true"] {}',
            "[data-elo-x] {}",
            ".root :component(Tabs) :component(core/Modal.Header) {}",
            ".root :cx(elo-x:part) {}",
            "app-shell {}",
            "button svg {}",
            "@keyframes elo-spin { from {} to {} }",
        ]
        for (const code of ok) assert.deepEqual(await run(rule, code), [], code)
    })

    test("prefix option", async () => {
        assert.equal((await run(rule, "app-header {} elo-alert {}", [true, { prefix: "app" }])).length, 1)
        assert.equal((await run(rule, "app-header {} elo-alert {} [app-x] {}", [true, { prefix: ["elo", "app"] }])).length, 3)
        const { invalid } = await lint("a {}", withRules({ [rule]: [true, { prefix: "Elo" }] } as Rules))
        assert.equal(invalid.length, 1)
    })
})

describe("libstylist/selector-class-pattern (core rule on the masked sheet)", () => {
    const rule = ruleNames.selectorClassPattern
    const pattern = localClassPattern("elo")

    test("checks local classes but not :component()/:cx() arguments", async () => {
        assert.deepEqual(await run(rule, ".root :component(Modal.Header) :component(core/Modal.Header) :cx(a:b) {}", [pattern]), [])
        const warnings = await run(rule, ".root .Foo, .ls-alert__icon, .elo-x, ._cxclass_elo-abc {}", [pattern])
        assert.deepEqual(
            warnings.map((w) => [w.column, w.endColumn]),
            [
                [7, 11],
                [13, 28],
                [30, 36],
                [38, 55],
            ],
        )
        assert.match(warnings[0].text, /^Expected "\.Foo" to match pattern/)
        assert.match(warnings[0].text, /\(libstylist\/selector-class-pattern\)$/)
    })

    test("the core rule misreads :component(Modal.Header) — which is why the preset swaps it", async () => {
        const { warnings } = await lint(".root :component(Modal.Header) {}", { rules: { "selector-class-pattern": pattern } })
        assert.equal(warnings.length, 1)
    })

    test("resolveNestedSelectors checks the classes & glues together", async () => {
        assert.deepEqual(await run(rule, ".root { &-Bad {} }", [pattern]), [])
        const glued = await run(rule, ".root { &-Bad {} &-icon {} }", [pattern, { resolveNestedSelectors: true }])
        assert.equal(glued.length, 1)
        assert.match(glued[0].text, /"\.root-Bad"/)
        assert.equal(glued[0].line, 1)
    })

    test("classes inside a legacy :global() hook are not parts, so they are not checked", async () => {
        assert.deepEqual(await run(rule, ".root:global(.minWidth) {} .root :global(.ls-x .Foo :component(core/Modal.Header)) {}", [pattern]), [])
        const [warning] = await run(rule, ".root:global(.minWidth) .Bad {}", [pattern])
        assert.match(warning.text, /"\.Bad"/)
        assert.equal(warning.column, 25)
    })

    test("invalid options are reported under the wrapper's name", async () => {
        const { invalid } = await lint(".a {}", withRules({ [rule]: [pattern, { bogus: true }] } as Rules))
        assert.equal(invalid.length, 1)
        assert.match(invalid[0], /libstylist\/selector-class-pattern/)
    })
})

describe("libstylist/selector-pseudo-class-no-unknown (core rule on the masked sheet)", () => {
    const rule = ruleNames.selectorPseudoClassNoUnknown

    test("knows the libstylist pseudo-classes and skips :cx() part names", async () => {
        assert.deepEqual(await run(rule, ".root :component(Tabs) :cx(player-controls:button) :global(.x:hover) {}"), [])
        const { errored, warnings } = await lint(".root :cx(player-controls:icon) {}", withRules({ [rule]: true }))
        assert.deepEqual(warnings, [])
        assert.equal(errored, false, "masked problems never flag the file")
    })

    test("still reports unknown pseudo-classes, at the right position", async () => {
        const warnings = await run(rule, ".root :cx(a:icon) .x:hovr, :global(.y:focsu) {}")
        assert.deepEqual(
            warnings.map((w) => [w.text.replace(/ \(.*$/, ""), w.column]),
            [
                ['Unexpected unknown pseudo-class selector ":hovr"', 21],
                ['Unexpected unknown pseudo-class selector ":focsu"', 38],
            ],
        )
    })

    test("honours ignorePseudoClasses and disable comments under its own name", async () => {
        assert.deepEqual(await run(rule, ".x:hovr {}", [true, { ignorePseudoClasses: ["hovr"] }]), [])
        assert.deepEqual(await run(rule, `/* stylelint-disable-next-line ${rule} -- test */\n.x:hovr {}`), [])
        const { warnings } = await lint(`/* stylelint-disable-next-line ${rule} -- test */\n.x:hovr {}`, { ...withRules({ [rule]: true }), reportNeedlessDisables: true })
        assert.deepEqual(warnings, [], "the disable is used, not needless")
    })

    test("the core rule misreads :cx(scope:part) — which is why the preset swaps it", async () => {
        const { warnings } = await lint(".root :cx(player-controls:icon) {}", { rules: { "selector-pseudo-class-no-unknown": [true, { ignorePseudoClasses: ["cx"] }] } })
        assert.equal(warnings.length, 1)
    })
})

describe("libstylist/selector-pseudo-class-disallowed-list and libstylist/selector-max-type", () => {
    test("parse the SPEC's :component(ns/Path) form the core rules choke on", async () => {
        const code = ".root :component(player/ControlsBar) { margin: 0 }"
        const core = await lint(code, { rules: { "selector-max-type": 0, "selector-pseudo-class-disallowed-list": [["global"]] } })
        assert.equal(core.errored, true, "core rules can't parse ns/Path")
        const wrapped = await lint(code, withRules({ [ruleNames.selectorMaxType]: 0, [ruleNames.selectorPseudoClassDisallowedList]: [["global"]] }))
        assert.deepEqual(wrapped.warnings, [])
        assert.equal(wrapped.errored, false)
    })

    test("report like the core rules, on the original nodes", async () => {
        const code = ".root :component(core/Modal) span,\n.root:global(.x):first-of-type {}"
        const { warnings } = await lint(code, withRules({ [ruleNames.selectorMaxType]: 0, [ruleNames.selectorPseudoClassDisallowedList]: [["global", "first-of-type"]] }))
        assert.deepEqual(
            warnings.map((w) => [w.rule, w.line, w.column]),
            [
                [ruleNames.selectorMaxType, 1, 1],
                [ruleNames.selectorPseudoClassDisallowedList, 2, 6],
                [ruleNames.selectorPseudoClassDisallowedList, 2, 17],
            ],
        )
        assert.match(warnings[0].text, /Expected "\.root :component\(core\/Modal\) span" to have no more than 0 type selectors/)
    })

    test("a single-string primary for the disallowed list stays one option (primaryOptionArray)", async () => {
        const { warnings, invalid } = await lint(".a:global(.b) {}", withRules({ [ruleNames.selectorPseudoClassDisallowedList]: ["global", "local"] }))
        assert.deepEqual(invalid, [])
        assert.equal(warnings.length, 1)
    })
})

describe("preset", () => {
    const rulesOf = (config: Config) => config.rules ?? {}

    test("shape: plugins, disables reporting, built-ins per mode", () => {
        const strict = preset()
        assert.deepEqual(strict.plugins, [...plugins])
        assert.equal(strict.reportDescriptionlessDisables, true)
        assert.equal(strict.reportNeedlessDisables, true)
        assert.deepEqual((rulesOf(strict)[ruleNames.selectorMaxType] as unknown[])[0], 0)
        assert.deepEqual((rulesOf(strict)[ruleNames.selectorPseudoClassDisallowedList] as unknown[])[0], [...DISALLOWED_PSEUDO_CLASSES])
        assert.deepEqual(rulesOf(strict)["at-rule-no-unknown"], [true, { ignoreAtRules: ["stylist"] }])
        for (const core of ["selector-class-pattern", "selector-pseudo-class-no-unknown", "selector-pseudo-class-disallowed-list", "selector-max-type"]) {
            assert.equal(rulesOf(strict)[core], null, `${core} is replaced by libstylist/${core}`)
        }
        const legacy = preset({ legacy: true })
        assert.equal(rulesOf(legacy)[ruleNames.selectorMaxType], null)
        assert.ok(!((rulesOf(legacy)[ruleNames.selectorPseudoClassDisallowedList] as string[][])[0]).includes("global"))
        assert.deepEqual((rulesOf(preset({ prefix: "app" }))["libstylist/no-identity-selectors"] as unknown[])[1], { prefix: "app", allowRemovedHooks: false })
        assert.deepEqual((rulesOf(preset({ prefix: "app", legacy: true }))["libstylist/no-identity-selectors"] as unknown[])[1], { prefix: "app", allowRemovedHooks: true })
        assert.throws(() => preset({ prefix: "App" }), /prefix/)
    })

    test("localClassPattern", () => {
        const re = new RegExp(localClassPattern("elo"))
        for (const ok of ["root", "icon", "input-wrapper", "h2", "elo"]) assert.ok(re.test(ok), ok)
        for (const bad of ["ls-alert", "elo-x", "_cxclass_elo-abc", "Foo", "minWidth", "a--b", "-a", "a_b"]) assert.ok(!re.test(bad), bad)
        assert.ok(new RegExp(localClassPattern("app")).test("elo-x"))
    })

    test("a migrated sheet in the new syntax is clean in strict mode", async () => {
        const code = `@stylist root Alert display flex;
@stylist root Alert.Title as title;

.root {
    color: var(--ls-color-text);
    --alert-bg: var(--ls-palette-blue-24);

    &[data-variant="info"] .icon {
        color: var(--alert-icon-color);
    }
    &:hover :component(Button) {
        opacity: 1;
    }
    & :cx(player-controls:button):focus-visible {
        outline: 0;
    }
}

.title {
    font-weight: 500;
}

@keyframes pulse {
    from { opacity: 0; }
    to { opacity: 1; }
}
`
        const { warnings, invalid } = await lint(code, preset(), "/repo/packages/css/src/components/alert.css")
        assert.deepEqual(invalid, [])
        assert.deepEqual(
            warnings.map((w) => w.text),
            [],
        )
    })

    test("legacy mode allows :global() and type selectors; strict mode bans them", async () => {
        const code = ".root :global(.icon-wrapper) svg { margin: 0 }"
        assert.deepEqual((await lint(code, preset({ legacy: true }))).warnings, [])
        const strict = (await lint(code, preset())).warnings.map((w) => w.rule).sort()
        assert.deepEqual(strict, [ruleNames.selectorMaxType, ruleNames.selectorPseudoClassDisallowedList])
    })

    test("built-ins: *-of-type, hex, custom properties, unknown at-rules, identity selectors", async () => {
        const code = `.root:first-of-type { color: #fff; --fooBar: 1 }
@foo bar;
.root [elo-button] {}
.Root {}`
        // migration (legacy) mode tolerates *-of-type; strict mode bans it
        const rules = (await lint(code, preset({ legacy: true }))).warnings.map((w) => w.rule).sort()
        assert.deepEqual(rules, [
            "at-rule-no-unknown",
            "color-no-hex",
            "custom-property-pattern",
            "libstylist/no-identity-selectors",
            "libstylist/selector-class-pattern",
        ])
        const strict = (await lint(code, preset())).warnings.map((w) => w.rule)
        assert.ok(strict.includes("libstylist/selector-pseudo-class-disallowed-list"))
    })

    test("migration mode tolerates the removed data-component/data-part hooks; strict mode bans them", async () => {
        const code = `.root [data-component="Tabs"] .x {}\n.root [data-part="list"] {}`
        assert.deepEqual((await lint(code, preset({ legacy: true }))).warnings, [])
        const strict = (await lint(code, preset())).warnings.map((w) => w.rule)
        assert.deepEqual(strict, ["libstylist/no-identity-selectors", "libstylist/no-identity-selectors"])
    })

    test("custom messages name the offending selector", async () => {
        const { warnings } = await lint(".root .Foo:nth-of-type(2) span {}", preset())
        const byRule = Object.fromEntries(warnings.map((w) => [w.rule, w.text]))
        assert.match(byRule["libstylist/selector-class-pattern"], /Expected "\.Foo" to be a part name/)
        assert.match(byRule[ruleNames.selectorPseudoClassDisallowedList], /Unexpected pseudo-class ":nth-of-type"/)
        assert.match(byRule[ruleNames.selectorMaxType], /Unexpected type selector in "\.root \.Foo:nth-of-type\(2\) span"/)
    })

    test("disables need a description and must not be needless", async () => {
        const described = "a { color: #fff; } /* stylelint-disable-line color-no-hex -- documented one-off */"
        assert.deepEqual((await lint(described, preset({ legacy: true }))).warnings, [])
        const bare = (await lint("a { color: #fff; } /* stylelint-disable-line color-no-hex */", preset({ legacy: true }))).warnings.map((w) => w.rule)
        assert.deepEqual(bare, ["--report-descriptionless-disables"])
        const needless = (await lint("a { color: red; } /* stylelint-disable-line color-no-hex -- nothing to disable */", preset({ legacy: true }))).warnings.map((w) => w.rule)
        assert.deepEqual(needless, ["--report-needless-disables"])
    })

    test("the default export is the plugin list, loadable by path", async () => {
        const mod = await import("../src/stylelint/index.js")
        assert.equal(mod.default, mod.plugins)
        const path = fileURLToPath(new URL("../src/stylelint/index.ts", import.meta.url))
        const { warnings } = await lint("elo-alert {}", { plugins: [path], rules: { [ruleNames.noIdentitySelectors]: true } })
        assert.deepEqual(
            warnings.map((w) => w.rule),
            [ruleNames.noIdentitySelectors],
        )
    })
})

describe("override sheets (SPEC §9)", () => {
    const BUTTON = '@stylist override Button from "@livesession/eloquentui-react";\n'

    test("parseStylistDirective reads the override grammar the build reads", () => {
        assert.deepEqual(parseStylistDirective(' override Table.Tr from "@ds/react" within render/RenderCart '), {
            ok: true,
            directive: { kind: "override", target: { kind: "component", path: "Table.Tr" }, from: "@ds/react", within: "render/RenderCart" },
        })
        assert.deepEqual(parseStylistDirective("override tooltip from '@ds/react'"), { ok: true, directive: { kind: "override", target: { kind: "sheet", scope: "tooltip" }, from: "@ds/react", within: null } })
        assert.deepEqual(parseStylistDirective("reset"), { ok: true, directive: { kind: "reset", parts: [] } })
        assert.deepEqual(parseStylistDirective("reset loader icon"), { ok: true, directive: { kind: "reset", parts: ["loader", "icon"] } })
        const bad = parseStylistDirective("override Button from @ds/react")
        assert.ok(!bad.ok && /the package is a quoted string: from "@ds\/react" — expected "@stylist override/.test(bad.error), JSON.stringify(bad))
        const dot = parseStylistDirective("reset .loader")
        assert.ok(!dot.ok && /"loader" is not a part name \(write it without the dot\)/.test(dot.error))
    })

    test("directive-syntax: a well-formed override sheet is clean", async () => {
        for (const code of [
            `${BUTTON}@stylist reset loader icon;\n\n.root { color: red; }\n.loader { display: none; }`,
            `/* restyle */\n${BUTTON}@stylist reset;\n.root {}`,
            '@stylist override Table from "@ds/react" within render/RenderCart;\n.td { color: red; }',
            '@stylist override tooltip from "@ds/react";\n.bubble {}',
        ]) {
            assert.deepEqual((await run(ruleNames.directiveSyntax, code)).map((w) => w.text), [], code)
        }
    })

    test("directive-syntax: the build's placement rules, the grammar, a nested reset", async () => {
        const cases: Array<[string, RegExp]> = [
            ["@stylist reset loader;\n.root {}", /Invalid override sheet directive — @stylist reset before @stylist override/],
            [`${BUTTON}@stylist override Modal from "@ds/react";`, /Invalid override sheet directive — an override sheet has one @stylist override/],
            [`${BUTTON}@stylist root Button;`, /Invalid override sheet directive — @stylist root in an override sheet — an override sheet declares no component of its own/],
            [`${BUTTON}@stylist reset loader;\n@stylist reset icon loader;`, /Invalid override sheet directive — part "loader" is reset twice/],
            [`${BUTTON}@stylist reset;\n@stylist reset loader;`, /Invalid override sheet directive — the whole target sheet is reset already/],
            [`${BUTTON}.root {}\n@stylist reset loader;`, /Invalid override sheet directive — @stylist directives come first in an override sheet/],
            [`${BUTTON}.loader { @stylist reset; }`, /Unexpected nested "@stylist reset" — a reset names its parts at the top of the override sheet/],
            ['@stylist override Button from "@ds/react/button";', /Invalid "@stylist override .*": "@ds\/react\/button" is a subpath/],
            ['@stylist override Button from "@ds/react" within cart;', /names no component/],
        ]
        for (const [code, re] of cases) {
            const warnings = await run(ruleNames.directiveSyntax, code)
            assert.equal(warnings.length, 1, `${code} → ${warnings.map((w) => w.text).join(" | ")}`)
            assert.match(warnings[0].text, re, code)
        }
    })

    test("sheet-root: .root is the component's identity — no binding, document context before it, never after another part", async () => {
        const rule = ruleNames.sheetRoot
        for (const code of [
            `${BUTTON}.root { & .loader {} }`,
            `${BUTTON}:root[data-theme="dark"] .root[data-kind="secondary"] {}`,
            `${BUTTON}html:not([dir]) .root:hover .icon {}`,
            `${BUTTON}.loader { color: red; }`,
            `${BUTTON}.icon { .root:hover & { color: red; } }`,
            // the sheet form: .root is a plain part of that sheet
            '@stylist override tooltip from "@ds/react";\n.bubble .root {}',
        ]) {
            assert.deepEqual((await run(rule, code, [true, { requireBinding: true }])).map((w) => w.text), [], code)
        }
        const leading = await run(rule, `${BUTTON}.loader .root {}`)
        assert.equal(leading.length, 1)
        assert.match(leading[0].text, /Expected "\.root" to lead "\.loader \.root"/)
        const compounded = await run(rule, `${BUTTON}.root.loader {}`)
        assert.match(compounded[0]?.text ?? "", /Unexpected "\.root\.loader"/)
    })

    test("the preset: an override sheet as the CRM would write it is clean", async () => {
        const code = `${BUTTON}@stylist reset loader;

.root {
    border-radius: var(--ls-radius-lg);

    &:focus-visible {
        outline: 2px solid var(--ls-color-primary-border);
    }
}
:root[data-theme="dark"] .root[data-kind="secondary"] {
    --btn-border: var(--ls-color-divider);
}
.loader {
    display: none;
}
.root[data-loading] .loader {
    display: grid;
    place-items: center;
}
`
        const { warnings, invalid } = await lint(code, preset({ prefix: "crm" }), "/repo/apps/crm/app/styles/overrides/button.css")
        assert.deepEqual(invalid, [])
        assert.deepEqual(warnings.map((w) => `${w.rule}: ${w.text}`), [])
    })
})
