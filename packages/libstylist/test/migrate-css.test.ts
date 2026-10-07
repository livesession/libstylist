// `libstylist migrate-selectors` on stylesheets (CSS, CSS Modules, SCSS/LESS without their syntax
// packages), against the fixture map in fixtures/migrate/map.json.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { styleParser } from "../src/migrate/css.js"
import { DEFAULT_OPTIONS, indexMap, loadMigrationMap, migrateCode, type Entry, type MigrateOptions } from "../src/migrate/index.js"
import { specificity } from "../src/postcss/index.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_MAP = join(HERE, "fixtures", "migrate", "map.json")
const index = indexMap(loadMigrationMap(FIXTURE_MAP))

const run = (code: string, file = "app.css", options: Partial<MigrateOptions> = {}) => migrateCode(code, file, index, { ...DEFAULT_OPTIONS, ...options }, tmpdir())
const kinds = (entries: Entry[], kind: Entry["kind"]) => entries.filter((e) => e.kind === kind)
/** One rule in, its selector out. */
const selector = async (sel: string, options: Partial<MigrateOptions> = {}, file = "app.css") => {
    const r = await run(`${sel} { color: red }`, file, options)
    return { out: r.output.replace(/ \{ color: red \}$/, ""), entries: r.entries }
}

test("classes: parts and roots become their part attribute — same specificity", async () => {
    const { out, entries } = await selector(".ls-alert .ls-alert__icon")
    assert.equal(out, "[_cxclass_elo-aaaaaa] [_cxclass_elo-bbbbbb]")
    assert.deepEqual(specificity(out), specificity(".ls-alert .ls-alert__icon"))
    assert.equal(kinds(entries, "rewrite").length, 1)
    assert.equal(entries[0].notes, undefined, "no specificity note when nothing changed")
})

test("classes: a renamed root local (tooltip root → bubble) uses the successor part", async () => {
    assert.equal((await selector(".ls-tooltip:hover")).out, "[_cxclass_elo-jjjjjj]:hover")
})

test("classes: a div/span type next to a root that is a custom tag now is retagged (same specificity)", async () => {
    const { out, entries } = await selector("div.ls-alert:hover > span.ls-alert__icon")
    assert.equal(out, "elo-alert[_cxclass_elo-aaaaaa]:hover > span[_cxclass_elo-bbbbbb]")
    assert.deepEqual(specificity(out), specificity("div.ls-alert:hover > span.ls-alert__icon"))
    assert.match(entries[0].notes!.join(" "), /renders <elo-alert> now: div → elo-alert/)
    // a marker root keeps its native element
    assert.equal((await selector("button.ls-button")).out, "button[_cxclass_elo-cccccc]")
    // a member root (Table.Td) retags too
    assert.equal((await selector("div.ls-table__td")).out, "elo-table-td[_cxclass_elo-gggggg]")
})

test("classes: --roots identity writes the tag / marker and notes the specificity change", async () => {
    const opts = { roots: "identity" as const }
    const tag = await selector(".ls-alert .ls-alert__icon", opts)
    assert.equal(tag.out, "elo-alert [_cxclass_elo-bbbbbb]")
    assert.match(tag.entries[0].notes!.join(" "), /specificity \(0,2,0\) → \(0,1,1\) \(lower\)/)
    assert.equal((await selector(".ls-button:focus", opts)).out, "[elo-button]:focus")
    assert.equal((await selector(".foo.ls-alert", opts)).out, ".foo:is(elo-alert)")
    assert.equal((await selector("div.ls-alert", opts)).out, "elo-alert")
    // no identity (a renamed root) → the part attribute
    assert.equal((await selector(".ls-tooltip", opts)).out, "[_cxclass_elo-jjjjjj]")
})

test(":global(): unwrapped when nothing is left to globalize, kept otherwise (a .module sheet)", async () => {
    const selectorIn = (sel: string) => selector(sel, {}, "card.module.css")
    assert.equal((await selectorIn(":global(.ls-alert__close) .mine")).out, "[_cxclass_elo-bbbbb2] .mine")
    assert.equal((await selectorIn(".mine:global(.ls-alert)")).out, ".mine[_cxclass_elo-aaaaaa]")
    assert.equal((await selectorIn(":global( .ls-alert .ls-alert__icon )")).out, "[_cxclass_elo-aaaaaa] [_cxclass_elo-bbbbbb]")
    assert.equal((await selectorIn(":global(.ls-alert .theirs) .mine")).out, ":global([_cxclass_elo-aaaaaa] .theirs) .mine")
    assert.equal((await selectorIn(":global(.ls-alert, .ls-button)")).out, ":global([_cxclass_elo-aaaaaa], [_cxclass_elo-cccccc])", "a list stays wrapped")
    assert.equal((await selectorIn(":global(div.ls-alert)")).out, "elo-alert[_cxclass_elo-aaaaaa]")
    assert.equal((await selectorIn(":global .ls-alert .mine")).out, ":global [_cxclass_elo-aaaaaa] .mine", "the bare mode switch stays")
})

