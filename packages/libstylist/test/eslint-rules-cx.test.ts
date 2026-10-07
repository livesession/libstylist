// RuleTester suites for the cx-family rules: no-classname, cx-args, cx-part-exists, no-cx-attribute,
// data-in-cx, no-literal-class, root-part.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import tsParser from "@typescript-eslint/parser"
import { RuleTester, type Rule } from "eslint"

import cxArgs from "../src/eslint/rules/cx-args.js"
import cxPartExists from "../src/eslint/rules/cx-part-exists.js"
import dataInCx from "../src/eslint/rules/data-in-cx.js"
import noClassname from "../src/eslint/rules/no-classname.js"
import noCxAttribute from "../src/eslint/rules/no-cx-attribute.js"
import noLiteralClass from "../src/eslint/rules/no-literal-class.js"
import rootPart from "../src/eslint/rules/root-part.js"

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const core = { libstylist: { prefix: "elo", namespace: "core", segments: ["ai", "app", "gram", "inf", "player"] } }

const tester = new RuleTester({ languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } } })

type Tests = Parameters<RuleTester["run"]>[2]

/**
 * Runs a suite with the base-package settings as the default. Flat config deep-merges settings,
 * so a case that needs other (or no) settings states them itself instead of layering on a base.
 */
const run = (name: string, rule: unknown, tests: Tests) => {
    const withDefaults = (c: string | { settings?: unknown }) => (typeof c === "string" ? { code: c, settings: core } : "settings" in c ? c : { ...c, settings: core })
    tester.run(name, rule as Rule.RuleModule, { valid: tests.valid.map(withDefaults), invalid: tests.invalid.map(withDefaults) } as Tests)
}

/** A small registry in the SPEC §7 shape. */
const registry = {
    version: 1,
    prefix: "elo",
    hash: { version: 1, length: 6 },
    scopes: {
        alert: {
            namespace: "core",
            group: "components",
            file: "components/alert.css",
            roots: [{ component: "Alert", local: "root", tag: "elo-alert" }],
            parts: { root: "_cxclass_elo-9f2k1x", icon: "_cxclass_elo-or4d4l", content: "_cxclass_elo-000001", title: "_cxclass_elo-000002", "group-label": "_cxclass_elo-00000c" },
        },
        modal: {
            namespace: "core",
            group: "components",
            roots: [
                { component: "Modal", local: "root", tag: "elo-modal" },
                { component: "Modal.Header", local: "header", tag: "elo-modal-header" },
            ],
            parts: { root: "_cxclass_elo-000003", header: "_cxclass_elo-000004", body: "_cxclass_elo-000005", backdrop: "_cxclass_elo-00000b" },
        },
        "text-input": { namespace: "core", group: "components", roots: [], parts: { root: "_cxclass_elo-000006", wrapper: "_cxclass_elo-000007", "input-wrapper": "_cxclass_elo-000008" } },
        switch: { namespace: "core", group: "components", roots: [{ component: "Switch", local: "root", tag: "elo-switch" }], parts: { root: "_cxclass_elo-00000d" } },
        "player-controls": { namespace: "player", group: "player", roots: [], parts: { root: "_cxclass_elo-000009", button: "_cxclass_elo-00000a" } },
    },
}
const partMaps = { components: "@x/css", player: "@x/css/player" }
const withRegistry = { libstylist: { ...core.libstylist, registry, partMaps } }

const RT = `import { cx } from "@livesession/libstylist/runtime"\n`
/** Imports of part maps (`alert as cn` by default) plus the runtime cx. */
const H = (maps = "alert as cn", module = "@x/css") => `import { ${maps} } from "${module}"\n${RT}`
const RUNTIME = `import { legacy } from "@livesession/libstylist/runtime"\n`

describe("libstylist/no-classname", () => {
    run("no-classname", noClassname, {
        valid: [
            `${H()}<div {...cx(cn.root, { kind: "primary" })} />`,
            `${RUNTIME}<div className={legacy("hover")} />`,
            `${RUNTIME}<div className={legacy("a", open && "b", on ? "c" : undefined)} />`,
            `import { legacyClassName } from "@livesession/libstylist/runtime"\n<div className={legacyClassName(className)} />`,
            `import { legacy, legacyClassName } from "@livesession/libstylist/runtime"\n<i className={legacy("icon-wrapper", legacyClassName(className))} />`,
            `<Comp classNames={x} />`,
            `React.createElement("div", { id: "x" })`,
            `const p = { id: "x" }\nconst a = <div {...p} />`,
        ],
        invalid: [
            { code: `<div className="x" />`, errors: [{ messageId: "className", data: { name: "className" } }] },
            { code: `<Alert className={cn.root} />`, errors: [{ messageId: "className" }] },
            { code: `<TextInput inputClassName="hover" />`, errors: [{ messageId: "className", data: { name: "inputClassName" } }] },
            { code: `<div class="x" />`, errors: [{ messageId: "className", data: { name: "class" } }] },
            { code: `${RUNTIME}<div className={legacy(props.className)} />`, errors: [{ messageId: "legacyArgs" }] },
            { code: `${RUNTIME}<div className={legacy("hover")} />`, options: [{ allowLegacy: false }], errors: [{ messageId: "legacyForbidden" }] },
            { code: `<div {...{ className: "x", id: "y" }} />`, errors: [{ messageId: "className" }] },
            { code: `React.createElement("div", { className: "x" })`, errors: [{ messageId: "className" }] },
        ],
    })
})

