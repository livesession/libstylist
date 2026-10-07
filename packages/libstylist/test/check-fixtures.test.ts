// `libstylist check` over the fixture monorepos in test/fixtures/check — one per hard case. Each
// test pins the complete set of findings (rule + key), split by the migration ratchet into errors and
// pending, so both misses and false positives fail.
import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { burndownReport, runCheck, type CheckResult, type Finding, type RawCheckConfig, type RootAnalysis } from "../src/check/index.js"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "check")
const ALL = ["exports", "export-problems", "conditional", "multi-root", "polymorphic", "delegate", "portal", "exemptions", "tags", "css", "roots", "wrapper", "forwarding", "member-roots", "ratchet", "zero", "edges", "cx-call", "workspace", "sources"]

const run = (name: string): Promise<CheckResult> => runCheck({ config: join(FIXTURES, name, "libstylist.config.mjs") })

/** First run of each fixture, kept for the determinism test. */
const firstRuns = new Map<string, CheckResult>()
const check = async (name: string): Promise<CheckResult> => {
    const r = await run(name)
    if (!firstRuns.has(name)) firstRuns.set(name, r)
    return r
}

/** `RULE key` lines, sorted — the comparable shape of a finding list. */
const keys = (findings: readonly Finding[], keep: (f: Finding) => boolean = () => true): string[] =>
    findings
        .filter(keep)
        .map((f) => `${f.rule} ${f.key}`)
        .sort()

const find = (r: CheckResult, rule: string, key: string): Finding => {
    const f = [...r.findings, ...r.pending].find((x) => x.rule === rule && x.key === key)
    assert.ok(f, `expected ${rule} ${key} in:\n${keys([...r.findings, ...r.pending]).join("\n")}`)
    return f
}

const analysis = (r: CheckResult, id: string): RootAnalysis => {
    const a = [...r.analyses.values()].find((x) => x.component.id === id)
    assert.ok(a, `no analysis for ${id}`)
    return a
}

const components = (r: CheckResult): string[] => [...r.analyses.keys()].map((c) => `${c.id} <${c.tag}>`).sort()

test("exports: Object.assign, expando, plain-object namespaces, memo/forwardRef and aliases are discovered and conform", async () => {
    const r = await check("exports")
    assert.deepEqual(keys(r.findings), [])
    assert.deepEqual(keys(r.pending), [])
    assert.deepEqual(components(r), [
        "core/Both <elo-both>",
        "core/List.Item <elo-list-item>",
        "core/List.Root <elo-list>",
        "core/Memoed <elo-memoed>",
        "core/Modal <elo-modal>",
        "core/Modal.Header <elo-modal-header>",
        "core/Reffed <elo-reffed>",
        "core/Tabs <elo-tabs>",
        "core/Tabs.Item <elo-tabs-item>",
        "core/Tabs.Panel <elo-tabs-panel>",
        "core/Tag <elo-tag>",
    ])
    assert.equal(r.stats.components, 11)
    assert.equal(r.stats.migrated, 11)
    assert.equal(r.stats.findings, 0)
    assert.equal(r.stats.errors, 0)
})

test("export problems: any-typed, factory-made and third-party members (C001), segment compounds (C002), duplicates (C003)", async () => {
    const r = await check("export-problems")
    assert.deepEqual(keys(r.findings, (f) => f.rule.startsWith("C")), ["C001 core/Table.Button", "C001 core/Table.Row", "C002 core/App.Dock", "C003 core/Shade", "C003 core/Thing"])
    // exports that are no component at all are judged by their file, which is not migrated
    assert.deepEqual(keys(r.pending), ["C001 core/Remote", "C001 core/Styled"])
    assert.match(find(r, "C001", "core/Table.Button").message, /typed `any`/)
    // the any-typed member is analyzed through its cast, so it owns its finding; a factory-made one belongs to its parent
    assert.equal(find(r, "C001", "core/Table.Button").component, "core/Table.Button")
    assert.equal(find(r, "C001", "core/Table.Row").component, "core/Table")
    assert.match(find(r, "C001", "core/Table.Row").message, /created by `makeRow\(\)`/)
    assert.match(find(r, "C001", "core/Remote").message, /third-party component/)
    // the finding points at the design-system export, not into the vendor .d.ts
    assert.equal(find(r, "C001", "core/Remote").file, "packages/ui/src/index.ts")
    assert.match(find(r, "C002", "core/App.Dock").message, /"app" segment/)
    assert.match(find(r, "C003", "core/Shade").message, /same component as EmptyState\.Shade/)
    assert.equal(find(r, "C003", "core/Shade").component, "core/EmptyState.Shade")
    assert.match(find(r, "C003", "core/Thing").message, /two implementations/)
    // the any-typed member is still analyzed through its cast; context objects are not components
    assert.ok(components(r).includes("core/Table.Button <elo-table-button>"))
    assert.ok(!components(r).some((c) => c.startsWith("core/ThemeContext")))
    assert.deepEqual(keys(r.findings, (f) => f.rule.startsWith("R")), [])
})

