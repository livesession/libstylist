import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"

import { parseSync } from "@babel/core"

import { normalizePackageConfig } from "../src/conventions/index.js"
import { CxGrammarError, collectRefs, isStaticIR, parseCxExpression } from "../src/codemod/legacy-cx.js"
import {
    classifyCxArg,
    dataAttrName,
    dataKeyOf,
    findScopePragma,
    isOwnPackageSpecifier,
    partMapGroup,
    partMapGroups,
    resolvePartMap,
    scopeOfExport,
    scopeOfExportName,
    type AnyNode,
    type CxEnv,
} from "../src/core/index.js"
import { partAttr, partHash, sha256, toHex } from "../src/hash/index.js"
import { stripNamespaceWord, tagName } from "../src/naming/index.js"

test("sha256 matches node:crypto on ASCII, unicode and block-boundary inputs", () => {
    const inputs = ["", "abc", "v1\u001felo\u001fcore\u001falert\u001ficon", "zażółć gęślą jaźń 🚀", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000)]
    for (let i = 0; i < 300; i++) inputs.push(Array.from({ length: i }, (_, j) => String.fromCharCode(32 + ((i * 7 + j * 13) % 90))).join(""))
    for (const s of inputs) assert.equal(toHex(sha256(s)), createHash("sha256").update(s, "utf8").digest("hex"), JSON.stringify(s))
})

test("SPEC §3.1 test vector", () => {
    assert.equal(toHex(sha256("v1\u001felo\u001fcore\u001falert\u001ficon")).slice(0, 16), "bad85507ad743675")
    assert.equal(partAttr({ prefix: "elo", namespace: "core", scope: "alert", part: "icon" }), "_cxclass_elo-or4d4l")
    assert.equal(partHash({ prefix: "elo", namespace: "core", scope: "alert", part: "icon" }).length, 6)
    assert.equal(partHash({ prefix: "elo", namespace: "core", scope: "alert", part: "icon" }, 8).length, 8)
})

test("part hash is name-derived and prefix/namespace sensitive", () => {
    const base = { prefix: "elo", namespace: "core", scope: "alert", part: "icon" }
    assert.equal(partAttr(base), partAttr({ ...base }))
    assert.notEqual(partAttr(base), partAttr({ ...base, prefix: "app" }))
    assert.notEqual(partAttr(base), partAttr({ ...base, namespace: "player" }))
    assert.notEqual(partAttr(base), partAttr({ ...base, part: "root" }))
    assert.match(partAttr({ ...base, prefix: "app" }), /^_cxclass_app-[0-9a-z]{6}$/)
    assert.throws(() => partAttr({ ...base, part: "Icon" }))
    assert.throws(() => partAttr({ ...base, scope: "a b" }))
})

test("naming: tags per namespace, word stripping, Root collapse", () => {
    const core = normalizePackageConfig({ prefix: "elo", namespace: "core" })
    const player = normalizePackageConfig({ prefix: "elo", namespace: "player" })
    const app = normalizePackageConfig({ prefix: "elo", namespace: "app" })
    const gram = normalizePackageConfig({ prefix: "elo", namespace: "gram" })
    const inf = normalizePackageConfig({ prefix: "elo", namespace: "inf" })
    const ai = normalizePackageConfig({ prefix: "elo", namespace: "ai" })
    assert.equal(core.segment, "")
    assert.equal(player.word, "Player")
    assert.equal(tagName(core, ["Alert"]), "elo-alert")
    assert.equal(tagName(core, ["Modal", "Header"]), "elo-modal-header")
    assert.equal(tagName(core, ["TextInput"]), "elo-textinput")
    assert.equal(tagName(player, ["ControlsBar"]), "elo-player-controlsbar")
    assert.equal(tagName(player, ["PlayerTopBar"]), "elo-player-topbar")
    assert.equal(tagName(player, ["PlayerTopBar", "Url"]), "elo-player-topbar-url")
    assert.equal(tagName(app, ["AppHeader"]), "elo-app-header")
    assert.equal(tagName(app, ["Dock"]), "elo-app-dock")
    assert.equal(tagName(gram, ["ListCollection", "Root"]), "elo-gram-listcollection")
    assert.equal(tagName(gram, ["ListCollection", "Item"]), "elo-gram-listcollection-item")
    assert.equal(tagName(inf, ["FilterBar"]), "elo-inf-filterbar")
    assert.equal(tagName(ai, ["ThinkingShader"]), "elo-ai-thinkingshader")
    assert.equal(stripNamespaceWord("Application", "App"), "Application")
    assert.equal(stripNamespaceWord("Player", "Player"), "Player")
})

