// Adversarial cases for the PostCSS layer (SPEC §4): whitespace inside :global(), case-insensitive
// pseudo-classes and directives, unflattened input, `[class]` selectors, at-rule preludes,
// directive grammar parity with stylelint, emitted forms, hash inputs and determinism.
import assert from "node:assert/strict"
import { test } from "node:test"

import postcss from "postcss"
import nesting from "postcss-nesting"

import { partAttr } from "../src/hash/index.js"
import {
    collectSheet,
    displayDefaultDeclarations,
    displayDefaultRule,
    findClassSelectors,
    parseDirective,
    preludeSelectors,
    specificityList,
    stylist,
    type StylistOptions,
    type StylistSink,
} from "../src/postcss/index.js"
import { DISPLAY_KEYWORDS, parseStylistDirective } from "../src/stylelint/directives.js"

const base: StylistOptions = { prefix: "elo", namespace: "core", scope: "alert", reportGlobals: false }
const attr = (scope: string, part: string, namespace = "core") => partAttr({ prefix: "elo", namespace, scope, part })
const ROOT = attr("alert", "root")
const ICON = "_cxclass_elo-or4d4l" // SPEC §3.1 test vector

const run = async (css: string, opts: Partial<StylistOptions> = {}, flatten = true) =>
    (await postcss([...(flatten ? [nesting()] : []), stylist({ ...base, ...opts })]).process(css, { from: "alert.css" })).css

const selectors = (css: string): string[] => {
    const out: string[] = []
    postcss.parse(css).walkRules(r => {
        if (!/keyframes$/i.test((r.parent as { name?: string } | undefined)?.name ?? "")) out.push(r.selector)
    })
    return out
}

test(":global() drops the whitespace inside its parentheses (a compound stays a compound)", async () => {
    // `.root:global( .hover )` means the root element with .hover — never a descendant .hover
    assert.deepEqual(selectors(await run(".root:global( .hover ) {}")), [`[${ROOT}].hover`])
    assert.deepEqual(selectors(await run(".root:global(\n  .hover.x\n) .icon {}")), [`[${ROOT}].hover.x [${ICON}]`])
    assert.deepEqual(selectors(await run(".root :global( .a ) .icon {}")), [`[${ROOT}] .a [${ICON}]`])
    // same result as the unpadded form, byte for byte
    assert.equal(await run(".root:global( .hover ):hover {}"), await run(".root:global(.hover):hover {}"))
})

test("pseudo-class names and directives are ASCII case-insensitive", async () => {
    assert.deepEqual(selectors(await run(".root :GLOBAL(.legacy) .icon {}")), [`[${ROOT}] .legacy [${ICON}]`])
    assert.deepEqual(selectors(await run(".root :Component(Tabs) :CX(alert:icon) {}")), [`[${ROOT}] :is(elo-tabs,[elo-tabs]) [${ICON}]`])
    const sink: StylistSink = {}
    const css = await run("@STYLIST root Alert display block;\n.root {}", { sink })
    assert.doesNotMatch(css, /@stylist/i)
    assert.deepEqual(sink.roots, [{ component: "Alert", local: "root", tag: "elo-alert", display: "block" }])
    assert.deepEqual(collectSheet("@Stylist scope pinned;\n.x:Global(.y) {}", { file: "a.css", group: "g" }), {
        file: "a.css",
        group: "g",
        scope: "pinned",
        pinned: true,
        roots: [],
        classes: ["x"],
        globals: [".y"],
        keyframes: [],
        components: [],
        cx: [],
        errors: [],
    })
})

test("unflattened input is refused, nested at-rules included", async () => {
    await assert.rejects(run(".root { .icon {} }", {}, false), /nested rule — run postcss-nesting/)
    await assert.rejects(run(".root { @media (min-width: 1px) { .icon { color: red } } }", {}, false), /nested @media — run postcss-nesting/)
    await assert.rejects(run(".root { @supports (display: grid) { display: grid } }", {}, false), /nested @supports/)
    // postcss-nesting leaves @scope (and other non-conditional at-rules) nested: say so
    await assert.rejects(run(".root { @scope (.icon) { .message { color: red } } }"), /@scope inside a rule is not flattened by postcss-nesting — write it at the top level/)
    // the same sheets are fine once postcss-nesting has run
    assert.deepEqual(selectors(await run(".root { @media (min-width: 1px) { .icon { color: red } } }")), [`[${ROOT}] [${ICON}]`])
})