test("CSS Modules: a legacy class outside :global() was localized — the app's own class, reported and never rewritten", async () => {
    // CSS Modules hashed `.ls-alert` here: the rule only ever matched the app's own styles["ls-alert"]
    // elements; rewriting it to the part attribute would start styling the design system's alerts
    const local = await selector(".ls-alert .mine", {}, "card.module.css")
    assert.equal(local.out, ".ls-alert .mine")
    const todo = kinds(local.entries, "todo")[0]
    assert.deepEqual([todo.old, todo.reason, todo.new], [".ls-alert", "class", "[_cxclass_elo-aaaaaa]"])
    assert.match(todo.message!, /CSS Modules localized this class/)
    // nor do localized classes anchor a literal hook, or get rewritten as one
    for (const sel of [".ls-button > .content", ":global(.ls-button) > .content"]) {
        const r = await selector(sel, {}, "card.module.css")
        assert.equal(r.out.includes("_cxclass_elo-dddddd"), false, sel)
    }
    for (const sel of [":global(.ls-alert) .mine", ":global .ls-alert .mine"]) {
        const g = await selector(sel, {}, "card.module.css")
        assert.equal(g.out.includes("[_cxclass_elo-aaaaaa]"), true, sel)
        assert.equal(kinds(g.entries, "todo").length, 0, sel)
    }
    const nested = await run(":global { .ls-alert { color: red } }", "card.module.css")
    assert.equal(nested.output, ":global { [_cxclass_elo-aaaaaa] { color: red } }", "an enclosing :global block switches the mode")
    assert.equal((await selector(".ls-alert", {}, "card.css")).out, "[_cxclass_elo-aaaaaa]", "plain CSS is never localized")
    assert.equal((await selector('.mine [data-component="Tabs"]', {}, "card.module.css")).out, ".mine :is(elo-tabs,[elo-tabs])", "attributes are never localized")
})

test("[data-component]: the identity selector; retagged with a type; operators and unknown values reported", async () => {
    assert.equal((await selector('[data-component="Tabs"] > a')).out, ":is(elo-tabs,[elo-tabs]) > a")
    assert.equal((await selector("[data-component=Menu]")).out, "[_cxclass_elo-pppppp]")
    const typed = await selector('div[data-component="Dock"]')
    assert.equal(typed.out, "elo-app-dock[_cxclass_elo-mmmmmm]")
    assert.deepEqual(specificity(typed.out), specificity('div[data-component="Dock"]'))
    const prefix = await selector('[data-component^="Do"]')
    assert.equal(prefix.out, '[data-component^="Do"]')
    const todo = kinds(prefix.entries, "todo")[0]
    assert.equal(todo.reason, "data-component")
    assert.equal(todo.new, ":is(elo-app-dock,[elo-app-dock])")
    const presence = await selector("[data-component]")
    assert.equal(kinds(presence.entries, "todo").length, 1)
    const unknown = await selector('[data-component="Nope"]')
    assert.equal(kinds(unknown.entries, "unknown")[0].old, '[data-component="Nope"]')
})

test("[data-part]: rewritten only next to a hook of its scope (or everywhere with --literals all)", async () => {
    assert.equal((await selector('[data-component="Dock"] [data-part="header"]')).out, ":is(elo-app-dock,[elo-app-dock]) [_cxclass_elo-qqqqqq]")
    assert.equal((await selector('.ls-dock > [data-part="header"]')).out, "[_cxclass_elo-mmmmmm] > [_cxclass_elo-qqqqqq]")
    const bare = await selector('[data-part="header"]')
    assert.equal(bare.out, '[data-part="header"]')
    assert.equal(bare.entries.length, 0, "an unanchored data-part is the app's own")
    assert.equal((await selector('[data-part="demo"]', { literals: "all" })).out, "[_cxclass_elo-ssssss]")
    const ambiguous = await selector('[data-part="header"]', { literals: "all" })
    assert.equal(kinds(ambiguous.entries, "todo")[0].reason, "data-part")
})

