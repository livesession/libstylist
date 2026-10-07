// The build-time reset (SPEC §9.5): which design-system rules a reset part owns (the subject
// classification), what is stripped, split, guarded or kept (custom properties included), the emptied
// at-rules and the statements left last, idempotence, the PostCSS plugin and the report (counts — guards
// included —, layout contracts and their acknowledgement under the same conditions, foreign rules, empty
// resets) — over small stylesheets and over the fixture design system.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import postcss from "postcss"
import selectorParser from "postcss-selector-parser"

import { partAttr } from "../src/hash/index.js"
import {
    acknowledgedDeclarations,
    acknowledges,
    attributeMatcher,
    classifySubject,
    formatResetReport,
    formatResetReports,
    identityMatcher,
    layoutKinds,
    resetCss,
    resetGuard,
    resetReports,
    resetStylesheet,
    selectorConditions,
    specificityList,
    stylistReset,
    subjectCompound,
    touchedTargets,
    type ResetOutcome,
    type ResetTarget,
} from "../src/postcss/index.js"
import { compileOverride } from "../src/workspace/index.js"
import { designSystem, resolveSheets } from "./fixtures/overrides/design-system.js"

const T = (attr: string, extra: Partial<ResetTarget> = {}): ResetTarget => ({ prefix: "ds", namespace: "core", scope: "x", part: attr, attr, label: `ds:core/x:${attr}`, tag: null, sheet: "o/x.css", line: 2, ...extra })

function reset(css: string, targets: ResetTarget[]): { css: string; outcome: ResetOutcome } {
    const root = postcss.parse(css)
    const outcome = resetStylesheet(root, targets)
    return { css: root.toString(), outcome }
}

/** The stylesheet's rules as `selector { decls }` lines, whitespace-normalized. */
const rules = (css: string): string[] => {
    const out: string[] = []
    postcss.parse(css).walkRules(r => {
        const decls = r.nodes.filter(n => n.type === "decl").map(n => `${(n as postcss.Declaration).prop}: ${(n as postcss.Declaration).value.trim()}${(n as postcss.Declaration).important ? " !important" : ""}`)
        out.push(`${r.selector.replace(/\s+/g, " ")} { ${decls.join("; ")} }`)
    })
    return out
}

const classify = (selector: string, attrs: string[]) => classifySubject(subjectCompound(selectorParser().astSync(selector).first), attributeMatcher(attrs))

describe("subject classification", () => {
    test("all, some, none", () => {
        assert.deepEqual(classify("[a]", ["a"]), { match: "all", names: ["a"] })
        assert.deepEqual(classify("[r] [a][data-x]:hover::before", ["a"]), { match: "all", names: ["a"] })
        assert.deepEqual(classify("[a=\"1\"]", ["a"]), { match: "all", names: ["a"] })
        assert.deepEqual(classify(":is([a], [a][x], :where([a]:hover))", ["a"]), { match: "all", names: ["a"] })
        assert.deepEqual(classify(":is([a], [b])", ["a"]), { match: "some", names: ["a"] })
        assert.deepEqual(classify(":is([x] [a], [b])", ["a", "b"]), { match: "all", names: ["a", "b"] })
        assert.deepEqual(classify(":is(:is([a], [c]), [b])", ["a"]), { match: "some", names: ["a"] })
        assert.deepEqual(classify(":nth-child(2 of [a])", ["a"]), { match: "some", names: ["a"] })
        assert.deepEqual(classify(":nth-last-child(odd of [b], [a])", ["a"]), { match: "some", names: ["a"] })
        for (const none of ["[a] [x]", "[x]:not([a])", "[x]:has([a])", "[x]:has(> [a])", "[a] > [x]::before", ":nth-child(2)", ":is([a] [x])", "[b]"]) {
            assert.deepEqual(classify(none, ["a"]), { match: "none", names: [] }, none)
        }
        // a guarded subject is none: the reset is idempotent
        assert.deepEqual(classify(`:is([a], [b])${resetGuard(["a"])}`, ["a"]), { match: "none", names: [] })
        assert.deepEqual(classify(`:is([a], [b], [c])${resetGuard(["a"])}`, ["a", "b"]), { match: "some", names: ["b"] })
        assert.equal(resetGuard(["a", "b"]), ":where(:not([a],[b]))")
    })

    test("identities: the custom tag and the marker", () => {
        const id = (s: string) => classifySubject(subjectCompound(selectorParser().astSync(s).first), identityMatcher("ds-button")).match
        assert.equal(id(":is(ds-button,[ds-button])"), "all")
        assert.equal(id("[chat] > ds-button"), "all")
        assert.equal(id("[ds-button]:hover"), "all")
        assert.equal(id(":where(ds-button:not([hidden]))"), "all")
        assert.equal(id("ds-button [x]"), "none")
    })
})