test("[class…] selectors are class selectors: refused outside :global(), audited, reported", async () => {
    await assert.rejects(run(".root[class] {}"), /\[class\] selects a class/)
    await assert.rejects(run(".root [CLASS~=\"x\"] {}"), /selects a class/)
    assert.deepEqual(selectors(await run(".root :global([class~=x]) {}")), [`[${ROOT}] [class~=x]`])
    const hits = findClassSelectors(".a [class^=\"ls-\"] {} [data-x] {}")
    assert.deepEqual(hits.map(h => [h.kind, h.className]), [["class", "a"], ["attribute", "[class^=\"ls-\"]"]])
    const info = collectSheet(".root [class] {} .ok :global([class]) {}", { file: "a.css", group: "g" })
    assert.deepEqual(info.errors.map(e => e.kind), ["selector"])
    assert.match(info.errors[0].message, /selects a class/)
})

test("@scope and @supports selector() preludes are rewritten and audited like rule selectors", async () => {
    const sink: StylistSink = {}
    const css = await run([
        "@scope (.root) to (.content) { .icon { color: red } }",
        "@supports selector(.root:has(.icon)) and (not selector(:global(.x))) { .root { color: blue } }",
        "@scope (.root :global(.theme)) { :scope { color: green } }",
    ].join("\n"), { sink })
    const content = attr("alert", "content")
    assert.match(css, new RegExp(`@scope \\(\\[${ROOT}\\]\\) to \\(\\[${content}\\]\\) \\{ \\[${ICON}\\]`))
    assert.match(css, new RegExp(`@supports selector\\(\\[${ROOT}\\]:has\\(\\[${ICON}\\]\\)\\) and \\(not selector\\(\\.x\\)\\)`))
    assert.match(css, new RegExp(`@scope \\(\\[${ROOT}\\] \\.theme\\)`))
    assert.deepEqual(sink.parts, { content, icon: ICON, root: ROOT })
    assert.deepEqual(sink.globals, [".theme", ".x"])
    // nothing but the spliced hooks remains
    assert.deepEqual(findClassSelectors(css).map(h => h.className).sort(), ["theme", "x"])
    // pass 1 sees the same parts
    const info = collectSheet("@scope (.root) to (.content) { .icon {} } @supports selector(.probe) {}", { file: "alert.css", group: "components" })
    assert.deepEqual(info.classes, ["content", "icon", "probe", "root"])
    // other at-rules have no prelude selectors
    const at = postcss.parse("@media (min-width: 1px) {} @supports (display: grid) {} @supports not-a-selector(.x) {}").nodes
    assert.deepEqual(at.map(n => preludeSelectors(n as never).length), [0, 0, 0])
})

test("directive grammar matches the stylelint layer's (lint and build never disagree)", () => {
    const cases = [
        "root Alert",
        "root Alert display block",
        "root Modal.Header as header",
        "root Modal.Header as header display inline-flex",
        "root Alert display flex as header",
        "root Alert as",
        "root Alert as Header",
        "root Alert display",
        "root Alert display inherit",
        "root Alert display -webkit-box",
        "root Alert display block flow",
        "root Alert display Block",
        "root alert",
        "root player/Alert",
        "root Alert extra",
        "root Alert as a as b",
        "scope text-input",
        "scope",
        "scope a b",
        "scope Text",
        "tag Alert",
        "",
        // an override sheet's (SPEC §9.2)
        "override Button from \"@livesession/eloquentui-react\"",
        "override Table.Tr from '@ds/react' within render/RenderCart",
        "override tooltip from \"@ds/react\" within RenderCart",
        "override Button",
        "override Button from @ds/react",
        "override Button from \"@ds/react/button\"",
        "override Button from \"./button\"",
        "override button_x from \"@ds/react\"",
        "override Button from \"@ds/react\" within",
        "override Button from \"@ds/react\" within cart",
        "override Button from \"@ds/react\" inside Cart",
        "reset",
        "reset loader icon",
        "reset .loader",
        "reset Loader",
    ]
    for (const params of cases) {
        let ours: boolean
        try {
            parseDirective(params)
            ours = true
        } catch {
            ours = false
        }
        assert.equal(ours, parseStylistDirective(params).ok, `"@stylist ${params}"`)
    }
    for (const keyword of DISPLAY_KEYWORDS) assert.deepEqual(parseDirective(`root Alert display ${keyword}`), { kind: "root", component: "Alert", local: "root", display: keyword })
})