test("conditional returns: null branches, ternaries, &&, helpers, consts and lets resolve; one generic branch and an empty component are reported", async () => {
    const r = await check("conditional")
    assert.deepEqual(keys(r.findings), ["R100 core/Nothing", "R101 core/Branchy"])
    assert.equal(find(r, "R101", "core/Branchy").line, 47)
})

test("multi-root: sibling roots need @libstylistRoot multi; roots without identity and two identities are always reported", async () => {
    const r = await check("multi-root")
    assert.deepEqual(keys(r.findings), ["R104 core/Double", "R104 core/Pair", "R104 core/Twins", "X122 core/Double"])
    assert.match(find(r, "R104", "core/Pair").message, /next to 1 sibling root \(<span>\)/)
    assert.match(find(r, "R104", "core/Double").message, /2 identity elements/)
    assert.match(find(r, "R104", "core/Twins").message, /none is <elo-twins>/)
    assert.equal(r.stats.exemptions.multi.used, 2)
})

test("polymorphic roots: finite unions pass, unbounded types and generic members fail", async () => {
    const r = await check("polymorphic")
    assert.deepEqual(keys(r.findings), ["R102 core/Bare", "R105 core/Slot", "R107 core/Loose", "R108 core/Boxy"])
    assert.match(find(r, "R107", "core/Loose").message, /type `string`/)
    assert.match(find(r, "R108", "core/Boxy").message, /can render <div>/)
    assert.match(find(r, "R105", "core/Slot").message, /component passed in as `Icon`/)
    assert.deepEqual(
        analysis(r, "core/Action").identities.map((h) => h.item.kind === "tagvar" && h.item.members),
        [["a", "button"]],
    )
})