test("literals: anchored part/tag successors are rewritten; data/prop/removed/pending are TODOs", async () => {
    assert.equal((await selector(".ls-table .table-td")).out, "[_cxclass_elo-ffffff] :is(elo-table-td,[elo-table-td])")
    assert.equal((await selector(".ls-button > .content")).out, "[_cxclass_elo-cccccc] > [_cxclass_elo-dddddd]")
    // not anchored: the app's own .content / .table-td
    for (const sel of [".content", ".table-td span", ".ls-alert .content"]) {
        const r = await selector(sel)
        assert.equal(r.out.includes("_cxclass_elo-dddddd") || r.out.includes("elo-table-td"), false, sel)
    }
    assert.equal((await selector(".table-td", { literals: "all" })).out, ":is(elo-table-td,[elo-table-td])")
    assert.equal((await selector(".ls-table .table-td", { literals: "off" })).out, "[_cxclass_elo-ffffff] .table-td")

    const small = await selector(".ls-icon.small")
    assert.equal(small.out, "[_cxclass_elo-eeeeee].small", "the literal stays — a data successor is a decision")
    const todo = kinds(small.entries, "todo")[0]
    assert.deepEqual([todo.old, todo.reason, todo.new], [".small", "literal", ':is(elo-icon,[elo-icon])[data-size="small"]'])
    assert.match(todo.message!, /data-size="small" on Icon/)

    const hover = await selector(".ls-text-input__field.hover")
    assert.match(kinds(hover.entries, "todo")[0].message!, /^prop — state="hover".*pending P3/)
    assert.equal(kinds(hover.entries, "todo")[0].new, '[_cxclass_elo-nnnnnn][data-force="hover"]', "the planned successor is the suggestion")
    const pending = await selector(".ls-button__content > .icon-wrapper")
    assert.equal(pending.out, "[_cxclass_elo-dddddd] > .icon-wrapper", "a pending successor is never written")
    assert.equal(kinds(pending.entries, "todo")[0].new, ":is(elo-icon,[elo-icon])")
    const removed = await selector(".ls-tabs__item .tab-icon")
    assert.match(kinds(removed.entries, "todo")[0].message!, /^removed — /)
})

test("literals: rewritten only on or inside the element of the hook that anchors them", async () => {
    // inside: the same compound, a descendant / child, a sibling of a descendant
    for (const [sel, out] of [
        [".ls-button > .x ~ .content", "[_cxclass_elo-cccccc] > .x ~ [_cxclass_elo-dddddd]"],
        [".ls-button:hover .content", "[_cxclass_elo-cccccc]:hover [_cxclass_elo-dddddd]"],
        [":global(.ls-button .content)", ":global([_cxclass_elo-cccccc] [_cxclass_elo-dddddd])"], // a sheet using :global keeps its wrappers
        [".ls-table__td.table-td", "[_cxclass_elo-gggggg]:is(elo-table-td,[elo-table-td])"],
    ]) assert.equal((await selector(sel)).out, out, sel)
    // elsewhere: an ancestor, a sibling, another branch of a list — the app's own .content, flagged only
    for (const sel of [".content .ls-button", ".ls-button + .content", ".ls-button ~ .content", ":is(.ls-button, .content)", ":global(.content .ls-button)", ".ls-table + .table-td"]) {
        const r = await selector(sel)
        assert.equal(r.out.includes("_cxclass_elo-dddddd") || r.out.includes("elo-table-td,"), false, sel)
        const todo = kinds(r.entries, "todo").find((e) => e.reason === "literal")!
        assert.match(todo.message!, /puts it elsewhere/, sel)
    }
    // --literals all keeps treating every occurrence as the design system's
    assert.equal((await selector(".content .x", { literals: "all" })).out, "[_cxclass_elo-dddddd] .x")
})