test("emitted forms: value-less part attributes, never a class, never a value", async () => {
    const css = await run(".root:hover > .icon ~ .message, .root .icon::after, .root:not(.message) {}")
    const attrs = [...css.matchAll(/\[([^\]]*)\]/g)].map(m => m[1])
    assert.ok(attrs.length >= 6)
    for (const a of attrs) assert.match(a, /^_cxclass_elo-[0-9a-z]{6}$/, "an attribute name with no value and no operator")
    assert.doesNotMatch(css.replace(/\[_cxclass_elo-[0-9a-z]{6}\]/g, "[]"), /class|=|\./)
    assert.deepEqual(findClassSelectors(css), [])
})

test("hash inputs: (prefix, namespace, scope, part) — scope pin, namespace and prefix all change the attribute", async () => {
    const one = async (css: string, opts: Partial<StylistOptions>, from = "alert.css") => {
        const sink: StylistSink = {}
        await postcss([stylist({ ...base, ...opts, sink })]).process(css, { from })
        return sink.parts ?? {}
    }
    assert.equal((await one(".icon {}", {})).icon, ICON)
    assert.equal((await one(".icon {}", { scope: undefined })).icon, ICON, "scope defaults to the basename")
    assert.equal((await one("@stylist scope alert;\n.icon {}", { scope: undefined }, "renamed-alert.css")).icon, ICON, "a pin keeps the hash across renames")
    assert.notEqual((await one(".icon {}", { namespace: "player" })).icon, ICON)
    assert.notEqual((await one(".icon {}", { prefix: "app" })).icon, ICON)
    assert.match((await one(".icon {}", { prefix: "app" })).icon, /^_cxclass_app-[0-9a-z]{6}$/)
    assert.match((await one(".icon {}", { hashLength: 8 })).icon, /^_cxclass_elo-[0-9a-z]{8}$/)
    // :cx() from another sheet hashes with the referenced scope
    assert.deepEqual(selectors(await run(".root :cx(alert:icon) {}", { scope: "banner" })), [`[${attr("banner", "root")}] [${ICON}]`])
})

test("display defaults: after the preamble, in directive order, zero specificity; none without directives", async () => {
    const css = await run([
        "@charset \"utf-8\";",
        "@import url(\"x.css\");",
        "/* header */",
        ".root { color: red }",
        "@stylist root Modal.Header as header display flex;",
        "@stylist root Alert display block;",
        "@stylist root Alert.Body as body;",
    ].join("\n"))
    const rules = selectors(css)
    assert.deepEqual(rules.slice(0, 2), [":where(elo-modal-header:not([hidden]))", ":where(elo-alert:not([hidden]))"])
    assert.ok(css.indexOf("@import") < css.indexOf(":where("))
    for (const r of rules.slice(0, 2)) assert.deepEqual(specificityList(r), [[0, 0, 0]])
    assert.doesNotMatch(await run("@stylist root Alert;\n.root {}"), /:where/)
    // a sheet with nothing but a display directive still gets its rule
    assert.equal(selectors(await run("@stylist root Alert display grid;")).length, 1)
})