test("delegates: marker forwarding and slot identity pass; non-forwarding delegates, missing identity and dropped cx fail", async () => {
    const r = await check("delegate")
    assert.deepEqual(keys(r.findings), ["R106 core/Plain", "R106 core/Relay", "R106 core/Sometimes", "R112 core/Dropped", "R112 core/Legacy", "S304 elo-styler", "S307 packages/ui/src/Wrappers.tsx>core/Legacy"])
    assert.match(find(r, "R106", "core/Relay").message, /Legacy doesn't pass stylist props/)
    assert.match(find(r, "R106", "core/Plain").message, /forward the marker \(<Panel elo-plain \{\.\.\.cx\(rest\)\}>\)/)
    assert.match(find(r, "R106", "core/Sometimes").message, /only sometimes/)
    const confirm = analysis(r, "core/Confirm")
    assert.equal(confirm.forwards, true)
    assert.deepEqual(confirm.identities.map((h) => h.form), ["forwarded"])
    // T9: a DOM-less component forwarding its marker must pass its props to the delegate too (<Modal elo-modalconfirm {...cx(rest)}>) —
    // without them it is R112, like any identity element, and a caller's cx can't reach it
    const dropped = analysis(r, "core/Dropped")
    assert.deepEqual([dropped.problems.map((p) => p.rule), dropped.forwards, dropped.identities[0]?.form], [["R112"], false, "forwarded"])
    assert.match(find(r, "R112", "core/Dropped").message, /<Panel elo-dropped \{\.\.\.cx\(rest\)\}>/)
    assert.deepEqual(analysis(r, "core/Slot").identities.map((h) => h.names), [["elo-slot"]])
})

test("portals and Radix: portal roots, portal siblings and native asChild hosts pass; a marker on a span needs native", async () => {
    const r = await check("portal")
    assert.deepEqual(keys(r.findings), ["R101 core/Tip", "R105 core/Opener"])
    assert.match(find(r, "R101", "core/Tip").message, /marker on a generic <span>/)
    assert.match(find(r, "R105", "core/Opener").message, /third-party component <Pop\.Trigger>/)
    assert.equal(r.stats.exemptions.native.used, 1)
})

test("exemptions: valid none/native pass; stale, malformed, misplaced and over-budget tags fail", async () => {
    const r = await check("exemptions")
    assert.deepEqual(keys(r.findings), [
        "R100 core/Short",
        "R101 core/Bogus",
        "X121 core/Bogus",
        "X121 core/Short",
        "X121 core/Twice#1",
        "X121 packages/ui/src/Exempt.tsx#renderHelper",
        "X122 core/Fine",
        "X123 none",
    ])
    assert.match(find(r, "X121", "core/Bogus").message, /unknown category "bogus"/)
    assert.match(find(r, "X121", "core/Short").message, /at least 12 characters \(got 9\)/)
    assert.match(find(r, "X123", "none").message, /4 `none` exemptions exceed the budget of 2/)
    assert.deepEqual(r.stats.exemptions, { none: { used: 4, budget: 2 }, multi: { used: 0, budget: 0 }, native: { used: 1, budget: 1 } })
})

test("tags: duplicate owners (T201), unregistered tags and markers (T202), tags rendered by non-owners (T203)", async () => {
    const r = await check("tags")
    assert.deepEqual(keys(r.findings, (f) => f.rule.startsWith("T") || f.rule.startsWith("R")), [
        "R103 core/Other",
        "T201 elo-menu",
        "T202 elo-ghost@packages/ui/src/Tags.tsx",
        "T202 elo-phantom@packages/ui/src/Tags.tsx",
        "T203 elo-badge@packages/ui/src/Tags.tsx",
        "T203 elo-card@packages/ui/src/Tags.tsx",
    ])
    assert.match(find(r, "T203", "elo-card@packages/ui/src/Tags.tsx").message, /renderCardLike renders it/)
    assert.match(find(r, "T203", "elo-badge@packages/ui/src/Tags.tsx").message, /Card renders it/)
})

test("css: unused parts, unowned bindings, display defaults, display on markers, className props and sheet errors", async () => {
    const r = await check("css")
    assert.deepEqual(keys(r.findings), [
        "S300 invalid-directive:packages/css/src/ui/broken.css",
        "S301 broken:thing",
        "S301 card:ghost",
        "S301 card:unused",
        "S302 card:Ghost",
        "S304 elo-stat",
        "S305 core/Field",
        "S308 core/Field:className",
        "S308 core/Field:inputClassName",
    ])
    // the unbound swatch sheet is exempt from S301; a member read outside cx() (markTitle's has-title) counts as a use
    assert.ok(!r.findings.some((f) => f.key.startsWith("swatch:")))
    assert.equal(find(r, "S301", "card:unused").line, 8)
    assert.equal(find(r, "S302", "card:Ghost").line, 3)
    assert.match(find(r, "S308", "core/Field:inputClassName").message, /named slot \(inputCx\)/)
    // a part on an inner element never gives the root its display: Stat's `.stat { display }` is on its <span>
    assert.match(find(r, "S304", "elo-stat").message, /@stylist root Stat display <keyword>/)
})

test("roots: generic, unmarked, wrong and opaque roots; forwarding and root-part rules; transparent wrappers and inlined internals", async () => {
    const r = await check("roots")
    assert.deepEqual(keys(r.findings), [
        "R101 core/Generic",
        "R102 core/Native",
        "R103 core/Wrong",
        "R105 core/Computed",
        "R105 core/Framed",
        "R105 core/Passthrough",
        "R105 core/Texty",
        "R112 core/Blocked",
        "R112 core/NoForward",
        "R113 core/NoPart",
        "S301 roots:nopart",
        "T202 elo-other@packages/ui/src/Roots.tsx",
    ])
    assert.match(find(r, "R105", "core/Passthrough").message, /`children` prop/)
    assert.match(find(r, "R112", "core/Blocked").message, /<InnerBlocked \{\.\.\.cx\(rest\)\}>/)
    assert.match(find(r, "R113", "core/NoPart").message, /add the roots part map's nopart to its cx\(\) call/)
    for (const id of ["core/Wrapped", "core/ViaConst", "core/Inlined", "core/Framed2", "core/Shell"]) {
        const a = analysis(r, id)
        assert.equal(a.problems.length, 0, id)
        assert.equal(a.forwards, true, id)
    }
})

test("wrapper branches: a <label>/<div> or an exported component's children around exactly one identity element pass; conditional, doubled, missing and non-forwarding ones fail", async () => {
    const r = await check("wrapper")
    assert.deepEqual(keys(r.findings), ["R101 core/Boxed", "R104 core/Twice", "R109 core/Maybe", "R112 core/Bare"])
    assert.deepEqual(keys(r.pending), [])
    // Button-like: plain, <label>-wrapped and <Tip>-wrapped (slot identity) branches, one identity element each
    const action = analysis(r, "core/Action")
    assert.deepEqual([action.problems.length, action.forwards, action.branches], [0, true, 3])
    const wrappers = new Set(action.identities.map((h) => (h.wrapper ? h.wrapper.tagName.getText() : "none")))
    assert.deepEqual([...wrappers].sort(), ["Tip", "label", "none"])
    // FilterEditor-like: the indent <div> is plain structure around the identity element
    const row = analysis(r, "core/Row")
    assert.deepEqual([row.problems.length, row.forwards], [0, true])
    assert.ok(row.identities.some((h) => h.wrapper?.tagName.getText() === "div" && h.rendersTag))
    assert.match(find(r, "R109", "core/Maybe").message, /only on some paths/)
    assert.match(find(r, "R104", "core/Twice").message, /2 identity elements inside <div>/)
    assert.match(find(r, "R101", "core/Boxed").message, /generic <div>/)
    // the implied pairs:root binding is carried by PairA; PairB (same file) needs no root part of its own
    assert.equal(analysis(r, "core/PairB").problems.length, 0)
    // a cx() spread on a Button-like component reaches its identity element through every wrapper
    assert.ok(!r.findings.some((f) => f.rule === "S307"))
})

test("marker forwarding: DOM-less components forward their marker onto a delegate (also through an unmigrated one that spreads props on); lost markers and lost cx fail", async () => {
    const r = await check("forwarding")
    assert.deepEqual(keys(r.findings), ["R106 core/Lost", "R110 core/Valued", "R112 core/Confirm", "R112 core/Confirm.Footer", "R112 core/Sink", "S307 packages/ui/src/Caller.tsx>core/Confirm"])
    assert.match(find(r, "R110", "core/Valued").message, /elo-valued has a value/)
    // Menu (Dropdown-like) is not migrated: its missing identity is pending, yet stylist props pass through it
    assert.deepEqual(keys(r.pending), ["R106 core/Menu"])
    assert.equal(r.components.find((c) => c.id === "core/Menu")?.migrated, false)
    assert.equal(analysis(r, "core/Menu").forwards, true)
    for (const id of ["core/Confirm", "core/Confirm.Footer", "core/Hint", "core/Speed"]) {
        const a = analysis(r, id)
        // T9: Confirm and its Footer forward their markers without passing their props on: R112 (the checker agrees with forward-props)
        assert.deepEqual(a.problems.map((p) => p.rule), id.startsWith("core/Confirm") ? ["R112"] : [], id)
        assert.deepEqual(a.identities.map((h) => h.form), ["forwarded"], id)
    }
    // ModalConfirm-like without props passed on: migrated by its markers alone, and a caller's cx never reaches it
    assert.equal(r.components.find((c) => c.id === "core/Confirm")?.reason, "identity")
    assert.equal(analysis(r, "core/Confirm").forwards, false)
    assert.equal(analysis(r, "core/Hint").forwards, true)
    assert.match(find(r, "R106", "core/Lost").message, /Sink doesn't pass stylist props/)
})

test("member roots: a portaled panel bound as Owner.Member is owned by the owner's file; unrendered, part-less, display-less, foreign and ownerless bindings fail", async () => {
    const r = await check("member-roots")
    assert.deepEqual(keys(r.findings), [
        "S301 card:media",
        "S301 thief:ghost",
        "S302 thief:Ghost.Part",
        "S303 elo-card-media",
        "S303 elo-drawer-body",
        "S304 elo-sheet-panel",
        "T203 elo-pop-content@packages/ui/src/Thief.tsx",
    ])
    assert.deepEqual(
        r.memberRoots.map((m) => `${m.component} <${m.tag}> ${m.scope}:${m.local} → ${m.owner.id}`).sort(),
        ["Card.Media <elo-card-media> card:media → core/Card", "Drawer.Body <elo-drawer-body> drawer:body → core/Drawer", "Pop.Content <elo-pop-content> pop:content → core/Pop", "Sheet.Panel <elo-sheet-panel> sheet:panel → core/Sheet"],
    )
    assert.match(find(r, "S303", "elo-drawer-body").message, /never renders it/)
    assert.match(find(r, "S303", "elo-card-media").message, /add cn\.media to its cx\(\) call, next to the slot that brings the caller.s parts/)
    assert.match(find(r, "T203", "elo-pop-content@packages/ui/src/Thief.tsx").message, /member root Pop\.Content of core\/Pop/)
    // Pop.Content in its own file is neither unregistered (T202) nor an unowned binding (S302)
    assert.ok(!r.findings.some((f) => f.key.includes("Pop.Content") || f.key === "elo-pop-content@packages/ui/src/Pop.tsx"))
    assert.equal(r.stats.exemptions.native.used, 1)
})

test("the cx() call API: forwarding needs the component's own props binding; data on a component is lost; messages name the file's local and the delegate form", async () => {
    const r = await check("cx-call")
    assert.deepEqual(keys(r.findings), [
        // T7: `style` is one of Space's props, not its props — R112, and a caller's parts on it are lost
        "R112 core/Confirmish",
        // forwardRef's ref (a later parameter) is not the component's props
        "R112 core/Listed",
        "R112 core/Space",
        "R113 core/Rooted",
        "S301 rooted:root",
        "S307 packages/ui/src/Caller.tsx>core/Button:data",
        "S307 packages/ui/src/Caller.tsx>core/Confirmish",
        "S307 packages/ui/src/Caller.tsx>core/Space",
    ])
    assert.deepEqual(keys(r.pending), [])
    // T7: body destructuring through `as`, a const alias of cx(props) and a helper closing over the rest forward
    for (const id of ["core/Box", "core/Aliased", "core/Mapped", "core/Button"]) {
        const a = analysis(r, id)
        assert.deepEqual([a.problems.length, a.forwards], [0, true], id)
    }
    assert.equal(analysis(r, "core/Space").forwards, false)
    // T4/app-4: data on a design-system component renders nothing; on Button's own polymorphic host it renders (no finding)
    assert.match(find(r, "S307", "packages/ui/src/Caller.tsx>core/Button:data").message, /data on <Button> is lost — design-system components forward only parts and markers/)
    // T11: R113 names the part as the file imports it; S307 and R112 on a DOM-less delegate name the delegate form (T9)
    assert.match(find(r, "R113", "core/Rooted").message, /\{\.\.\.cx\(cn\.root, rest\)\}/)
    assert.match(find(r, "S307", "packages/ui/src/Caller.tsx>core/Confirmish").message, /its delegate must receive them with the marker: <Panel elo-confirmish \{\.\.\.cx\(rest\)\}>/)
    assert.match(find(r, "R112", "core/Confirmish").message, /<Panel elo-confirmish \{\.\.\.cx\(rest\)\}>/)
})

test("the ratchet: unmigrated components only count as pending; hard rules and migrated components are errors; helpers, class props and host parts are counted", async () => {
    const r = await check("ratchet")
    assert.deepEqual(keys(r.findings), ["S306 done:inner", "S306 old:nope", "S308 core/Ignored:labelClassName", "T201 elo-older"])
    assert.deepEqual(keys(r.pending), ["R101 core/Old", "R101 core/Older", "R101 core/Older.Root", "S308 core/Old:className"])
    assert.deepEqual(
        r.components.map((c) => `${c.id} ${c.reason}`),
        ["core/Done cx", "core/Ignored identity", "core/Old null", "core/Older null", "core/Older.Root null", "core/Provider exemption"],
    )
    assert.deepEqual([r.stats.migrated, r.stats.errors, r.stats.pending], [3, 4, 4])
    assert.deepEqual(r.stats.pendingByRule, { R101: 3, S308: 1 })
    // the flipped sheet is checked (host parts skip S301); the legacy one is pending, never S301
    assert.deepEqual(
        r.sheets.map((s) => `${s.scope} ${s.flipped}`),
        ["done true", "old false"],
    )
    assert.ok(!r.findings.some((f) => f.key === "done:engine" || f.key.startsWith("old:unused")))
    assert.match(find(r, "S306", "done:inner").message, /design-system source reads it from the part map/)
    assert.match(find(r, "S306", "old:nope").message, /has no part "nope"/)
    assert.equal(find(r, "S306", "old:nope").file, "libstylist.config.mjs")
    // migration helpers: counted, never errors
    assert.deepEqual(r.legacy.calls, { legacy: 1, legacyClassName: 1 })
    assert.deepEqual(r.legacy.files, [{ file: "packages/ui/src/Done.tsx", legacy: 1, legacyClassName: 1 }])
    assert.deepEqual(
        r.legacy.classProps.map((p) => `${p.component}.${p.prop} ${p.applied}`),
        ["core/Done.className true", "core/Ignored.inputClassName false"],
    )
    assert.deepEqual(r.stats.legacy, { legacy: 1, legacyClassName: 1, classProps: 2 })
    assert.equal(r.stats.hostParts, 3)
})

test("edges: switch/try/nested-callback/useMemo/Suspense paths, memo/forwardRef, expando members, re-export shapes, portal boundaries, helper wrappers, two-level forwarding, unbounded and mapped polymorphic tags", async () => {
    const r = await check("edges")
    assert.deepEqual(keys(r.findings), [
        // null/undefined/false branches are fine; an all-empty component and a generic branch are not;
        // a Suspense fallback is a render path of its own
        "R100 core/Empty",
        "R101 core/HalfDiv",
        "R101 core/Hosted",
        "R101 core/MemoDiv",
        "R101 core/NotNone",
        "R101 core/Suspended",
        "R102 core/Helpered",
        "R102 core/Listed",
        "R103 core/Card.Body",
        "R103 core/Icons.Open",
        "R104 core/Doubled",
        "R106 core/Top2",
        "R107 core/Elementy",
        "R107 core/Unbounded",
        "R108 core/Anything",
        "R112 core/Mid2",
        "R112 core/RefNoFwd",
        "S305 core/Para",
        "S307 packages/ui/src/Chain.tsx>core/Mid2",
        "S307 packages/ui/src/Slots.tsx>core/Dropper:inputCx",
        "S307 packages/ui/src/Slots.tsx>core/Field:labelCx",
        "T202 elo-open@packages/ui/src/icons/index.tsx",
        "T203 elo-card@packages/ui/src/Expando.tsx",
        "X122 core/NotNone",
    ])
    assert.deepEqual(keys(r.pending), [])
    // every export shape is discovered under its public path: renamed (Pill), a re-exported default
    // import (Def), a module namespace (`export * as Icons`) and expando members (Card.Body, Card.Footer)
    for (const id of ["core/Pill <elo-pill>", "core/Def <elo-def>", "core/Icons.Close <elo-icons-close>", "core/Card.Body <elo-card-body>", "core/Card.Footer <elo-card-footer>"]) {
        assert.ok(components(r).includes(id), id)
    }
    assert.ok(!r.findings.some((f) => f.rule === "C001" || f.rule === "S302"), "module namespace members resolve and own their bindings")
    for (const id of ["core/Switcher", "core/Nested", "core/Guarded", "core/Memoized", "core/Layer", "core/Deep", "core/Framed", "core/Optioned", "core/Shorthanded", "core/Top", "core/Mid", "core/Mapped", "core/Clamp", "core/Icons.Close", "core/Pill", "core/Def"]) {
        const a = analysis(r, id)
        assert.deepEqual([a.problems.length, a.forwards], [0, true], id)
    }
    // a helper called twice renders two different wrappers: the branch without the identity is not merged away
    assert.match(find(r, "R102", "core/Helpered").message, /<label> has no marker/)
    // exemptions: `none` covers a DOM-less memo'd provider and an expando member; it never excuses a generic root
    assert.equal(r.stats.exemptions.none.used, 3)
    assert.match(find(r, "X122", "core/NotNone").message, /excuses none of the component's findings \(R101\)/)
    // two levels of marker forwarding: Top's marker reaches <elo-base> through Mid; Mid2 passes nothing on
    assert.deepEqual(analysis(r, "core/Top").identities.map((h) => h.form), ["forwarded"])
    assert.match(find(r, "R106", "core/Top2").message, /Mid2 doesn't pass stylist props/)
    assert.equal(analysis(r, "core/Mid2").forwards, false)
    // the documented polymorphic mapping renders the tag in its generic branch
    assert.deepEqual(analysis(r, "core/Mapped").identities.map((h) => [h.rendersTag, h.item.kind === "tagvar" && h.item.members]), [[true, ["elo-mapped", "p"]]])
    // Truncate-like: the display default serves the tag branch, so the marked <p> branch is no S305
    assert.ok(!r.findings.some((f) => f.key === "core/Clamp"))
    // named slots: Field spreads its inputCx, Relay passes it on with its props (Tooltip → Popover);
    // Dropper declares it and drops it, and Field has no labelCx
    assert.ok(!r.findings.some((f) => /core\/(Field|Relay):inputCx$/.test(f.key)))
    assert.match(find(r, "S307", "packages/ui/src/Slots.tsx>core/Dropper:inputCx").message, /declares `inputCx` but never passes it to an element.s cx\(\) call/)
    assert.match(find(r, "S307", "packages/ui/src/Slots.tsx>core/Field:labelCx").message, /Field has no `labelCx` prop/)
})

test("a workspace of app packages: packages share the core and render namespaces, keep their sheets in their own directories and root on a design-system component", async () => {
    const r = await check("workspace")
    assert.deepEqual(keys(r.findings), [
        // a third-party component at the root, a design-system one without the marker, and a marker
        // forwarded onto a DOM-less one (`@libstylistRoot none` in its .d.ts)
        "R105 render/RenderPartnersGrid",
        "R106 render/RenderPartnersDialog",
        "R106 render/RenderPartnersLoading",
        // RenderAccounts' sheet sits in the core directory: it binds a core component that doesn't exist
        "S302 render-accounts:RenderAccounts",
        // no css.registry: the checker reads where `libstylist build` writes it, and it was never built
        "S309 missing",
        // both packages export Badge: one tag, two owners
        "T201 crm-badge",
    ])
    assert.deepEqual(keys(r.pending), [])
    // the naming comes from the implementation file: src/components → core, src/render → render (the word
    // Render stripped); the second package's Badge keeps an id of its own
    assert.deepEqual(components(r), [
        "core/AccountsList <crm-accountslist>",
        "core/Badge <crm-badge>",
        "core/Badge@packages/partners <crm-badge>",
        "core/PartnersCard <crm-partnerscard>",
        "render/RenderAccounts <crm-render-accounts>",
        "render/RenderAccountsTable <crm-render-accountstable>",
        "render/RenderPartners <crm-render-partners>",
        "render/RenderPartnersDialog <crm-render-partnersdialog>",
        "render/RenderPartnersGrid <crm-render-partnersgrid>",
        "render/RenderPartnersLoading <crm-render-partnersloading>",
    ])
    assert.deepEqual(
        r.components.map((c) => `${c.id} ${c.namespace} ${c.package}`),
        [
            "core/AccountsList core @fx/accounts",
            "core/Badge core @fx/accounts",
            "core/Badge@packages/partners core @fx/partners",
            "core/PartnersCard core @fx/partners",
            "render/RenderAccounts render @fx/accounts",
            "render/RenderAccountsTable render @fx/accounts",
            "render/RenderPartners render @fx/partners",
            "render/RenderPartnersDialog render @fx/partners",
            "render/RenderPartnersGrid render @fx/partners",
            "render/RenderPartnersLoading render @fx/partners",
        ],
    )
    assert.match(find(r, "T201", "crm-badge").message, /<crm-badge> is the tag of both core\/Badge \(@fx\/accounts\) and core\/Badge@packages\/partners \(@fx\/partners\)/)
    assert.match(find(r, "S302", "render-accounts:RenderAccounts").message, /names no exported component of @fx\/accounts in namespace "core"/)
    assert.equal(find(r, "S309", "missing").message, "node_modules/.cache/libstylist/stylist-registry.json does not exist — run `libstylist build` so lint and consumers see the current parts")
    assert.match(find(r, "R105", "render/RenderPartnersGrid").message, /third-party component <DataGrid>/)
    assert.match(find(r, "R106", "render/RenderPartnersDialog").message, /renders <Modal> without an identity of its own — forward the marker \(<Modal crm-render-partnersdialog \{\.\.\.cx\(rest\)\}>\)/)
    assert.match(find(r, "R106", "render/RenderPartnersLoading").message, /forwards crm-render-partnersloading onto <Loader>, which renders no DOM \(its library marks it `@libstylistRoot none`\) — the marker never reaches the DOM/)
    // one group per (package, namespace), sheets found recursively and grouped by their directory's namespace
    assert.deepEqual(
        r.sheets.map((x) => `${x.scope} ${x.group} ${x.package}`),
        [
            "accounts-list accounts @fx/accounts",
            "render-accounts accounts @fx/accounts",
            "render-accounts-table accounts.render @fx/accounts",
            "partners-card partners @fx/partners",
            "render-partners partners.render @fx/partners",
        ],
    )
    // a design-system component at the root with the marker: a libstylist delegate (its forwarding assumed), no wrapper
    const table = analysis(r, "render/RenderAccountsTable")
    assert.deepEqual([table.problems.length, table.forwards, table.identities.map((h) => `${h.form} ${h.item.kind}`)], [0, true, ["forwarded libstylist-delegate"]])
    // a DOM-less render component forwards its marker onto the core list it imports through #components
    const accounts = analysis(r, "render/RenderAccounts")
    assert.deepEqual([accounts.problems.length, accounts.forwards, accounts.identities.map((h) => `${h.form} ${h.item.kind}`)], [0, true, ["forwarded delegate"]])
    // a design-system component its library marks DOM-less is no forwarding delegate
    assert.equal(analysis(r, "render/RenderPartnersLoading").forwards, false)
    // burndown per package, never per namespace (both packages share core and render)
    assert.deepEqual(
        burndownReport(r).packages.map((p) => `${p.name} ${p.migrated}/${p.components} components ${p.flippedSheets}/${p.sheets} sheets`),
        ["@fx/accounts 4/4 components 3/3 sheets", "@fx/partners 6/6 components 2/2 sheets"],
    )
})

test("sources outside src: a package's components under app/pages/settings import each other through the `~/` alias that typescript.paths resolves", async () => {
    const r = await check("sources")
    // the registry was never built (S309); nothing else — every aliased component resolves
    assert.deepEqual(keys(r.findings), ["S309 missing"])
    assert.deepEqual(keys(r.pending), [])
    assert.deepEqual(components(r), [
        "settings/MemberRow <crm-settings-memberrow>",
        "settings/RenderTeam <crm-settings-renderteam>",
        "settings/RenderTeamLayout <crm-settings-renderteamlayout>",
        "settings/SettingsPage <crm-settings-page>",
    ])
    // the page frame imported as ~/pages/settings/components is a delegate the marker is forwarded onto
    const team = analysis(r, "settings/RenderTeam")
    assert.deepEqual([team.problems.length, team.forwards, team.identities.map((h) => `${h.form} ${h.item.kind}`)], [0, true, ["forwarded delegate"]])
    // the program reaches every source through the alias: entries, the components they import, nothing outside
    assert.equal(r.stats.files, 8)

    // without typescript.paths the alias is unresolved: the frame is `any`, so both components rooting on it
    // are opaque (R105) and the internal frame forwarding RenderTeamLayout's marker renders a foreign one (T203)
    const dir = join(FIXTURES, "sources")
    const raw = (await import(pathToFileURL(join(dir, "libstylist.config.mjs")).href)).default as RawCheckConfig
    const bare = await runCheck({ config: { ...raw, typescript: undefined }, root: dir })
    assert.deepEqual(keys(bare.findings), [
        "R105 settings/RenderTeam",
        "R105 settings/RenderTeamLayout",
        "S309 missing",
        "T203 crm-settings-renderteamlayout@apps/web/app/pages/settings/team/render/RenderTeamLayout.tsx",
    ])
    assert.match(find(bare, "R105", "settings/RenderTeam").message, /renders `<SettingsPage>`, typed `any`/)
    assert.match(find(bare, "T203", "crm-settings-renderteamlayout@apps/web/app/pages/settings/team/render/RenderTeamLayout.tsx").message, /but TeamFrame renders it/)
})

test("every finding is well-formed and every run is deterministic", async () => {
    for (const name of ALL) {
        const a = firstRuns.get(name) ?? (await run(name))
        const b = await run(name)
        assert.deepEqual(a.findings, b.findings, name)
        assert.deepEqual(a.pending, b.pending, name)
        const all = [...a.findings, ...a.pending]
        for (const f of all) {
            assert.match(f.rule, /^[CRSTX]\d{3}$/, name)
            assert.ok(f.key && !/:\d+$/.test(f.key.split("@")[0]), `${name}: key "${f.key}" must not carry a line number`)
            assert.ok(f.line >= 0 && !f.file.startsWith("/"), `${name}: ${f.file}:${f.line}`)
        }
        assert.equal(new Set(all.map((f) => `${f.rule} ${f.key}`)).size, all.length, `${name}: one finding per rule and key`)
        assert.equal(a.stats.errors + a.stats.warnings, a.findings.length, name)
        assert.equal(a.stats.pending, a.pending.length, name)
    }
})