describe("libstylist/cx-args", () => {
    run("cx-args", cxArgs, {
        valid: [
            `${H()}<elo-alert {...cx(cn.root, rest, { variant, hasTitle: !!title, "row-id": id, ...state })} />`,
            `${H()}<span {...cx(cn.icon)} />`,
            `${H()}<span {...cx(cn["group-label"], props.inputCx, inputCx!, inputCx as any)} />`,
            `${H()}<span {...cx(cn.icon, cx(cn.title, slot))} />`,
            `${H()}<span {...cx({ open })} />`,
            `${H()}<TextInput inputCx={cx(cn.field)} />`,
            `${H()}const attrs = cx(cn.icon, undefined, null, false)`,
            // T4/app-4: data on a polymorphic host binding or a third-party component renders (they pass it to their DOM)
            `${H()}function B({ as: As = "button", ...rest }: any) { return <As elo-button {...cx(cn.root, rest, { size })} /> }`,
            // …and on a tag held in a const (it is no component function)
            `${H()}const Tag = open ? "p" : "elo-mapped"\nconst el = <Tag {...cx(cn.root, { size })} />`,
            `${H()}import * as RadixPopover from "@radix-ui/react-popover"\n<RadixPopover.Content elo-popover-content {...cx(cn.content, contentCx, { side })} />`,
            // T6: locals that hold no part and no data literal stay props
            `${H()}function A({ inputCx }: any) { const slot = inputCx ?? undefined; return <span {...cx(cn.icon, slot)} /> }`,
            `${H()}const attrs = cx(cn.icon)\nconst el = <span {...cx(cn.title, attrs)} />`,
            `${H()}const { a } = { a: cn.icon }\nconst el = <span {...cx(cn.title, a)} />`,
            `${H()}function A(props: any) { const r = props ?? {}; return <span {...cx(cn.icon, r)} /> }`,
            // a type wrapper around a cx() call is no outer call: its data literal renders
            `${H()}<span {...(cx(cn.icon, { open }) as React.HTMLAttributes<HTMLSpanElement>)} />`,
            `${H()}<span {...cx(cn.icon, { open })!} />`,
            `${H()}<TextInput inputCx={cx(cn.field) as never} />`,
            `${H()}function A({ inputCx }: any) { return <TextInput inputCx={inputCx} /> }`,
            `${H("playerControls", "@x/css/player")}<Button {...cx(playerControls.button)} />`,
            `import * as rt from "@livesession/libstylist/runtime"\nimport { alert as cn } from "@x/css"\n<span {...rt.cx(cn.icon, { a })} />`,
            // not the runtime cx: another module's helper or a local one is not checked here
            `import { cx } from "../utils/cx"\n<span className={cx("a", open && "b")} />`,
            `function cx(...a: unknown[]) { return a }\ncx("a", open && "b")`,
            { code: `${H()}<span {...cx(cn.icon, { open })} />`, settings: withRegistry },
        ],
        invalid: [
            { code: `${H()}<span {...cx(open && cn.open)} />`, errors: [{ messageId: "stateParts" }] },
            { code: `${H()}<span {...cx(cn.root, open ? cn.a : cn.b)} />`, errors: [{ messageId: "stateParts" }] },
            { code: `${H()}<span {...cx(cn.root, open ? cn.a : undefined)} />`, errors: [{ messageId: "stateParts" }] },
            { code: `${H()}<span {...cx(open && "open")} />`, errors: [{ messageId: "stateParts" }] },
            { code: `${H()}<span {...cx([cn.a, cn.b])} />`, errors: [{ messageId: "stateParts" }] },
            { code: `${H()}<span {...cx("icon")} />`, errors: [{ messageId: "invalid", data: { message: `string arguments are not parts — read the part from its part map: import { alert as cn } from "<css package>" and write cx(cn.icon)` } }] },
            { code: `${H()}<span {...cx(cn[key])} />`, errors: [{ messageId: "invalid" }] },
            { code: `${H()}<span {...cx(cn.$tags)} />`, errors: [{ messageId: "invalid" }] },
            { code: `${H()}<span {...cx(f(cn.icon))} />`, errors: [{ messageId: "invalid" }] },
            { code: `${H()}<span {...cx(open ? rest : undefined)} />`, errors: [{ messageId: "invalid" }] },
            { code: `${H()}<span {...cx(cn)} />`, errors: [{ messageId: "invalid" }] },
            { code: `${H()}<span {...cx(true, 1)} />`, errors: [{ messageId: "invalid" }, { messageId: "invalid" }] },
            // data held in a variable is forwarded as props, never rendered
            { code: `${H()}const state = { open: true }\nconst el = <span {...cx(cn.icon, state)} />`, errors: [{ messageId: "invalid" }] },
            // the abandoned { data: … } wrapper
            { code: `${H()}<span {...cx(cn.icon, { data: { open } })} />`, errors: [{ messageId: "invalid" }] },
            { code: `${H()}<span {...cx({ [key]: 1 })} />`, errors: [{ messageId: "invalid" }] },
            { code: `${H()}<span {...cx(...parts)} />`, errors: [{ messageId: "invalid" }] },
            // data in a nested call is dropped
            { code: `${H()}<span {...cx(cn.icon, cx(cn.title, { open }))} />`, errors: [{ messageId: "nestedData" }] },
            { code: `${H()}<React.Fragment {...cx(cn.icon)} />`, errors: [{ messageId: "fragment" }] },
            { code: `${H()}<Fragment {...cx(cn.icon)} />`, errors: [{ messageId: "fragment" }] },
            // T4/app-4: a slot carries parts and markers only — its data literal renders nothing
            { code: `${H()}<TextInput inputCx={cx(cn.field, { wide })} />`, errors: [{ messageId: "slotData", data: { slot: "inputCx" } }] },
            // …through a type wrapper (not a nested call), and in a conditional slot value (also a conditional part)
            { code: `${H()}<TextInput inputCx={cx(cn.field, { wide }) as never} />`, errors: [{ messageId: "slotData", data: { slot: "inputCx" } }] },
            {
                code: `${H()}<TextInput inputCx={open ? cx(cn.field, { wide }) : undefined} />`,
                errors: [{ messageId: "stateParts" }, { messageId: "slotData", data: { slot: "inputCx" } }],
            },
            { code: `${H()}<TextInput inputCx={open ? cx(cn.field) : cx(cn.icon)} />`, errors: [{ messageId: "stateParts" }] },
            { code: `${H()}<TextInput inputCx={open && cx(cn.field)} />`, errors: [{ messageId: "stateParts" }] },
            // …and so does a libstylist component's root: its cx() forwards parts and markers only
            {
                code: `import { Button } from "../Button"\n${H()}<Button {...cx(cn.close, { open })}>x</Button>`,
                errors: [{ messageId: "componentData", data: { element: "Button" } }],
            },
            // review open issue: a cx() result held in a local and spread on its own escapes oneCall and the
            // conditional-spread check and gets no dev annotations — spread the call itself
            {
                code: `${H()}const attrs = cx(cn.icon, { open })\nconst el = <span {...attrs} {...cx(cn.title)} />`,
                errors: [{ messageId: "heldCall", data: { name: "attrs" } }],
            },
            {
                code: `${H()}function A(props: P) { const a = cx(cn.icon); const b = cx(cn.title); return <span {...(open ? a : b)} /> }`,
                errors: [{ messageId: "heldCall", data: { name: "a" } }, { messageId: "heldCall", data: { name: "b" } }],
            },
            {
                code: `${H()}function A(props: P) { let a; a = cx(cn.icon); return <span {...{ ...a }} /> }`,
                errors: [{ messageId: "heldCall", data: { name: "a" } }],
            },
            // …and a conditional of calls held in a local — a conditional part in disguise
            {
                code: `${H()}function A(props: P) { const attrs = open ? cx(cn.icon) : cx(cn.title); return <span {...attrs} /> }`,
                errors: [{ messageId: "heldCall", data: { name: "attrs" } }],
            },
            {
                code: `${H()}function A(props: P) { const attrs = open && cx(cn.icon); return <span {...attrs} /> }`,
                errors: [{ messageId: "heldCall", data: { name: "attrs" } }],
            },
            // a held result passed on as an argument or a slot value forwards only its parts and markers:
            // its data renders nothing (the nested and slot data checks, through the local)
            { code: `${H()}const attrs = cx(cn.icon, { open })
const el = <span {...cx(cn.title, attrs)} />`, errors: [{ messageId: "nestedData" }] },
            { code: `${H()}const attrs = open ? cx(cn.icon, { open }) : cx(cn.icon)
const el = <span {...cx(cn.title, attrs)} />`, errors: [{ messageId: "nestedData" }] },
            { code: `${H()}const attrs = cx(cn.field, { wide })
const el = <TextInput inputCx={attrs} />`, errors: [{ messageId: "slotData", data: { slot: "inputCx" } }] },
            // …a component defined in the same file too (a function, or a component wrapper of one)
            {
                code: `${H()}function Item(props: P) { return <elo-item {...cx(cn.root, props)} /> }\nconst el = <Item {...cx(cn.icon, { open })} />`,
                errors: [{ messageId: "componentData", data: { element: "Item" } }],
            },
            {
                code: `${H()}const Row = forwardRef<HTMLLIElement, P>((props, ref) => <li ref={ref} {...cx(cn.icon, props)} />)\nconst el = <Row {...cx(cn.title, { open })} />`,
                errors: [{ messageId: "componentData", data: { element: "Row" } }],
            },
            // T5: a conditional spread of cx() calls is a conditional part; one cx() call per element
            { code: `${H()}<span {...(hasTitle ? cx(cn.icon) : cx(cn.action))} />`, errors: [{ messageId: "stateParts" }] },
            { code: `${H()}<span {...(hasAction && cx(cn.content))} />`, errors: [{ messageId: "stateParts" }] },
            { code: `${H()}<span {...(c ? cx(cn.a) : undefined)} />`, errors: [{ messageId: "stateParts" }] },
            { code: `${H()}<span {...{ ...cx(cn.icon), ...(open ? cx(cn.title) : {}) }} />`, errors: [{ messageId: "stateParts" }] },
            { code: `${H()}<span {...cx(cn.icon)} {...cx(cn.title, { a: 1 })} {...cx({ b: 2 })} />`, errors: [{ messageId: "oneCall" }, { messageId: "oneCall" }] },
            // T6: a part or a data literal routed through a local is reported like the inline form
            { code: `${H()}const part = open ? cn.icon : cn.title\nconst el = <span {...cx(part)} />`, errors: [{ message: /^part holds a part: pass the part-map member itself/ }] },
            { code: `${H()}const p = cn.icon\nconst el = <span {...cx(p)} />`, errors: [{ message: /^p holds a part/ }] },
            { code: `${H()}let p = cn.icon\nif (open) p = cn.title\nconst el = <span {...cx(p)} />`, errors: [{ message: /^p holds a part/ }] },
            { code: `${H()}let d = { open }\nconst el = <elo-alert {...cx(cn.root, rest, d)} />`, errors: [{ message: /^d holds an object literal/ }] },
            { code: `${H()}var d = { open }\nconst el = <elo-alert {...cx(cn.root, rest, d)} />`, errors: [{ message: /^d holds an object literal/ }] },
            { code: `${H()}let e\ne = { open }\nconst el = <elo-alert {...cx(cn.root, rest, e)} />`, errors: [{ message: /^e holds an object literal/ }] },
            // …whichever branch of a conditional or logical initializer holds it
            { code: `${H()}const d = open ? { open } : { closed: true }\nconst el = <elo-alert {...cx(cn.root, rest, d)} />`, errors: [{ message: /^d holds an object literal/ }] },
            { code: `${H()}const d = open && { open }\nconst el = <elo-alert {...cx(cn.root, rest, d)} />`, errors: [{ message: /^d holds an object literal/ }] },
            // …and a data value that reads a part renders its attribute name as data
            { code: `${H()}<elo-alert {...cx(cn.root, rest, { icon: open && cn.icon })} />`, errors: [{ message: /^data value "icon" reads a part-map member/ }] },
            // T11: the object form of a conditional part gets the state guidance
            { code: `${H()}<span {...cx({ [cn.icon]: open })} />`, errors: [{ messageId: "stateParts" }] },
            // app-3: a part map imported by a path is not recognized — say so instead of reading it as props
            {
                code: `import { alert as cn } from "../styles-dist/parts"\n${RT}<span {...cx(cn.icon)} />`,
                settings: withRegistry,
                errors: [{ messageId: "relativeMap", data: { local: "cn", scope: "alert", module: "../styles-dist/parts" } }],
            },
        ],
    })
})

