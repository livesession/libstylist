import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"

import postcss from "postcss"
import nesting from "postcss-nesting"

import { partAttr } from "../src/hash/index.js"
import { stylist, type StylistSink } from "../src/postcss/index.js"
import {
    buildRegistry,
    createResolvers,
    diffLock,
    exportName,
    formatLockDiff,
    stylistOptions,
    toLock,
    toPartMapModules,
    toSelectorRenameMap,
    type Registry,
    type RegistryGroup,
} from "../src/registry/index.js"

const GROUPS: Record<string, RegistryGroup> = {
    components: { namespace: "core" },
    "app-ui": { namespace: "app" },
    player: { namespace: "player" },
}
const attr = (namespace: string, scope: string, part: string, length?: number) => partAttr({ prefix: "elo", namespace, scope, part }, length)

const alertCss = [
    "@stylist root Alert display block;",
    ".root { animation: spin 1s } .root .icon:global(.icon-wrapper) {} .message {}",
    "@keyframes spin { to { opacity: 1 } }",
].join("\n")
const modalCss = "@stylist root Modal display flex;\n@stylist root Modal.Header as header;\n.root .header .close {}"
const topBarCss = "@stylist root PlayerTopBar display flex;\n@stylist root PlayerTopBar.Url as url;\n.root .url :cx(alert:icon) :component(core/Modal.Header) {}"

const build = (sheets: Array<{ file: string; group: string; css: string; scope?: string }>, hashLength?: number) =>
    buildRegistry({ prefix: "elo", hashLength, groups: GROUPS, sheets })

const sample = () =>
    build([
        { file: "components/alert.css", group: "components", css: alertCss },
        { file: "components/modal.css", group: "components", css: modalCss },
        { file: "player/player-top-bar.css", group: "player", css: topBarCss },
        { file: "components/switch.css", group: "components", css: ".root .thumb {}" },
    ])

test("registry: SPEC §7 shape", () => {
    const { registry, errors } = sample()
    assert.deepEqual(errors, [])
    assert.equal(registry.version, 1)
    assert.equal(registry.prefix, "elo")
    assert.deepEqual(registry.hash, { version: 1, length: 6 })
    assert.deepEqual(Object.keys(registry.scopes), ["alert", "modal", "player-top-bar", "switch"])
    assert.deepEqual(registry.scopes.alert, {
        namespace: "core",
        group: "components",
        file: "components/alert.css",
        roots: [{ component: "Alert", local: "root", tag: "elo-alert", display: "block" }],
        parts: { icon: "_cxclass_elo-or4d4l", message: attr("core", "alert", "message"), root: attr("core", "alert", "root") },
        globals: [".icon-wrapper"],
        keyframes: { spin: "elo-alert-spin" },
    })
    assert.deepEqual(registry.scopes.modal.roots, [
        { component: "Modal", local: "root", tag: "elo-modal", display: "flex" },
        { component: "Modal.Header", local: "header", tag: "elo-modal-header" },
    ])
    assert.deepEqual(registry.scopes["player-top-bar"].roots.map(r => r.tag), ["elo-player-topbar", "elo-player-topbar-url"])
    assert.equal(registry.scopes["player-top-bar"].parts.url, attr("player", "player-top-bar", "url"))
    // plain JSON: round-trips unchanged
    assert.deepEqual(JSON.parse(JSON.stringify(registry)), registry)
})

test("registry: root locals are parts even without a rule", () => {
    const { registry } = build([{ file: "a/card.css", group: "components", css: "@stylist root Card.Body as body;" }])
    assert.deepEqual(registry.scopes.card.parts, { body: attr("core", "card", "body") })
})

test("registry: duplicate scopes are reported with both files and the first sheet wins", () => {
    const { registry, errors } = build([
        { file: "components/alert.css", group: "components", css: ".root {}" },
        { file: "player/alert.css", group: "player", css: ".root .x {}" },
        { file: "player/banner.css", group: "player", css: "@stylist scope alert;" },
    ])
    assert.deepEqual(errors.map(e => [e.code, e.files]), [
        ["duplicate-scope", ["components/alert.css", "player/alert.css"]],
        ["duplicate-scope", ["components/alert.css", "player/banner.css"]],
    ])
    assert.equal(registry.scopes.alert.file, "components/alert.css")
})

