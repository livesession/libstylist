// libstylist inside a full Babel pipeline (preset-typescript + plugin-transform-react-jsx + modules-commonjs),
// the shape plugin-react/Storybook-style Babel setups use. The preset and plugins are not libstylist
// dependencies (a consumer brings its own Babel setup), so the package lists them as devDependencies.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { describe, test } from "node:test"

import { transformSync, type PluginItem } from "@babel/core"

import { libstylistBabel, type LibstylistBabelOptions } from "../src/babel/index.js"
import { partAttr } from "../src/hash/index.js"
import * as runtime from "../src/runtime/index.js"

const require = createRequire(import.meta.url)
const React = require("react") as typeof import("react")
const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server")

/** A Babel preset or plugin as its CommonJS module exports it (`exports.default`). */
function babelModule(name: string): PluginItem {
    const mod = require(name) as { default?: PluginItem } | PluginItem
    return (mod as { default?: PluginItem }).default ?? (mod as PluginItem)
}

const presetTs = babelModule("@babel/preset-typescript")
const reactJsx = babelModule("@babel/plugin-transform-react-jsx")
const commonjs = babelModule("@babel/plugin-transform-modules-commonjs")

const RUNTIME = "@livesession/libstylist/runtime"
const part = (scope: string, p: string) => partAttr({ prefix: "elo", namespace: "core", scope, part: p })

type Exports = Record<string, React.ComponentType<Record<string, unknown>>>

function compile(source: string, opts: LibstylistBabelOptions = {}): { code: string; exports: Exports } {
    const out = transformSync(source, {
        filename: "/repo/packages/components/src/Alert.tsx",
        babelrc: false,
        configFile: false,
        plugins: [
            [libstylistBabel, { prefix: "elo", namespace: "core", sourceRoot: "/repo", dev: "runtime", ...opts }],
            [reactJsx, { runtime: "automatic" }],
            commonjs,
        ],
        presets: [[presetTs, { isTSX: true, allExtensions: true }]],
    })
    assert.ok(out?.code)
    const mod = { exports: {} as Exports }
    const modules: Record<string, unknown> = {
        [RUNTIME]: runtime,
        react: React,
        "react/jsx-runtime": require("react/jsx-runtime"),
        "@livesession/eloquentui-css": { alert: { root: part("alert", "root"), icon: part("alert", "icon") } },
    }
    const req = (id: string) => {
        if (!(id in modules)) throw new Error(`fixture imports unknown module "${id}"`)
        return modules[id]
    }
    new Function("require", "module", "exports", out.code)(req, mod, mod.exports)
    return { code: out.code, exports: mod.exports }
}

function render(el: React.ReactElement, nodeEnv: "development" | "production"): string {
    const prev = process.env.NODE_ENV
    const prevError = console.error
    const warnings: string[] = []
    console.error = (...args: unknown[]) => void warnings.push(args.map(String).join(" "))
    process.env.NODE_ENV = nodeEnv
    try {
        const html = renderToStaticMarkup(el)
        assert.deepEqual(warnings, [])
        return html
    } finally {
        if (prev === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = prev
        console.error = prevError
    }
}

describe("libstylist in a preset-typescript + react-jsx pipeline", () => {
    const SOURCE = `import type { ReactNode } from "react"
import { alert as cn } from "@livesession/eloquentui-css"
import { cx } from "${RUNTIME}"

interface Props { open?: boolean; label?: string; children?: ReactNode }

export function Alert({ open, label, children, ...rest }: Props) {
    return (
        <elo-alert {...cx(cn.root, rest, { open })} aria-label={label as string} aria-hidden={open}>
            <span {...cx(cn.icon)}>{children}</span>
        </elo-alert>
    )
}
`

    test("helper imports survive TypeScript import elision (injected into the author's import), type imports go", () => {
        const { code } = compile(SOURCE)
        assert.ok(!/require\("react"\)/.test(code), "the type-only react import is elided")
        assert.match(code, /require\("@livesession\/libstylist\/runtime"\)/)
        assert.match(code, /require\("@livesession\/eloquentui-css"\)/, "the part map is a value import")
        assert.match(code, /\bcxData\b/)
        assert.match(code, /\bcxAttr\b/)
        assert.equal(code.split('require("@livesession/libstylist/runtime")').length - 1, 1, "one runtime import")
    })

    test("renders parts, data, custom-tag booleans and NODE_ENV-guarded dev attributes", () => {
        const { exports } = compile(SOURCE)
        const dev = render(React.createElement(exports.Alert, { open: true, label: "L", children: "x", "elo-wrapper": "" }), "development")
        assert.ok(dev.startsWith(`<elo-alert ${part("alert", "root")}="" elo-wrapper="" data-open="true" aria-label="L" aria-hidden="true"`), dev)
        assert.ok(dev.includes(`_cxpart="root"`) && dev.includes(`data-react-component="Alert"`), dev)
        assert.ok(dev.includes(`<span ${part("alert", "icon")}="" _cxpart="icon"`), dev)
        const prod = render(React.createElement(exports.Alert, { children: "x" }), "production")
        assert.equal(prod, `<elo-alert ${part("alert", "root")}=""><span ${part("alert", "icon")}="">x</span></elo-alert>`)
    })
})
