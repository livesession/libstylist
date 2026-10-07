// Override sheets (SPEC §9): the directive grammar, pass 1, the resolution against a design system's
// registry (targets, parts, packages, `within`, cross-sheet rules, reset targets, the lock sections), the
// compile (`stylistOverride()` after postcss-nesting: rewrites, specificity, forbidden selectors,
// keyframes, `within`) and the workspace helpers (layer wrap and placement, the generated module).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import postcss from "postcss"
import nesting from "postcss-nesting"

import { partAttr } from "../src/hash/index.js"
import {
    collectOverrideSheet,
    collectSheet,
    findClassSelectors,
    importantConflicts,
    importantDeclarations,
    overlappingProperties,
    parseDirective,
    readOverrideDirectives,
    specificityList,
    stylist,
    stylistOverride,
    type StylistOverrideOptions,
    type StylistOverrideSink,
} from "../src/postcss/index.js"
import { diffLock, formatLockDiff, resolveOverrideTarget, resolveWithin, toLock } from "../src/registry/index.js"
import { DEFAULT_OVERRIDES_LAYER, PART_MAP_HEADER, bundleLayerProblem, compileOverride, declaredLayerOrder, overridesLayerProblem, renderOverridesModule } from "../src/workspace/index.js"
import { appRegistry, designSystem, resolveSheets } from "./fixtures/overrides/design-system.js"

const ds = (scope: string, part: string, namespace = "core") => partAttr({ prefix: "ds", namespace, scope, part })
const STATEMENT = ["reset", "tokens", "components", "utilities", "app.overrides", "app.core", "app.render"]

const selectors = (css: string): string[] => {
    const out: string[] = []
    postcss.parse(css).walkRules(r => {
        if (!/keyframes$/i.test((r.parent as { name?: string } | undefined)?.name ?? "")) out.push(r.selector)
    })
    return out
}

/** Resolves `css` as the override sheet `file` against the fixture and compiles it (nesting + plugin). */
async function compile(file: string, css: string, sink?: StylistOverrideSink): Promise<string> {
    const r = await resolveSheets({ [file]: css })
    assert.deepEqual(r.errors, [], "the sheet resolves")
    const sheet = r.sheets[0]
    return (await postcss([nesting(), stylistOverride({ ...sheet.plugin, sink })]).process(css, { from: file })).css
}

const BUTTON = "@stylist override Button from \"@ds/react\";\n"
const TABLE = "@stylist override Table from \"@ds/react\";\n"