describe("the strip", () => {
    test("a rule whose subject is a reset part loses its declarations — states, pseudo-elements, compounds, !important, valued attributes", () => {
        const { css, outcome } = reset("[a] { color: red }\n[a]:hover { color: blue }\n[a]::before { content: \"\" }\n[a][data-x] { margin: 0 !important }\n[r] [a=\"1\"] { top: 0 }\n[b] { color: green }", [T("a")])
        assert.deepEqual(rules(css), ["[b] { color: green }"])
        assert.equal(outcome.changed, true)
        assert.deepEqual(outcome.rules.map(r => [r.selectors.map(s => s.selector), r.declarations.map(d => `${d.prop}${d.important ? "!" : ""}`), r.removed]), [
            [["[a]"], ["color"], true],
            [["[a]:hover"], ["color"], true],
            [["[a]::before"], ["content"], true],
            [["[a][data-x]"], ["margin!"], true],
            [["[r] [a=\"1\"]"], ["top"], true],
        ])
        assert.deepEqual(outcome.rules[2].selectors[0], { selector: "[a]::before", attrs: ["a"], pseudoElement: true })
        assert.equal(outcome.rules[0].declarations[0].line, 1)
    })

    test("custom properties stay: a rule of only custom properties is untouched, a mixed one keeps them", () => {
        const { css, outcome } = reset("[a][data-size=\"s\"] { --h: 1px; --w: 2px }\n[a] { --h: 1px; color: red; /* c */ }", [T("a")])
        assert.deepEqual(rules(css), ["[a][data-size=\"s\"] { --h: 1px; --w: 2px }", "[a] { --h: 1px }"])
        assert.deepEqual(outcome.rules.map(r => r.removed), [false])
        const only = reset("[a] { --h: 1px }", [T("a")])
        assert.deepEqual([only.outcome.changed, only.outcome.rules], [false, []])
    })

    test("a selector list is split: the other selectors keep the rule, a clone before it keeps the reset part's custom properties", () => {
        assert.equal(reset("[a], [b] { color: red }", [T("a")]).css, "[b] { color: red }")
        assert.equal(reset("[b],[a],[c] { color: red }", [T("a")]).css, "[b],[c] { color: red }")
        const { css, outcome } = reset("[a],\n[b] {\n    --p: 1px;\n    padding: var(--p);\n}", [T("a")])
        assert.equal(css, "[a] {\n    --p: 1px;\n}\n[b] {\n    --p: 1px;\n    padding: var(--p);\n}")
        assert.deepEqual(outcome.rules.map(r => [r.selectors.map(s => s.selector), r.removed]), [[["[a]"], false]])
    })

    test("a reset part among in-place alternatives is guarded, with no specificity change, before a pseudo-element", () => {
        const src = "[r] :is([a], [b], :is(ds-icon,[ds-icon])) { width: 1em }\n:is([a], [b])::after { content: \"\" }\n[r]:nth-child(2 of [a]) { color: red }\n:where([a], [b]) { top: 0 }"
        const { css, outcome } = reset(src, [T("a")])
        const expected = [
            "[r] :is([a], [b], :is(ds-icon,[ds-icon])):where(:not([a])) { width: 1em }",
            ":is([a], [b]):where(:not([a]))::after { content: \"\" }",
            "[r]:nth-child(2 of [a]):where(:not([a])) { color: red }",
            ":where([a], [b]):where(:not([a])) { top: 0 }",
        ]
        assert.deepEqual(rules(css), expected)
        const before = rules(src).map(r => r.split(" {")[0])
        assert.deepEqual(expected.map(r => specificityList(r.split(" {")[0])), before.map(s => specificityList(s)))
        assert.deepEqual(outcome.guarded.map(g => [g.selector, g.attrs]), [
            ["[r] :is([a], [b], :is(ds-icon,[ds-icon]))", ["a"]],
            [":is([a], [b])::after", ["a"]],
            ["[r]:nth-child(2 of [a])", ["a"]],
            [":where([a], [b])", ["a"]],
        ])
        assert.deepEqual(outcome.rules, [])
        // two reset parts in one guard; a list mixing a guarded and a dropped selector
        assert.deepEqual(rules(reset(":is([a], [b], [c]) { top: 0 }", [T("a"), T("b")]).css), [":is([a], [b], [c]):where(:not([a],[b])) { top: 0 }"])
        assert.deepEqual(rules(reset("[a], :is([a], [c]) { top: 0 }", [T("a")]).css), [":is([a], [c]):where(:not([a])) { top: 0 }"])
        // a guard takes the rule's declarations off the reset element: it records them, with their conditions
        const media = reset("@media (x) { [r] :is([a], [b])::before { top: 0; --k: 1 } }", [T("a")]).outcome.guarded[0]
        assert.deepEqual([media.declarations.map(d => d.prop), media.context, media.pseudoElement], [["top"], ["@media (x)"], true])
    })

    test("custom properties stay for guarded elements too: a rule of only custom properties is never guarded, a mixed one gets a clone", () => {
        const only = reset(":is([a], [b]) { --h: 1px }", [T("a")])
        assert.deepEqual([only.css, only.outcome.changed, only.outcome.guarded], [":is([a], [b]) { --h: 1px }", false, []])
        const { css, outcome } = reset("[r] :is([a], [b]),\n[a] { --h: 1px; height: var(--h) }\n[c] { top: 0 }", [T("a")])
        assert.deepEqual(rules(css), ["[a],[r] :is([a], [b]) { --h: 1px }", "[r] :is([a], [b]):where(:not([a])) { --h: 1px; height: var(--h) }", "[c] { top: 0 }"])
        assert.deepEqual([outcome.rules.map(r => r.selectors.map(x => x.selector)), outcome.guarded.map(g => g.selector)], [[["[a]"]], ["[r] :is([a], [b])"]])
        assert.equal(reset(css, [T("a")]).outcome.changed, false, "idempotent")
    })

    test(":not(), :has(), ancestors and descendants are other elements: untouched", () => {
        const src = "[r]:not([a]) { color: red }\n[r]:has(> [a]) { gap: 0 }\n[a] [x] { top: 0 }\n[a] > [x]::before { content: \"\" }\n[footer] button:first-child { margin-right: 8px }"
        const { css, outcome } = reset(src, [T("a"), T("footer")])
        assert.equal(css, src)
        assert.equal(outcome.changed, false)
    })

    test("at-rules a reset empties go; an emptied layer block that first declares its layer stays a statement; @keyframes are untouched", () => {
        const src = [
            "@media (x) { [a] { color: red } }",
            "@supports (display: grid) { @media (y) { [a] { color: red } } }",
            "@container (min-width: 1px) { [a] { top: 0 } [b] { top: 1px } }",
            "@media (z) {}",
            "@keyframes spin { from { transform: none } to { transform: rotate(1turn) } }",
            "[a][data-spin] { animation: spin 1s }",
        ].join("\n")
        const { css } = reset(src, [T("a")])
        assert.equal(css, "@container (min-width: 1px) { [b] { top: 1px } }\n@media (z) {}\n@keyframes spin { from { transform: none } to { transform: rotate(1turn) } }")
        const layered = "@layer reset, components;\n@layer components { [a] { color: red } }\n@layer components { [b] { color: red } }"
        assert.equal(reset(layered, [T("a")]).css, "@layer reset, components;\n@layer components { [b] { color: red } }")
        assert.equal(reset("@layer components { [a] { color: red } }\n@layer utilities { [b] {} }", [T("a")]).css, "@layer components;\n@layer utilities { [b] {} }")
    })

    test("a statement a strip leaves last ends with `;`: a bundler concatenating the next stylesheet keeps its first rule", () => {
        const next = ":root { --probe: 1 }\n[x] { color: red }"
        const firstRule = (css: string) => {
            const root = postcss.parse(`${css}${next}`)
            return [root.nodes.filter(n => n.type === "rule").map(r => (r as postcss.Rule).selector), root.nodes.filter(n => n.type === "atrule").map(a => (a as postcss.AtRule).params)]
        }
        // a per-sheet file wholly reset: its only layer block becomes the statement declaring the layer
        const perSheet = resetCss("@layer components {\n[a] { color: red }\n}\n", [T("a")], { comment: false }).css as string
        assert.equal(perSheet, "@layer components;\n")
        assert.deepEqual(firstRule(perSheet), [[":root", "[x]"], ["components"]])
        // an aggregate whose last block goes: the order statement before it is left last
        const aggregate = resetCss("@layer reset, components;\n@layer components { [a] { color: red } }", [T("a")]).css as string
        assert.ok(aggregate.endsWith("@layer reset, components;"), aggregate)
        assert.deepEqual(firstRule(aggregate)[0], [":root", "[x]"])
        // nested: the last statement of a block is ended too
        assert.equal(reset("@media (x) { @layer a { [a] { color: red } } }\n[b] {}", [T("a")]).css, "@media (x) { @layer a; }\n[b] {}")
    })

    test("display defaults and other components' rules on a reset identity are kept, and the latter reported", () => {
        const src = ":where(ds-button:not([hidden])) { display: block }\n[chat] :is(ds-button,[ds-button]) { margin: 0 }\n[r] { color: red }\n[r][data-x] :is(ds-button,[ds-button]) { margin: 0 }"
        const { css, outcome } = reset(src, [T("r", { tag: "ds-button" })])
        assert.deepEqual(rules(css), [":where(ds-button:not([hidden])) { display: block }", "[chat] :is(ds-button,[ds-button]) { margin: 0 }", "[r][data-x] :is(ds-button,[ds-button]) { margin: 0 }"])
        assert.deepEqual(outcome.foreign, [
            { tag: "ds-button", selector: "[chat] :is(ds-button,[ds-button])", line: 2 },
            { tag: "ds-button", selector: "[r][data-x] :is(ds-button,[ds-button])", line: 4 },
        ])
    })

    test("@scope: :scope and & stand for the scope's start", () => {
        const src = "@scope ([a]) { :scope { color: red } [x] { color: blue } }\n@scope ([a], [b]) to ([c]) { :scope:hover { top: 0 } }"
        assert.deepEqual(rules(reset(src, [T("a")]).css), ["[x] { color: blue }", ":scope:hover:where(:not([a])) { top: 0 }"])
        assert.deepEqual(rules(reset("@scope ([b]) { :scope { color: red } }", [T("a")]).css), [":scope { color: red }"])
    })

    test("idempotent: a second pass changes nothing", async () => {
        const src = "[r] :is([a], [b]) { width: 1em }\n[a], [b] { --p: 1; color: red }\n[a] { top: 0 }\n@media (x) { [a] { top: 1px } }"
        const once = reset(src, [T("a")])
        const twice = reset(once.css, [T("a")])
        assert.equal(twice.css, once.css)
        assert.equal(twice.outcome.changed, false)
        const { styles, registry } = await designSystem()
        const everything = Object.entries(registry.scopes).flatMap(([scope, s]) => Object.entries(s.parts).map(([part, attr]) => T(attr, { scope, part, tag: s.roots.find(r => r.local === part)?.tag ?? null })))
        const first = resetCss(styles, everything)
        assert.ok(first.css)
        assert.equal(resetCss(first.css as string, everything).css, null)
    })

    test("no targets: nothing parsed or changed; a local @import is an error while resets are active; unflattened input is refused", () => {
        assert.deepEqual(resetCss("[a] { color: red }", []), { css: null, outcome: { rules: [], guarded: [], foreign: [], changed: false } })
        assert.equal(resetCss("@import \"./button.css\";", []).css, null)
        assert.throws(() => resetCss("@import \"./button.css\";\n[a] {}", [T("a")]), /\[reset-import\] @import "\.\/button\.css" in a design-system stylesheet while resets are active/)
        assert.throws(() => resetCss("@import url(components/button.css);", [T("a")]), /reset-import/)
        assert.equal(resetCss("@import url(\"https://fonts.example/x.css\");\n[b] {}", [T("a")]).css, null)
        assert.throws(() => resetCss("[a] { [b] { color: red } }", [T("a")]), /nested rule/)
    })

    test("resetCss starts a changed stylesheet with the reset comment (after @charset)", () => {
        const out = resetCss("@charset \"utf-8\";\n[a] { color: red }\n[b] {}", [T("a"), T("c", { label: "ds:core/y:c", sheet: "o/y.css" })])
        assert.equal(out.css, "@charset \"utf-8\";\n/* libstylist: reset ds:core/x:a (o/x.css) */\n[b] {}")
        assert.equal(resetCss("[a] {color: red}", [T("a")], { comment: false }).css, "")
    })

    test("stylistReset(): the PostCSS plugin reports each stylesheet's outcome", async () => {
        const seen: Array<[boolean, string | undefined]> = []
        const plugin = stylistReset({ resets: [T("a")], onOutcome: (o, file) => seen.push([o.changed, file]) })
        const result = await postcss([plugin]).process("[a] { color: red }\n[b] { color: blue }", { from: "styles.css" })
        assert.equal(result.css, "/* libstylist: reset ds:core/x:a (o/x.css) */\n[b] { color: blue }")
        await postcss([plugin]).process("[b] {}", { from: "code.css" })
        assert.deepEqual(seen, [[true, "styles.css"], [false, "code.css"]])
        assert.equal((await postcss([stylistReset({ resets: [] })]).process("[a] {}", { from: undefined })).css, "[a] {}")
        assert.throws(() => stylistReset({} as never), /needs \{ resets \}/)
    })
})

