// Render tests: libstylist Babel → esbuild (automatic JSX, CJS) → React 19 renderToStaticMarkup, with
// the part maps as the css package would export them.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"

import { transformSync } from "@babel/core"
import selectorParser from "postcss-selector-parser"
import { transformWithEsbuild } from "vite"

import { libstylistBabel, type LibstylistBabelOptions } from "../src/babel/index.js"
import { partAttr } from "../src/hash/index.js"
import * as runtime from "../src/runtime/index.js"

const require = createRequire(import.meta.url)
const React = require("react") as typeof import("react")
const jsxRuntime = require("react/jsx-runtime") as unknown
const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server")

type Exports = Record<string, React.ComponentType<Record<string, unknown>>>

const ROOT = "/repo"
const RUNTIME = "@livesession/libstylist/runtime"
const CSS = "@livesession/eloquentui-css"
const APP_CSS = "@web/css"

const part = (scope: string, p: string, prefix = "elo", namespace = "core"): string => partAttr({ prefix, namespace, scope, part: p })
const partMap = (scope: string, parts: string[], prefix = "elo", namespace = "core") => Object.fromEntries(parts.map((p) => [p, part(scope, p, prefix, namespace)]))

/** The part maps a css build exports (values are part attribute names). */
const MAPS = {
    [CSS]: {
        alert: partMap("alert", ["root", "icon", "content", "title"]),
        button: partMap("button", ["root", "content", "children"]),
        textInput: partMap("text-input", ["root", "input-wrapper", "input"]),
        copyButton: partMap("copy-button", ["root"]),
        filterEditor: partMap("filter-editor", ["search", "field"]),
    },
    [APP_CSS]: { page: partMap("page", ["banner"], "app", "web") },
}

/** Transforms a fixture with libstylist, compiles JSX with esbuild and evaluates it as CommonJS. */
async function compile(source: string, file: string, opts: LibstylistBabelOptions = {}, deps: Record<string, unknown> = {}): Promise<Exports> {
    const babel = transformSync(source, {
        filename: join(ROOT, file),
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["jsx", "typescript"] },
        plugins: [[libstylistBabel, { prefix: "elo", namespace: "core", sourceRoot: ROOT, dev: "runtime", ...opts }]],
    })
    assert.ok(babel?.code)
    const js = await transformWithEsbuild(babel.code, join(tmpdir(), "libstylist-fixture.tsx"), {
        loader: "tsx",
        jsx: "automatic",
        format: "cjs",
        target: "es2020",
        tsconfigRaw: {},
    })
    const mod = { exports: {} as Exports }
    const modules: Record<string, unknown> = { [RUNTIME]: runtime, react: React, "react/jsx-runtime": jsxRuntime, ...MAPS, ...deps }
    const req = (id: string) => {
        if (!(id in modules)) throw new Error(`fixture imports unknown module "${id}"`)
        return modules[id]
    }
    new Function("require", "module", "exports", js.code)(req, mod, mod.exports)
    return mod.exports
}