describe("libstylist/cx-args: libstylist packages resolved from node_modules", () => {
    // app-4: a component imported from a package that declares a libstylist prefix drops a caller's data;
    // one from a third-party package (no libstylist field) passes it to its DOM
    const dir = mkdtempSync(join(tmpdir(), "libstylist-pkgs-"))
    const pkg = (name: string, json: object) => {
        mkdirSync(join(dir, "node_modules", name), { recursive: true })
        writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, ...json }))
    }
    pkg("@x/ds", { libstylist: { prefix: "elo", namespace: "core" } })
    pkg("@x/third", {})
    after(() => rmSync(dir, { recursive: true, force: true }))
    const filename = join(dir, "src", "Page.tsx")
    run("cx-args", cxArgs, {
        valid: [{ code: `import { Menu } from "@x/third"\n${H()}<Menu {...cx(cn.menu, { open })} />`, filename }],
        invalid: [{ code: `import { Alert } from "@x/ds"\n${H()}<Alert {...cx(cn.banner, { pinned })} />`, filename, errors: [{ messageId: "componentData", data: { element: "Alert" } }] }],
    })
})

describe("libstylist/cx-part-exists", () => {
    run("cx-part-exists", cxPartExists, {
        valid: [
            { code: `${H()}<span {...cx(cn.icon, cn["group-label"], cn.$tags)} />`, settings: withRegistry },
            { code: `${H("playerControls", "@x/css/player")}<Button {...cx(playerControls.button)} />`, settings: withRegistry },
            { code: `${H("switchClasses")}<button elo-switch {...cx(switchClasses.root)} />`, settings: withRegistry },
            { code: `${H()}const attr = cn.icon`, settings: withRegistry },
            // no registry configured: nothing to check against
            `${H()}<span {...cx(cn.nope)} />`,
            // not a part map module
            { code: `import { alert as cn } from "./local"\n${RT}<span {...cx(cn.nope)} />`, settings: withRegistry },
            { code: `import type { alert } from "@x/css"\nconst x: typeof alert = null!`, settings: withRegistry },
        ],
        invalid: [
            {
                code: `${H()}<span {...cx(cn.icn)} />`,
                settings: withRegistry,
                errors: [{ messageId: "unknownPart", data: { part: "icn", map: "cn", scope: "alert", hint: ` — did you mean "icon"?` }, suggestions: [{ messageId: "replace", data: { replacement: "cn.icon" }, output: `${H()}<span {...cx(cn.icon)} />` }] }],
            },
            {
                code: `${H()}const attr = cn["group-lbl"]`,
                settings: withRegistry,
                errors: [{ messageId: "unknownPart", suggestions: [{ messageId: "replace", data: { replacement: `cn["group-label"]` }, output: `${H()}const attr = cn["group-label"]` }] }],
            },
            {
                code: `${H("alrt as cn")}<span {...cx(cn.icon)} />`,
                settings: withRegistry,
                errors: [{ messageId: "unknownMap", data: { name: "alrt", module: "@x/css", hint: ` — did you mean "alert"?` }, suggestions: [{ messageId: "replace", data: { replacement: "alert" }, output: `${H()}<span {...cx(cn.icon)} />` }] }],
            },
            // a part map of another group is not exported by this module
            { code: `${H("playerControls")}<Button {...cx(playerControls.button)} />`, settings: withRegistry, errors: [{ messageId: "unknownMap" }] },
        ],
    })
})