test("naming: an app's render layer (namespace render → segment render, word Render)", () => {
    const core = normalizePackageConfig({ prefix: "crm", namespace: "core" })
    const render = normalizePackageConfig({ prefix: "crm", namespace: "render" })
    assert.deepEqual([render.segment, render.word], ["render", "Render"])
    assert.equal(tagName(core, ["InvitationRow"]), "crm-invitationrow")
    assert.equal(tagName(render, ["RenderInvitationRow"]), "crm-render-invitationrow")
    assert.equal(tagName(render, ["RenderAccounts", "Row"]), "crm-render-accounts-row")
    // the word is stripped only before an uppercase letter; without it the name is kept whole
    assert.equal(tagName(render, ["Renderer"]), "crm-render-renderer")
    assert.equal(tagName(render, ["InvitationRow"]), "crm-render-invitationrow")
    // a core compound under a `Render` parent would read as the render segment (the checker's C002)
    assert.equal(tagName(core, ["Render", "Row"]), "crm-render-row")
})


const expr = (code: string) => {
    const ast = parseSync(`(${code})`, { filename: "x.tsx", babelrc: false, configFile: false, parserOpts: { plugins: ["jsx", "typescript"] } })!
    return (ast.program.body[0] as any).expression
}

// --- the cx() call grammar (SPEC §5.2) ------------------------------------------------------------

/** A test env: `cn` and `controls` are part maps, `cx`/`rt.cx` the runtime cx, `state` a local object literal. */
const env: CxEnv = {
    isCx: (callee) => (callee.type === "Identifier" && callee.name === "cx") || (callee.type === "MemberExpression" && callee.object.name === "rt" && callee.property.name === "cx"),
    partMap: (id) =>
        id.name === "cn"
            ? { local: "cn", exportName: "alert", module: "@x/css", scope: "alert" }
            : id.name === "controls"
              ? { local: "controls", exportName: "playerControls", module: "@x/css/player", scope: "player-controls" }
              : null,
    isObjectVariable: (id) => id.name === "state",
}
const classify = (code: string) => classifyCxArg(expr(code) as AnyNode, env)

test("cx() grammar: parts, props, data, nested calls and nothing", () => {
    assert.deepEqual({ ...classify("cn.icon"), node: null, map: null }, { kind: "part", node: null, map: null, part: "icon" })
    assert.equal((classify(`cn["group-label"]`) as { part: string }).part, "group-label")
    assert.equal((classify("controls.button") as { map: { scope: string } }).map.scope, "player-controls")
    assert.equal(classify("(cn.icon as string)").kind, "part")
    for (const props of ["rest", "props", "inputCx", "props.inputCx", "props.slots.inputCx", "inputCx!"]) assert.equal(classify(props).kind, "props", props)
    for (const nothing of ["undefined", "null", "false"]) assert.equal(classify(nothing).kind, "skip", nothing)
    const data = classify(`{ size, hasTitle: open, "row-id": id, ...state }`) as { kind: string; entries: Array<{ kind: string; attr?: string }> }
    assert.equal(data.kind, "data")
    assert.deepEqual(
        data.entries.map((e) => e.attr ?? e.kind),
        ["data-size", "data-has-title", "data-row-id", "spread"],
    )
    const nested = classify("cx(cn.icon, rest, { open })") as { kind: string; args: Array<{ kind: string }> }
    assert.equal(nested.kind, "nested")
    assert.deepEqual(
        nested.args.map((a) => a.kind),
        ["part", "props", "data"],
    )
    assert.equal(classify("rt.cx(cn.icon)").kind, "nested")
})

test("cx() grammar: conditional parts are rejected with the state rule", () => {
    for (const bad of ["open && cn.open", "open ? cn.a : cn.b", "open ? cn.a : undefined", "cn.a || cn.b", `open && "open"`, "[cn.a, cn.b]"]) {
        const arg = classify(bad) as { kind: string; problem?: string; message?: string }
        assert.equal(arg.kind, "invalid", bad)
        assert.equal(arg.problem, "conditional-part", bad)
        assert.match(arg.message ?? "", /state and variants go through data-\* attributes; parts name structure only/)
    }
})

test("cx() grammar: everything else is rejected with a reason", () => {
    const cases: Array<[string, string]> = [
        [`"icon"`, "string"],
        ["`icon`", "string"],
        ["`a ${b}`", "string"],
        ["cn[key]", "computed-member"],
        ["cn.$tags", "tags-member"],
        ["cn.Icon", "invalid-part"],
        ["f(cn.icon)", "call"],
        ["legacy('x')", "call"],
        ["open ? rest : undefined", "conditional"],
        ["state", "data-variable"],
        ["{ data: { open } }", "data-wrapper"],
        ["{ [k]: 1 }", "data-key"],
        ["{ get x() { return 1 } }", "data-key"],
        ["{ m() {} }", "data-key"],
        ["{ 'has title': 1 }", "data-key"],
        ["true", "literal"],
        ["1", "literal"],
        ["cn", "other"],
        ["() => cn.icon", "other"],
    ]
    for (const [code, problem] of cases) {
        const arg = classify(code) as { kind: string; problem?: string }
        assert.equal(arg.kind, "invalid", code)
        assert.equal(arg.problem, problem, code)
    }
})

test("data attribute names follow element.dataset", () => {
    assert.equal(dataAttrName("hasTitle"), "data-has-title")
    assert.equal(dataAttrName("size"), "data-size")
    assert.equal(dataAttrName("has-title"), "data-has-title")
    assert.equal(dataAttrName("a1B"), "data-a1-b")
    assert.equal(dataKeyOf("data-has-title"), "hasTitle")
    assert.equal(dataKeyOf("data-menu-open"), "menuOpen")
})

