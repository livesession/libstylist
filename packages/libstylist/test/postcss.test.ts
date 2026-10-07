import assert from "node:assert/strict"
import { test } from "node:test"

import postcss from "postcss"
import nesting from "postcss-nesting"

import { partAttr } from "../src/hash/index.js"
import {
    collectSheet,
    compareSpecificity,
    findClassSelectors,
    parseDirective,
    renameAnimationValue,
    replaceRefs,
    scanRefs,
    specificity,
    specificityList,
    stylist,
    type StylistOptions,
    type StylistSink,
} from "../src/postcss/index.js"

const ICON = "_cxclass_elo-or4d4l" // SPEC §3.1 test vector: elo/core/alert/icon
const attr = (scope: string, part: string, namespace = "core") => partAttr({ prefix: "elo", namespace, scope, part })
const base: StylistOptions = { prefix: "elo", namespace: "core", scope: "alert" }

async function run(css: string, opts: Partial<StylistOptions> = {}, from = "alert.css") {
    const result = await postcss([nesting(), stylist({ ...base, ...opts })]).process(css, { from })
    return result
}

const selectors = (css: string): string[] => {
    const out: string[] = []
    postcss.parse(css).walkRules(r => {
        if (!/keyframes$/i.test((r.parent as { name?: string } | undefined)?.name ?? "")) out.push(r.selector)
    })
    return out
}

test("every local class, .root included, becomes a part attribute with the same specificity", async () => {
    const src = ".root[data-has-title] .icon, .root > .message:hover::before {} .icon:not(.root) {}"
    const { css } = await run(src)
    const root = attr("alert", "root")
    const message = attr("alert", "message")
    assert.deepEqual(selectors(css), [`[${root}][data-has-title] [${ICON}], [${root}] > [${message}]:hover::before`, `[${ICON}]:not([${root}])`])
    const before = specificityList(".root[data-has-title] .icon, .root > .message:hover::before")
    assert.deepEqual(specificityList(selectors(css)[0]), before)
    assert.deepEqual(before, [[0, 3, 0], [0, 3, 1]])
    assert.equal(findClassSelectors(css).length, 0)
})

test("runs after nesting in the same pipeline (OnceExit) and on pre-flattened CSS", async () => {
    const nested = ".root { &[data-size=\"small\"] { & .icon { color: red } } }"
    const flat = ".root[data-size=\"small\"] .icon { color: red }"
    const a = await run(nested)
    const b = await postcss([stylist(base)]).process(flat, { from: "alert.css" })
    assert.deepEqual(selectors(a.css), selectors(b.css))
    assert.deepEqual(selectors(a.css), [`[${attr("alert", "root")}][data-size="small"] [${ICON}]`])
})

test("refuses unflattened input", async () => {
    await assert.rejects(postcss([stylist(base)]).process(".root { .icon {} }", { from: "alert.css" }), /nested rule/)
    await assert.rejects(postcss([stylist(base)]).process("& .icon {}", { from: "alert.css" }), /& in a flattened selector/)
})

test("local classes must be kebab-case parts", async () => {
    await assert.rejects(run(".root.minWidth {}"), /\.minWidth is not a valid part name/)
    const ok = await run(".root:global(.minWidth) {}")
    assert.deepEqual(selectors(ok.css), [`[${attr("alert", "root")}].minWidth`])
})

test(":global(x) is spliced verbatim, reported, and lists are errors", async () => {
    const sink: StylistSink = {}
    const result = await run(".root :global(.icon-wrapper.right) svg, .root:global(.hover) {}", { sink })
    const root = attr("alert", "root")
    assert.deepEqual(selectors(result.css), [`[${root}] .icon-wrapper.right svg, [${root}].hover`])
    assert.deepEqual(sink.globals, [".hover", ".icon-wrapper.right"])
    assert.equal(result.warnings().length, 1)
    assert.match(result.warnings()[0].text, /legacy :global\(\) hooks spliced verbatim: \.hover, \.icon-wrapper\.right/)
    assert.equal((await run(".root:global(.hover) {}", { reportGlobals: false })).warnings().length, 0)
    await assert.rejects(run(".root :global(.a, .b) {}"), /contains a selector list/)
    await assert.rejects(run(".root :global() {}"), /needs a selector/)
    // specificity is the spliced selector's, same as the legacy namespace plugin
    assert.deepEqual(specificity(".root :global(.icon-wrapper.right) svg"), [0, 3, 1])
})