describe("libstylist/no-cx-attribute", () => {
    run("no-cx-attribute", noCxAttribute, {
        valid: [
            `${H()}<span {...cx(cn.icon)} />`,
            `<svg><circle cx={5} /><ellipse cx="5" /><radialGradient cx="50%" /><motion.circle cx={1} /></svg>`,
            `${H()}<TextInput inputCx={cx(cn.field)} contentCx={contentCx} slotCx={props.slotCx} />`,
            `/* cxScope is not a pragma without the @ */\nconst a = 1`,
        ],
        invalid: [
            { code: `<span cx="icon" />`, errors: [{ messageId: "attribute" }] },
            { code: `<Button cx={["a", open && "b"]} />`, errors: [{ messageId: "attribute" }] },
            { code: `/** @cxScope text-input */\nconst a = 1`, errors: [{ messageId: "pragma", data: { name: "textInput" } }] },
            { code: `/** @cxScope switch */\nconst a = 1`, errors: [{ messageId: "pragma", data: { name: "switchClasses" } }] },
            { code: `<TextInput inputCx="field" />`, errors: [{ messageId: "slotValue", data: { name: "inputCx" } }] },
            { code: `<TextInput inputCx={["field", wide && "wide"]} />`, errors: [{ messageId: "slotValue" }] },
            { code: `<TextInput inputCx={{ field: true }} />`, errors: [{ messageId: "slotValue" }] },
            { code: `<input inputCx={x} />`, errors: [{ messageId: "slotOnHost", data: { name: "inputCx", element: "input" } }] },
        ],
    })
})