/** Renders under a NODE_ENV, failing on any React warning. */
function render(element: React.ReactElement, nodeEnv: "development" | "production" = "development"): string {
    const prevEnv = process.env.NODE_ENV
    const prevError = console.error
    const warnings: string[] = []
    console.error = (...args: unknown[]) => void warnings.push(args.map(String).join(" "))
    process.env.NODE_ENV = nodeEnv
    try {
        const html = renderToStaticMarkup(element)
        assert.deepEqual(warnings, [], "React warnings")
        return html
    } finally {
        if (prevEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = prevEnv
        console.error = prevError
    }
}

interface Tag {
    name: string
    attrs: Map<string, string>
}

/** Opening tags of serialized HTML with their attributes in order (enough for SSR output). */
function tags(html: string): Tag[] {
    const out: Tag[] = []
    for (const m of html.matchAll(/<([a-z][a-z0-9-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*\/?>/g)) {
        const attrs = new Map<string, string>()
        for (const a of m[2].matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) attrs.set(a[1], a[2] ?? "")
        out.push({ name: m[1], attrs })
    }
    return out
}

const tag = (html: string, name: string, index = 0): Tag => {
    const found = tags(html).filter((t) => t.name === name)[index]
    assert.ok(found, `<${name}> #${index} in ${html}`)
    return found
}

const DEV_ATTRS = ["_cxpart", "data-react-component", "data-file-source"]

const ALERT = `import * as React from "react"
import { alert as cn } from "${CSS}"
import { cx } from "${RUNTIME}"

export function Alert({ variant = "info", title, children, onClose, count, ...rest }: any) {
    const hasTitle = title != null
    return (
        <elo-alert {...cx(cn.root, rest, { variant, hasTitle, dismissible: onClose ? true : undefined, count, hidden: false, gone: null })} role="status" aria-busy={false}>
            <span {...cx(cn.icon)}>i</span>
            <span {...cx(cn.content)}>
                {hasTitle && <span {...cx(cn.title)}>{title}</span>}
                {children}
            </span>
        </elo-alert>
    )
}

export function Box(props: any) {
    return <elo-box {...cx(cn.icon)} {...props} data-static />
}
`

const BUTTON = `import * as React from "react"
import { button as cn } from "${CSS}"
import { cx } from "${RUNTIME}"

export const Button = React.forwardRef(function Button({ as: As = "button", loading, children, ...rest }: any, ref: any) {
    return (
        <As elo-button {...cx(cn.root, rest, { loading })} ref={ref} type={As === "button" ? "button" : undefined}>
            <div {...cx(cn.content)}><span {...cx(cn.children)}>{children}</span></div>
        </As>
    )
})
`

const TEXT_INPUT = `import { textInput as cn } from "${CSS}"
import { cx } from "${RUNTIME}"

export function TextInput({ inputCx, disabled, ...rest }: any) {
    return (
        <elo-textinput {...cx(cn.root, rest, { disabled })}>
            <div {...cx(cn["input-wrapper"])}>
                <input {...cx(cn.input, inputCx)} disabled={disabled} />
            </div>
        </elo-textinput>
    )
}
`

const [alert, button, input] = await Promise.all([
    compile(ALERT, "packages/components/src/Alert.tsx"),
    compile(BUTTON, "packages/components/src/Button.tsx"),
    compile(TEXT_INPUT, "packages/components/src/TextInput.tsx"),
])

describe("render (React 19)", () => {
    test("Alert: the root carries its part, forwarded props and data; no class anywhere", () => {
        const html = render(React.createElement(alert.Alert, { title: "T", onClose: () => {}, count: 0, children: "body" }))
        assert.ok(!/\sclass=/.test(html), html)
        const root = tag(html, "elo-alert")
        assert.equal(root.attrs.get(part("alert", "root")), "")
        assert.equal(root.attrs.get("data-has-title"), "true")
        assert.equal(root.attrs.get("data-dismissible"), "true")
        assert.equal(root.attrs.get("data-variant"), "info")
        assert.equal(root.attrs.get("data-count"), "0", "numbers render as strings, 0 included")
        assert.ok(!root.attrs.has("data-hidden") && !root.attrs.has("data-gone"), "false and null are omitted")
        assert.equal(root.attrs.get("aria-busy"), "false")
        assert.equal(tag(html, "span", 0).attrs.get(part("alert", "icon")), "")
        assert.equal(tag(html, "span", 1).attrs.get(part("alert", "content")), "")
        assert.equal(tag(html, "span", 2).attrs.get(part("alert", "title")), "")
        assert.ok(html.includes(`<elo-alert ${part("alert", "root")}=""`), "part attributes serialize value-less (empty)")

        const plain = tag(render(React.createElement(alert.Alert, { children: "body" })), "elo-alert")
        assert.ok(!plain.attrs.has("data-has-title") && !plain.attrs.has("data-dismissible") && !plain.attrs.has("data-count"))
    })

    test("dev attributes follow NODE_ENV at render time", () => {
        const el = React.createElement(alert.Alert, { title: "T", children: "x" })
        const dev = tag(render(el, "development"), "elo-alert")
        assert.equal(dev.attrs.get("_cxpart"), "root")
        assert.equal(dev.attrs.get("data-react-component"), "Alert")
        assert.equal(dev.attrs.get("data-file-source"), "packages/components/src/Alert.tsx:8")
        assert.equal(tag(render(el, "development"), "span").attrs.get("_cxpart"), "icon")

        const prod = render(el, "production")
        for (const a of DEV_ATTRS) assert.ok(!prod.includes(a), `${a} in production: ${prod}`)
        assert.equal(tag(prod, "elo-alert").attrs.get(part("alert", "root")), "")
    })

    test("custom-tag spreads still go through hostProps", () => {
        const html = render(React.createElement(alert.Box, { "data-open": true, "aria-hidden": true, "data-n": 2, title: "t" }))
        const box = tag(html, "elo-box")
        assert.equal(box.attrs.get("data-open"), "true")
        assert.equal(box.attrs.get("aria-hidden"), "true")
        assert.equal(box.attrs.get("data-n"), "2")
        assert.equal(box.attrs.get("data-static"), "true")
        assert.equal(box.attrs.get(part("alert", "icon")), "")
    })

    test("Button: polymorphic marker host; state travels as data, the part set never changes", () => {
        const html = render(React.createElement(button.Button, { children: "Save" }))
        const root = tag(html, "button")
        assert.equal(root.attrs.get("elo-button"), "")
        assert.equal(root.attrs.get(part("button", "root")), "")
        assert.ok(!root.attrs.has("data-loading"))
        assert.equal(root.attrs.get("type"), "button")
        assert.equal(root.attrs.get("_cxpart"), "root")
        assert.equal(root.attrs.get("data-react-component"), "Button")
        assert.equal(tag(html, "div").attrs.get(part("button", "content")), "")

        const loading = tag(render(React.createElement(button.Button, { as: "a", loading: true, children: "Go" })), "a")
        assert.equal(loading.attrs.get("elo-button"), "")
        assert.equal(loading.attrs.get(part("button", "root")), "")
        assert.equal(loading.attrs.get("data-loading"), "true")
        assert.equal(loading.attrs.get("_cxpart"), "root")
        assert.ok(!loading.attrs.has("type"))
    })

    test("a wrapper forwards its marker and its root part onto the delegate's identity element", async () => {
        const copy = await compile(
            `import { copyButton as cn } from "${CSS}"\nimport { cx } from "${RUNTIME}"\nimport { Button } from "./Button"\nexport function CopyButton(props: any) { return <Button elo-copybutton {...cx(cn.root, props)}>Copy</Button> }`,
            "packages/components/src/CopyButton.tsx",
            {},
            { "./Button": button },
        )
        const root = tag(render(React.createElement(copy.CopyButton, { "elo-toolbar-item": "" })), "button")
        assert.equal(root.attrs.get("elo-button"), "")
        assert.equal(root.attrs.get("elo-copybutton"), "")
        assert.equal(root.attrs.get("elo-toolbar-item"), "", "the caller's marker rides along")
        assert.equal(root.attrs.get(part("button", "root")), "")
        assert.equal(root.attrs.get(part("copy-button", "root")), "")
        assert.equal(root.attrs.get("data-react-component"), "Button", "the delegate's own dev spread comes last")
    })

    test("an app consumer's part lands on the DS root next to the DS root part", async () => {
        const app = await compile(
            `import { page } from "${APP_CSS}"\nimport { cx } from "${RUNTIME}"\nimport { Alert } from "@livesession/eloquentui-react"\nexport function Page() { return <Alert {...cx(page.banner)}>Hi</Alert> }`,
            "apps/web/src/Page.tsx",
            { prefix: "app", namespace: "web" },
            { "@livesession/eloquentui-react": alert },
        )
        const root = tag(render(React.createElement(app.Page), "production"), "elo-alert")
        assert.equal(root.attrs.get(part("alert", "root")), "")
        assert.equal(root.attrs.get(part("page", "banner", "app", "web")), "")
        assert.match(part("page", "banner", "app", "web"), /^_cxclass_app-/)
    })

    test("TextInput: a slot's parts reach the inner field; the caller's data stays with the caller's element", async () => {
        const editor = await compile(
            `import { filterEditor as cn } from "${CSS}"\nimport { cx } from "${RUNTIME}"\nimport { TextInput } from "./TextInput"\nexport function Editor({ wide }: any) { return <TextInput {...cx(cn.search)} inputCx={cx(cn.field, { wide })} disabled /> }`,
            "packages/infinity/src/Editor.tsx",
            {},
            { "./TextInput": input },
        )
        const html = render(React.createElement(editor.Editor, { wide: true }))
        const root = tag(html, "elo-textinput")
        assert.equal(root.attrs.get(part("text-input", "root")), "")
        assert.equal(root.attrs.get(part("filter-editor", "search")), "")
        assert.equal(root.attrs.get("data-disabled"), "true")
        assert.equal(tag(html, "div").attrs.get(part("text-input", "input-wrapper")), "")
        const field = tag(html, "input")
        assert.equal(field.attrs.get(part("text-input", "input")), "")
        assert.equal(field.attrs.get(part("filter-editor", "field")), "")
        assert.ok(!field.attrs.has("data-wide"), "a slot forwards parts, never data")
        assert.equal(field.attrs.get("disabled"), "")
        assert.ok(!/\sclass=/.test(html))
    })

    test("part attribute names are valid CSS attribute selectors", () => {
        for (const attr of [part("alert", "root"), part("text-input", "input-wrapper"), part("page", "banner", "app", "web")]) {
            const parsed = selectorParser().astSync(`[${attr}]`)
            const node = parsed.first.first
            assert.equal(node.type, "attribute")
            assert.equal((node as selectorParser.Attribute).attribute, attr)
        }
    })

    test("rendering restores NODE_ENV", () => {
        assert.notEqual(process.env.NODE_ENV, "production")
    })
})