test("literals and data-part hooks in nested rules: the parent anchors them when every branch names the hook", async () => {
    const r = await run(".ls-button { .content { a: b } &:hover .content { a: b } } .ls-dock { > [data-part=\"header\"] { a: b } }")
    assert.equal(r.output, "[_cxclass_elo-cccccc] { [_cxclass_elo-dddddd] { a: b } &:hover [_cxclass_elo-dddddd] { a: b } } [_cxclass_elo-mmmmmm] { > [_cxclass_elo-qqqqqq] { a: b } }")
    const mixed = await run(".ls-button, .mine { .content { a: b } } .ls-button { .content & { a: b } }")
    assert.equal(mixed.output, "[_cxclass_elo-cccccc], .mine { .content { a: b } } [_cxclass_elo-cccccc] { .content & { a: b } }")
})

test("[data-part]: a hook of its scope named elsewhere (an ancestor-less position) flags it, never rewrites", async () => {
    const r = await selector('[data-part="header"] .ls-dock')
    assert.equal(r.out, '[data-part="header"] [_cxclass_elo-mmmmmm]')
    const todo = kinds(r.entries, "todo").find((e) => e.reason === "data-part")!
    assert.equal(todo.new, "[_cxclass_elo-qqqqqq]")
})

test("a polymorphic root's identity is its tag or its marker (--roots identity)", async () => {
    const opts = { roots: "identity" as const }
    assert.equal((await selector(".ls-card", opts)).out, ":is(elo-card,[elo-card])")
    assert.equal((await selector("section.ls-card", opts)).out, "section:is(elo-card,[elo-card])", "section → <section elo-card>")
    assert.equal((await selector("div.ls-card", opts)).out, "elo-card", "a div renders the custom tag")
    assert.equal((await selector("section.ls-card")).out, "section[_cxclass_elo-tttttt]")
})

test("literals: a complex successor is wrapped in :is() and the specificity change is noted", async () => {
    const { out, entries } = await selector(".ls-heading.mb-4")
    assert.equal(out, "[_cxclass_elo-hhhhhh]:is([_cxclass_elo-iiiiii] > :is(elo-heading,[elo-heading]))")
    assert.match(entries[0].notes!.join(" "), /specificity \(0,2,0\) → \(0,3,0\) \(higher\)/)
})

test("removed and unknown legacy classes are reported, never rewritten", async () => {
    const removed = await selector(".ls-color .swatch")
    assert.equal(removed.out, ".ls-color .swatch")
    assert.equal(kinds(removed.entries, "todo")[0].reason, "removed")
    assert.match(kinds(removed.entries, "todo")[0].message!, /Storybook-only swatch.*pending P5/)
    const unknown = await selector(".ls-nope .ls-alert")
    assert.equal(unknown.out, ".ls-nope [_cxclass_elo-aaaaaa]")
    assert.deepEqual(
        kinds(unknown.entries, "unknown").map((e) => e.old),
        [".ls-nope"],
    )
})

test("a literal held only by a removed hook is not the successor's: .ls-color .label is the swatch's label, not Button's", async () => {
    const swatch = await selector(".ls-color .label")
    assert.equal(swatch.out, ".ls-color .label", "never the Button label part")
    assert.deepEqual(
        kinds(swatch.entries, "todo").map((e) => `${e.reason} ${e.old}`),
        ["removed .ls-color", "literal .label"],
    )
    assert.match(kinds(swatch.entries, "todo")[1].message!, /removed \(no successor\)/)
    assert.equal(kinds(swatch.entries, "todo")[1].new, undefined, "no suggestion: the successor belongs to another component")
    assert.equal((await selector(".ls-button .label")).out, "[_cxclass_elo-cccccc] [_cxclass_elo-uuuuuu]", "inside Button it is Button's label")
    const nested = await run(".ls-color { .label { a: b } }")
    assert.equal(nested.output, ".ls-color { .label { a: b } }", "a removed nesting parent anchors nothing either")
})

test("a block name the design system never rendered is unknown (with its component), not a name built from pieces", async () => {
    const block = await selector(".ls-alert-x, .ls-toast .x")
    assert.deepEqual(
        [...kinds(block.entries, "unknown"), ...kinds(block.entries, "todo")].map((e) => `${e.kind} ${e.reason} ${e.old}`),
        ["unknown unknown .ls-alert-x", "unknown unknown .ls-toast"],
    )
    assert.match(kinds(block.entries, "unknown")[1].message!, /never rendered it; its classes \(ls-toast__title\) belong to toast/)
    const cut = await selector(".ls-toast__")
    assert.equal(kinds(cut.entries, "todo")[0].reason, "dynamic", "a name ending at a separator is a fragment")
})