test("part maps: modules, export names and scopes", () => {
    const partMaps = { components: "@x/css", player: "@x/css/player" }
    assert.equal(partMapGroup("@x/css", partMaps), "components")
    assert.equal(partMapGroup("@x/other", partMaps), null)
    assert.equal(partMapGroup("@x/other", null), undefined)
    assert.equal(partMapGroup("./local", null), null)
    assert.equal(partMapGroup("@livesession/libstylist/runtime", null), null)
    assert.equal(scopeOfExportName("playerControls"), "player-controls")
    assert.equal(scopeOfExportName("switchClasses"), "switch")
    const registry = { scopes: { switch: { group: "components" }, "player-controls": { group: "player" }, alert: { group: "components" } } }
    assert.equal(scopeOfExport("switchClasses", registry), "switch")
    assert.equal(scopeOfExport("playerControls", registry, "player"), "player-controls")
    assert.equal(scopeOfExport("playerControls", registry, "components"), null)
    assert.equal(scopeOfExport("nothing", registry), null)
    assert.deepEqual(resolvePartMap("cn", "alert", "@x/css", registry, partMaps), { local: "cn", exportName: "alert", module: "@x/css", scope: "alert" })
    assert.equal(resolvePartMap("cn", "alert", "@x/other", registry, partMaps), null)
    assert.equal(resolvePartMap("x", "helper", "@x/css", registry, partMaps), null)
    assert.equal(resolvePartMap("cn", "textInput", "@x/css", null, null)?.scope, "text-input")
})

test("part maps: one specifier serving several groups (an app package's #css: its core and render groups)", () => {
    const partMaps = { "crm-accounts": "#css", "crm-accounts.render": "#css", "crm-partners": "#partners-css" }
    assert.deepEqual(partMapGroups("#css", partMaps), ["crm-accounts", "crm-accounts.render"])
    assert.deepEqual(partMapGroups("#partners-css", partMaps), ["crm-partners"])
    assert.equal(partMapGroups("#other", partMaps), null)
    assert.equal(partMapGroups("#css", null), undefined)
    assert.equal(partMapGroups("./css", null), null)
    // the single-group form keeps its contract: the first group
    assert.equal(partMapGroup("#css", partMaps), "crm-accounts")
    const registry = {
        scopes: {
            "accounts-list": { group: "crm-accounts" },
            "render-accounts": { group: "crm-accounts.render" },
            "partners-card": { group: "crm-partners" },
        },
    }
    // a render scope resolves through the specifier's second group
    assert.equal(scopeOfExport("renderAccounts", registry, ["crm-accounts", "crm-accounts.render"]), "render-accounts")
    assert.equal(scopeOfExport("partnersCard", registry, ["crm-accounts", "crm-accounts.render"]), null)
    assert.deepEqual(resolvePartMap("cn", "renderAccounts", "#css", registry, partMaps), { local: "cn", exportName: "renderAccounts", module: "#css", scope: "render-accounts" })
    assert.equal(resolvePartMap("cn", "accountsList", "#css", registry, partMaps)?.scope, "accounts-list")
    assert.equal(resolvePartMap("cn", "partnersCard", "#css", registry, partMaps), null)
    // a subpath import is the package's own module (a component import), yet still a package specifier for part maps
    assert.equal(isOwnPackageSpecifier("#components"), true)
    assert.equal(isOwnPackageSpecifier("../Button"), true)
    assert.equal(isOwnPackageSpecifier("@livesession/eloquentui-react"), false)
})

test("@cxScope pragma (the removed syntax the tooling reports)", () => {
    assert.equal(findScopePragma([{ value: "* @cxScope text-input " }]), "text-input")
    assert.equal(findScopePragma([{ value: " nothing" }]), null)
})

// --- the removed cx attribute grammar, kept for the codemod ----------------------------------------

test("legacy cx grammar accepts static shapes", () => {
    const ir = parseCxExpression(expr(`["root", open && "open", kind === "a" ? "a-part" : "b-part", { shown: visible, "x y": z }, null, false, undefined, "player-controls:button"]`))
    assert.equal(isStaticIR(ir), false)
    assert.deepEqual(
        collectRefs(ir).map((r) => r.label),
        ["root", "open", "a-part", "b-part", "shown", "x", "y", "player-controls:button"],
    )
    assert.deepEqual(collectRefs(ir).at(-1), { scope: "player-controls", part: "button", label: "player-controls:button" })
    assert.equal(isStaticIR(parseCxExpression(expr(`["a", "b c"]`))), true)
    assert.equal(parseCxExpression(expr("`icon`")).kind, "parts")
})

test("legacy cx grammar rejects dynamic shapes", () => {
    for (const bad of ["cls", "cn.icon", "f()", "a || 'b'", "a ?? 'b'", "`a ${b}`", "[...xs]", "{ [k]: true }", "{ ...o }", "'Icon'", "'a:b:c'"]) {
        assert.throws(() => parseCxExpression(expr(bad)), CxGrammarError, bad)
    }
})