describe("layout contracts and the report", () => {
    test("layoutKinds: what a parent reads from the element, what its children rely on", () => {
        assert.deepEqual(layoutKinds("flex-shrink", "0"), ["item"])
        assert.deepEqual(layoutKinds("justify-self", "start"), ["item"])
        assert.deepEqual(layoutKinds("top", "0"), ["item"])
        assert.deepEqual(layoutKinds("position", "relative"), ["item", "container"])
        assert.deepEqual(layoutKinds("position", "static"), [])
        assert.deepEqual(layoutKinds("display", "flex"), ["container"])
        assert.deepEqual(layoutKinds("display", "none"), ["container"])
        assert.deepEqual(layoutKinds("display", "block flex"), ["container"])
        assert.deepEqual(layoutKinds("display", "table-cell"), ["container"])
        assert.deepEqual(layoutKinds("display", "block"), [])
        assert.deepEqual(layoutKinds("gap", "8px"), ["container"])
        assert.deepEqual(layoutKinds("overflow-x", "auto"), ["container"])
        assert.deepEqual(layoutKinds("color", "red"), [])
        // sizes by value: a zero minimum lets a flex or grid item shrink, a relative size reads the parent, an auto margin places the item
        assert.deepEqual(layoutKinds("min-width", "0"), ["item"])
        assert.deepEqual(layoutKinds("min-height", "0px"), ["item"])
        assert.deepEqual(layoutKinds("min-width", "120px"), [])
        assert.deepEqual(layoutKinds("width", "100%"), ["item"])
        assert.deepEqual(layoutKinds("height", "calc(100% - 8px)"), ["item"])
        assert.deepEqual(layoutKinds("inline-size", "stretch"), ["item"])
        assert.deepEqual(layoutKinds("width", "16px"), [])
        assert.deepEqual(layoutKinds("margin-left", "auto"), ["item"])
        assert.deepEqual(layoutKinds("margin", "0 auto"), ["item"])
        assert.deepEqual(layoutKinds("margin", "0 8px"), [])
    })

    test("acknowledgedDeclarations: the override rules whose subject is the target — properties with their longhands, the selector's conditions, the at-rules", () => {
        const css = ":is(ds-modal-header,[ds-modal-header]):hover { position: relative }\n@media (x) { [_cxclass_ds-h] { inset: 0 } }\n[_cxclass_ds-h] [x] { display: flex }\n[_cxclass_ds-o] { flex: 1 }\n:root[data-theme=\"dark\"] [_cxclass_ds-q] [_cxclass_ds-o][data-size=small]::before { order: 1 }"
        const h = acknowledgedDeclarations(css, { attr: "_cxclass_ds-h", tag: "ds-modal-header" })
        assert.deepEqual(h, [
            { props: ["position"], conditions: [":hover"], context: [] },
            { props: ["bottom", "inset", "inset-block", "inset-block-end", "inset-block-start", "inset-inline", "inset-inline-end", "inset-inline-start", "left", "right", "top"], conditions: [], context: ["@media (x)"] },
        ])
        assert.deepEqual(acknowledgedDeclarations(css, { attr: "_cxclass_ds-o", tag: null }), [
            { props: ["flex", "flex-basis", "flex-grow", "flex-shrink"], conditions: [], context: [] },
            { props: ["order"], conditions: ["::before", ":root", "[data-size=\"small\"]", "[data-theme=\"dark\"]"], context: [] },
        ])
    })

    test("selectorConditions: state, pseudo-classes and elements, document context — not parts, identities or combinators", () => {
        const of = (s: string) => [...selectorConditions(selectorParser().astSync(s).first)].sort()
        assert.deepEqual(of(":is(ds-button,[ds-button])[data-loading] > [_cxclass_ds-a] [_cxclass_ds-b]"), ["[data-loading]"])
        assert.deepEqual(of("[_cxclass_ds-a][data-kind='primary']:hover [x-y]"), [":hover", "[data-kind=\"primary\"]"])
        assert.deepEqual(of(":is([_cxclass_ds-a][data-align=right], [_cxclass_ds-b]) [disabled]"), [":is([_cxclass_ds-a][data-align=right], [_cxclass_ds-b])", "[disabled]"])
        assert.deepEqual(of("ds-modal [_cxclass_ds-a]:not([hidden])"), [":not([hidden])"])
    })

    test("acknowledges: an override re-declaration holds wherever the design system's did — not under a state or a media query it lacks", () => {
        // part attributes as the design system emits them: [r] root, [c] content, [l] loader
        const at = (css: string) => css.replace(/\[([rcl])\]/g, "[_cxclass_ds-$1]")
        const ack = (override: string, selector: string, context: string[] = []) => acknowledges(acknowledgedDeclarations(at(override), { attr: "_cxclass_ds-l", tag: null }), "display", at(selector), context)
        // the design system hides the loader until the loading state shows it
        assert.equal(ack("[r][data-loading] [l] { display: flex }", "[l]"), false, "a state-only re-declaration leaves every other state without it")
        assert.equal(ack("[r][data-loading] [l] { display: flex }", "[r][data-loading] [c] [l]"), true, "the same state")
        assert.equal(ack("[l] { display: grid }", "[r][data-loading] [c] [l]"), true, "an unconditional one holds in every state")
        assert.equal(ack(":is(ds-button,[ds-button]) [l] { display: grid }", "[l]"), true, "structure is no condition")
        assert.equal(ack("[l]::before { display: none }", "[l]"), false, "a pseudo-element is another box")
        assert.equal(ack("@media (min-width: 600px) { [l] { display: none } }", "[l]"), false)
        assert.equal(ack("@media (min-width: 600px) { [l] { display: none } }", "[l]", ["@media (min-width:  600px)"]), true)
        assert.equal(ack("[l] { display: none }", "[l]", ["@media (x)"]), true)
        assert.equal(ack("[l] { place-items: center }", "[l]"), false, "another property")
        assert.equal(acknowledges(acknowledgedDeclarations(at("[l] { place-items: center }"), { attr: "_cxclass_ds-l", tag: null }), "align-items", at("[l]"), []), true, "a shorthand sets its longhands")
        assert.equal(ack("[l]:hover { display: none }\n[l] { display: none }", "[l], [l]:focus"), true, "every selector of the rule is covered")
    })

    test("resetReports: unique counts across stylesheets, layout notes not re-declared, guarded and foreign rules, empty resets", () => {
        const a = T("a", { tag: "ds-a" })
        const sheet = "[a] { display: flex; color: red; flex-shrink: 0 }\n[a]::after { position: absolute; inset: 0 }\n[r] :is([a], [b]) { width: 1em }\n[chat] :is(ds-a,[ds-a]) { margin: 0 }"
        const one = reset(sheet, [a, T("z")])
        const two = reset(sheet, [a, T("z")])
        const [report, empty] = resetReports([a, T("z")], [{ file: "dist/styles.css", outcome: one.outcome }, { file: "dist/components/a.css", outcome: two.outcome }], {
            acknowledged: t => (t.attr === "a" ? [{ props: ["display"], conditions: [], context: [] }] : []),
        })
        // the guarded icon slot counts: its width no longer reaches [a]
        assert.deepEqual([report.declarations, report.rules, report.stylesheets], [6, 3, ["dist/styles.css", "dist/components/a.css"]])
        assert.deepEqual(report.layout.map(n => [n.prop, n.kinds, n.file, n.line]), [["flex-shrink", ["item"], "dist/styles.css", 1]])
        assert.deepEqual(report.guarded.map(g => g.guarded), ["[r] :is([a], [b]):where(:not([a]))"])
        assert.deepEqual(report.foreign, [{ file: "dist/styles.css", selector: "[chat] :is(ds-a,[ds-a])", line: 4 }])
        assert.equal(report.empty, false)
        assert.deepEqual(formatResetReport(report), [
            { level: "reset", text: "ds:core/x:a — 6 declarations in 3 rules (dist/styles.css, dist/components/a.css); 1 selector kept for other elements; 1 rule of other components still style it" },
            { level: "note", text: "ds:core/x:a drops flex-shrink: 0 (dist/styles.css:1) — its parent's layout may rely on it; declare it in o/x.css to keep it" },
        ])
        assert.equal(empty.empty, true)
        assert.deepEqual(formatResetReport(empty), [{
            level: "error",
            text: "[empty-reset] o/x.css:2: the reset of ds:core/x:z drops nothing — no design-system rule styles that part any more (or only sets custom properties there); remove \"z\" from @stylist reset",
        }])
    })

    test("formatResetReports: a whole reset is empty only when no part drops anything", () => {
        const whole = (attr: string) => T(attr, { whole: true, scope: "y", label: `ds:core/y:${attr}` })
        const sheet = reset("[a] { display: none }", [whole("a"), whole("b")])
        const reports = resetReports([whole("a"), whole("b")], [{ file: "styles.css", outcome: sheet.outcome }])
        assert.deepEqual(reports.map(r => r.empty), [false, true])
        assert.deepEqual(formatResetReports(reports), [
            { level: "reset", text: "ds:core/y:a — 1 declaration in 1 rule (styles.css)" },
            { level: "note", text: "ds:core/y:a drops display: none (styles.css:1) — the design system hides it until a state shows it; declare it in o/x.css to keep it" },
        ])
        const none = resetReports([whole("b"), whole("c")], [{ file: "styles.css", outcome: sheet.outcome }])
        assert.deepEqual(formatResetReports(none), [{ level: "error", text: "[empty-reset] o/x.css:2: the whole reset of ds:core/y drops nothing — no design-system rule styles its parts any more; remove @stylist reset;" }])
    })
})