describe("libstylist/data-in-cx", () => {
    run("data-in-cx", dataInCx, {
        valid: [
            `${H()}<elo-alert {...cx(cn.root, rest, { size, open })} role="status" aria-hidden={hidden} />`,
            `<div role="status" aria-label="x" />`,
            // dev annotations and removed hooks are no-dev-attrs' to report
            `<div data-react-component="A" data-file-source="x" data-component="X" data-part="y" />`,
            // app-4: on a libstylist component a data-* attribute is a prop (the component decides where it goes)
            `import { Alert } from "../Alert"\n<Alert data-testid="alert-1" />`,
            // …and so it is on a component defined in the same file (a function, or memo/forwardRef of one)
            `function Item(props: P) { return <elo-item {...cx(cn.root, props)} /> }\nconst el = <Item data-open={open} />`,
            `const Row = React.memo((props: P) => <li {...cx(cn.icon, props)} />)\nconst el = <Row data-size="s" />`,
        ],
        invalid: [
            // merged into the element's existing data literal; `|| undefined` stays unless the value is boolean-shaped (T1)
            {
                code: `${H()}<elo-alert {...cx(cn.root, rest, { variant })} data-has-title={hasTitle || undefined} />`,
                output: `${H()}<elo-alert {...cx(cn.root, rest, { variant, hasTitle: hasTitle || undefined })} />`,
                errors: [{ messageId: "move", data: { name: "data-has-title", key: "hasTitle", hint: "{...cx(cn.root, rest, { hasTitle: hasTitle || undefined })}" } }],
            },
            {
                code: `${H()}<elo-alert {...cx(cn.root, rest)} data-has-title={!!title || undefined} data-open={a === b || undefined} />`,
                output: `${H()}<elo-alert {...cx(cn.root, rest, { hasTitle: !!title, open: a === b })} />`,
                errors: [{ messageId: "move" }, { messageId: "move" }],
            },
            // T1: `x || undefined` omits 0 and "", the literal renders them — a number or string keeps its `|| undefined`,
            // and the message shows each entry exactly as the fix writes it (never a bare `{ count }` or `{ sortDir }`)
            {
                code: `${H()}<elo-alert {...cx(cn.root, rest)} data-count={count || undefined} data-sort-dir="asc" />`,
                output: `${H()}<elo-alert {...cx(cn.root, rest, { count: count || undefined, sortDir: "asc" })} />`,
                errors: [
                    { messageId: "move", data: { name: "data-count", key: "count", hint: "{...cx(cn.root, rest, { count: count || undefined })}" } },
                    { messageId: "move", data: { name: "data-sort-dir", key: "sortDir", hint: '{...cx(cn.root, rest, { sortDir: "asc" })}' } },
                ],
            },
            {
                code: `${H()}<span {...cx(cn.icon)} data-count={count || undefined} data-label={label || undefined} />`,
                output: `${H()}<span {...cx(cn.icon, { count: count || undefined, label: label || undefined })} />`,
                errors: [{ messageId: "move", data: { name: "data-count", key: "count", hint: "{...cx(cn.icon, { count: count || undefined })}" } }, { messageId: "move" }],
            },
            // T2: a JSX attribute string decodes entities and has no escapes — the literal gets its decoded value
            {
                code: `${H()}<span {...cx(cn.icon)} data-label="Tom &amp; Jerry" data-path="C:\\new" data-quote='say "hi"' />`,
                output: `${H()}<span {...cx(cn.icon, { label: "Tom & Jerry", path: "C:\\\\new", quote: "say \\"hi\\"" })} />`,
                errors: [{ messageId: "move" }, { messageId: "move" }, { messageId: "move" }],
            },
            {
                code: `${H()}<span {...cx(cn.icon)} data-text="two\nlines" />`,
                output: `${H()}<span {...cx(cn.icon, { text: "two\\nlines" })} />`,
                errors: [{ messageId: "move" }],
            },
            // T11: the message shows the element's own call (no cn.root on a non-identity element)
            { code: `${H()}<span data-count={2} />`, output: `${H()}<span {...cx({ count: 2 })} />`, errors: [{ messageId: "move", data: { name: "data-count", key: "count", hint: "{...cx({ count: 2 })}" } }] },
            {
                code: `${H()}<elo-alert data-open="true" />`,
                output: `${H()}<elo-alert {...cx({ open: "true" })} />`,
                errors: [{ messageId: "move", data: { name: "data-open", key: "open", hint: '{...cx(cn.root, { open: "true" })}' } }],
            },
            // a new literal as the call's last argument
            {
                code: `${H()}<span {...cx(cn.icon)} data-size="small" data-open={open ? "true" : undefined} />`,
                output: `${H()}<span {...cx(cn.icon, { size: "small", open: open ? "true" : undefined })} />`,
                errors: [{ messageId: "move" }, { messageId: "move" }],
            },
            // no cx() spread yet: one is created (cx is already imported)
            {
                code: `${H()}<div data-dropdown-item data-n={2} />`,
                output: `${H()}<div {...cx({ dropdownItem: true, n: 2 })} />`,
                errors: [{ messageId: "move" }, { messageId: "move" }],
            },
            // …and cx is imported when the file has no runtime import — in the @livesession/* group (T12): after the
            // package imports, ahead of the local ones
            {
                code: `import * as React from "react"\n<div data-tone="warn" />`,
                output: `import * as React from "react"\n\nimport { cx } from "@livesession/libstylist/runtime"\n<div {...cx({ tone: "warn" })} />`,
                errors: [{ messageId: "move" }],
            },
            {
                code: `import * as React from "react"\n\nimport { Icon } from "../Icon"\n<div data-tone="warn" />`,
                output: `import * as React from "react"\n\nimport { cx } from "@livesession/libstylist/runtime"\n\nimport { Icon } from "../Icon"\n<div {...cx({ tone: "warn" })} />`,
                errors: [{ messageId: "move" }],
            },
            {
                code: `import { alert as cn } from "@livesession/eloquentui-css"\n\nimport { Icon } from "../Icon"\n<div data-tone="warn" />`,
                output: `import { alert as cn } from "@livesession/eloquentui-css"\nimport { cx } from "@livesession/libstylist/runtime"\n\nimport { Icon } from "../Icon"\n<div {...cx({ tone: "warn" })} />`,
                errors: [{ messageId: "move" }],
            },
            {
                code: `import { Icon } from "../Icon"\n<div data-tone="warn" />`,
                output: `import { cx } from "@livesession/libstylist/runtime"\n\nimport { Icon } from "../Icon"\n<div {...cx({ tone: "warn" })} />`,
                errors: [{ messageId: "move" }],
            },
            {
                code: `import { unsetRef } from "@livesession/libstylist/runtime"\n<div data-tone="warn" />`,
                output: `import { unsetRef, cx } from "@livesession/libstylist/runtime"\n<div {...cx({ tone: "warn" })} />`,
                errors: [{ messageId: "move" }],
            },
            // a trailing comma in the literal is kept
            {
                code: `${H()}<i {...cx(cn.icon, { a, })} data-b="1" />`,
                output: `${H()}<i {...cx(cn.icon, { a, b: "1", })} />`,
                errors: [{ messageId: "move" }],
            },
            // a key that doesn't round-trip camelCase is quoted
            { code: `${H()}<i {...cx(cn.icon)} data-a1-b2="x" />`, output: `${H()}<i {...cx(cn.icon, { a1B2: "x" })} />`, errors: [{ messageId: "move" }] },
            // a value that can be false renders "false" today and nothing in the literal: a suggestion, not a fix
            {
                code: `${H()}<i {...cx(cn.icon)} data-active={active} />`,
                output: null,
                errors: [{ messageId: "move", suggestions: [{ messageId: "moveSuggest", output: `${H()}<i {...cx(cn.icon, { active })} />` }] }],
            },
            // cx bound to something else: reported without a fix
            { code: `const cx = (s: string) => s;\n<div data-x="1" />`, output: null, errors: [{ messageId: "move" }] },
        ],
    })
})