test("[class~=…] is a class: rewritten; exact and substring matches are TODOs with the candidates", async () => {
    assert.equal((await selector('[class~="ls-alert__icon"]')).out, "[_cxclass_elo-bbbbbb]")
    const sub = await selector('[class*="ls-alert"]')
    assert.equal(sub.out, '[class*="ls-alert"]')
    assert.equal(kinds(sub.entries, "todo")[0].new, ":is([_cxclass_elo-aaaaaa], [_cxclass_elo-bbbbbb], [_cxclass_elo-bbbbb2])")
    assert.equal(kinds((await selector('[class="ls-alert"]')).entries, "todo")[0].new, "[_cxclass_elo-aaaaaa]")
})

test("the ledger: an exact design-system selector takes its recorded successor; related ones get a note", async () => {
    assert.equal((await selector(".ls-tabs a")).out, "[_cxclass_elo-kkkkkk] [_cxclass_elo-llllll]")
    assert.equal((await selector(".ls-tabs   a")).out, "[_cxclass_elo-kkkkkk] [_cxclass_elo-llllll]", "whitespace-insensitive")
    const removed = await selector(".ls-tabs .ls-tabs__item.hover")
    assert.equal(removed.out, ".ls-tabs .ls-tabs__item.hover")
    assert.match(kinds(removed.entries, "todo")[0].message!, /removed this selector: forced hover/)
    const related = await selector(".ls-tabs a:hover")
    assert.equal(related.out, "[_cxclass_elo-kkkkkk] a:hover")
    assert.match(related.entries[0].notes!.join(" "), /rewrote the related selector \.ls-tabs a → /)
})

test("keyframes: animation values and @keyframes names; function names and unknown names", async () => {
    const r = await run(
        [
            ".a { animation: ls-popover-fade-in 200ms ease-in, spin 1s steps(4); }",
            ".b { -webkit-animation-name: ls-toast-fade-out; animation-name: ls-mine; }",
            "@keyframes ls-popover-fade-in { from { opacity: 0 } to { opacity: 1 } }",
            ".c { transition: ls-popover-fade-in 1s; }",
        ].join("\n"),
    )
    assert.equal(
        r.output,
        [
            ".a { animation: elo-popover-fade-in 200ms ease-in, spin 1s steps(4); }",
            ".b { -webkit-animation-name: elo-toast-fade-out; animation-name: ls-mine; }",
            "@keyframes elo-popover-fade-in { from { opacity: 0 } to { opacity: 1 } }",
            ".c { transition: ls-popover-fade-in 1s; }",
        ].join("\n"),
    )
    assert.deepEqual(
        kinds(r.entries, "unknown").map((e) => e.old),
        ["ls-mine"],
    )
})

test("composes, @extend and other at-rule parameters are TODOs; @supports selector() and @scope are rewritten", async () => {
    const r = await run(
        [
            ".a { composes: ls-alert from global; }",
            "@supports selector(.ls-alert) { .x { a: b } }",
            "@scope (.ls-alert) to (.ls-alert__icon) { .x { a: b } }",
            '@import "./ls-alert.css";',
            "@media (min-width: 10px) { .ls-button { a: b } }",
        ].join("\n"),
    )
    assert.equal(
        r.output,
        [
            ".a { composes: ls-alert from global; }",
            "@supports selector([_cxclass_elo-aaaaaa]) { .x { a: b } }",
            "@scope ([_cxclass_elo-aaaaaa]) to ([_cxclass_elo-bbbbbb]) { .x { a: b } }",
            '@import "./ls-alert.css";',
            "@media (min-width: 10px) { [_cxclass_elo-cccccc] { a: b } }",
        ].join("\n"),
    )
    assert.deepEqual(
        kinds(r.entries, "todo").map((e) => e.reason),
        ["composes"],
    )
})

test("formatting, comments and unrelated rules are left byte for byte", async () => {
    const code = [
        "/* .ls-alert in a comment stays */",
        ".mine,",
        "  .ls-alert   >   .ls-alert__icon /* why */ ,",
        "\t.other { color: var(--ls-color-text); }",
        "",
        "@keyframes spin { from { a: b } 50% { a: c } }",
    ].join("\n")
    const r = await run(code)
    assert.equal(r.output, code.replace(".ls-alert   >   .ls-alert__icon", "[_cxclass_elo-aaaaaa]   >   [_cxclass_elo-bbbbbb]"))
})