test("registry: hash collisions name both parts", () => {
    // brute-force a real collision at the shortest allowed length (36^4 buckets)
    const seen = new Map<string, string>()
    let pair: [string, string] | undefined
    for (let i = 0; !pair && i < 20000; i++) {
        const a = attr("core", "one", `p${i}`, 4)
        const b = attr("core", "two", `p${i}`, 4)
        if (seen.has(b)) pair = [seen.get(b) as string, `p${i}`]
        seen.set(a, `p${i}`)
    }
    assert.ok(pair, "found a collision to test with")
    const [partOne, partTwo] = pair
    const { errors } = build(
        [
            { file: "components/one.css", group: "components", css: `.${partOne} {}` },
            { file: "components/two.css", group: "components", css: `.${partTwo} {}` },
        ],
        4,
    )
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, "hash-collision")
    assert.deepEqual(errors[0].files, ["components/one.css", "components/two.css"])
    assert.match(errors[0].message, new RegExp(`core/one:${partOne} \\(components/one.css\\) and core/two:${partTwo} \\(components/two.css\\) both hash to _cxclass_elo-[0-9a-z]{4}`))
    // at the default length the same parts don't collide
    assert.deepEqual(build([
        { file: "components/one.css", group: "components", css: `.${partOne} {}` },
        { file: "components/two.css", group: "components", css: `.${partTwo} {}` },
    ]).errors, [])
})

test("registry: duplicate tags and namespace compounds", () => {
    const { errors } = build([
        { file: "components/list.css", group: "components", css: "@stylist root List;" },
        { file: "components/list-root.css", group: "components", css: "@stylist root List.Root;" },
        { file: "components/app.css", group: "components", css: "@stylist root App.Dock;" },
        { file: "app-ui/dock.css", group: "app-ui", css: "@stylist root Dock;" },
        { file: "components/player.css", group: "components", css: "@stylist root Player;" },
    ])
    assert.deepEqual(errors.map(e => e.code), ["duplicate-tag", "namespace-compound", "duplicate-tag"])
    assert.deepEqual(errors[0].files, ["components/list.css", "components/list-root.css"])
    assert.match(errors[0].message, /core\/List \(components\/list.css\) and core\/List.Root \(components\/list-root.css\) both map to <elo-list>/)
    assert.match(errors[1].message, /App.Dock → <elo-app-dock> reads as a tag of the "app" segment/)
    assert.deepEqual(errors[2].files, ["components/app.css", "app-ui/dock.css"])
})

test("registry: invalid directives, sheets and groups are reported, not thrown", () => {
    const { registry, errors } = build([
        { file: "components/a.css", group: "components", css: "@stylist root alert;\n.ok {}" },
        { file: "components/b.css", group: "components", css: ".Bad {}" },
        { file: "gram/c.css", group: "gram", css: ".root {}" },
        { file: "components/d.css", group: "components", css: "@stylist root D as;" },
    ])
    assert.deepEqual(errors.map(e => e.code), ["invalid-directive", "invalid-sheet", "unknown-group", "invalid-directive"])
    assert.match(errors[0].message, /^components\/a.css:1: invalid directive "@stylist root alert"/)
    assert.deepEqual(Object.keys(registry.scopes), ["a", "b", "d"])
    assert.deepEqual(registry.scopes.a.parts, { ok: attr("core", "a", "ok") })
})

test("registry: unresolved :cx() and :component() references", () => {
    const { errors } = build([
        { file: "components/alert.css", group: "components", css: ".root :cx(alert:nope) :cx(ghost:root) :component(Alert) :component(player/Missing) {}" },
        { file: "player/x.css", group: "player", css: "@stylist root PlayerX;\n.root {}" },
        { file: "components/y.css", group: "components", css: ".root :component(player/PlayerX) :cx(x:root) {}" },
    ])
    assert.deepEqual(errors.map(e => [e.code, e.message.replace(/ names .*/, "")]), [
        ["unresolved-ref", "components/alert.css:1: :cx(alert:nope)"],
        ["unresolved-ref", "components/alert.css:1: :cx(ghost:root)"],
        ["unresolved-ref", "components/alert.css:1: :component(Alert)"],
        ["unresolved-ref", "components/alert.css:1: :component(player/Missing)"],
    ])
})

test("registry: bad configuration throws", () => {
    assert.throws(() => buildRegistry({ prefix: "Elo", groups: GROUPS, sheets: [] }), /invalid prefix/)
    assert.throws(() => buildRegistry({ prefix: "elo", hashLength: 2, groups: GROUPS, sheets: [] }), /hashLength/)
    assert.throws(() => buildRegistry({ prefix: "elo", groups: { a: { namespace: "x", segment: "one" }, b: { namespace: "x", segment: "two" } }, sheets: [] }), /name tags differently/)
})