describe("libstylist/no-literal-class", () => {
    run("no-literal-class", noLiteralClass, {
        valid: [
            `<div className={cn.root} />`,
            `<div className={variant === "a" ? cn.a : cn.b} />`,
            `${RUNTIME}<div className={legacy("hover")} />`,
            `cx(cn.root, className)`,
            `${H()}<span {...cx(cn.icon)} />`,
            // the runtime cx is cx-args' to check
            `${RT}const a = cx("x")`,
            `other("x")`,
            `<div data-state="open" />`,
            { code: `cx("a")`, options: [{ helpers: ["joinClasses"] }] },
        ],
        invalid: [
            { code: `<div className="box" />`, errors: [{ messageId: "literal", data: { name: "box" } }] },
            { code: `<div className={open ? "open" : undefined} />`, errors: [{ messageId: "literal", data: { name: "open" } }] },
            { code: `cx(cn.root, variant === "settings" && "settings", className)`, errors: [{ messageId: "literal", data: { name: "settings" } }] },
            { code: `const cls = cx("a", "b")`, errors: [{ messageId: "literal", data: { name: "a" } }, { messageId: "literal", data: { name: "b" } }] },
            { code: `clsx({ active: on }, ["x"])`, errors: [{ messageId: "literal", data: { name: "active" } }, { messageId: "literal", data: { name: "x" } }] },
            { code: `joinClasses("a")`, options: [{ helpers: ["joinClasses"] }], errors: [{ messageId: "literal" }] },
        ],
    })
})