test("display defaults: block is the UA div pair, inline (the custom-element default) emits nothing, others emit display only", async () => {
    const block = await run("@stylist root Alert display block;")
    assert.match(block, /:where\(elo-alert:not\(\[hidden\]\)\) \{\s*display: block;\s*unicode-bidi: isolate;?\s*\}/)
    const inline = await run("@stylist root Alert display inline;\n.root { color: red }")
    assert.doesNotMatch(inline, /:where|display|unicode-bidi/)
    const flex = await run("@stylist root Alert display inline-flex;")
    assert.match(flex, /\{\s*display: inline-flex;?\s*\}/)
    assert.doesNotMatch(flex, /unicode-bidi/)
    const sink: StylistSink = {}
    await run("@stylist root Alert display inline;", { sink })
    assert.deepEqual(sink.roots, [{ component: "Alert", local: "root", tag: "elo-alert", display: "inline" }])
    assert.deepEqual(displayDefaultDeclarations("block"), [["display", "block"], ["unicode-bidi", "isolate"]])
    assert.equal(displayDefaultRule("elo-alert", "inline"), undefined)
    assert.equal(displayDefaultRule("elo-alert", "block"), ":where(elo-alert:not([hidden])) { display: block; unicode-bidi: isolate }")
})

test("keyframes: only local names are rewritten; global references and custom properties stay", async () => {
    const css = await run([
        "@-webkit-keyframes spin { to { opacity: 1 } }",
        "@keyframes spin { to { opacity: 1 } }",
        ".root { animation: 0.3s ease-in-out 0s 1 slideInScale; -webkit-animation: spin 1s; }",
        ".icon { animation-name: var(--spin, spin), none; --spin: spin; }",
    ].join("\n"))
    assert.match(css, /@-webkit-keyframes elo-alert-spin/)
    assert.match(css, /@keyframes elo-alert-spin/)
    assert.match(css, /animation: 0\.3s ease-in-out 0s 1 slideInScale;/)
    assert.match(css, /-webkit-animation: elo-alert-spin 1s;/)
    assert.match(css, /animation-name: var\(--spin, elo-alert-spin\), none; --spin: spin;/)
})

test("specificity is preserved for a battery of nested selectors", async () => {
    const sources = [
        ".root { &[data-size=\"small\"] .icon, &:hover > .message { color: red } }",
        ".root, .icon { &:focus-visible { color: red } }",
        ".root { .icon & { color: red } }",
        ".root { &:not(.message, [disabled]) .icon::before { color: red } }",
        ".root { :global(.theme-dark) & .icon { color: red } }",
        ".root { &:has(> .icon:nth-child(2n of .message)) { color: red } }",
        ".root { @media (min-width: 1px) { & .icon:where(.message) { color: red } } }",
        ".root :component(Tabs) > :cx(button:icon), .message {}",
    ]
    for (const src of sources) {
        const flat = selectors((await postcss([nesting()]).process(src, { from: "alert.css" })).css)
        const out = selectors(await run(src))
        assert.equal(out.length, flat.length, src)
        flat.forEach((before, i) => assert.deepEqual(specificityList(out[i]), specificityList(before), `${before} → ${out[i]}`))
    }
})

test("deterministic: same input, same output and sink, parts in key order", async () => {
    const src = ".zeta {} .alpha .root {} @stylist root Alert as mid display block; @keyframes z {} @keyframes a {} .root { animation: z 1s, a 1s }"
    const a: StylistSink = {}
    const b: StylistSink = {}
    const first = await run(src, { sink: a })
    const second = await run(src, { sink: b })
    assert.equal(first, second)
    assert.deepEqual(a, b)
    assert.deepEqual(Object.keys(a.parts ?? {}), ["alpha", "mid", "root", "zeta"])
    assert.deepEqual(Object.keys(a.keyframes ?? {}), ["a", "z"])
})

test("stylist() used without options fails with a clear message", () => {
    assert.throws(() => (stylist as unknown as () => unknown)(), /stylist\(\) needs options/)
    assert.throws(() => stylist({ ...base, prefix: "Elo" }), /invalid prefix/)
    assert.throws(() => stylist({ ...base, hashLength: 3 }), /hashLength/)
})