// a workspace of app packages: every package has a core group and a render group, and the packages
// share both namespaces — scopes and tags stay unique per prefix, across packages
const WORKSPACE: Record<string, RegistryGroup> = {
    "crm-accounts": { namespace: "core" },
    "crm-accounts.render": { namespace: "render" },
    "crm-partners": { namespace: "core" },
    "crm-partners.render": { namespace: "render" },
}
const workspace = (sheets: Array<{ file: string; group: string; css: string }>, groups = WORKSPACE) => buildRegistry({ prefix: "crm", groups, sheets })

test("registry: packages sharing namespaces — each package's core and render groups build one registry", () => {
    const { registry, errors } = workspace([
        { file: "packages/accounts/src/css/accounts-list.css", group: "crm-accounts", css: "@stylist root AccountsList display block;\n.root {}" },
        { file: "packages/accounts/src/css/render/render-accounts.css", group: "crm-accounts.render", css: "@stylist root RenderAccounts display block;\n.root :component(core/AccountsList) {}" },
        { file: "packages/partners/src/css/partners-card.css", group: "crm-partners", css: "@stylist root PartnersCard;\n.root :component(AccountsList) {}" },
        { file: "packages/partners/src/css/render/render-partners.css", group: "crm-partners.render", css: "@stylist root RenderPartners;\n.root :cx(render-accounts:root) :component(RenderAccounts) {}" },
    ])
    assert.deepEqual(errors, [])
    assert.deepEqual(
        Object.entries(registry.scopes).map(([scope, s]) => `${scope} ${s.namespace} ${s.group} <${s.roots.map((r) => r.tag).join(",")}>`),
        [
            "accounts-list core crm-accounts <crm-accountslist>",
            "partners-card core crm-partners <crm-partnerscard>",
            "render-accounts render crm-accounts.render <crm-render-accounts>",
            "render-partners render crm-partners.render <crm-render-partners>",
        ],
    )
    // a part hashes with its namespace, never its group: two packages' core sheets hash the same way
    assert.equal(registry.scopes["partners-card"].parts.root, partAttr({ prefix: "crm", namespace: "core", scope: "partners-card", part: "root" }))
    assert.equal(registry.scopes["render-partners"].parts.root, partAttr({ prefix: "crm", namespace: "render", scope: "render-partners", part: "root" }))
})

test("registry: across packages sharing a namespace, a duplicate scope or tag is an error; a namespace names tags one way", () => {
    const { errors } = workspace([
        { file: "packages/accounts/src/css/list.css", group: "crm-accounts", css: ".root {}" },
        { file: "packages/partners/src/css/list.css", group: "crm-partners", css: ".root {}" },
        { file: "packages/accounts/src/css/badge.css", group: "crm-accounts", css: "@stylist root Badge;" },
        { file: "packages/partners/src/css/partner-badge.css", group: "crm-partners", css: "@stylist root Badge;" },
        { file: "packages/partners/src/css/render/row.css", group: "crm-partners.render", css: "@stylist root RenderRow;" },
        { file: "packages/accounts/src/css/render/row-alias.css", group: "crm-accounts.render", css: "@stylist root Row;" },
    ])
    assert.deepEqual(
        errors.map((e) => [e.code, e.files]),
        [
            ["duplicate-scope", ["packages/accounts/src/css/list.css", "packages/partners/src/css/list.css"]],
            ["duplicate-tag", ["packages/accounts/src/css/badge.css", "packages/partners/src/css/partner-badge.css"]],
            ["duplicate-tag", ["packages/partners/src/css/render/row.css", "packages/accounts/src/css/render/row-alias.css"]],
        ],
    )
    assert.match(errors[1].message, /core\/Badge \(packages\/accounts\/src\/css\/badge.css\) and core\/Badge \(packages\/partners\/src\/css\/partner-badge.css\) both map to <crm-badge>/)
    // the render word is stripped in both packages: RenderRow and Row are one tag
    assert.match(errors[2].message, /render\/RenderRow .* and render\/Row .* both map to <crm-render-row>/)
    assert.throws(() => workspace([], { ...WORKSPACE, "crm-partners.render": { namespace: "render", word: "Rendered" } }), /groups "crm-accounts.render" and "crm-partners.render" share namespace "render" but name tags differently/)
})