describe("libstylist/root-part", () => {
    const rootLocals = (locals: Record<string, string | false>) => ({ libstylist: { ...core.libstylist, rootLocals: locals } })
    const M = H("modal as cn")

    run("root-part", rootPart, {
        valid: [
            `${H()}<elo-alert {...cx(cn.root, props)} />`,
            `${H()}<elo-alert {...cx(rest, cn.root, { open })} />`,
            `${H()}<elo-alert {...cx(cx(cn.root), rest)} />`,
            `${H("button as cn")}const b = <As elo-button {...cx(cn.root, rest)} type="button" />`,
            `${H("modalConfirm as cn")}<Modal elo-modalconfirm {...cx(cn.root, rest)} />`,
            // no part map read → no sheet → no root part to require
            `<elo-alert role="status" />`,
            `${H()}<span {...cx(cn.icon)} />`,
            `${H()}<Icon {...cx(cn.chevron)} />`,
            // several identity elements, no binding info: which one is the root is not definite
            `${M}<><elo-modal {...cx(cn.root)} /><elo-modal-header {...cx(cn.header)} /></>`,
            { code: `${M}<elo-modal-header {...cx(cn.header)} />`, settings: rootLocals({ "Modal.Header": "header" }) },
            { code: `${M}<elo-modal-header {...cx(cn.header)} />`, settings: rootLocals({ "elo-modal-header": "modal:header" }) },
            { code: `${H()}<elo-alert />`, settings: rootLocals({ "elo-alert": false }) },
            { code: `${M}<elo-modal-header {...cx(cn.header)} />`, settings: withRegistry },
            { code: `${M}<elo-modal {...cx(cn.root)}><elo-modal-header {...cx(cn.header)} /></elo-modal>`, settings: withRegistry },
            { code: `${M}<elo-modal-backdrop {...cx(cn.backdrop)} />`, settings: withRegistry },
            { code: `${H("switchClasses")}<button elo-switch {...cx(switchClasses.root, rest)} />`, settings: withRegistry },
            { code: `<elo-alert />`, settings: { libstylist: {} } },
            `${H("textInput as cn")}<><elo-textinput {...cx(cn.root)} /><div elo-textinput-hint /></>`,
            // app-3: a part map imported by a path (cx-args reports it) — its root can't be seen, so it isn't claimed missing
            { code: `import { alert as cn } from "../styles-dist/parts"\n${RT}<elo-alert {...cx(cn.root, rest)} />`, settings: withRegistry },
            // a bare settings local belongs to the file that renders its identity element
            { code: `${H()}<elo-alert {...cx(cn.root)}><span {...cx(cn.header)} /></elo-alert>`, settings: rootLocals({ "Modal.Header": "header" }) },
        ],
        invalid: [
            {
                code: `${H()}<elo-alert role="status" />`,
                output: `${H()}<elo-alert {...cx(cn.root)} role="status" />`,
                errors: [{ messageId: "missing", data: { identity: "<elo-alert>", label: "`cn.root`", local: "root" } }],
            },
            {
                code: `${H("button as cn")}<button elo-button type="button" />`,
                output: `${H("button as cn")}<button elo-button {...cx(cn.root)} type="button" />`,
                errors: [{ messageId: "missing", data: { identity: "<button elo-button>", label: "`cn.root`", local: "root" } }],
            },
            // a cx() spread without the root part gets it as its first argument
            { code: `${H()}<elo-alert {...cx(cn.icon, rest)} />`, output: `${H()}<elo-alert {...cx(cn.root, cn.icon, rest)} />`, errors: [{ messageId: "missing" }] },
            // cx is imported by the fix when needed
            {
                code: `import { alert as cn } from "@x/css"\n<elo-alert />`,
                output: `import { alert as cn } from "@x/css"\n\nimport { cx } from "@livesession/libstylist/runtime"\n<elo-alert {...cx(cn.root)} />`,
                errors: [{ messageId: "missing" }],
            },
            { code: `${H()}<span {...cx(cn.root)} />`, errors: [{ messageId: "reserved", data: { label: "`cn.root`" } }] },
            { code: `${H()}<Icon {...cx(cn.root)} />`, errors: [{ messageId: "reserved" }] },
            { code: `${H()}<TextInput inputCx={cx(cn.root)} />`, errors: [{ messageId: "reserved" }] },
            { code: `${H()}const slot = cx(cn.icon, cx(cn.root))`, errors: [{ messageId: "reserved" }] },
            {
                code: `${M}<><elo-modal /><elo-modal-header {...cx(cn.header)} /></>`,
                errors: [{ messageId: "missing", suggestions: [{ messageId: "addPart", data: { label: "`cn.root`" }, output: `${M}<><elo-modal {...cx(cn.root)} /><elo-modal-header {...cx(cn.header)} /></>` }] }],
            },
            {
                code: `${M}<elo-modal-header />`,
                settings: withRegistry,
                output: `${M}<elo-modal-header {...cx(cn.header)} />`,
                errors: [{ messageId: "missing", data: { identity: "<elo-modal-header>", label: "`cn.header`", local: "header" } }],
            },
            {
                code: `${M}<><elo-modal {...cx(cn.root)} /><elo-modal-header {...cx(cn.body)} /></>`,
                settings: withRegistry,
                output: `${M}<><elo-modal {...cx(cn.root)} /><elo-modal-header {...cx(cn.header, cn.body)} /></>`,
                errors: [{ messageId: "missing", data: { identity: "<elo-modal-header>", label: "`cn.header`", local: "header" } }],
            },
            {
                code: `${M}<elo-modal-header {...cx(cn.header, cn.root)} />`,
                settings: withRegistry,
                errors: [{ messageId: "misplaced", data: { label: "`cn.root`", identity: "<elo-modal-header>", expected: "`cn.header`" } }],
            },
            { code: `${M}<span {...cx(cn.header)} />`, settings: withRegistry, errors: [{ messageId: "reserved", data: { label: "`cn.header`" } }] },
            // the identity's binding in another sheet: fixed when that map is imported, reported with where to find it otherwise
            {
                code: `${H("playerBar as cn")}<elo-alert />`,
                settings: withRegistry,
                errors: [{ messageId: "missing", data: { identity: "<elo-alert>", label: "`root` of the alert part map", local: "root" } }],
            },
            {
                code: `${H("playerBar as cn, alert")}<elo-alert />`,
                settings: withRegistry,
                output: `${H("playerBar as cn, alert")}<elo-alert {...cx(alert.root)} />`,
                errors: [{ messageId: "missing", data: { identity: "<elo-alert>", label: "`alert.root`", local: "root" } }],
            },
            {
                code: `${M}<elo-modal-header />`,
                settings: rootLocals({ "Modal.Header": "header" }),
                output: `${M}<elo-modal-header {...cx(cn.header)} />`,
                errors: [{ messageId: "missing" }],
            },
            // settings-bound locals are reserved like registry-bound ones
            {
                code: `${M}<elo-modal-header {...cx(cn.header)}><span {...cx(cn.header)} /></elo-modal-header>`,
                settings: rootLocals({ "Modal.Header": "header" }),
                errors: [{ messageId: "reserved", data: { label: "`cn.header`" } }],
            },
            // several identity elements and nobody carries the implied root: each bare one gets a suggestion
            {
                code: `${H("textInput as cn")}<><elo-textinput /><elo-textinput-hint /></>`,
                errors: [
                    { messageId: "missing", suggestions: [{ messageId: "addPart", output: `${H("textInput as cn")}<><elo-textinput {...cx(cn.root)} /><elo-textinput-hint /></>` }] },
                    { messageId: "missing", suggestions: [{ messageId: "addPart", output: `${H("textInput as cn")}<><elo-textinput /><elo-textinput-hint {...cx(cn.root)} /></>` }] },
                ],
            },
        ],
    })
})