test(":component(Path | ns/Path) compiles to :is(tag,[tag]) with (0,1,0)", async () => {
    const { css } = await run(".root :component(Tabs) > :component(player/PlayerTopBar.Url), :component(Modal.Header) {}")
    assert.deepEqual(selectors(css), [
        `[${attr("alert", "root")}] :is(elo-tabs,[elo-tabs]) > :is(elo-player-topbar-url,[elo-player-topbar-url]), :is(elo-modal-header,[elo-modal-header])`,
    ])
    assert.deepEqual(specificityList(".root :component(Tabs) > :component(player/PlayerTopBar.Url), :component(Modal.Header)"), specificityList(selectors(css)[0]))
    assert.deepEqual(specificity(":is(elo-tabs,[elo-tabs])"), [0, 1, 0])

    const seen: Array<[string | null, string]> = []
    const resolved = await run(".root :component(inf/FilterBar) {}", { resolveTag: (ns, path) => (seen.push([ns, path]), "elo-inf-filterbar") })
    assert.deepEqual(seen, [["inf", "FilterBar"]])
    assert.match(resolved.css, /:is\(elo-inf-filterbar,\[elo-inf-filterbar\]\)/)
    await assert.rejects(run(".root :component(Nope) {}", { resolveTag: () => undefined }), /:component\(Nope\) — unknown component/)
    await assert.rejects(run(".root :component(tabs) {}"), /dotted PascalCase path/)
})

test(":cx(scope:part) compiles to that scope's part attribute", async () => {
    const { css } = await run(".root :cx(player-controls:button) {}", { namespace: "player", scope: "player-fullscreen-button" })
    assert.deepEqual(selectors(css), [`[${attr("player-fullscreen-button", "root", "player")}] [${attr("player-controls", "button", "player")}]`])
    const viaRegistry = await run(".root :cx(button:icon) {}", { resolvePart: (scope, part) => (scope === "button" && part === "icon" ? "_cxclass_elo-zzzzzz" : undefined) })
    assert.match(viaRegistry.css, /\[_cxclass_elo-zzzzzz\]/)
    await assert.rejects(run(".root :cx(button:nope) {}", { resolvePart: () => undefined }), /:cx\(button:nope\) — unknown part/)
    await assert.rejects(run(".root :cx(Button) {}"), /expected ":cx\(scope:part\)"/)
})