describe("over the fixture design system", () => {
    const B = (part: string) => partAttr({ prefix: "ds", namespace: "core", scope: "button", part })
    const M = (part: string) => partAttr({ prefix: "ds", namespace: "core", scope: "modal", part })
    const TB = (part: string) => partAttr({ prefix: "ds", namespace: "core", scope: "table", part })

    /** Every rule left whose subject is (or may be) a reset part carries custom properties only: the others are guarded. */
    const assertStripped = (css: string, targets: ResetTarget[]) => {
        const match = attributeMatcher(targets.map(t => t.attr))
        postcss.parse(css).walkRules(rule => {
            if (/keyframes$/i.test((rule.parent as postcss.AtRule | undefined)?.name ?? "")) return
            for (const complex of selectorParser().astSync(rule.selector).nodes) {
                const c = classifySubject(subjectCompound(complex), match)
                if (c.match !== "none") assert.ok(rule.nodes.every(n => n.type !== "decl" || (n as postcss.Declaration).prop.startsWith("--")), `${rule.selector} keeps only custom properties`)
            }
        })
    }

    test("Button: a part reset (loader, icon) strips its rules, guards the shared icon slot, keeps custom properties, display defaults and keyframes", async () => {
        const { styles } = await designSystem()
        const r = await resolveSheets({ "o/button.css": "@stylist override Button from \"@ds/react\";\n@stylist reset loader icon;\n.loader { display: grid }" })
        assert.deepEqual(r.errors, [])
        const out = resetCss(styles, r.resets, { from: "styles.css" })
        const css = out.css as string
        assert.ok(css.startsWith("/* libstylist: reset ds:core/button:icon, ds:core/button:loader (o/button.css) */\n@layer reset, tokens, components, utilities;"))
        assertStripped(css, r.resets)
        assert.ok(!css.includes(`[${B("loader")}] {`) && !css.includes(`[${B("loader")}][data-hidden]`) && !css.includes(`[${B("content")}] [${B("loader")}]`))
        assert.ok(css.includes("@keyframes ds-button-spin"), "keyframes stay")
        assert.ok(css.includes("--btn-h: 24px;") && css.includes("--btn-icon-w: 16px;"), "custom properties stay")
        assert.ok(css.includes(":where(ds-modal:not([hidden]))"), "display defaults stay")
        assert.ok(css.includes(`[${B("root")}] :is([${B("icon")}],[${B("chevron")}],:is(ds-icon,[ds-icon])):where(:not([${B("icon")}])) {`), "the icon slot keeps the chevron and an Icon")
        assert.ok(!css.includes(`[${B("icon")}][data-align="left"]`))
        // every rule the reset did not touch is byte-identical
        const untouched = (text: string) => rules(text).filter(x => !x.includes(B("loader")) && !x.includes(B("icon")))
        assert.deepEqual(untouched(css), untouched(styles))

        const reports = resetReports(r.resets, [{ file: "styles.css", outcome: out.outcome }])
        // the icon's own rule, and the two shared slot rules it is guarded out of
        assert.deepEqual(reports.map(x => [x.target.part, x.declarations, x.rules, x.guarded.length]), [["icon", 4, 3, 2], ["loader", 6, 4, 0]])
        assert.deepEqual(reports[0].layout.map(n => `${n.prop}: ${n.value}`), ["display: flex"])
    })

    test("Button root: the root part's own rules go, its --btn-* stay, the other components' rules on <button ds-button> are reported", async () => {
        const { styles } = await designSystem()
        const r = await resolveSheets({ "o/button.css": "@stylist override Button from \"@ds/react\";\n@stylist reset root;\n.root { display: inline-flex }" })
        const out = resetCss(styles, r.resets, { from: "styles.css" })
        const css = out.css as string
        assertStripped(css, r.resets)
        assert.ok(css.includes(`[${B("root")}][data-size="small"] {\n        --btn-h: 24px;`))
        assert.ok(css.includes(`[${B("root")}][data-kind="primary"][data-theme="fill"] {\n        --btn-bg: blue;\n    }`), "a mixed rule keeps its custom properties")
        assert.ok(css.includes(`[${B("root")}] :is([${B("icon")}]`), "descendant rules stay")
        const [report] = resetReports(r.resets, [{ file: "styles.css", outcome: out.outcome }])
        assert.deepEqual(report.foreign.map(f => f.selector), [`[${partAttr({ prefix: "ds", namespace: "core", scope: "chat", part: "root" })}] :is(ds-button,[ds-button])`])
        assert.deepEqual(report.layout.map(n => `${n.prop}: ${n.value}`), ["display: flex", "align-items: center", "flex-shrink: 0", "position: relative"])
    })

    test("Modal: a re-declared layout contract is acknowledged, a dropped one — or one re-declared only under a state — is a note; pseudo-element rules are no contract", async () => {
        const { styles } = await designSystem()
        const src = "@stylist override Modal from \"@ds/react\";\n@stylist reset header frame;\n.header { position: relative; padding: 8px }\n.frame:hover { overflow: clip }"
        const r = await resolveSheets({ "o/modal.css": src })
        const compiled = await compileOverride(src, { from: "o/modal.css", plugin: r.sheets[0].plugin, statement: ["components", "app.overrides"] })
        const out = resetCss(styles, r.resets, { from: "dist/styles.css" })
        assertStripped(out.css as string, r.resets)
        assert.ok((out.css as string).includes(`[${M("footer")}] button:first-child`), "descendant rules of other parts stay")
        // a stylesheet is named by its path under the design system's dist (what reports print)
        const reports = resetReports(r.resets, [{ file: "styles.css", outcome: out.outcome }], { acknowledged: t => acknowledgedDeclarations(compiled.css, t) })
        const lines = reports.flatMap(formatResetReport).map(l => `${l.level} ${l.text.replace(/\(styles\.css:\d+\)/, "(styles.css:N)")}`)
        assert.deepEqual(lines, [
            "reset ds:core/modal:frame — 7 declarations in 3 rules (styles.css)",
            "note ds:core/modal:frame drops position: relative (styles.css:N) — its descendants may position against it, and its parent may place it; declare it in o/modal.css to keep it",
            // `.frame:hover { overflow: clip }` holds only while hovered: the frame lost its overflow everywhere else
            "note ds:core/modal:frame drops overflow: hidden (styles.css:N) — its children's layout may rely on it; declare it in o/modal.css to keep it",
            "reset ds:core/modal:header — 2 declarations in 1 rule (styles.css); 1 rule of other components still style it",
        ])
        assert.ok(!(out.css as string).includes("prefers-reduced-motion"), "the emptied @media is gone")
    })

    test("a part styled only through a shared :is() rule (the tooltip's link-icon) is reset by its guards: counted, noted, touched — never an empty reset", async () => {
        const { styles } = await designSystem()
        const TT = (part: string) => partAttr({ prefix: "ds", namespace: "core", scope: "tooltip", part })
        const r = await resolveSheets({ "o/tooltip.css": "@stylist override tooltip from \"@ds/react\";\n@stylist reset link-icon;\n.link-icon { width: 12px }" })
        assert.deepEqual(r.errors, [])
        const out = resetCss(styles, r.resets, { from: "styles.css" })
        assert.deepEqual(out.outcome.rules, [], "no rule of its own")
        assertStripped(out.css as string, r.resets)
        assert.ok(rules(out.css as string).includes(`[${TT("link")}] :is([${TT("link-icon")}], :is(ds-icon,[ds-icon])) { --tooltip-icon: 1em }`), "its custom property stays")
        assert.ok(rules(out.css as string).includes(`[${TT("link")}] :is([${TT("link-icon")}], :is(ds-icon,[ds-icon])):where(:not([${TT("link-icon")}])) { --tooltip-icon: 1em; display: flex; width: var(--tooltip-icon); margin-left: auto }`), "an Icon keeps the slot")
        assert.deepEqual(touchedTargets(r.resets, out.outcome).map(t => t.label), ["ds:core/tooltip:link-icon"])
        const compiled = await compileOverride("@stylist override tooltip from \"@ds/react\";\n.link-icon { width: 12px }", { from: "o/tooltip.css", plugin: r.sheets[0].plugin, statement: ["components", "app.overrides"] })
        const [report] = resetReports(r.resets, [{ file: "styles.css", outcome: out.outcome }], { acknowledged: t => acknowledgedDeclarations(compiled.css, t) })
        assert.deepEqual([report.empty, report.declarations, report.rules, report.guarded.length], [false, 3, 1, 1])
        assert.deepEqual(formatResetReports([report]).map(l => `${l.level} ${l.text.replace(/\(styles\.css:\d+\)/, "(styles.css:N)")}`), [
            "reset ds:core/tooltip:link-icon — 3 declarations in 1 rule (styles.css); 1 selector kept for other elements",
            "note ds:core/tooltip:link-icon drops display: flex (styles.css:N) — its children's layout may rely on it; declare it in o/tooltip.css to keep it",
            "note ds:core/tooltip:link-icon drops margin-left: auto (styles.css:N) — it places the element in its flex or grid parent; declare it in o/tooltip.css to keep it",
        ])
    })

    test("Table: a whole reset strips every part, a td reset splits the shared .td, .th rule and leaves the compact-density rule to a root reset", async () => {
        const { styles } = await designSystem()
        const whole = await resolveSheets({ "o/table.css": "@stylist override Table from \"@ds/react\";\n@stylist reset;\n.root { display: grid }" })
        const all = resetCss(styles, whole.resets)
        assertStripped(all.css as string, whole.resets)
        assert.ok(rules(all.css as string).includes(`[${TB("td")}], [${TB("th")}] { --cell-pad: 8px }`), "the custom properties of a dropped list stay")
        assert.ok((all.css as string).includes(":where(ds-table-td:not([hidden]))"))

        const td = await resolveSheets({ "o/table.css": "@stylist override Table from \"@ds/react\";\n@stylist reset td;\n.td { display: flex }" })
        const css = resetCss(styles, td.resets).css as string
        const list = rules(css)
        const at = list.indexOf(`[${TB("td")}] { --cell-pad: 8px }`)
        assert.ok(at > 0 && list[at + 1] === `[${TB("th")}] { --cell-pad: 8px; padding: var(--cell-pad) }`, "the list is split, the clone first")
        assert.ok(!css.includes(`[data-density="compact"] [${TB("td")}]`), "the compact rule's subject is td")

        const root = await resolveSheets({ "o/table.css": "@stylist override Table from \"@ds/react\";\n@stylist reset root;\n.root {}" })
        assert.ok((resetCss(styles, root.resets).css as string).includes(`[data-density="compact"] [${TB("td")}]`), "a root reset keeps its descendants' rules")
    })

    test("the gram aggregate is reset with the gram namespace's attributes; a stylesheet a reset does not reach stays untouched", async () => {
        const { gram, styles } = await designSystem()
        const r = await resolveSheets({ "o/list.css": "@stylist override ListCollection.Root from \"@ds/gram\";\n@stylist reset item;\n.item { display: block }" })
        assert.equal(resetCss(styles, r.resets).css, null)
        const out = resetCss(gram, r.resets)
        assert.ok(out.css && !out.css.includes(`[${partAttr({ prefix: "ds", namespace: "gram", scope: "list-collection", part: "item" })}] {`))
    })
})
