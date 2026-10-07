// RuleTester suites for identity and annotation rules: marker-attr, tag-name, forward-props,
// no-dev-attrs.
import { resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import tsParser from "@typescript-eslint/parser"
import { RuleTester, type Rule } from "eslint"

import forwardProps from "../src/eslint/rules/forward-props.js"
import markerAttr from "../src/eslint/rules/marker-attr.js"
import noDevAttrs from "../src/eslint/rules/no-dev-attrs.js"
import tagName from "../src/eslint/rules/tag-name.js"

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const SEGMENTS = ["ai", "app", "gram", "inf", "player"]
const core = { libstylist: { prefix: "elo", namespace: "core", segments: SEGMENTS } }
const player = { libstylist: { prefix: "elo", namespace: "player", segments: SEGMENTS } }
const app = { libstylist: { prefix: "elo", namespace: "app", segments: SEGMENTS } }

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

/**
 * A file inside a package of the monorepo fixture (test/fixtures/monorepo, a design-system-shaped pnpm workspace:
 * `components` is the core package, `player` and `app-ui` carry their namespaces, and the sibling packages
 * supply the discovered segments), so the package config and the segments are resolved from disk.
 */
const monorepo = resolve(fileURLToPath(new URL("./fixtures/monorepo", import.meta.url)))
const pkgFile = (pkg: string) => `${monorepo}/packages/${pkg}/src/components/Example/Example.tsx`

describe("libstylist/marker-attr", () => {
    run("marker-attr", markerAttr, {
        valid: [
            `<button elo-button type="button" />`,
            `<button elo-button="" />`,
            `<button elo-button={""} />`,
            `<a elo-link href="/x" />`,
            `<Modal elo-modalconfirm />`,
            `<elo-alert role="status" />`,
            `<elo-modal elo-modalconfirm />`,
            `<div data-elo="1" aria-label="x" />`,
            `/** @libstylistRoot native Radix owns this host and its boolean ARIA */\nexport function Content() { return <div elo-popover-content /> }`,
            `/** @libstylistRoot native Radix owns this host and its boolean ARIA */\nexport const Content = () => <span elo-popover-content />`,
            // No prefix known (no settings, file outside any configured package): nothing to check.
            { code: `<div elo-x="y" />`, settings: { libstylist: {} } },
        ],
        invalid: [
            { code: `<button elo-button="true" />`, output: `<button elo-button />`, errors: [{ messageId: "value", data: { name: "elo-button", element: "button" } }] },
            { code: `<button elo-button={true} type="button" />`, output: `<button elo-button type="button" />`, errors: [{ messageId: "value" }] },
            { code: `<button elo-button={"x"} />`, output: `<button elo-button />`, errors: [{ messageId: "value" }] },
            { code: `<button elo-button={cond} />`, output: null, errors: [{ messageId: "value" }] },
            // false/null/undefined render no marker: making it value-less would change the DOM, so no fix.
            { code: `<button elo-button={false} />`, output: null, errors: [{ messageId: "value" }] },
            { code: `<button elo-button={null} />`, output: null, errors: [{ messageId: "value" }] },
            { code: `<button elo-button={undefined} />`, output: null, errors: [{ messageId: "value" }] },
            { code: `<button elo-button={1} />`, output: `<button elo-button />`, errors: [{ messageId: "value" }] },
            { code: `<div elo-alert />`, errors: [{ messageId: "generic", data: { name: "elo-alert", element: "div" } }] },
            {
                code: `<span elo-badge="x" />`,
                output: `<span elo-badge />`,
                errors: [{ messageId: "generic" }, { messageId: "value" }],
            },
            { code: `<elo-alert elo-alert role="status" />`, output: `<elo-alert role="status" />`, errors: [{ messageId: "redundant", data: { name: "elo-alert" } }] },
            {
                code: `/** Radix owns this host */\nexport function Content() { return <div elo-popover-content /> }`,
                errors: [{ messageId: "generic" }],
            },
            {
                code: `<button app-cta="1" />`,
                settings: { libstylist: { prefix: "app", namespace: "core" } },
                output: `<button app-cta />`,
                errors: [{ messageId: "value" }],
            },
        ],
    })
})

describe("libstylist/tag-name", () => {
    run("tag-name", tagName, {
        valid: [
            `<elo-alert />`,
            `<elo-modal-header />`,
            `<elo-application />`,
            `<button elo-button />`,
            `<div data-x="1" />`,
            `<Modal.Header />`,
            { code: `<elo-player-topbar-url />`, settings: player },
            { code: `<button elo-player-speed />`, settings: player },
            { code: `<elo-app-dock />`, settings: app },
            { code: `<elo-inf-filterbar />`, settings: { libstylist: { prefix: "elo", namespace: "inf", segments: SEGMENTS } } },
            { code: `<model-viewer />`, options: [{ allowTags: ["model-viewer"] }] },
            { code: `<my-widget />`, settings: { libstylist: {} } },
            // Segment unknown (namespace not configured): grammar only.
            { code: `<elo-app-anything />`, settings: { libstylist: { prefix: "elo" } } },
            // Package config resolved from the file's nearest package.json.
            { code: `<elo-player-controlsbar />`, filename: pkgFile("player"), settings: {} },
            { code: `<button elo-player-speed />`, filename: pkgFile("player"), settings: {} },
            { code: `<elo-alert />`, filename: pkgFile("components"), settings: {} },
            { code: `<elo-app-dock />`, filename: pkgFile("app-ui"), settings: {} },
        ],
        invalid: [
            { code: `<my-widget />`, errors: [{ messageId: "prefix", data: { name: "my-widget", prefix: "elo" } }] },
            { code: `<elo-Alert />`, errors: [{ messageId: "invalid" }] },
            { code: `<elo-text_input />`, errors: [{ messageId: "invalid" }] },
            { code: `<elo-alert- />`, errors: [{ messageId: "invalid" }] },
            { code: `<button elo-Button />`, errors: [{ messageId: "invalid" }] },
            { code: `<elo-app-dock />`, errors: [{ messageId: "foreignSegment", data: { name: "elo-app-dock", prefix: "elo", other: "app" } }] },
            { code: `<button elo-player-speed />`, errors: [{ messageId: "foreignSegment" }] },
            { code: `<elo-controlsbar />`, settings: player, errors: [{ messageId: "segment", data: { name: "elo-controlsbar", prefix: "elo", segment: "player", namespace: "player" } }] },
            { code: `<button elo-button />`, settings: player, errors: [{ messageId: "segment" }] },
            { code: `<elo-app />`, settings: app, errors: [{ messageId: "segment" }] },
        ],
    })

    run("tag-name (package resolution)", tagName, {
        valid: [],
        invalid: [
            // The player package's package.json says namespace "player": its tags are elo-player-….
            { code: `<elo-topbar />`, filename: pkgFile("player"), settings: {}, errors: [{ messageId: "segment" }] },
            // Base package: sibling segments are discovered from the workspace's package.json files.
            { code: `<elo-gram-listcollection />`, filename: pkgFile("components"), settings: {}, errors: [{ messageId: "foreignSegment", data: { name: "elo-gram-listcollection", prefix: "elo", other: "gram" } }] },
        ],
    })
})

describe("libstylist/forward-props", () => {
    const F = `import { alert as cn } from "@x/css"\nimport { cx } from "@livesession/libstylist/runtime"\n`
    run("forward-props", forwardProps, {
        valid: [
            `${F}<elo-alert {...cx(cn.root, props)} role="status" />`,
            `${F}<button elo-button {...cx(cn.root, rest, { size })} type="button" />`,
            `${F}<Modal elo-modalconfirm {...cx(rest)} />`,
            `${F}<elo-alert {...cx(cn.root, props.inputCx)} />`,
            `${F}<elo-alert {...cx(cn.root, cx(rest))} />`,
            `import * as s from "@livesession/libstylist/runtime"\n<elo-alert {...s.cx(props)} />`,
            `import { cx as c } from "virtual:libstylist/runtime"\n<elo-alert {...c(props)} />`,
            // the whole props object handed on forwards the markers and parts too
            `function A({ ...rest }) { return <elo-alert {...rest} /> }`,
            `<Popover elo-tooltip {...props} />`,
            `<div role="status" />`,
            `<Modal title="x" />`,
            `<my-widget />`,
            { code: `<elo-alert />`, settings: { libstylist: {} } },
            // T7: the component's own props, as bound — a parameter, its rest, a slot it destructures, body
            // destructuring and const aliases of those, a .map callback closing over the rest
            `${F}function A(props: P) { return <elo-alert {...cx(cn.root, props)} /> }`,
            `${F}function A({ size, ...rest }: P) { return <elo-alert {...cx(cn.root, rest, { size })} /> }`,
            `${F}function A({ contentCx }: P) { return <RadixPopover.Content elo-popover-content {...cx(cn.content, contentCx)} /> }`,
            `${F}function A(props: P) { const { className: _c, ...rest } = props as React.HTMLAttributes<HTMLElement>; return <elo-alert {...cx(cn.root, rest)} /> }`,
            `${F}function A(props: P) { const forwarded = cx(props); return <elo-alert {...cx(cn.root, forwarded)} /> }`,
            `${F}function A({ items, ...rest }: P) { return items.map((i) => <elo-alert key={i} {...cx(cn.root, rest)} />) }`,
            `${F}const A = forwardRef<HTMLElement, P>(({ size, ...rest }, ref) => <elo-alert ref={ref} {...cx(cn.root, rest)} />)`,
            // the component wrappers' function is the component: memo, React.forwardRef, observer, Object.assign's root
            `${F}const A = memo((props: P) => <elo-alert {...cx(cn.root, props)} />)`,
            `${F}const A = React.forwardRef(function A(props: P, ref) { return <elo-alert ref={ref} {...cx(cn.root, props)} /> })`,
            `${F}const A = observer(({ ...rest }: P) => <elo-alert {...cx(cn.root, rest)} />)`,
            `${F}const A = Object.assign(((props: P) => <elo-alert {...cx(cn.root, props)} />) as Fc, { Item })`,
            // a local helper (no callback) receives what the component passes it
            `${F}function A(props: P) { const renderRoot = (p: P) => <elo-alert {...cx(cn.root, p)} />; return renderRoot(props) }`,
        ],
        invalid: [
            { code: `<elo-alert role="status" />`, errors: [{ messageId: "missing", data: { identity: "<elo-alert>", hint: "{...cx(cn.root, rest)}" } }] },
            { code: `<button elo-button type="button" />`, errors: [{ messageId: "missing", data: { identity: "<button elo-button>", hint: "{...cx(cn.root, rest)}" } }] },
            // T9: a delegate's message names the delegate form, not an own root part
            {
                code: `<Modal elo-modalconfirm title="x" />`,
                errors: [{ messageId: "missing", data: { identity: "<Modal elo-modalconfirm>", hint: "a delegate forwards the caller's parts with its marker: <Modal elo-modalconfirm {...cx(rest)}>" } }],
            },
            {
                code: `import { Modal } from "../Modal"\n<Modal elo-modalconfirm title="x" />`,
                errors: [{ messageId: "missing", data: { identity: "<Modal elo-modalconfirm>", hint: "a delegate forwards the caller's parts with its marker: <Modal elo-modalconfirm {...cx(rest)}>" } }],
            },
            // …and a member root on a third-party host, its bound part and slot
            {
                code: `${F}import * as RadixPopover from "@radix-ui/react-popover"\n<RadixPopover.Content elo-popover-content {...cx(cn.content)} />`,
                errors: [{ messageId: "missing", data: { identity: "<RadixPopover.Content elo-popover-content>", hint: "a member root carries its bound part and the slot that brings the caller's parts: {...cx(cn.root, contentCx)}" } }],
            },
            // …naming the slot the component destructures
            {
                code: `${F}import * as RadixPopover from "@radix-ui/react-popover"\nfunction Menu({ panelCx, ...rest }: P) { return <RadixPopover.Content elo-popover-content {...cx(cn.content, rest.x)} /> }`,
                errors: [{ messageId: "missing", data: { identity: "<RadixPopover.Content elo-popover-content>", hint: "a member root carries its bound part and the slot that brings the caller's parts: {...cx(cn.root, panelCx)}" } }],
            },
            // T7: another prop, an import, a `let` or an unrelated member is not the component's props
            { code: `${F}function Space({ gap, style, ...rest }: P) { return <elo-space {...cx(cn.root, style)} /> }`, errors: [{ messageId: "missing" }] },
            { code: `${F}import { rest } from "./shared"\n<elo-alert {...cx(cn.root, rest)} />`, errors: [{ messageId: "missing" }] },
            { code: `${F}function A(props: P) { let rest = props; return <elo-alert {...cx(cn.root, rest)} /> }`, errors: [{ messageId: "missing" }] },
            { code: `${F}function A(props: P) { return <elo-alert {...cx(cn.root, props.style)} /> }`, errors: [{ messageId: "missing" }] },
            { code: `${F}<elo-alert {...cx(cn.root, props.rootProps)} />`, errors: [{ messageId: "missing" }] },
            { code: `function A({ style }: P) { return <Popover elo-tooltip {...style} /> }`, errors: [{ messageId: "missing" }] },
            // a callback's parameter (or its pattern's rest) and a later parameter are not the component's props
            { code: `${F}function A({ items }: P) { return items.map((item) => <elo-alert key={item.id} {...cx(cn.root, item)} />) }`, errors: [{ messageId: "missing" }] },
            { code: `${F}function A({ items }: P) { return items.map(({ id, ...item }) => <elo-alert key={id} {...cx(cn.root, item)} />) }`, errors: [{ messageId: "missing" }] },
            { code: `${F}function A({ items }: P) { return items.map(function (item) { return <elo-alert {...cx(cn.root, item)} /> }) }`, errors: [{ messageId: "missing" }] },
            { code: `function A({ items }: P) { return items.map((item) => <Popover elo-tooltip {...item} />) }`, errors: [{ messageId: "missing" }] },
            { code: `${F}const A = forwardRef<HTMLElement, P>((props, ref) => <elo-alert {...cx(cn.root, ref)} />)`, errors: [{ messageId: "missing" }] },
            // only a wrapper's first argument is the component: memo's comparator is a callback
            {
                code: `${F}const A = memo((props: P) => <elo-alert {...cx(cn.root, props)} />, (prev: P) => !<elo-alert {...cx(cn.root, prev)} />)`,
                errors: [{ messageId: "missing" }],
            },
            // the cx() call carries parts and data but not the props
            { code: `${F}<elo-alert {...cx(cn.root, { open })} />`, errors: [{ messageId: "missing" }] },
            // a local object literal is no props object
            { code: `const extra = { role: "status" }\nconst el = <elo-alert {...extra} />`, errors: [{ messageId: "missing" }] },
            { code: `<elo-alert {...{ role: "status" }} />`, errors: [{ messageId: "missing" }] },
            // not the runtime cx
            { code: `import { cx } from "../utils/cx"\n<elo-alert {...cx(props)} />`, errors: [{ messageId: "missing" }] },
            { code: `<elo-alert {...(dev && { title: "x" })} {...null} />`, errors: [{ messageId: "missing" }] },
        ],
    })
})

describe("libstylist/no-dev-attrs", () => {
    run("no-dev-attrs", noDevAttrs, {
        valid: [
            `<div data-kind="primary" data-state="open" />`,
            `<div data-components="x" data-part-count={2} data-partial />`,
            `<div {...{ "data-kind": "x" }} />`,
            `el.querySelector("[data-kind=primary]")`,
            `el.querySelector("[data-partial]")`,
            `import x from "./[data-component].ts"`,
            `const cx = "_cxpart"`,
            `React.createElement("div", { "data-kind": "x" })`,
            `import { cx } from "@livesession/libstylist/runtime"\n<div {...cx({ kind: "x", components: 1, reactComponents: 2 })} />`,
        ],
        invalid: [
            { code: `<span _cxpart="icon" />`, output: `<span />`, errors: [{ messageId: "dev", data: { name: "_cxpart" } }] },
            {
                code: `<div data-react-component="Alert" data-file-source="x.tsx:1" role="status" />`,
                // Adjacent removals: one per fix pass (ESLint re-runs fixes until stable).
                output: `<div data-file-source="x.tsx:1" role="status" />`,
                errors: [{ messageId: "dev", data: { name: "data-react-component" } }, { messageId: "dev", data: { name: "data-file-source" } }],
            },
            { code: `<div\n    role="status"\n    data-file-source="x.tsx:1"\n/>`, output: `<div\n    role="status"\n/>`, errors: [{ messageId: "dev" }] },
            { code: `<div data-component="Tabs" />`, output: null, errors: [{ messageId: "removed", data: { name: "data-component" } }] },
            { code: `<div data-part="header" />`, output: null, errors: [{ messageId: "removed", data: { name: "data-part" } }] },
            { code: `<span _cxclass_elo-or4d4l="" />`, output: null, errors: [{ messageId: "part", data: { name: "_cxclass_elo-or4d4l" } }] },
            {
                code: `<div {...(dev && { _cxpart: "x", id: "a" })} />`,
                output: `<div {...(dev && { id: "a" })} />`,
                errors: [{ messageId: "dev" }],
            },
            {
                code: `<div {...{ id: "a", "data-file-source": "x" }} />`,
                output: `<div {...{ id: "a" }} />`,
                errors: [{ messageId: "dev" }],
            },
            { code: `const p = { "data-component": "X" }\nconst el = <div {...p} />`, output: null, errors: [{ messageId: "removed" }] },
            { code: `const p = { _cxpart: "x" }\nconst el = <div {...p} />`, output: null, errors: [{ messageId: "dev" }] },
            // One report per property, however many elements spread the object.
            { code: `const p = { _cxpart: "x" }\nconst a = <div {...p} />\nconst b = <span {...p} />`, output: null, errors: [{ messageId: "dev", line: 1 }] },
            // createElement props are the same attributes.
            { code: `React.createElement("div", { _cxpart: "x", id: "a" })`, output: `React.createElement("div", { id: "a" })`, errors: [{ messageId: "dev" }] },
            { code: `createElement(Tag, { "data-part": "x" })`, output: null, errors: [{ messageId: "removed", data: { name: "data-part" } }] },
            { code: `el.querySelector('[data-component="Tabs"]')`, errors: [{ messageId: "removedSelector", data: { name: "data-component" } }] },
            { code: `el.querySelectorAll("[data-part=header] > a")`, errors: [{ messageId: "removedSelector", data: { name: "data-part" } }] },
            { code: `document.querySelector("[_cxpart~=icon]")`, errors: [{ messageId: "devSelector", data: { name: "_cxpart" } }] },
            // cx() data-literal keys render data-<kebab(key)>: dev annotations and removed hooks are caught there too
            {
                code: `import { cx } from "@livesession/libstylist/runtime"\n<div {...cx({ fileSource: "x", component: "Tabs", "react-component": "A", part: "p" })} />`,
                output: null,
                errors: [
                    { messageId: "dev", data: { name: "data-file-source" } },
                    { messageId: "removed", data: { name: "data-component" } },
                    { messageId: "dev", data: { name: "data-react-component" } },
                    { messageId: "removed", data: { name: "data-part" } },
                ],
            },
            { code: "el.querySelector(`[data-react-component=\"${name}\"]`)", errors: [{ messageId: "devSelector", data: { name: "data-react-component" } }] },
        ],
    })
})