test("resolvers and stylistOptions drive the plugin from the registry", async () => {
    const { registry } = sample()
    const r = createResolvers(registry, "player")
    assert.equal(r.resolvePart("alert", "icon"), "_cxclass_elo-or4d4l")
    assert.equal(r.resolvePart("alert", "nope"), undefined)
    assert.equal(r.resolvePart("constructor", "root"), undefined)
    assert.equal(r.resolveTag(null, "PlayerTopBar.Url"), "elo-player-topbar-url")
    assert.equal(r.resolveTag("core", "Modal.Header"), "elo-modal-header")
    assert.equal(r.resolveTag(null, "Modal.Header"), undefined)

    const sink: StylistSink = {}
    const opts = stylistOptions(registry, "player-top-bar", GROUPS)
    const { css } = await postcss([nesting(), stylist({ ...opts, sink })]).process(topBarCss, { from: "player/player-top-bar.css" })
    const root = registry.scopes["player-top-bar"].parts.root
    const url = registry.scopes["player-top-bar"].parts.url
    assert.match(css, new RegExp(`\\[${root}\\] \\[${url}\\] \\[_cxclass_elo-or4d4l\\] :is\\(elo-modal-header,\\[elo-modal-header\\]\\)`))
    assert.deepEqual(sink.parts, registry.scopes["player-top-bar"].parts)
    assert.deepEqual(sink.roots, registry.scopes["player-top-bar"].roots)
    assert.throws(() => stylistOptions(registry, "nope", GROUPS), /not in the registry/)
})

test("plugin and registry agree on every scope (pass 1 ≡ pass 2)", async () => {
    const { registry } = sample()
    const sources: Record<string, string> = { alert: alertCss, modal: modalCss, "player-top-bar": topBarCss, switch: ".root .thumb {}" }
    for (const [scope, css] of Object.entries(sources)) {
        const sink: StylistSink = {}
        await postcss([nesting(), stylist({ ...stylistOptions(registry, scope, GROUPS), sink, reportGlobals: false })]).process(css, { from: `${scope}.css` })
        const info = registry.scopes[scope]
        assert.deepEqual(Object.fromEntries(Object.entries(sink.parts ?? {}).sort()), info.parts, scope)
        assert.deepEqual(sink.roots, info.roots, scope)
        assert.deepEqual(sink.keyframes, info.keyframes, scope)
        assert.deepEqual(sink.globals, info.globals, scope)
    }
})