test("idempotence: a second run over the output changes nothing and reports the same TODOs", async () => {
    const code = [
        ".ls-alert .ls-alert__icon, div.ls-table__td { a: b }",
        '[data-component="Dock"] [data-part="header"], .ls-table .table-td { a: b }',
        ".ls-icon.small, .ls-heading.mb-4 { a: b }",
        ".ls-button__content > .icon-wrapper { a: b }",
        ".x { animation: ls-popover-fade-in 1s }",
        "@keyframes ls-toast-fade-out { to { a: b } }",
        ".ls-tabs a, .ls-nope { a: b }",
    ].join("\n")
    const moduleCode = ":global(.ls-button) .mine { a: b }\n:global(.ls-table) :global(.table-td) { a: b }\n.ls-alert { a: b }"
    for (const [file, text] of [
        ["app.css", code],
        ["app.module.css", moduleCode],
    ])
        for (const options of [{}, { roots: "identity" as const }, { literals: "all" as const }]) {
            const once = await run(text, file, options)
            assert.ok(once.changed)
            const twice = await run(once.output, file, options)
            assert.equal(twice.output, once.output, JSON.stringify(options))
            assert.equal(kinds(twice.entries, "rewrite").length, 0)
            assert.deepEqual(
                kinds(twice.entries, "todo").map((e) => e.old),
                kinds(once.entries, "todo").map((e) => e.old),
                "TODOs stay visible: the part attributes still anchor the literals",
            )
        }
})

test("a stylesheet using :global is a scoped (CSS Modules-style) sheet under any file name: its other classes are local", async () => {
    // the webapp-next sheet pipeline, Svelte / Vue scoped styles: `.content` there is the app's own
    const r = await run(":global(.ls-button) > .content { a: b }\n.ls-alert { a: b }\n:global(.ls-alert__icon) { a: b }", "page.css")
    assert.equal(r.output, ":global([_cxclass_elo-cccccc]) > .content { a: b }\n.ls-alert { a: b }\n:global([_cxclass_elo-bbbbbb]) { a: b }", "the wrappers stay: they mark the sheet as scoped")
    assert.deepEqual(
        kinds(r.entries, "todo").map((e) => `${e.reason} ${e.old}`),
        ["class .ls-alert"],
    )
    const again = await run(r.output, "page.css")
    assert.equal(again.output, r.output, "a second run still reads it as scoped")
    assert.equal((await run(":global(.ls-alert) { a: b }", "page.module.css")).output, "[_cxclass_elo-aaaaaa] { a: b }", "a .module file is scoped by its name")
})

test("SCSS / LESS without postcss-scss / postcss-less: // comments masked, nesting, BEM suffixes reported", async (t) => {
    const scss = await styleParser("scss", mkdtempSync(join(tmpdir(), "libstylist-scss-")))
    if (!scss.fallback) {
        t.skip("postcss-scss is installed here — the fallback path is not exercised")
        return
    }
    const code = [
        "// a line comment with .ls-alert",
        ".ls-alert {",
        "  color: red; // trailing",
        "  .ls-alert__icon { a: b }",
        "  &__close { a: b }",
        "  &:hover { a: b }",
        "}",
        "$x: 1;",
        ".y { @extend .ls-button; }",
    ].join("\n")
    const r = await run(code, "app.scss")
    assert.equal(
        r.output,
        code.replace(".ls-alert {", "[_cxclass_elo-aaaaaa] {").replace("  .ls-alert__icon {", "  [_cxclass_elo-bbbbbb] {"),
    )
    assert.match(r.parser!, /postcss-scss not installed/)
    const bem = kinds(r.entries, "todo").find((e) => e.reason === "bem")!
    assert.equal(bem.old, "&__close")
    assert.equal(bem.new, "@at-root [_cxclass_elo-bbbbb2]")
    assert.ok(kinds(r.entries, "todo").some((e) => e.reason === "at-rule" && e.old === "@extend .ls-button"))
    await assert.rejects(run(".ls-#{$x} { a: b }", "app.scss"), /needs postcss-scss/)

    const less = await run("// c\n.ls-button { .ls-button__content { a: b } }", "app.less")
    assert.equal(less.output, "// c\n[_cxclass_elo-cccccc] { [_cxclass_elo-dddddd] { a: b } }")
})

test("plain CSS nesting: &__x is not a BEM concatenation there", async () => {
    const r = await run(".ls-alert { &__close { a: b } }", "app.css")
    assert.equal(kinds(r.entries, "todo").length, 0)
})
