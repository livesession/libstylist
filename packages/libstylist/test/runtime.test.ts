// The runtime cx() (SPEC §6): parts, forwarding, falsy arguments, branded data literals and the
// development warning for a data literal compiled without the plugin.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

import ts from "typescript"

import { cx, cxAttr, cxData, hostProps, legacy, legacyClassName, unsetRef, withoutStylist } from "../src/runtime/index.js"
import * as runtime from "../src/runtime/index.js"

const A = "_cxclass_elo-aaaaaa"
const B = "_cxclass_elo-bbbbbb"

/** A fresh copy of the runtime module (its warn-once state starts over). */
let copies = 0
const freshRuntime = async (): Promise<typeof runtime> => (await import(`../src/runtime/index.ts?copy=${++copies}`)) as typeof runtime

/** Runs `fn` under NODE_ENV, collecting console.warn calls. */
async function withWarnings<T>(nodeEnv: string, fn: () => T | Promise<T>): Promise<{ result: T; warnings: string[] }> {
    const prevEnv = process.env.NODE_ENV
    const prevWarn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "))
    process.env.NODE_ENV = nodeEnv
    try {
        return { result: await fn(), warnings }
    } finally {
        console.warn = prevWarn
        if (prevEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = prevEnv
    }
}

describe("cx(): parts and forwarding", () => {
    test("a string argument is a part attribute", () => {
        assert.deepEqual(cx(A, B), { [A]: "", [B]: "" })
        assert.deepEqual(cx(A, A), { [A]: "" })
    })

    test("undefined, null and false add nothing (an unset slot or rest)", () => {
        assert.deepEqual(cx(A, undefined, null, false, B), { [A]: "", [B]: "" })
        assert.deepEqual(cx(), {})
        assert.deepEqual(cx(undefined), {})
    })

    test("an object argument contributes exactly its markers and part attributes whose value is \"\"", () => {
        const props = {
            "elo-modalconfirm": "",
            "_cxclass_app-k2m9qa": "",
            "data-kind": "",
            "aria-label": "",
            "elo-x": "nope",
            title: "t",
            children: 1,
            onClick: () => {},
        }
        assert.deepEqual(cx(A, props), { [A]: "", "elo-modalconfirm": "", "_cxclass_app-k2m9qa": "" })
    })

    test("another cx() result forwards its parts and markers but never its data", () => {
        const inner = cx(B, { "elo-tooltip": "" }, cxData({ open: true }))
        assert.deepEqual(inner, { [B]: "", "elo-tooltip": "", "data-open": "true" })
        assert.deepEqual(cx(A, inner), { [A]: "", [B]: "", "elo-tooltip": "" })
    })

    test("returns a fresh object; argument order does not change the attribute set", () => {
        const slot = cx(B)
        const out = cx(A, slot)
        assert.notEqual(out, slot)
        assert.deepEqual(Object.keys(cx(A, slot, cxData({ size: "s" }))).sort(), Object.keys(cx(cxData({ size: "s" }), slot, A)).sort())
    })
})

describe("cx(): data literals", () => {
    test("each key renders data-<kebab(key)>, camelCase like element.dataset", () => {
        assert.deepEqual(cx(cxData({ hasTitle: true, size: "small", menuOpen: "yes" })), { "data-has-title": "true", "data-size": "small", "data-menu-open": "yes" })
    })

    test("quoted kebab keys are written as they are", () => {
        assert.deepEqual(cx(cxData({ "has-title": true, "row-id": "r1" })), { "data-has-title": "true", "data-row-id": "r1" })
    })

    test("values: string as is, number → String(n), true → \"true\", false/null/undefined → omitted", () => {
        assert.deepEqual(cx(cxData({ a: "x", b: "", c: 0, d: 2.5, e: true, f: false, g: null, h: undefined })), { "data-a": "x", "data-b": "", "data-c": "0", "data-d": "2.5", "data-e": "true" })
    })

    test("a spread inside the literal contributes its keys (the literal is evaluated before branding)", () => {
        const state = { open: true, disabled: false }
        assert.deepEqual(cx(A, cxData({ ...state, size: "m" })), { [A]: "", "data-open": "true", "data-size": "m" })
    })

    test("a branded literal renders data; the same object unbranded is forwarded as props (renders nothing)", () => {
        const literal = { open: true, "elo-x": "" }
        assert.deepEqual(cx(cxData(literal)), { "data-open": "true", "data-elo-x": "" })
        assert.deepEqual(cx(literal), { "elo-x": "" })
    })

    test("parts, forwarded props and data in one call — the shape of an identity element", () => {
        const rest = { "elo-modalconfirm": "", [B]: "", id: "x" }
        assert.deepEqual(cx(A, rest, cxData({ variant: "info", hasTitle: false })), { [A]: "", "elo-modalconfirm": "", [B]: "", "data-variant": "info" })
    })
})

describe("cx(): the development warning for an unbranded data literal", () => {
    test("warns once for a plain object of primitives with no forwardable key", async () => {
        const rt = await freshRuntime()
        const { result, warnings } = await withWarnings("development", () => [rt.cx({ open: true, size: "s" }), rt.cx({ open: false })])
        assert.deepEqual(result, [{}, {}])
        assert.equal(warnings.length, 1)
        assert.match(warnings[0], /compiled without the libstylist Babel\/Vite plugin/)
        assert.match(warnings[0], /open, size/)
    })

    test("silent in production", async () => {
        const rt = await freshRuntime()
        const { warnings } = await withWarnings("production", () => rt.cx({ open: true }))
        assert.deepEqual(warnings, [])
    })

    test("silent for props: an object with a forwardable key, a non-primitive value, a class instance, or no keys", async () => {
        const rt = await freshRuntime()
        class Props {
            open = true
        }
        const { warnings } = await withWarnings("development", () => {
            rt.cx({ "elo-x": "", open: true })
            rt.cx({ "_cxclass_elo-aaaaaa": "", open: true })
            rt.cx({ open: true, onClick: () => {} })
            rt.cx({ open: true, style: { color: "red" } })
            rt.cx(new Props())
            rt.cx({})
        })
        assert.deepEqual(warnings, [])
    })

    // T8: a key counts as forwardable only when addForwarded would forward it — a part or a non-data/aria
    // marker valued "" — so a quoted kebab data key ("row-id": "5") no longer passes as a marker
    test("warns for quoted kebab keys and data-/aria- keys: only a forwardable key (valued \"\") marks props", async () => {
        const kebab = await freshRuntime()
        const { result, warnings } = await withWarnings("development", () => kebab.cx("_cxclass_elo-x", { "row-id": "5", "has-title": true }))
        assert.deepEqual(result, { "_cxclass_elo-x": "" })
        assert.equal(warnings.length, 1, "a quoted kebab data literal compiled without the plugin")
        assert.match(warnings[0], /row-id, has-title/)
        for (const obj of [{ open: true, "aria-label": "x" }, { "data-x": "", open: true }, { "elo-x": "y" }]) {
            const rt = await freshRuntime()
            const { warnings: w } = await withWarnings("development", () => rt.cx(obj))
            assert.equal(w.length, 1, JSON.stringify(obj))
        }
    })

    // T8: a plugin-compiled module marks its runtime copy when it loads — before any cx() call — so a
    // compiled component whose rest holds only primitives (`{ id, title }`) never trips the heuristic
    test("silent once a plugin-compiled module was loaded (cxCompiled), even before any branded literal", async () => {
        const rt = await freshRuntime()
        const { result, warnings } = await withWarnings("development", () => {
            rt.cxCompiled()
            return rt.cx("_cxclass_elo-x", { id: "s1", title: "t" })
        })
        assert.deepEqual(result, { "_cxclass_elo-x": "" })
        assert.deepEqual(warnings, [])
    })

    // app-1: in a browser bundle `process` doesn't exist (Vite replaces `process.env.NODE_ENV`, never
    // `typeof process`): the warning must still fire there, and only a production NODE_ENV silences it
    test("warns where no `process` global exists (a browser), unless the bundler made NODE_ENV production", async () => {
        const src = readFileSync(fileURLToPath(new URL("../src/runtime/index.ts", import.meta.url)), "utf8")
        const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
        const load = (code: string) => {
            const warnings: string[] = []
            const sandbox = { exports: {} as Record<string, (...a: unknown[]) => unknown>, console: { warn: (...a: unknown[]) => void warnings.push(a.map(String).join(" ")) } }
            const context = vm.createContext(sandbox)
            vm.runInContext(code, context)
            assert.equal(vm.runInContext("typeof process", context), "undefined")
            return { call: () => vm.runInContext(`exports.cx({ size: "large" })`, context) as object, warnings }
        }
        const browser = load(js)
        // the argument is built inside the sandbox: a plain object of that realm
        assert.equal(JSON.stringify(browser.call()), "{}")
        assert.equal(browser.warnings.length, 1, "the browser gets the warning")
        // what a production bundler leaves: `process.env.NODE_ENV` replaced by "production"
        const prod = load(js.replace(/process\.env\.NODE_ENV/g, '"production"'))
        prod.call()
        assert.deepEqual(prod.warnings, [])
    })

    test("silent once a branded literal was seen: the bundle was compiled by the plugin", async () => {
        const rt = await freshRuntime()
        const { warnings } = await withWarnings("development", () => {
            rt.cx(rt.cxData({ open: true }))
            rt.cx({ id: "only-primitives" })
        })
        assert.deepEqual(warnings, [])
    })

    test("branded literals from another copy of the runtime still render as data (Symbol.for brand)", async () => {
        const other = await freshRuntime()
        assert.deepEqual(cx(other.cxData({ open: true })), { "data-open": "true" })
    })
})

describe("the other runtime helpers", () => {
    test("cxAttr and hostProps normalize boolean true on custom tags", () => {
        assert.equal(cxAttr(true), "true")
        assert.equal(cxAttr(false), false)
        assert.equal(cxAttr(undefined), undefined)
        assert.equal(cxAttr("x"), "x")
        assert.deepEqual(hostProps({ "data-open": true, "aria-hidden": true, onClick: 1, "data-x": "y", hidden: true }), { "data-open": "true", "aria-hidden": "true", onClick: 1, "data-x": "y", hidden: true })
        assert.deepEqual(hostProps(null), {})
    })

    test("legacy helpers pass through", () => {
        assert.equal(legacy("a", false, "b"), "a b")
        assert.equal(legacy(false), undefined)
        assert.equal(legacyClassName("x"), "x")
        assert.equal(legacyClassName(""), undefined)
    })

    test("unsetRef is stable per set of unset names and undefined while everything is set", () => {
        assert.equal(unsetRef({ title: "t" }), undefined)
        assert.equal(unsetRef({ title: undefined }), unsetRef({ title: null }))
    })

    test("withoutStylist drops exactly what cx() forwards (parts and markers) and keeps the rest", () => {
        const props = { [A]: "", "elo-modalconfirm": "", "data-open": "", "aria-label": "x", id: "i", value: "v", onChange: () => {} }
        const out = withoutStylist(props)
        assert.deepEqual(Object.keys(out).sort(), ["aria-label", "data-open", "id", "onChange", "value"])
        assert.equal(out.onChange, props.onChange)
        assert.notEqual(out, props)
        // a marker or part with a non-empty value is not forwarded by cx(), so it stays
        const onClick = (): void => {}
        assert.deepEqual(withoutStylist({ [B]: "x", onClick }), { [B]: "x", onClick })
    })

    test("forwardStylist and cxParts are gone from the public runtime", () => {
        assert.ok(!("forwardStylist" in runtime))
        assert.ok(!("cxParts" in runtime))
    })
})