test("local keyframes are namespaced and animation references follow", async () => {
    const sink: StylistSink = {}
    const src = [
        ".root { animation: fade-in 0.2s steps(4) forwards, slideInScale 1s; }",
        ".icon { animation-name: fade-in, spin; -webkit-animation-name: spin; }",
        ".message { animation: var(--anim, fade-in) 1s; --fade-in: 1; }",
        "@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }",
        "@media (min-width: 1px) { @keyframes spin { to { transform: rotate(1turn) } } }",
    ].join("\n")
    const { css } = await run(src, { sink })
    assert.match(css, /animation: elo-alert-fade-in 0\.2s steps\(4\) forwards, slideInScale 1s;/)
    assert.match(css, /animation-name: elo-alert-fade-in, elo-alert-spin;/)
    assert.match(css, /-webkit-animation-name: elo-alert-spin;/)
    assert.match(css, /animation: var\(--anim, elo-alert-fade-in\) 1s; --fade-in: 1;/)
    assert.match(css, /@keyframes elo-alert-fade-in \{ from/)
    assert.match(css, /@keyframes elo-alert-spin \{/)
    assert.deepEqual(sink.keyframes, { "fade-in": "elo-alert-fade-in", spin: "elo-alert-spin" })
})

test("renameAnimationValue leaves strings, functions and unknown names alone", () => {
    const names = { fade: "elo-x-fade", s: "elo-x-s" }
    assert.equal(renameAnimationValue("fade 1s ease", names), "elo-x-fade 1s ease")
    assert.equal(renameAnimationValue("fade(1) \"fade\" 'fade' 1.5s", names), "fade(1) \"fade\" 'fade' 1.5s")
    assert.equal(renameAnimationValue("a,fade,b", names), "a,elo-x-fade,b")
    assert.equal(renameAnimationValue("--fade fade-out", names), "--fade fade-out")
})

test("@stylist root directives: removed, bind parts, emit display defaults first", async () => {
    const sink: StylistSink = {}
    const src = [
        "/* Alert sheet */",
        "@layer components;",
        ".root { color: red }",
        "@stylist root Alert display block;",
        "@stylist root Alert.Title as title;",
        "@stylist root Modal.Header as header display inline-flex;",
    ].join("\n")
    const { css } = await run(src, { sink })
    assert.doesNotMatch(css, /@stylist/)
    const rules = selectors(css)
    assert.deepEqual(rules.slice(0, 2), [":where(elo-alert:not([hidden]))", ":where(elo-modal-header:not([hidden]))"])
    // `block` restores the UA div pair (display + unicode-bidi isolate); a custom element has neither
    assert.match(css, /^\/\* Alert sheet \*\/\n@layer components;\n:where\(elo-alert:not\(\[hidden\]\)\) \{\s*display: block;\s*unicode-bidi: isolate;?\s*\}/)
    assert.match(css, /:where\(elo-modal-header:not\(\[hidden\]\)\) \{\s*display: inline-flex;?\s*\}/)
    assert.deepEqual(specificity(rules[0]), [0, 0, 0])
    assert.deepEqual(sink.roots, [
        { component: "Alert", local: "root", tag: "elo-alert", display: "block" },
        { component: "Alert.Title", local: "title", tag: "elo-alert-title" },
        { component: "Modal.Header", local: "header", tag: "elo-modal-header", display: "inline-flex" },
    ])
    // a root local is a part even without a rule of its own
    assert.equal(sink.parts?.title, attr("alert", "title"))
    assert.equal(sink.parts?.header, attr("alert", "header"))
    assert.equal(sink.parts?.root, attr("alert", "root"))
})

test("root tags follow the namespace naming", async () => {
    const sink: StylistSink = {}
    await run("@stylist root PlayerTopBar display flex; @stylist root PlayerTopBar.Url;", { namespace: "player", sink }, "player-top-bar.css")
    assert.deepEqual(sink.roots?.map(r => r.tag), ["elo-player-topbar", "elo-player-topbar-url"])
    const custom: StylistSink = {}
    await run("@stylist root Thing;", { namespace: "x", naming: () => ({ segment: "ext", word: "" }), sink: custom }, "thing.css")
    assert.deepEqual(custom.roots?.map(r => r.tag), ["elo-ext-thing"])
    await assert.rejects(run("@stylist root List; @stylist root List.Root;"), /both map to <elo-list>/)
})

test("scope: @stylist scope pins it over the option and the file name", async () => {
    const sink: StylistSink = {}
    await run("@stylist scope old-name; .icon {}", { scope: "renamed", sink }, "renamed.css")
    assert.equal(sink.scope, "old-name")
    assert.equal(sink.parts?.icon, attr("old-name", "icon"))
    const byFile: StylistSink = {}
    await postcss([stylist({ prefix: "elo", namespace: "core", sink: byFile })]).process(".icon {}", { from: "/x/y/text-input.css" })
    assert.equal(byFile.scope, "text-input")
    await assert.rejects(postcss([stylist({ prefix: "elo", namespace: "core" })]).process(".icon {}", { from: undefined }), /no scope/)
    await assert.rejects(run(".icon {}", { scope: "Bad_Scope" }), /not kebab-case/)
})

test("directive grammar", async () => {
    assert.deepEqual(parseDirective("root Alert"), { kind: "root", component: "Alert", local: "root" })
    assert.deepEqual(parseDirective(" root  Modal.Header as header display flex "), { kind: "root", component: "Modal.Header", local: "header", display: "flex" })
    assert.deepEqual(parseDirective("scope text-input"), { kind: "scope", scope: "text-input" })
    for (const bad of ["", "root", "root alert", "root Alert as", "root Alert as Header", "root Alert display", "root Alert display Block",
        "root Alert display flex as header", "root Alert extra", "root player/Alert", "scope", "scope A", "scope a b", "tag Alert"]) {
        assert.throws(() => parseDirective(bad), /directive/, bad)
    }
    await assert.rejects(run("@stylist root Alert display;"), /"display" needs a keyword/)
    await assert.rejects(run(".root { @stylist root Alert; }"), /top-level/)
    await assert.rejects(run("@stylist root Alert { }"), /not blocks/)
    await assert.rejects(run("@stylist root Alert; @stylist root Alert display block;"), /duplicate @stylist root for Alert/)
    await assert.rejects(run("@stylist scope a; @stylist scope b;"), /duplicate @stylist scope/)
    await assert.rejects(run("@stylist frobnicate;"), /unknown directive/)
})

test("specificity helper", () => {
    const cases: Array<[string, [number, number, number]]> = [
        ["*", [0, 0, 0]],
        ["div", [0, 0, 1]],
        [".a", [0, 1, 0]],
        ["[_cxclass_elo-or4d4l]", [0, 1, 0]],
        ["#x", [1, 0, 0]],
        ["a:hover::before", [0, 1, 2]],
        ["a:before", [0, 0, 2]],
        [".a > .b + .c ~ .d", [0, 4, 0]],
        [":where(.a, #b) .c", [0, 1, 0]],
        [":is(.a, #b) .c", [1, 1, 0]],
        [":not(.a, div)", [0, 1, 0]],
        [":has(> img, #x)", [1, 0, 0]],
        [":nth-child(2n+1)", [0, 1, 0]],
        [":nth-child(2n+1 of .a, #b)", [1, 1, 0]],
        ["li:nth-last-child(odd of .x.y)", [0, 3, 1]],
        [":nth-of-type(2)", [0, 1, 0]],
        ["::slotted(.a)", [0, 1, 1]],
        [":host(.a)", [0, 2, 0]],
        [":global(.a .b) c", [0, 2, 1]],
        [":component(player/PlayerTopBar.Url)", [0, 1, 0]],
        [":cx(alert:icon) .x", [0, 2, 0]],
        [":where(elo-alert:not([hidden]))", [0, 0, 0]],
    ]
    for (const [sel, expected] of cases) assert.deepEqual(specificity(sel), expected, sel)
    assert.deepEqual(specificityList(".a, #b, c"), [[0, 1, 0], [1, 0, 0], [0, 0, 1]])
    assert.deepEqual(specificity(".a, #b, c"), [1, 0, 0])
    assert.ok(compareSpecificity([0, 2, 0], [0, 1, 9]) > 0)
    assert.ok(compareSpecificity([0, 1, 0], [1, 0, 0]) < 0)
    assert.throws(() => specificity("& .a"), /flatten/)
})

test("reference scanner skips strings and nests parentheses", () => {
    const sel = "[title=\":cx(a:b)\"] :component(Tabs) :not(:cx(alert:icon))"
    assert.deepEqual(scanRefs(sel).map(r => [r.kind, r.arg]), [["component", "Tabs"], ["cx", "alert:icon"]])
    assert.equal(replaceRefs(sel, r => `<${r.kind}>`), "[title=\":cx(a:b)\"] <component> :not(<cx>)")
    assert.equal(scanRefs("::cx(a:b)").length, 0)
})

test("findClassSelectors lists every surviving class", () => {
    const hits = findClassSelectors("[_cxclass_elo-x] .icon-wrapper {} @keyframes k { from {} } .a.b, :component(A.B) {}")
    assert.deepEqual(hits.map(h => h.className), ["icon-wrapper", "a", "b"])
})

test("collectSheet reads source sheets without transforming them", () => {
    const src = [
        "@stylist root Alert display block;",
        "@stylist root Alert.Title as title;",
        ".root { & .icon:global(.icon-wrapper) { animation: spin 1s } &:hover .message {} }",
        ".root :component(player/PlayerTopBar) :cx(button:icon) {}",
        "@keyframes spin { to { transform: none } }",
        "@keyframes fade { from { opacity: 0 } }",
    ].join("\n")
    const info = collectSheet(src, { file: "packages/css/src/components/alert.css", group: "components" })
    assert.equal(info.scope, "alert")
    assert.equal(info.pinned, false)
    assert.deepEqual(info.roots.map(({ line: _line, ...r }) => r), [
        { component: "Alert", local: "root", display: "block" },
        { component: "Alert.Title", local: "title" },
    ])
    assert.deepEqual(info.classes, ["icon", "message", "root"])
    assert.deepEqual(info.globals, [".icon-wrapper"])
    assert.deepEqual(info.keyframes, ["fade", "spin"])
    assert.deepEqual(info.components.map(({ line: _line, ...r }) => r), [{ namespace: "player", path: "PlayerTopBar" }])
    assert.deepEqual(info.cx.map(({ line: _line, ...r }) => r), [{ scope: "button", part: "icon" }])
    assert.deepEqual(info.errors, [])

    const bare = collectSheet(".root { color: red }", { file: "x/button.css", group: "components" })
    assert.deepEqual(bare.roots, [])
    assert.deepEqual(bare.classes, ["root"])

    const pinned = collectSheet("@stylist scope legacy-name;", { file: "new-name.css", group: "components", scope: "ignored" })
    assert.equal(pinned.scope, "legacy-name")
    assert.equal(pinned.pinned, true)
    assert.equal(collectSheet("", { file: "a.css", group: "g", scope: "given" }).scope, "given")

    const bad = collectSheet([
        "@stylist root alert;",
        ".root { @stylist scope x; }",
        ".Bad, :global(.a, .b), :cx(nope) {}",
        "@keyframes \"quoted\" {}",
    ].join("\n"), { file: "Weird_Name.css", group: "components" })
    assert.deepEqual(bad.errors.map(e => e.kind).sort(), ["directive", "directive", "keyframes", "scope", "selector"])
    const unparsable = collectSheet(".a {", { file: "a.css", group: "g" })
    assert.equal(unparsable.errors[0].kind, "parse")
})