test("part-map modules: ESM, CJS and literal d.ts per group", async () => {
    const { registry } = sample()
    assert.equal(exportName("text-input"), "textInput")
    assert.equal(exportName("switch"), "switchClasses")
    assert.equal(exportName("delete"), "deleteClasses")
    assert.equal(exportName("player-top-bar"), "playerTopBar")

    const core = toPartMapModules(registry, "components")
    const expected = {
        alert: { ...registry.scopes.alert.parts, $tags: { Alert: "elo-alert" } },
        modal: { ...registry.scopes.modal.parts, $tags: { Modal: "elo-modal", "Modal.Header": "elo-modal-header" } },
        switchClasses: { ...registry.scopes.switch.parts, $tags: {} },
    }
    const esm = await import(`data:text/javascript;base64,${Buffer.from(core.mjs).toString("base64")}`)
    assert.deepEqual({ ...esm }, expected)
    const cjs: Record<string, unknown> = {}
    new Function("exports", core.cjs)(cjs)
    assert.deepEqual(cjs, expected)
    assert.match(core.dts, /export declare const alert: \{\n {2}readonly "icon": "_cxclass_elo-or4d4l";/)
    assert.match(core.dts, /readonly "\$tags": \{\n {4}readonly "Modal": "elo-modal";\n {4}readonly "Modal.Header": "elo-modal-header";\n {2}\};/)
    assert.match(core.dts, /export declare const switchClasses: \{\n[^]*readonly "\$tags": \{\};\n\};/)

    // the d.ts type-checks and carries literal types
    const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript")
    const files: Record<string, string> = {
        "/maps.d.ts": core.dts,
        "/use.ts": [
            "import { alert, modal, switchClasses } from \"./maps\"",
            "const icon: \"_cxclass_elo-or4d4l\" = alert.icon",
            "const header: \"elo-modal-header\" = modal.$tags[\"Modal.Header\"]",
            "const tags: {} = switchClasses.$tags",
            "// @ts-expect-error unknown part",
            "alert.nope",
            "export { icon, header, tags }",
        ].join("\n"),
    }
    const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Node10, types: [], noLib: false }
    const host = ts.createCompilerHost(options)
    const readFile = host.readFile.bind(host)
    const getSourceFile = host.getSourceFile.bind(host)
    host.fileExists = f => f in files || ts.sys.fileExists(f)
    host.readFile = f => files[f] ?? readFile(f)
    host.getSourceFile = (f, v) => (f in files ? ts.createSourceFile(f, files[f], v) : getSourceFile(f, v))
    const program = ts.createProgram(["/use.ts"], options, host)
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
    assert.deepEqual(diagnostics, [])

    const player = toPartMapModules(registry, "player")
    assert.match(player.mjs, /^export const playerTopBar = \{/)
    assert.deepEqual(toPartMapModules(registry, "gram"), { mjs: "export {};\n", cjs: "", dts: "export {};\n" })
})

test("part-map modules reject two scopes with one export name", () => {
    const { registry } = build([
        { file: "a/a-b1.css", group: "components", css: ".x {}" },
        { file: "a/a-b-1.css", group: "components", css: ".y {}" },
    ])
    assert.throws(() => toPartMapModules(registry, "components"), /both export as "aB1"/)
})

test("lock: flat projection and diff", () => {
    const { registry } = sample()
    const lock = toLock(registry)
    assert.equal(lock.parts["core/alert:icon"], "_cxclass_elo-or4d4l")
    assert.equal(lock.tags["core/Modal.Header"], "elo-modal-header")
    assert.equal(lock.tags["player/PlayerTopBar.Url"], "elo-player-topbar-url")
    assert.deepEqual(Object.keys(lock.parts), Object.keys(lock.parts).slice().sort())
    assert.equal(Object.keys(lock.parts).length, Object.values(registry.scopes).reduce((n, s) => n + Object.keys(s.parts).length, 0))

    assert.deepEqual(diffLock(lock, toLock(registry)), { added: [], removed: [], changed: [], breaking: false })
    const first = diffLock({}, lock)
    assert.equal(first.breaking, false)
    assert.equal(first.added.length, Object.keys(lock.parts).length + Object.keys(lock.tags).length)

    const next = structuredClone(lock)
    delete next.parts["core/alert:message"]
    next.parts["core/alert:icon"] = "_cxclass_elo-zzzzzz"
    next.parts["core/alert:new"] = "_cxclass_elo-aaaaaa"
    next.tags["core/Modal"] = "elo-dialog"
    const diff = diffLock(lock, next)
    assert.equal(diff.breaking, true)
    assert.deepEqual(diff.removed, [{ kind: "part", key: "core/alert:message", before: lock.parts["core/alert:message"] }])
    assert.deepEqual(diff.changed, [
        { kind: "part", key: "core/alert:icon", before: "_cxclass_elo-or4d4l", after: "_cxclass_elo-zzzzzz" },
        { kind: "tag", key: "core/Modal", before: "elo-modal", after: "elo-dialog" },
    ])
    assert.deepEqual(diff.added, [{ kind: "part", key: "core/alert:new", after: "_cxclass_elo-aaaaaa" }])
    assert.equal(formatLockDiff(diff).split("\n")[0], `- part core/alert:message ${lock.parts["core/alert:message"]}`)
    assert.equal(diffLock(lock, { ...lock, parts: { ...lock.parts, "core/x:y": "_cxclass_elo-000000" } }).breaking, false)
})

test("rename map: legacy classes → part attribute selectors", () => {
    const { registry } = sample()
    const legacy = {
        alert: { root: "ls-alert", icon: "ls-alert__icon", message: "ls-alert__message", gone: "ls-alert__gone" },
        switchClasses: { root: "ls-switch", thumb: "ls-switch__thumb" },
        unknown: { root: "ls-unknown" },
    }
    const map = toSelectorRenameMap(legacy, registry)
    assert.deepEqual(map, {
        ".ls-alert": `[${registry.scopes.alert.parts.root}]`,
        ".ls-alert__icon": "[_cxclass_elo-or4d4l]",
        ".ls-alert__message": `[${registry.scopes.alert.parts.message}]`,
        ".ls-switch": `[${registry.scopes.switch.parts.root}]`,
        ".ls-switch__thumb": `[${registry.scopes.switch.parts.thumb}]`,
    })
    assert.throws(() => toSelectorRenameMap({ alert: { root: "ls-x" }, modal: { root: "ls-x" } }, registry), /maps to both/)

    // compare-dist keyframes entries, opt-in
    assert.deepEqual(Object.entries(toSelectorRenameMap({}, registry, { keyframes: true })), [["@keyframes spin", "elo-alert-spin"]])
    assert.deepEqual(toSelectorRenameMap({}, registry, { keyframes: { alert: { "ls-alert-spin": "spin", "ls-alert-gone": "gone" } } }), { "@keyframes ls-alert-spin": "elo-alert-spin" })
})

export type { Registry }