describe("directive grammar", () => {
    test("@stylist override: component, member, Root, sheet id, quotes, within", () => {
        assert.deepEqual(parseDirective("override Button from \"@livesession/eloquentui-react\""), {
            kind: "override",
            target: { kind: "component", path: "Button" },
            from: "@livesession/eloquentui-react",
            within: null,
        })
        assert.deepEqual(parseDirective(" override  Table.Tr  from  '@ds/react' ").target, { kind: "component", path: "Table.Tr" })
        assert.deepEqual(parseDirective("override ListCollection.Root from \"@ds/gram\"").target, { kind: "component", path: "ListCollection.Root" })
        assert.deepEqual(parseDirective("override user-menu from \"x\"").target, { kind: "sheet", scope: "user-menu" })
        assert.deepEqual(parseDirective("override Table from \"@ds/react\" within RenderCart").within, { namespace: null, path: "RenderCart" })
        assert.deepEqual(parseDirective("override Table from \"@ds/react\" within render/RenderCart.Row").within, { namespace: "render", path: "RenderCart.Row" })
        assert.equal((parseDirective("override Button from \"ui\"") as { from: string }).from, "ui")
    })

    test("@stylist override errors name the grammar", () => {
        const bad: Array<[string, RegExp]> = [
            ["override", /missing the component/],
            ["override Button", /missing `from/],
            ["override Button of \"@ds/react\"", /"of" where "from" belongs/],
            ["override Button from", /needs the quoted package name/],
            ["override Button from @ds/react", /the package is a quoted string/],
            ["override Button from \"@ds/react'", /the package is a quoted string/],
            ["override Button from \"@ds/react/button\"", /is a subpath/],
            ["override Button from \"lodash/fp\"", /is a subpath/],
            ["override Button from \"./button\"", /is a path/],
            ["override Button from \"@DS/React\"", /not a package name/],
            ["override button_x from \"@ds/react\"", /neither a component path .* nor a sheet id/],
            ["override Button from \"@ds/react\" within", /"within" needs an app component/],
            ["override Button from \"@ds/react\" within cart", /names no component/],
            ["override Button from \"@ds/react\" within Cart extra", /unexpected "extra"/],
            ["override Button from \"@ds/react\" inside Cart", /unexpected "inside"/],
        ]
        for (const [params, message] of bad) {
            assert.throws(() => parseDirective(params), (err: Error) => err.name === "DirectiveError" && message.test(err.message) && err.message.includes("@stylist override <Component | sheet-id>"), params)
        }
    })

    test("@stylist reset: nothing (the whole sheet) or kebab-case parts", () => {
        assert.deepEqual(parseDirective("reset"), { kind: "reset", parts: [] })
        assert.deepEqual(parseDirective("reset loader  sort-icon"), { kind: "reset", parts: ["loader", "sort-icon"] })
        assert.throws(() => parseDirective("reset .loader"), /"loader" is not a part name \(write it without the dot\)/)
        assert.throws(() => parseDirective("reset Loader"), /"Loader" is not a part name \(kebab-case\)/)
        assert.throws(() => parseDirective("resets loader"), /unknown directive .* in an override sheet/)
    })

    test("a package sheet rejects override and reset, pointing at the overrides directory", async () => {
        const info = collectSheet("@stylist override Button from \"@ds/react\";\n@stylist reset;\n.root {}", { file: "alert.css", group: "components" })
        assert.deepEqual(info.errors.map(e => [e.kind, e.line]), [["directive", 1], ["directive", 2]])
        assert.match(info.errors[0].message, /@stylist override belongs in an override sheet \(the workspace's css\.overrides\.dir\)/)
        await assert.rejects(postcss([stylist({ prefix: "elo", namespace: "core", scope: "alert" })]).process("@stylist reset;\n.root {}", { from: "alert.css" }), /@stylist reset belongs in an override sheet/)
    })

    test("readOverrideDirectives: one override, first; resets after it; all before the first rule", () => {
        const read = (css: string) => readOverrideDirectives(postcss.parse(css)).errors.map(e => e.message)
        const ok = readOverrideDirectives(postcss.parse(`/* x */\n@charset "utf-8";\n${BUTTON}@stylist reset loader;\n@stylist reset icon label;\n.root {}`))
        assert.deepEqual(ok.errors, [])
        assert.deepEqual(ok.override && { target: ok.override.target, from: ok.override.from }, { target: { kind: "component", path: "Button" }, from: "@ds/react" })
        assert.deepEqual(ok.resets.map(r => r.parts), [["loader"], ["icon", "label"]])
        assert.equal(ok.nodes.length, 3)

        assert.match(read(".root {}")[0], /an override sheet starts with @stylist override/)
        assert.match(read("@stylist reset;\n" + BUTTON)[0], /@stylist reset before @stylist override/)
        assert.match(read("@stylist reset;\n" + BUTTON)[1], /@stylist override comes first/)
        assert.match(read(BUTTON + BUTTON)[0], /has one @stylist override/)
        assert.match(read(BUTTON + "@stylist root Button;")[0], /@stylist root in an override sheet — an override sheet declares no component of its own/)
        assert.match(read(BUTTON + "@stylist scope button;")[0], /@stylist scope in an override sheet/)
        assert.match(read(BUTTON + "@stylist reset loader;\n@stylist reset icon loader;")[0], /part "loader" is reset twice/)
        assert.match(read(BUTTON + "@stylist reset loader loader;")[0], /part "loader" is reset twice/)
        assert.match(read(BUTTON + "@stylist reset loader;\n@stylist reset;")[0], /resets the whole target sheet — drop the part resets/)
        assert.match(read(BUTTON + "@stylist reset;\n@stylist reset loader;")[0], /the whole target sheet is reset already/)
        assert.match(read(BUTTON + "@stylist reset;\n@stylist reset;")[0], /duplicate @stylist reset;/)
        assert.match(read(BUTTON + ".root {}\n@stylist reset loader;")[0], /come first in an override sheet, before any rule/)
        assert.match(read(BUTTON + ".loader { @stylist reset; }")[0], /top-level statements — a part reset names the part at the top of the sheet: @stylist reset <part>;/)
        assert.match(read(BUTTON + "@stylist reset loader { }")[0], /not blocks/)
    })
})

describe("pass 1: collectOverrideSheet", () => {
    test("reads the directives, every class with its first line (nested source), own keyframes; never throws", () => {
        const css = [
            BUTTON.trim(),
            "@stylist reset loader;",
            ".root {",
            "    &:hover .loader { color: red }",
            "    & :is(.icon, .chevron) {}",
            "}",
            "@media (min-width: 1px) { .label:not(.loader) {} }",
            "@supports selector(.content:has(.children)) {}",
            "@keyframes pulse { to { opacity: .5 } }",
        ].join("\n")
        const info = collectOverrideSheet(css, { file: "app/overrides/button.css" })
        assert.equal(info.id, "button")
        assert.deepEqual(info.errors, [])
        assert.deepEqual(info.override, { target: { kind: "component", path: "Button" }, from: "@ds/react", within: null, line: 1 })
        assert.deepEqual(info.resets, [{ parts: ["loader"], line: 2 }])
        assert.deepEqual(info.classes, [
            { name: "chevron", line: 5 },
            { name: "children", line: 8 },
            { name: "content", line: 8 },
            { name: "icon", line: 5 },
            { name: "label", line: 7 },
            { name: "loader", line: 4 },
            { name: "root", line: 3 },
        ])
        assert.deepEqual(info.keyframes, ["pulse"])
        assert.deepEqual(info.components, [])
        assert.equal(collectOverrideSheet(".root {", { file: "x.css" }).errors[0].kind, "parse")
        assert.equal(collectOverrideSheet(".root {}", { file: "x.css", id: "y" }).id, "y")
    })

    test("the :component() references of the context, with their first line; a malformed one is a selector error", () => {
        const info = collectOverrideSheet(`${BUTTON}:component(Table.Td) .root {}\n@scope (:component(gram/ListCollection)) { .label {} }\n:component(Table.Td) > .icon {}`, { file: "o/button.css" })
        assert.deepEqual(info.errors, [])
        assert.deepEqual(info.components, [
            { arg: "Table.Td", namespace: null, path: "Table.Td", line: 2 },
            { arg: "gram/ListCollection", namespace: "gram", path: "ListCollection", line: 3 },
        ])
        const bad = collectOverrideSheet(`${BUTTON}:component(table) .root {}`, { file: "o/button.css" })
        assert.deepEqual(bad.errors.map(e => [e.kind, e.line]), [["selector", 2]])
        assert.match(bad.errors[0].message, /:component\(table\) — expected ":component\(Path\)"/)
    })

    test("the sheet id is its kebab-case file name: another is an error of pass 1, so of the resolution", async () => {
        for (const file of ["o/Button.css", "o/button.override.css", "o/button_x.css"]) {
            const info = collectOverrideSheet(`${BUTTON}.root {}`, { file })
            assert.deepEqual(info.errors.map(e => e.kind), ["scope"], file)
            assert.match(info.errors[0].message, /^the sheet id ".+" \(its file name\) is not kebab-case — rename the sheet/)
        }
        assert.deepEqual(collectOverrideSheet(`${BUTTON}.root {}`, { file: "o/table-in-cart.css" }).errors, [])
        const r = await resolveSheets({ "o/Button.css": `${BUTTON}.root {}` })
        assert.deepEqual(r.errors.map(e => [e.code, e.message]), [["invalid-override", "o/Button.css: the sheet id \"Button\" (its file name) is not kebab-case — rename the sheet (button.css, table-in-cart.css): the id namespaces its own keyframes"]])
    })
})

describe("resolution against the registry", () => {
    test("component form: the scope binding it, its identity tag and root part — marker and custom-tag roots, members, Root", async () => {
        const { registry } = await designSystem()
        const target = (path: string, namespace = "core") => resolveOverrideTarget(registry, namespace, { kind: "component", path }, "@ds/react")
        assert.deepEqual(target("Button"), { kind: "component", prefix: "ds", namespace: "core", scope: "button", path: "Button", tag: "ds-button", rootPart: "root", label: "Button (core, from \"@ds/react\")" })
        assert.deepEqual(target("Table"), { kind: "component", prefix: "ds", namespace: "core", scope: "table", path: "Table", tag: "ds-table", rootPart: "root", label: "Table (core, from \"@ds/react\")" })
        assert.deepEqual(target("Table.Tr"), { kind: "component", prefix: "ds", namespace: "core", scope: "table", path: "Table.Tr", tag: "ds-table-tr", rootPart: "tr", label: "Table.Tr (core, from \"@ds/react\")" })
        assert.deepEqual(target("UserMenu.Item"), { kind: "component", prefix: "ds", namespace: "core", scope: "user-menu", path: "UserMenu.Item", tag: "ds-usermenu-item", rootPart: "item", label: "UserMenu.Item (core, from \"@ds/react\")" })
        const root = { kind: "component", prefix: "ds", namespace: "gram", scope: "list-collection", path: "ListCollection.Root", tag: "ds-gram-listcollection", rootPart: "root", label: "ListCollection (gram, from \"@ds/react\")" }
        assert.deepEqual(target("ListCollection", "gram"), root)
        assert.deepEqual(target("ListCollection.Root", "gram"), root)
    })

    test("scope form: the named sheet of the namespace; `root` only when the sheet has that part", async () => {
        const { registry } = await designSystem()
        assert.deepEqual(resolveOverrideTarget(registry, "core", { kind: "sheet", scope: "tooltip" }, "@ds/react"), {
            kind: "sheet", prefix: "ds", namespace: "core", scope: "tooltip", path: null, tag: null, rootPart: null, label: "sheet \"tooltip\" (core, from \"@ds/react\")",
        })
        assert.equal((resolveOverrideTarget(registry, "core", { kind: "sheet", scope: "controls" }, "x") as { rootPart: string }).rootPart, "root")
    })

    test("unknown targets: did-you-mean, the namespace that has it, the members of a family, the delegate hint", async () => {
        const { registry } = await designSystem()
        const message = (path: string, namespace = "core") => (resolveOverrideTarget(registry, namespace, { kind: "component", path }, "@ds/react") as { code: string; message: string })
        assert.deepEqual(message("Buton"), { code: "unknown-target", message: "Buton is not a component of namespace \"core\" (from \"@ds/react\") — did you mean \"Button\"?" })
        assert.match(message("ListCollection").message, /^ListCollection is not a component of namespace "core" .* It is a component of namespace "gram": name the package that exports it\.$/)
        assert.equal(
            message("UserMenu").message,
            "UserMenu is not a component of namespace \"core\" (from \"@ds/react\") UserMenu has no identity of its own; the user-menu sheet binds UserMenu.Header, UserMenu.Item: override a member (@stylist override UserMenu.Header from \"@ds/react\";) or the sheet (@stylist override user-menu from \"@ds/react\";).",
        )
        assert.match(message("ModalConfirm").message, /A component that renders another one has no sheet of its own: override the component it renders\./)
        // a component rendering another one's identity, with a sheet of its own named after it (Tooltip renders a Popover)
        assert.equal(
            message("Tooltip").message,
            "Tooltip is not a component of namespace \"core\" (from \"@ds/react\") Tooltip renders another component's identity; its own look is the tooltip sheet: @stylist override tooltip from \"@ds/react\"; (its parts: bubble, link, link-icon).",
        )
        assert.match(message("Tooltip.Content").message, /its own look is the tooltip sheet: @stylist override tooltip from "@ds\/react";/)
        const sheet = (scope: string) => (resolveOverrideTarget(registry, "gram", { kind: "sheet", scope }, "@ds/gram") as { message: string }).message
        assert.equal(sheet("list-colection"), "\"list-colection\" is not a sheet of namespace \"gram\" (from \"@ds/gram\") — did you mean \"list-collection\"?")
        assert.match(sheet("tooltip"), /It is a sheet of namespace "core": name the package that exports its components\./)
    })

    test("unknown parts — classes and reset parts — with did-you-mean and the full part list, at their lines", async () => {
        const r = await resolveSheets({ "o/button.css": `${BUTTON}@stylist reset loadr;\n.root {}\n.lable {}\n.chevron:not(.zz) {}` })
        assert.deepEqual(r.sheets, [])
        assert.deepEqual(r.errors.map(e => e.code), ["unknown-part", "unknown-part", "unknown-part"])
        const parts = "chevron, children, content, icon, label, loader, root"
        assert.deepEqual(r.errors.map(e => e.message), [
            `o/button.css:4: Button (core, from "@ds/react") has no part "lable" — did you mean "label"? Its parts: ${parts}`,
            `o/button.css:5: Button (core, from "@ds/react") has no part "zz" Its parts: ${parts}`,
            `o/button.css:2: Button (core, from "@ds/react") has no part "loadr" — did you mean "loader"? Its parts: ${parts}`,
        ])
        assert.deepEqual(r.errors[0].files, ["o/button.css"])

        const scoped = await resolveSheets({ "o/tooltip.css": "@stylist override tooltip from \"@ds/react\";\n@stylist reset root;\n.root .bubble {}" })
        assert.deepEqual(scoped.errors.map(e => e.message), [
            "o/tooltip.css:3: sheet \"tooltip\" (core, from \"@ds/react\") has no \"root\" part — in an override of a sheet, .root is that sheet's root part. Its parts: bubble, link, link-icon",
            "o/tooltip.css:2: sheet \"tooltip\" (core, from \"@ds/react\") has no \"root\" part to reset. Its parts: bubble, link, link-icon",
        ])
    })

    test("`from`: an unresolved package, a css package, the app's own package, an unconfigured design system", async () => {
        const errorsOf = async (from: string) => (await resolveSheets({ "o/x.css": `@stylist override Button from "${from}";\n.root {}` })).errors
        assert.deepEqual(await errorsOf("@ds/reakt"), [{ code: "unresolved-package", message: "o/x.css:1: from \"@ds/reakt\": @ds/reakt is not installed where the override sheet is", files: ["o/x.css"] }])
        assert.match((await errorsOf("@ds/css"))[0].message, /from "@ds\/css": @ds\/css is a css package .* name the component package/)
        assert.match((await errorsOf("@shop/ui"))[0].message, /"@shop\/ui" is a package of the app itself \(prefix "app"\) — an override sheet restyles a design-system component/)
        assert.match((await errorsOf("@other/ui"))[0].message, /belongs to the design system of prefix "zz", whose registry is not configured \(css\.overrides\.registries: prefix ds\)/)
    })

    test("within: an app component of one namespace, `ns/Path`, ambiguity, did-you-mean, no app registry", () => {
        const app = appRegistry()
        assert.deepEqual(resolveWithin(app, { namespace: null, path: "RenderCart" }), { namespace: "render", path: "RenderCart", tag: "app-render-cart" })
        assert.deepEqual(resolveWithin(app, { namespace: "core", path: "Cart" }), { namespace: "core", path: "Cart", tag: "app-cart" })
        assert.deepEqual(resolveWithin(app, { namespace: null, path: "Shared" }), {
            code: "unknown-within",
            message: "within Shared is ambiguous: core/Shared, render/Shared — name the namespace, within core/Shared",
        })
        assert.deepEqual(resolveWithin(app, { namespace: "render", path: "Shared" }), { namespace: "render", path: "Shared", tag: "app-render-shared" })
        assert.equal((resolveWithin(app, { namespace: null, path: "RenderKart" }) as { message: string }).message, "within RenderKart: the app has no component RenderKart — did you mean \"RenderCart\"?")
        assert.match((resolveWithin(app, { namespace: "core", path: "RenderCart" }) as { message: string }).message, /no component RenderCart in namespace "core"/)
        assert.match((resolveWithin(null, { namespace: null, path: "Cart" }) as { message: string }).message, /needs the app's registry/)
    })

    test("several override sheets for one design-system sheet: one global, one per within component", async () => {
        const two = await resolveSheets({ "o/button.css": `${BUTTON}.root {}`, "o/button-2.css": `${BUTTON}.label {}` })
        assert.deepEqual(two.errors.map(e => [e.code, e.files]), [["duplicate-override", ["o/button.css", "o/button-2.css"]]])
        assert.match(two.errors[0].message, /both override the button sheet of the "ds" design system .* merge them/)
        assert.deepEqual(two.sheets.map(s => s.file), ["o/button.css"])

        // Table and Table.Tr are one target sheet
        const member = await resolveSheets({ "o/table.css": `${TABLE}.root {}`, "o/tr.css": "@stylist override Table.Tr from \"@ds/react\";\n.root {}" })
        assert.deepEqual(member.errors.map(e => e.code), ["duplicate-override"])

        // a global and a scoped sheet coexist; two scoped ones for one component don't
        const scoped = {
            "o/table.css": `${TABLE}.root {}`,
            "o/table-in-cart.css": "@stylist override Table from \"@ds/react\" within RenderCart;\n.root {}",
            "o/table-in-core-cart.css": "@stylist override Table from \"@ds/react\" within Cart;\n.root {}",
        }
        assert.deepEqual((await resolveSheets(scoped)).errors, [])
        const again = await resolveSheets({ ...scoped, "o/table-in-cart-2.css": "@stylist override Table.Tr from \"@ds/react\" within render/RenderCart;\n.root {}" })
        assert.deepEqual(again.errors.map(e => e.code), ["duplicate-override"])
        assert.match(again.errors[0].message, /within RenderCart .* and within component keeps the cascade deterministic/)

        // sheet ids are unique (they name keyframes)
        const ids = await resolveSheets({ "a/button.css": `${BUTTON}.root {}`, "b/button.css": "@stylist override Modal from \"@ds/react\";\n.root {}" })
        assert.deepEqual(ids.errors.map(e => [e.code, e.files]), [["invalid-override", ["a/button.css", "b/button.css"]]])
    })

    test("resets: parts by name, `root` as the target's root part, a whole component, a whole sheet; within and shared sheets refused", async () => {
        const r = await resolveSheets({
            "o/button.css": `${BUTTON}@stylist reset loader;\n@stylist reset root icon;\n.root {}`,
            "o/table.css": `${TABLE}@stylist reset;\n.root {}`,
            "o/tooltip.css": "@stylist override tooltip from \"@ds/react\";\n@stylist reset bubble;\n.bubble {}",
        })
        assert.deepEqual(r.errors, [])
        const button = r.sheets.find(s => s.file === "o/button.css")!
        assert.deepEqual([button.resets, button.whole, button.uses], [["icon", "loader", "root"], false, []])
        const table = r.sheets.find(s => s.file === "o/table.css")!
        assert.deepEqual([table.whole, table.resets], [true, ["button", "cell", "root", "row", "td", "th", "tr"]])
        assert.deepEqual(
            r.resets.map(t => [t.label, t.attr, t.tag, t.sheet, t.line]),
            [
                ["ds:core/button:icon", ds("button", "icon"), null, "o/button.css", 3],
                ["ds:core/button:loader", ds("button", "loader"), null, "o/button.css", 2],
                ["ds:core/button:root", ds("button", "root"), "ds-button", "o/button.css", 3],
                ["ds:core/table:button", ds("table", "button"), "ds-table-button", "o/table.css", 2],
                ["ds:core/table:cell", ds("table", "cell"), null, "o/table.css", 2],
                ["ds:core/table:root", ds("table", "root"), "ds-table", "o/table.css", 2],
                ["ds:core/table:row", ds("table", "row"), null, "o/table.css", 2],
                ["ds:core/table:td", ds("table", "td"), "ds-table-td", "o/table.css", 2],
                ["ds:core/table:th", ds("table", "th"), null, "o/table.css", 2],
                ["ds:core/table:tr", ds("table", "tr"), "ds-table-tr", "o/table.css", 2],
                ["ds:core/tooltip:bubble", ds("tooltip", "bubble"), null, "o/tooltip.css", 2],
            ],
        )
        assert.deepEqual(r.resets[0], { prefix: "ds", namespace: "core", scope: "button", part: "icon", attr: ds("button", "icon"), label: "ds:core/button:icon", tag: null, sheet: "o/button.css", line: 3 })

        // `reset root` of a member is its root local
        const tr = await resolveSheets({ "o/tr.css": "@stylist override Table.Tr from \"@ds/react\";\n@stylist reset root;\n.root {}" })
        assert.deepEqual(tr.resets.map(t => [t.part, t.tag]), [["tr", "ds-table-tr"]])

        // a whole reset of a component whose sheet binds others
        const shared = await resolveSheets({
            "o/tr.css": "@stylist override Table.Tr from \"@ds/react\";\n@stylist reset;\n.root {}",
            "o/play.css": "@stylist override PlayButton from \"@ds/react\";\n@stylist reset;\n.root {}",
        })
        assert.deepEqual(shared.errors.map(e => e.code), ["shared-reset", "shared-reset"])
        assert.match(shared.errors[0].message, /^o\/tr\.css:2: @stylist reset; resets the whole table sheet, which also styles Table, Table\.Td, Table\.Button — reset Table\.Tr's parts by name .* or override the sheet \(@stylist override table from "@ds\/react";\)/)
        assert.match(shared.errors[1].message, /whole controls sheet, which also styles ControlsBar/)
        // … which the scope form resets whole
        const sheetForm = await resolveSheets({ "o/controls.css": "@stylist override controls from \"@ds/react\";\n@stylist reset;\n.play {}" })
        assert.deepEqual([sheetForm.errors, sheetForm.sheets[0].resets], [[], ["play", "root"]])

        const within = await resolveSheets({ "o/t.css": "@stylist override Table from \"@ds/react\" within RenderCart;\n@stylist reset td;\n.root {}" })
        assert.deepEqual(within.errors.map(e => e.code), ["reset-within"])
        assert.match(within.errors[0].message, /^o\/t\.css:2: @stylist reset in a sheet scoped with within — a reset edits the design system's stylesheets at build time/)
    })

    test("own keyframes named like the target's keyframes are ambiguous", async () => {
        const r = await resolveSheets({ "o/modal.css": "@stylist override Modal from \"@ds/react\";\n.root { animation: fade-in 1s }\n@keyframes fade-in { to { opacity: 1 } }" })
        assert.deepEqual(r.errors.map(e => e.code), ["keyframes-clash"])
        assert.match(r.errors[0].message, /@keyframes fade-in: Modal .* has keyframes "fade-in" too/)
    })

    test("directive and parse errors of a sheet are invalid-override errors", async () => {
        const r = await resolveSheets({ "o/x.css": ".root {}", "o/y.css": `${BUTTON}@stylist reset .loader;` })
        assert.deepEqual(r.errors.map(e => [e.code, e.message.split(":")[0]]), [["invalid-override", "o/x.css"], ["invalid-override", "o/y.css"]])
    })
})

describe("the lock sections", () => {
    test("overrideLock: every identity and part read or reset, prefixed by the design system; toLock adds the sections only when non-empty", async () => {
        const r = await resolveSheets({
            "o/button.css": `${BUTTON}@stylist reset loader;\n.root .chevron {}`,
            "o/tooltip.css": "@stylist override tooltip from \"@ds/react\";\n.bubble {}",
            "o/list.css": "@stylist override ListCollection from \"@ds/gram\";\n.item {}",
        })
        assert.deepEqual(r.errors, [])
        assert.deepEqual(r.lock, {
            overrides: {
                "ds:core/Button": "ds-button",
                "ds:core/button:chevron": ds("button", "chevron"),
                "ds:core/button:loader": ds("button", "loader"),
                "ds:core/tooltip:bubble": ds("tooltip", "bubble"),
                "ds:gram/ListCollection.Root": "ds-gram-listcollection",
                "ds:gram/list-collection:item": ds("list-collection", "item", "gram"),
            },
            resets: { "ds:core/button:loader": ds("button", "loader") },
        })
        const { registry } = await designSystem()
        const plain = toLock(registry)
        assert.deepEqual(Object.keys(plain), ["parts", "tags"])
        assert.deepEqual(toLock(registry, { overrides: {}, resets: {} }), plain)
        assert.deepEqual(Object.keys(toLock(registry, r.lock)), ["parts", "tags", "overrides", "resets"])
        assert.deepEqual(Object.keys(toLock(registry, { overrides: r.lock.overrides, resets: {} })), ["parts", "tags", "overrides"])
    })

    test("diffLock: a renamed part a sheet reads or resets is a breaking change", () => {
        const before = { parts: {}, tags: {}, overrides: { "ds:core/button:loader": "_cxclass_ds-aaaaaa" }, resets: { "ds:core/button:loader": "_cxclass_ds-aaaaaa" } }
        const after = { parts: {}, tags: {}, overrides: { "ds:core/button:spinner": "_cxclass_ds-bbbbbb" } }
        const diff = diffLock(before, after)
        assert.equal(diff.breaking, true)
        assert.equal(
            formatLockDiff(diff),
            ["- override ds:core/button:loader _cxclass_ds-aaaaaa", "- reset ds:core/button:loader _cxclass_ds-aaaaaa", "+ override ds:core/button:spinner _cxclass_ds-bbbbbb"].join("\n"),
        )
        assert.equal(diffLock({ parts: {}, tags: {} }, { parts: {}, tags: {}, resets: { a: "b" } }).breaking, false)
    })
})

describe("compile: stylistOverride()", () => {
    test(".root is the identity — marker and custom tag alike — and every other class the part attribute, with a class's specificity", async () => {
        const src = `${BUTTON}.root, .root[data-kind="primary"] .content > .children, .label:hover::before {}`
        const css = await compile("o/button.css", src)
        assert.deepEqual(selectors(css), [
            `:is(ds-button,[ds-button]), :is(ds-button,[ds-button])[data-kind="primary"] [${ds("button", "content")}] > [${ds("button", "children")}], [${ds("button", "label")}]:hover::before`,
        ])
        assert.deepEqual(specificityList(selectors(css)[0]), specificityList(".root, .root[data-kind=\"primary\"] .content > .children, .label:hover::before"))
        assert.deepEqual(specificityList(selectors(css)[0]), [[0, 1, 0], [0, 4, 0], [0, 2, 1]])
        assert.doesNotMatch(css, /@stylist/)
        assert.deepEqual(findClassSelectors(css), [])

        const table = await compile("o/table.css", `${TABLE}.root .tr .td {}`)
        assert.deepEqual(selectors(table), [`:is(ds-table,[ds-table]) [${ds("table", "tr")}] [${ds("table", "td")}]`])
        // a member's .root is its own identity; its root local is its part
        const tr = await compile("o/tr.css", "@stylist override Table.Tr from \"@ds/react\";\n.root, .tr, .root .cell {}")
        assert.deepEqual(selectors(tr), [`:is(ds-table-tr,[ds-table-tr]), [${ds("table", "tr")}], :is(ds-table-tr,[ds-table-tr]) [${ds("table", "cell")}]`])
        // the scope form: .root is the sheet's root part
        const controls = await compile("o/controls.css", "@stylist override controls from \"@ds/react\";\n.root .play {}")
        assert.deepEqual(selectors(controls), [`[${ds("controls", "root")}] [${ds("controls", "play")}]`])
    })

    test("nesting, combinators, pseudo-classes and elements, lists, at-rule preludes, document context", async () => {
        const src = [
            BUTTON.trim(),
            ".root {",
            "    &[data-size=\"small\"] { --btn-h: 20px; }",
            "    &:not([disabled]):hover { color: red; }",
            "    & .loader, & > .content ~ .chevron { display: grid; }",
            "    &::after { content: \"\"; }",
            "    .label + & { margin: 0; }",
            "    @media (min-width: 600px) { & .icon { width: 1em; } }",
            "}",
            ":root[data-theme=\"dark\"] .root:has(> .icon):is(:focus-visible, [data-force=\"focus\"]) .children:where(:not(.label)) { color: white; }",
            ":nth-child(2 of .root) {}",
            "@supports selector(.root:has(.loader)) { .content { gap: 4px; } }",
            "@scope (.root) to (.content) { .icon { color: red; } }",
        ].join("\n")
        const css = await compile("o/button.css", src)
        const B = ":is(ds-button,[ds-button])"
        const [loader, content, chevron, icon, label, children] = ["loader", "content", "chevron", "icon", "label", "children"].map(p => `[${ds("button", p)}]`)
        assert.deepEqual(selectors(css), [
            `${B}[data-size="small"]`,
            `${B}:not([disabled]):hover`,
            `${B} ${loader},${B} > ${content} ~ ${chevron}`,
            `${B}::after`,
            `${label} + ${B}`,
            `${B} ${icon}`,
            `:root[data-theme="dark"] ${B}:has(> ${icon}):is(:focus-visible, [data-force="focus"]) ${children}:where(:not(${label}))`,
            `:nth-child(2 of ${B})`,
            content,
            icon,
        ])
        assert.ok(css.includes(`@supports selector(${B}:has(${loader}))`), css)
        assert.match(css, /@scope \(:is\(ds-button,\[ds-button\]\)\) to \(\[_cxclass_ds-[0-9a-z]+\]\)/)
        assert.deepEqual(findClassSelectors(css), [])
    })

    test("specificity: every rewrite keeps the class's (0,1,0), rule by rule", async () => {
        const src = `${BUTTON}.root .content > .loader:hover, .root:is(.label, [data-x]), .icon:not(.chevron)::before, :where(.root) .children {}`
        const css = await compile("o/button.css", src)
        assert.deepEqual(specificityList(selectors(css)[0]), specificityList(src.split("\n")[1].replace(" {}", "")))
    })

    test("forbidden selectors: other components, :global, ids, classes as attributes, hashes, dev and removed attributes, identities, unanchored rules", async () => {
        const cases: Array<[string, RegExp]> = [
            [".root :component(Icon) {}", /\[override-selector\] ".root :component\(Icon\)": :component\(Icon\) is the element this rule styles — another design-system component is restyled in its own override sheet \(@stylist override Icon …\), where this component is context/],
            [".root :is(.icon, :component(Icon)) {}", /:component\(Icon\) is the element this rule styles/],
            [".root :cx(icon:glyph) {}", /:cx\(icon:glyph\) — an override speaks its target's vocabulary/],
            [".root :global(.x) {}", /:global\(\.x\) — :global\(\) is legacy only/],
            [".root#save {}", /#save selects one instance/],
            [".root[class~=\"x\"] {}", /\[class~="x"\] selects a class/],
            [`.root [${ds("button", "loader")}] {}`, /is a generated part attribute — write the part by name \(\.loader\)/],
            [".root[_cxpart~=\"loader\"] {}", /is a dev-only attribute/],
            [".root[data-react-component] {}", /is a dev-only attribute/],
            [".root[data-file-source] {}", /is a dev-only attribute/],
            [".root [data-part=\"x\"] {}", /is a removed hook/],
            [".root[data-component] {}", /is a removed hook/],
            ["ds-button .loader {}", /"ds-button \.loader": ds-button is an identity tag — write \.root/],
            ["[ds-button] .loader {}", /\[ds-button\] is an identity marker/],
            ["app-cart .root {}", /": app-cart is an identity tag/],
            [".root [app-cart] {}", /\[app-cart\] is an identity marker/],
            ["[data-open] {}", /\[override-selector\] "\[data-open\]": the selector names no part of Button .* \(outside :not\(\)\) — every override selector reaches \.root or a part/],
            ["button:not(.root) {}", /names no part of Button/],
            [".root, [data-open] {}", /"\[data-open\]": the selector names no part/],
            // a part named only as context: the element styled is outside the component
            [":root:has(.root) [data-open] {}", /\[override-selector\] ":root:has\(\.root\) \[data-open\]": \[data-open\] is not \.root, a part of Button \(core, from "@ds\/react"\) or inside one — an override restyles the target's own elements/],
            [":has(.loader) {}", /":has\(\.loader\)": :has\(\.loader\) is not \.root, a part of Button/],
            ["[data-open]:has(.loader) {}", /is not \.root, a part of Button/],
            [".root ~ p {}", /"\.root ~ p": p is not \.root, a part of Button/],
            [".root + * {}", /is not \.root, a part of Button/],
            [":is(.icon, p) {}", /is not \.root, a part of Button/],
            [":nth-child(2 of .root, p) {}", /is not \.root, a part of Button/],
            [":component(Table.Td) svg {}", /names no part of Button/],
        ]
        for (const [rule, message] of cases) await assert.rejects(compile("o/button.css", `${BUTTON}${rule}`), message, rule)
        await assert.rejects(compile("o/button.css", `${BUTTON}@layer x { .root {} }`), /@layer — the build wraps an override sheet in the overrides layer/)
        await assert.rejects(compile("o/button.css", `${BUTTON}@import "./x.css";`), /@import — an override sheet is compiled alone/)
        // the element styled is .root, a part or inside one — data-*, aria-*, role, states, type selectors and
        // :has() on it pass through, so do siblings inside the component; document context goes before
        const inside = [".root:has(.loader)", "section :is(.root)[aria-busy=\"true\"][role] svg", ".content > *", ".icon + .children", ".root .icon ~ span", ":nth-child(2 of .root)", ":where(.label, .children):hover"]
        assert.equal(selectors(await compile("o/button.css", `${BUTTON}${inside.join(", ")} {}`)).length, 1)
        // an at-rule prelude limits or tests, it selects nothing: no part needed
        const prelude = await compile("o/button.css", `${BUTTON}@supports selector(:has(*)) { .root:has(.icon) { gap: 4px } }\n@scope ([data-x]) { .label { color: red } }`)
        assert.match(prelude, /@supports selector\(:has\(\*\)\) \{ :is\(ds-button,\[ds-button\]\):has\(\[_cxclass_ds-[0-9a-z]+\]\) \{ gap: 4px \} \}/)
        assert.match(prelude, /@scope \(\[data-x\]\) \{ \[_cxclass_ds-[0-9a-z]+\] \{ color: red \} \}/)
    })

    test("another design-system component as context: :component() before .root or a part, inside :has() or a prelude — never the element styled", async () => {
        // Buttons inside table cells: the Button override, the cell as context
        const src = `${BUTTON}:component(Table.Td) .root, .root:has(:component(Icon)), :component(Table.Td) > .content .icon {}\n@scope (:component(Table)) { .label {} }`
        const r = await resolveSheets({ "o/button.css": src })
        assert.deepEqual(r.errors, [])
        assert.deepEqual(r.sheets[0].components, [
            { arg: "Icon", namespace: "core", path: "Icon", tag: "ds-icon" },
            { arg: "Table", namespace: "core", path: "Table", tag: "ds-table" },
            { arg: "Table.Td", namespace: "core", path: "Table.Td", tag: "ds-table-td" },
        ])
        assert.deepEqual(r.sheets[0].plugin.components, { Icon: "ds-icon", Table: "ds-table", "Table.Td": "ds-table-td" })
        const css = (await postcss([nesting(), stylistOverride(r.sheets[0].plugin)]).process(src, { from: "o/button.css" })).css
        const B = ":is(ds-button,[ds-button])"
        assert.deepEqual(selectors(css), [
            `:is(ds-table-td,[ds-table-td]) ${B}, ${B}:has(:is(ds-icon,[ds-icon])), :is(ds-table-td,[ds-table-td]) > [${ds("button", "content")}] [${ds("button", "icon")}]`,
            `[${ds("button", "label")}]`,
        ])
        assert.match(css, /@scope \(:is\(ds-table,\[ds-table\]\)\)/)
        // the same specificity as the design system's own :component(): (0,1,0)
        assert.deepEqual(specificityList(selectors(css)[0]), [[0, 2, 0], [0, 2, 0], [0, 3, 0]])
        // the lock records the identities it reads, so a rename of Table.Td shows up in review
        assert.equal(r.lock.overrides["ds:core/Table.Td"], "ds-table-td")

        // the element styled is another component: its own override sheet, where this one is context
        await assert.rejects(compile("o/table.css", `${TABLE}.td :component(Button) {}`), /\[override-selector\] "\.td :component\(Button\)": :component\(Button\) is the element this rule styles — another design-system component is restyled in its own override sheet \(@stylist override Button …\)/)
        // resolution: the target's own identities are written with their class, an unknown one has a did-you-mean
        const errors = async (css: string, file = "o/button.css") => (await resolveSheets({ [file]: css })).errors.map(e => `[${e.code}] ${e.message}`)
        assert.deepEqual(await errors(`${BUTTON}:component(Button) .label {}`), ["[unresolved-ref] o/button.css:2: :component(Button) is an identity of the button sheet this sheet overrides — write .root"])
        assert.deepEqual(await errors(`${TABLE}:component(Table.Tr) .cell {}`, "o/table.css"), ["[unresolved-ref] o/table.css:2: :component(Table.Tr) is an identity of the table sheet this sheet overrides — write .tr"])
        assert.deepEqual(await errors(`${BUTTON}:component(Tabel.Td) .root {}`), [
            "[unresolved-ref] o/button.css:2: :component(Tabel.Td): Tabel.Td is not a component of namespace \"core\" of the design system of \"@ds/react\" — did you mean \"Table.Td\"? (an override's :component() names a component of the same design system; an app component is `within`)",
        ])
        assert.match((await errors(`${BUTTON}:component(nope/Table) .root {}`))[0], /the design system of "@ds\/react" has no namespace "nope"/)
        assert.deepEqual(await errors(`${BUTTON}:component(gram/ListCollection) .root {}`), [])
        // the plugin without the resolution's components
        await assert.rejects(postcss([stylistOverride({ ...r.sheets[0].plugin, components: {} })]).process(":component(Table.Td) .root {}", { from: "o/button.css" }), /\[unresolved-ref\] :component\(Table\.Td\) is not resolved against the design system/)
        // within: the suffix goes on the first compound that is the target's, not on the context
        const scoped = "@stylist override Button from \"@ds/react\" within RenderCart;\n:component(Table.Td) .root {}"
        const w = await resolveSheets({ "o/button-in-cart.css": scoped })
        const out = (await postcss([nesting(), stylistOverride(w.sheets[0].plugin)]).process(scoped, { from: "o/button-in-cart.css" })).css
        assert.deepEqual(selectors(out), [`:is(ds-table-td,[ds-table-td]) ${B}:is(app-render-cart,[app-render-cart],app-render-cart *,[app-render-cart] *)`])
    })

    test("unknown parts at compile time name the target and its parts", async () => {
        const r = await resolveSheets({ "o/button.css": `${BUTTON}.root {}` })
        const plugin = r.sheets[0].plugin
        await assert.rejects(postcss([nesting(), stylistOverride(plugin)]).process(`${BUTTON}.spinner {}`, { from: "o/button.css" }), /\[unknown-part\] Button \(core, from "@ds\/react"\) has no part "spinner" Its parts: chevron, children, content, icon, label, loader, root/)
        const scoped = { ...plugin, identity: null, label: "sheet \"tooltip\"", parts: { bubble: "_cxclass_ds-aaaaaa" } }
        await assert.rejects(postcss([stylistOverride(scoped)]).process(".root {}", { from: "o/tooltip.css" }), /\[unknown-part\] sheet "tooltip" has no "root" part/)
    })

    test("keyframes: own ones namespaced by the app prefix and the sheet id; the target's by their local name; a clash is an error", async () => {
        const sink: StylistOverrideSink = {}
        const css = await compile("o/button.css", `${BUTTON}.loader { animation: pulse 1s, spin 2s linear; }\n.chevron { animation-name: pulse; }\n@keyframes pulse { to { opacity: .5 } }`, sink)
        assert.match(css, /animation: app-override-button-pulse 1s, ds-button-spin 2s linear;/)
        assert.match(css, /animation-name: app-override-button-pulse;/)
        assert.match(css, /@keyframes app-override-button-pulse \{/)
        assert.deepEqual(sink, { uses: ["chevron", "loader"], keyframes: { pulse: "app-override-button-pulse" } })
        const r = await resolveSheets({ "o/modal.css": "@stylist override Modal from \"@ds/react\";\n.root {}" })
        await assert.rejects(postcss([stylistOverride(r.sheets[0].plugin)]).process("@keyframes fade-in { to {} }\n.root {}", { from: "o/modal.css" }), /\[keyframes-clash\] @keyframes fade-in: Modal/)
    })

    test("within: the first compound naming a part gets the app component's identity-or-inside suffix, before a pseudo-element, +(0,1,0)", async () => {
        const src = "@stylist override Table from \"@ds/react\" within RenderCart;\n.root .td, :root[data-theme=\"dark\"] .tr::before, [data-x] > .cell:hover {}"
        const r = await resolveSheets({ "o/table-in-cart.css": src })
        assert.deepEqual(r.errors, [])
        assert.deepEqual(r.sheets[0].within, { namespace: "render", path: "RenderCart", tag: "app-render-cart" })
        const css = (await postcss([nesting(), stylistOverride(r.sheets[0].plugin)]).process(src, { from: "o/table-in-cart.css" })).css
        const W = ":is(app-render-cart,[app-render-cart],app-render-cart *,[app-render-cart] *)"
        assert.deepEqual(selectors(css), [
            `:is(ds-table,[ds-table])${W} [${ds("table", "td")}], :root[data-theme="dark"] [${ds("table", "tr")}]${W}::before, [data-x] > [${ds("table", "cell")}]:hover${W}`,
        ])
        const plain = specificityList(":is(ds-table,[ds-table]) [a], :root[data-theme=\"dark\"] [b]::before, [data-x] > [c]:hover")
        assert.deepEqual(specificityList(selectors(css)[0]), plain.map(([a, b, c]) => [a, b + 1, c]))
        // preludes are not scoped; the rules inside them are
        const scoped = "@stylist override Table from \"@ds/react\" within RenderCart;\n@scope (.root) { .td { color: red } }"
        const r2 = await resolveSheets({ "o/table-in-cart.css": scoped })
        const out = (await postcss([nesting(), stylistOverride(r2.sheets[0].plugin)]).process(scoped, { from: "o/table-in-cart.css" })).css
        assert.equal(out, `@scope (:is(ds-table,[ds-table])) { [${ds("table", "td")}]${W} { color: red } }`)
    })

    test("the plugin validates its options and needs a sheet id", async () => {
        const base: StylistOverrideOptions = { prefix: "ds", appPrefix: "app", label: "Button", parts: { loader: "_cxclass_ds-aaaaaa" }, identity: "ds-button" }
        assert.throws(() => stylistOverride(undefined as never), /needs options/)
        assert.throws(() => stylistOverride({ ...base, prefix: "D" }), /invalid design-system prefix/)
        assert.throws(() => stylistOverride({ ...base, appPrefix: "" }), /invalid app prefix/)
        await assert.rejects(postcss([stylistOverride(base)]).process(".root {}", { from: undefined }), /no sheet id/)
        const ok = await postcss([stylistOverride({ ...base, sheetId: "button" })]).process(".root .loader {}", { from: undefined })
        assert.equal(ok.css, ":is(ds-button,[ds-button]) [_cxclass_ds-aaaaaa] {}")
        await assert.rejects(postcss([stylistOverride({ ...base, sheetId: "button" })]).process(".root { .loader {} }", { from: undefined }), /nested rule — run postcss-nesting/)
    })
})

describe("workspace helpers", () => {
    test("compileOverride: nesting, the plugin, the layer wrap with the order statement", async () => {
        const src = `${BUTTON}@stylist reset loader;\n.root { border-radius: 2px; & .loader { display: grid } }`
        const r = await resolveSheets({ "o/button.css": src })
        const compiled = await compileOverride(src, { from: "o/button.css", plugin: r.sheets[0].plugin, statement: STATEMENT })
        assert.equal(
            compiled.css,
            `@layer reset, tokens, components, utilities, app.overrides, app.core, app.render;\n@layer app.overrides {\n:is(ds-button,[ds-button]) { border-radius: 2px; }\n:is(ds-button,[ds-button]) [${ds("button", "loader")}] { display: grid }\n}\n`,
        )
        assert.deepEqual([compiled.layer, compiled.uses, compiled.keyframes, compiled.warnings], [DEFAULT_OVERRIDES_LAYER, ["loader"], {}, []])
        assert.equal((await compileOverride(src, { from: "o/button.css", plugin: r.sheets[0].plugin, statement: ["components", "x"], layer: "x" })).css.split("\n")[1], "@layer x {")
    })

    test("overridesLayerProblem: after components, before every namespace layer, a layer of its own", () => {
        const ns = ["app.core", "app.render"]
        assert.equal(overridesLayerProblem(STATEMENT, "app.overrides", ns), null)
        assert.equal(overridesLayerProblem(["reset", "tokens", "components", "utilities", "crm-theme", "app.overrides", "app.core"], "app.overrides", ["app.core"]), null)
        assert.match(overridesLayerProblem(["reset", "tokens", "components", "utilities", "app.core"], "app.overrides", ns) ?? "", /does not declare "app\.overrides", the layer of the override sheets — add it after "components" and before "app\.core", "app\.render"/)
        assert.match(overridesLayerProblem(["reset", "app.overrides", "tokens", "components", "app.core"], "app.overrides", ns) ?? "", /before the design system's "components" layer/)
        assert.match(overridesLayerProblem(["app.overrides", "app.core"], "app.overrides", ns) ?? "", /before the design system's "components" layer/)
        assert.match(overridesLayerProblem(["components", "app.core", "app.overrides", "app.render"], "app.overrides", ns) ?? "", /after "app\.core" — the app's own components .* must beat a global override/)
        assert.match(overridesLayerProblem(STATEMENT, "app.core", ns) ?? "", /is a namespace's layer/)
        assert.match(overridesLayerProblem(STATEMENT, "components", ns) ?? "", /is a design-system layer/)
    })

    test("declaredLayerOrder: every layer by first declaration, sublayers after their parent, inside conditions too", () => {
        const css = [
            "@layer reset, tokens, components, utilities;",
            "@layer components { [a] {} }",
            "@media (x) { @layer crm-theme; }",
            "@layer reset, tokens, components, utilities, crm-theme, app.core, app.render;",
            "@layer app { @layer overrides { [b] {} } }",
            "@layer { [c] {} }",
            "@layer app.core { @layer inner; }",
        ].join("\n")
        assert.deepEqual(declaredLayerOrder(css).map(l => l.name), ["reset", "tokens", "components", "utilities", "crm-theme", "app", "app.core", "app.core.inner", "app.render", "app.overrides"])
        assert.deepEqual(declaredLayerOrder(css).find(l => l.name === "app.core"), { name: "app.core", at: "@layer reset, tokens, components, utilities, crm-theme, app.core, app.render" })
    })

    test("bundleLayerProblem: a hand-written order statement that leaves the overrides layer out puts it after the app's layers", () => {
        const ns = ["app.core", "app.render"]
        const order = (...statements: string[]) => declaredLayerOrder(statements.map(x => `@layer ${x};`).join("\n"))
        const full = "reset, tokens, components, utilities, app.overrides, app.core, app.render"
        assert.equal(bundleLayerProblem(order(full), "app.overrides", ns), null)
        assert.equal(bundleLayerProblem(order("reset, tokens, components, utilities, crm-theme, app.overrides, app.core, app.render", full), "app.overrides", ns), null)
        assert.equal(bundleLayerProblem(order("reset, tokens, components, utilities, app.core"), "app.overrides", ns), null, "no override sheet bundled")
        // the CRM's globals.css imported before the override sheets
        assert.equal(
            bundleLayerProblem(order("reset, tokens, components, utilities, crm-theme, app.core, app.render", full), "app.overrides", ns),
            "the bundle declares \"app.overrides\" after \"app.core\", \"app.render\": \"@layer reset, tokens, components, utilities, crm-theme, app.core, app.render\" declares them first and does not list \"app.overrides\" — every @layer order statement the app writes lists \"app.overrides\" where css.layers.statement puts it (after \"components\", before the app's own layers), or the override sheets beat the app's components",
        )
        assert.match(bundleLayerProblem(order("app.overrides", full), "app.overrides", ns) ?? "", /declares "app\.overrides" before the design system's "components" layer \(first by "@layer app\.overrides"\)/)
    })

    test("!important: a design-system !important beats every override declaration of the same element and property", () => {
        const ds = "[_cxclass_ds-l][data-hidden] { visibility: hidden !important; color: red }\n[_cxclass_ds-d] [_cxclass_ds-k] { text-decoration: none !important }\n:is(ds-x,[ds-x]) > :is(ds-button,[ds-button]) { margin: 0 !important }\n@keyframes k { to { opacity: 0 !important } }"
        const importants = importantDeclarations(ds, "styles.css")
        assert.deepEqual(importants.map(d => [d.names, d.prop, d.selector, d.line]), [
            [["_cxclass_ds-l"], "visibility", "[_cxclass_ds-l][data-hidden]", 1],
            [["_cxclass_ds-k"], "text-decoration", "[_cxclass_ds-d] [_cxclass_ds-k]", 2],
            [["ds-button"], "margin", ":is(ds-x,[ds-x]) > :is(ds-button,[ds-button])", 3],
        ])
        const elements = new Map([["_cxclass_ds-l", ["_cxclass_ds-l"]], ["_cxclass_ds-k", ["_cxclass_ds-k"]], ["ds-button", ["ds-button", "_cxclass_ds-r"]], ["_cxclass_ds-r", ["ds-button", "_cxclass_ds-r"]]])
        const compiled = "[_cxclass_ds-l] { visibility: visible; color: blue }\n[_cxclass_ds-k]:hover { text-decoration-line: underline }\n:is(ds-button,[ds-button]) { margin-left: 4px !important; padding: 0 }\n[_cxclass_ds-z] { visibility: visible }"
        assert.deepEqual(importantConflicts(compiled, elements, importants).map(c => [c.prop, c.line, c.name, c.important.prop]), [
            ["visibility", 1, "_cxclass_ds-l", "visibility"],
            ["text-decoration-line", 2, "_cxclass_ds-k", "text-decoration"],
            ["margin-left", 3, "ds-button", "margin"],
        ])
        assert.deepEqual(importantConflicts(compiled, new Map(), importants), [])
        assert.equal(overlappingProperties("border", "border-top-color"), true)
        assert.equal(overlappingProperties("border", "border-radius"), false)
        assert.equal(overlappingProperties("flex", "flex-grow"), true)
        assert.equal(overlappingProperties("color", "background-color"), false)
    })

    test("renderOverridesModule: the header, one side-effect import per sheet sorted by path, export {}", () => {
        assert.equal(
            renderOverridesModule("/app/styles/overrides", ["/app/styles/overrides/table.css", "/app/styles/overrides/button.css", "/app/styles/overrides/cart/table-in-cart.css"]),
            `${PART_MAP_HEADER}\nimport "./button.css"\nimport "./cart/table-in-cart.css"\nimport "./table.css"\n\nexport {}\n`,
        )
        assert.equal(renderOverridesModule("/x", []), `${PART_MAP_HEADER}\n\nexport {}\n`)
    })
})
