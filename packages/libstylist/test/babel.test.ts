// The Babel transform (SPEC §5): data-literal branding of runtime cx() calls, markers, custom-tag
// hosts, dev annotations, the removed syntax, runtime imports and package configuration.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"

import { parseSync, transformSync, type types as t } from "@babel/core"
import { transformWithEsbuild } from "vite"

import libstylistBabel, { libstylistBabel as named, type LibstylistBabelOptions, type LibstylistFileMetadata, type StylistPartRegistry } from "../src/babel/index.js"
import { clearConventionsCache } from "../src/conventions/index.js"
import { partAttr } from "../src/hash/index.js"

const FILE = "/repo/packages/components/src/components/Alert/Alert.tsx"
const BASE: LibstylistBabelOptions = { prefix: "elo", namespace: "core", sourceRoot: "/repo", dev: false }
const RT = `import { cx } from "@livesession/libstylist/runtime"\n`
const MAPS = `import { alert as cn, textInput } from "@livesession/eloquentui-css"\nimport { playerControls } from "@livesession/eloquentui-css/player"\n`

const a = (scope: string, part: string, namespace = "core"): string => partAttr({ prefix: "elo", namespace, scope, part })
const REGISTRY: StylistPartRegistry = {
    scopes: {
        alert: { namespace: "core", group: "components", parts: { root: a("alert", "root"), icon: a("alert", "icon"), title: a("alert", "title"), "group-label": a("alert", "group-label") } },
        "text-input": { namespace: "core", group: "components", parts: { root: a("text-input", "root"), field: a("text-input", "field") } },
        "player-controls": { namespace: "player", group: "player", parts: { button: a("player-controls", "button", "player") } },
    },
}

function transform(code: string, opts: LibstylistBabelOptions = {}, filename: string = FILE) {
    const out = transformSync(code, {
        filename,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["jsx", "typescript"] },
        plugins: [[libstylistBabel, { ...BASE, ...opts }]],
    })
    assert.ok(out && typeof out.code === "string")
    return { code: out.code, meta: (out.metadata as { libstylist?: LibstylistFileMetadata }).libstylist }
}

const run = (code: string, opts: LibstylistBabelOptions = {}, filename?: string): string => transform(code, opts, filename).code
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

/** The attributes of the first JSX opening element in `code`, as JSX itself reads them. */
function firstElementAttrs(code: string): Map<string, string | null> {
    const ast = parseSync(code, { filename: "out.tsx", babelrc: false, configFile: false, parserOpts: { plugins: ["jsx", "typescript"] } })
    assert.ok(ast)
    let found: t.JSXOpeningElement | null = null
    const visit = (node: unknown): void => {
        if (found || !node || typeof node !== "object") return
        if ((node as { type?: string }).type === "JSXOpeningElement") {
            found = node as t.JSXOpeningElement
            return
        }
        for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(visit) : visit(value)
    }
    visit(ast.program)
    assert.ok(found, code)
    const attrs = new Map<string, string | null>()
    for (const attr of (found as t.JSXOpeningElement).attributes) {
        if (attr.type !== "JSXAttribute" || attr.name.type !== "JSXIdentifier") continue
        const v = attr.value
        if (!v) attrs.set(attr.name.name, null)
        else if (v.type === "StringLiteral") attrs.set(attr.name.name, v.value)
        else if (v.type === "JSXExpressionContainer" && v.expression.type === "StringLiteral") attrs.set(attr.name.name, v.expression.value)
        else attrs.set(attr.name.name, `<${v.type}>`)
    }
    return attrs
}

describe("data literals of runtime cx() calls are branded", () => {
    test("every inline object-literal argument is wrapped in cxData, in any position", () => {
        const out = run(`${RT}${MAPS}const el = <elo-alert {...cx(cn.root, rest, { variant, hasTitle })}><span {...cx({ open })} /><i {...cx(cn.icon, { size }, inputCx)} /></elo-alert>`)
        assert.ok(out.includes(`import { cx, cxData, cxCompiled } from "@livesession/libstylist/runtime";`), out)
        assert.ok(out.includes(`{...cx(cn.root, rest, cxData({\n  variant,\n  hasTitle\n}))}`), out)
        assert.match(out, /\{\.\.\.cx\(cxData\(\{\s*open\s*\}\)\)\}/)
        assert.match(out, /\{\.\.\.cx\(cn\.icon, cxData\(\{\s*size\s*\}\), inputCx\)\}/)
        assert.equal(count(out, "cxData("), 3)
    })

    test("literals with spreads, quoted kebab keys and TS wrappers are branded whole", () => {
        const out = run(`${RT}const x = cx({ ...state, "row-id": id } as const)`)
        assert.ok(/cx\(cxData\(\{\s*\.\.\.state,\s*"row-id": id\s*\} as const\)\)/.test(out), out)
    })

    test("calls anywhere: slot values, nested calls, variables, non-JSX files", () => {
        const out = run(`${RT}const slot = cx(cn.field, { wide })\nconst el = <TextInput inputCx={cx(cn.field, cx(cn.icon, { deep }))} />`)
        assert.equal(count(out, "cxData("), 2, out)
        assert.ok(out.includes(`const slot = cx(cn.field, cxData({`), out)
        assert.ok(out.includes(`cx(cn.icon, cxData({`), out)
        const ts = transformSync(`import { cx } from "@livesession/libstylist/runtime"\nexport const attrs = cx({ open: true })`, {
            filename: "/repo/packages/components/src/attrs.ts",
            babelrc: false,
            configFile: false,
            parserOpts: { plugins: ["typescript"] },
            plugins: [[libstylistBabel, BASE]],
        })
        assert.ok(ts?.code?.includes("cx(cxData({"), ts?.code ?? "")
    })

    test("aliased, namespace and virtual-module imports of cx are recognized", () => {
        assert.ok(run(`import { cx as c } from "@livesession/libstylist/runtime"\nconst x = c({ a })`).includes("c(cxData({"))
        assert.ok(run(`import * as rt from "@livesession/libstylist/runtime"\nconst x = rt.cx({ a })`).includes("rt.cx(cxData({"))
        assert.ok(run(`import { cx } from "virtual:libstylist/runtime"\nconst x = cx({ a })`).includes("cx(cxData({"))
        assert.ok(run(`import { cx } from "~stylist"\nconst x = cx({ a })`, { runtimeModule: "~stylist" }).includes("cx(cxData({"))
    })

    test("only runtime cx() literals: not other functions named cx, not identifiers or members", () => {
        const local = `function cx(...a) { return a }\nconst x = cx({ a }, rest)`
        assert.ok(!run(local).includes("cxData"), "a local cx")
        assert.ok(!run(`import { cx } from "../utils/cx"\nconst x = cx({ a })`).includes("cxData"), "another module's cx")
        assert.ok(!run(`${RT}function f(cx) { return cx({ a }) }`).includes("cxData"), "a shadowing parameter")
        const out = run(`${RT}const x = cx(rest, props.inputCx, state, f({ a }), [{ b }])`)
        assert.ok(!out.includes("cxData"), out)
        assert.ok(!run(`${RT}const x = other({ a }, cx)`).includes("cxData"), "cx passed as a value")
    })

    test("idempotent: branded literals are not branded again", () => {
        const once = run(`${RT}const x = cx(cn.a, { open })`)
        assert.equal(run(once), once)
        assert.equal(count(once, "cxData("), 1)
    })

    test("an author import of cxData is reused; a taken name gets a collision-free local", () => {
        const reused = run(`import { cx, cxData as brand } from "@livesession/libstylist/runtime"\nconst x = cx({ a })`)
        assert.ok(reused.includes("cx(brand({"), reused)
        assert.equal(count(reused, "import"), 1)
        const taken = run(`${RT}const cxData = 1\nconst x = cx({ a })`)
        assert.ok(taken.includes(`import { cx, cxData as _cxData, cxCompiled } from "@livesession/libstylist/runtime";`), taken)
        assert.ok(taken.includes("cx(_cxData({"), taken)
    })

    test("files outside every libstylist package are branded too (the runtime needs it)", () => {
        const dir = mkdtempSync(join(tmpdir(), "libstylist-plain-"))
        try {
            writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "plain" }))
            clearConventionsCache()
            const { code, meta } = transform(`${RT}const el = <elo-alert {...rest} {...cx({ open })} />`, { prefix: undefined, namespace: undefined }, join(dir, "x.tsx"))
            assert.ok(code.includes("cx(cxData({"), code)
            assert.ok(!code.includes("hostProps"), "no host adaptation outside a package")
            assert.equal(meta?.dataLiterals, 1)
        } finally {
            rmSync(dir, { recursive: true, force: true })
            clearConventionsCache()
        }
    })

    test("metadata counts branded literals and helpers", () => {
        const { meta } = transform(`${RT}const el = <elo-a {...r} {...cx({ a }, { b })} />`)
        assert.deepEqual(meta, { changed: true, dataLiterals: 2, helpers: ["cxData", "hostProps", "cxCompiled"] })
        assert.deepEqual(transform(`const el = <div />`).meta, { changed: false, dataLiterals: 0, helpers: [] })
    })
})

// T8: a module with runtime cx() calls tells its copy of the runtime it was compiled — at load, before any
// render — so the development heuristic for unbranded data literals never fires on a props object of
// primitives in plugin-compiled code (a component whose identity call has no data literal)
describe("the compiled-module mark", () => {
    test("one top-level cxCompiled() per module with a runtime cx() call, after the imports, guarded in runtime dev mode", () => {
        const guarded = run(`${RT}${MAPS}export function Space({ gap, ...rest }) { return <elo-space {...cx(cn.root, rest)}>{gap}</elo-space> }`, { dev: "runtime" })
        assert.equal(count(guarded, "cxCompiled()"), 1, guarded)
        assert.ok(guarded.includes(`import { cx, cxCompiled } from "@livesession/libstylist/runtime";`), guarded)
        assert.match(guarded, /\nprocess\.env\.NODE_ENV !== "production" && cxCompiled\(\);\nexport function Space/)
        const plain = run(`${RT}const x = cx({ a })`, { dev: true })
        assert.match(plain, /\ncxCompiled\(\);\nconst x = cx\(cxData/)
    })

    test("idempotent, and absent from modules without a runtime cx() call", () => {
        const once = run(`${RT}const x = cx({ a })`, { dev: "runtime" })
        assert.equal(run(once, { dev: "runtime" }), once)
        assert.equal(count(once, "cxCompiled()"), 1)
        assert.ok(!run(`${RT}const el = <div />`).includes("cxCompiled"))
        assert.ok(!run(`import { cx } from "../utils/cx"\nconst x = cx("a")`).includes("cxCompiled"))
    })

    test("a compiled module loaded by a runtime copy silences the heuristic for primitive props; an uncompiled one still warns", async () => {
        const js = transformSync(`${RT}export const render = (rest) => cx("_cxclass_elo-x", rest)`, {
            filename: FILE,
            babelrc: false,
            configFile: false,
            parserOpts: { plugins: ["jsx", "typescript"] },
            plugins: [[libstylistBabel, { ...BASE, dev: true }]],
        })?.code as string
        const rt = await import(`../src/runtime/index.ts?compiled-mark=${Date.now()}`)
        const warnings: string[] = []
        const prevWarn = console.warn
        const prevEnv = process.env.NODE_ENV
        console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "))
        process.env.NODE_ENV = "development"
        try {
            // evaluate the compiled module against that runtime copy: its top-level mark runs first
            const body = js.replace(/^import \{([^}]*)\} from "@livesession\/libstylist\/runtime";\n/m, "const {$1} = rt;\n").replace("export const render =", "return")
            const render = new Function("rt", body)(rt) as (p: object) => object
            assert.deepEqual(render({ id: "s1", title: "t" }), { "_cxclass_elo-x": "" })
            assert.deepEqual(warnings, [])
        } finally {
            console.warn = prevWarn
            if (prevEnv === undefined) delete process.env.NODE_ENV
            else process.env.NODE_ENV = prevEnv
        }
    })
})

describe("the removed source API fails the build", () => {
    test("a cx attribute is an error with the new form in the message", () => {
        assert.throws(() => run(`const el = <span cx="icon" />`), /the cx attribute was removed — spread a cx\(\) call instead[\s\S]*\{\.\.\.cx\(cn\.icon\)\}/)
        assert.throws(() => run(`const el = <Icon cx={["a"]} />`), /cx attribute was removed/)
    })

    test("SVG geometry keeps its cx", () => {
        const src = `const el = <svg><circle cx={5} cy={5} r={2} /><ellipse cx="5" /><radialGradient cx="50%" /><motion.circle cx={1} /></svg>;`
        assert.equal(run(src), src)
    })

    test("a part-list string in a named slot is an error; a cx() value is fine", () => {
        assert.throws(() => run(`const el = <TextInput inputCx="field" />`), /named slot inputCx takes a cx\(\) value/)
        assert.throws(() => run(`const el = <TextInput inputCx={["field", on && "wide"]} />`), /named slot inputCx/)
        assert.ok(run(`${RT}const el = <TextInput inputCx={cx(cn.field)} contentCx={contentCx} />`).includes("inputCx={cx(cn.field)}"))
    })
})

describe("markers", () => {
    test("value-less markers are normalized to an empty string on hosts and components", () => {
        assert.ok(run(`const el = <button elo-button type="button" />`).includes(`<button elo-button="" type="button" />`))
        assert.ok(run(`const el = <As elo-button />`).includes(`<As elo-button="" />`))
        assert.ok(run(`const el = <Modal elo-modalconfirm="" />`).includes(`<Modal elo-modalconfirm="" />`))
        assert.ok(run(`const el = <button app-button elo-x="1" />`).includes(`<button app-button elo-x="1" />`))
    })

    test("markers on generic tags are an error unless the file documents a native root", () => {
        assert.throws(() => run(`const el = <div elo-popover-content />`), /marker "elo-popover-content" on <div>[\s\S]*custom tag <elo-popover-content>/)
        assert.throws(() => run(`const el = <span elo-x />`), /on <span>/)
        const ok = run(`/**\n * @libstylistRoot native Radix owns this host and prints boolean aria on custom tags\n */\nconst el = <div elo-popover-content />`)
        assert.ok(ok.includes(`<div elo-popover-content="" />`), ok)
    })
})

describe("custom-tag hosts", () => {
    test("spreads go through hostProps, booleans become strings, expressions go through cxAttr", () => {
        const out = run(
            `const el = <elo-alert {...rest} data-a data-b={true} data-c={false} data-d={flag} aria-e={x || undefined} data-f="s" data-g={1} data-h={\`t\`} data-i={null} data-j={undefined} role={role} title={t} />`,
        )
        assert.ok(
            out.includes(
                `<elo-alert {...hostProps(rest)} data-a="true" data-b="true" data-c="false" data-d={cxAttr(flag)} aria-e={cxAttr(x || undefined)} data-f="s" data-g={1} data-h={\`t\`} data-i={null} data-j={undefined} role={role} title={t} />`,
            ),
            out,
        )
    })

    test("a cx() spread is string-only: never wrapped; native hosts are untouched", () => {
        const out = run(`import { cx, hostProps } from "@livesession/libstylist/runtime"\nconst el = <elo-alert {...cx(cn.root, rest, { open })} {...hostProps(x)} />`)
        assert.ok(out.includes(`<elo-alert {...cx(cn.root, rest, cxData({`), out)
        assert.equal(count(out, "hostProps("), 1, "the author's hostProps call is not re-wrapped")
        const native = `const el = <div {...rest} data-a data-b={flag} />;`
        assert.equal(run(native), native)
        assert.ok(run(`const el = <x-widget {...rest} data-on={on} />`).includes(`<x-widget {...hostProps(rest)} data-on={cxAttr(on)} />`))
    })

    test("a cx() imported under another name is still recognized as string-only", () => {
        const out = run(`import { cx as c } from "@livesession/libstylist/runtime"\nconst el = <elo-alert {...c(cn.root, rest)} />`)
        assert.ok(out.includes(`<elo-alert {...c(cn.root, rest)} />`), out)
    })
})

describe("dev annotations", () => {
    const src = `${RT}${MAPS}
export function Alert({ open, ...rest }) {
    return (
        <elo-alert {...cx(cn.root, rest)}>
            <span {...cx(cn.icon, playerControls.button, { open })} />
            <button elo-button />
            <span {...cx({ open })} />
            <span data-plain />
            <b {...cx(cn["group-label"], cx(cn.title, textInput.field))} />
        </elo-alert>
    )
}`
    test('"runtime" appends one guarded spread last, labels read from the part-map members', () => {
        const out = run(src, { dev: "runtime", registry: REGISTRY })
        assert.ok(
            out.includes(`<elo-alert {...cx(cn.root, rest)} {...process.env.NODE_ENV !== "production" && {
    _cxpart: "root",
    "data-react-component": "Alert",
    "data-file-source": "packages/components/src/components/Alert/Alert.tsx:7"
  }}>`),
            out,
        )
        assert.ok(out.includes(`_cxpart: "icon player-controls:button",\n      "data-file-source": "packages/components/src/components/Alert/Alert.tsx:8"`), out)
        assert.ok(out.includes(`<button elo-button="" {...process.env.NODE_ENV !== "production" && {\n      "data-react-component": "Alert",\n      "data-file-source": "packages/components/src/components/Alert/Alert.tsx:9"`), out)
        assert.match(out, /\{\.\.\.cx\(cxData\(\{\s*open\s*\}\)\)\} \{\.\.\.process\.env\.NODE_ENV !== "production" && \{\s*"data-file-source": "packages\/components\/src\/components\/Alert\/Alert\.tsx:10"\s*\}\}/, "a data-only cx() gets a file source but no label")
        assert.ok(out.includes(`<span data-plain />`), "plain elements get nothing")
        assert.ok(out.includes(`_cxpart: "group-label title text-input:field"`), "computed literal members and nested calls")
    })

    test("labels resolve without a registry too (export name → kebab scope)", () => {
        const out = run(src, { dev: true })
        assert.ok(out.includes(`_cxpart="icon player-controls:button"`), out)
    })

    test("the file's own sheet is the one most of its members read; any other sheet is qualified, even alone", () => {
        const out = run(`${RT}${MAPS}const a = <i {...cx(cn.icon)} />\nconst b = <i {...cx(cn.title)} />\nconst c = <Button {...cx(playerControls.button)} />`, { dev: true, registry: REGISTRY })
        assert.ok(out.includes(`<Button {...cx(playerControls.button)} _cxpart="player-controls:button"`), out)
        assert.ok(out.includes(`<i {...cx(cn.icon)} _cxpart="icon"`), out)
    })

    test("true emits plain attributes, false emits nothing", () => {
        const on = run(src, { dev: true })
        assert.ok(on.includes(`<elo-alert {...cx(cn.root, rest)} _cxpart="root" data-react-component="Alert" data-file-source="packages/components/src/components/Alert/Alert.tsx:7">`), on)
        assert.ok(!on.includes("process.env"))
        const off = run(src, { dev: false })
        assert.ok(!/_cxpart|data-react-component|data-file-source|process\.env/.test(off), off)
    })

    // app-10: outside any checkout (no pnpm-workspace.yaml or .git up to /) the path is relative to the
    // nearest package.json — `src/counter/Counter.tsx:5`, never the bare `Counter.tsx:5`
    test("outside a checkout, data-file-source is relative to the package root", () => {
        const dir = mkdtempSync(join(tmpdir(), "libstylist-nogit-"))
        try {
            writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app" }))
            mkdirSync(join(dir, "src", "counter"), { recursive: true })
            const out = run(`${RT}${MAPS}\nconst el = <span {...cx(cn.icon)} />`, { dev: true, sourceRoot: undefined }, join(dir, "src", "counter", "Counter.tsx"))
            assert.ok(out.includes(`data-file-source="src/counter/Counter.tsx:5"`), out)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("defaults to runtime and to the repo root above the file", () => {
        const dir = mkdtempSync(join(tmpdir(), "libstylist-babel-"))
        try {
            writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n")
            mkdirSync(join(dir, "pkg", "src"), { recursive: true })
            const out = run(src, { dev: undefined, sourceRoot: undefined }, join(dir, "pkg", "src", "Alert.tsx"))
            assert.ok(out.includes(`"data-file-source": "pkg/src/Alert.tsx:7"`), out)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test("the dev spread stays last after author spreads, on components too", () => {
        const out = run(`${RT}${MAPS}const el = <Icon {...cx(cn.icon)} {...rest} />`, { dev: "runtime" })
        assert.match(out, /<Icon \{\.\.\.cx\(cn\.icon\)\} \{\.\.\.rest\} \{\.\.\.process\.env\.NODE_ENV !== "production" && \{[^}]*\}\} \/>/)
    })

    test('dev: true keeps generated strings exact in JSX (no escapes, no entities)', () => {
        for (const file of [`/repo/src/josé "q".tsx`, `/repo/src/R&amp;D\\x.tsx`, `/repo/src/plain.tsx`]) {
            const out = run(`${RT}${MAPS}function Alert() { return <elo-alert {...cx(cn.root)} /> }`, { dev: true }, file)
            const attrs = firstElementAttrs(out)
            assert.equal(attrs.get("data-file-source"), `${file.slice("/repo/".length)}:4`, out)
            assert.equal(attrs.get("data-react-component"), "Alert")
            assert.equal(attrs.get("_cxpart"), "root")
        }
    })

    test("runtime mode puts every dev value in a JS object (strings escape normally)", () => {
        const out = run(`function Alert() { return <elo-alert /> }`, { dev: "runtime" }, `/repo/src/josé "q".tsx`)
        assert.ok(out.includes(`"data-file-source": "src/jos\\xE9 \\"q\\".tsx:1"`), out)
    })
})

describe("component names", () => {
    const names = (code: string, filename?: string): string[] => [...run(code, { dev: true }, filename).matchAll(/data-react-component="([^"]+)"/g)].map((m) => m[1])

    const cases: Array<[string, string, string[]]> = [
        ["function declaration", `function Alert() { return <elo-alert /> }`, ["Alert"]],
        ["arrow const", `const Alert = () => <elo-alert />`, ["Alert"]],
        ["function expression const", `const Alert = function () { return <elo-alert /> }`, ["Alert"]],
        ["named function expression", `const X = forwardRef(function Button(p, r) { return <button elo-button /> })`, ["Button"]],
        ["memo arrow", `export const Alert = memo(() => <elo-alert />)`, ["Alert"]],
        ["React.memo(forwardRef) with as", `export const Alert = React.memo(React.forwardRef((p, r) => <elo-alert />)) as Foo`, ["Alert"]],
        ["observer satisfies", `const Alert = observer((() => <elo-alert />) satisfies Fn)`, ["Alert"]],
        ["expando assignment", `Modal.Header = function () { return <elo-modal-header /> }`, ["Modal.Header"]],
        ["expando arrow", `Modal.Footer = () => <elo-modal-footer />`, ["Modal.Footer"]],
        ["Object.assign members", `export const Modal = Object.assign(Root, { Header: () => <elo-modal-header />, Body() { return <elo-modal-body /> } })`, ["Modal.Header", "Modal.Body"]],
        ["Object.assign statement", `Object.assign(Tabs, { Item: forwardRef((p, r) => <elo-tabs-item />) })`, ["Tabs.Item"]],
        ["object namespace", `const Table = { Row: () => <elo-table-row />, Cell: memo(() => <elo-table-cell />) }`, ["Table.Row", "Table.Cell"]],
        ["lowercase helper skipped", `function Button() { const renderIcon = () => <i elo-icon />; function inner() { return <b elo-x /> } return renderIcon() }`, ["Button", "Button"]],
        ["innermost PascalCase wins", `function Outer() { const Inner = () => <elo-inner />; return <elo-outer /> }`, ["Inner", "Outer"]],
        ["class render", `class Legacy extends React.Component { render() { return <elo-legacy /> } }`, ["Legacy"]],
        ["class property arrow", `class Legacy extends React.Component { renderIt = () => <elo-legacy /> }`, ["Legacy"]],
        ["class expression", `const Legacy = class extends React.Component { render() { return <elo-legacy /> } }`, ["Legacy"]],
        ["no component", `const el = <elo-alert />; const lower = () => <elo-alert />`, []],
        ["only identity elements", `function Alert() { return <div><span data-x /></div> }`, []],
        ["lowercase named function expression bound to a PascalCase name", `export const Button = forwardRef(function button(p, r) { return <button elo-button /> })`, ["Button"]],
        ["forwardRef/memo inside Object.assign", `export const Tabs = Object.assign(Root, { Item: memo(forwardRef((p, r) => <elo-tabs-item />)) })`, ["Tabs.Item"]],
        ["inline Object.assign root", `export const Tabs = Object.assign(forwardRef((p, r) => <elo-tabs />), { Item: () => <elo-tabs-item /> })`, ["Tabs", "Tabs.Item"]],
    ]
    for (const [label, code, expected] of cases) test(label, () => assert.deepEqual(names(code), expected))

    test("anonymous default exports use the PascalCase file basename", () => {
        assert.deepEqual(names(`export default function () { return <elo-alert /> }`, "/repo/src/alert-banner.tsx"), ["AlertBanner"])
        assert.deepEqual(names(`export default () => <elo-alert />`, "/repo/src/Alert.tsx"), ["Alert"])
        assert.deepEqual(names(`export default memo(() => <elo-alert />)`, "/repo/src/Button/index.tsx"), ["Button"])
    })
})

describe("key placement", () => {
    test("key moves ahead of the element's cx() spreads so the automatic runtime keeps jsx()", async () => {
        const out = run(`${RT}const el = items.map((i) => <li {...cx(cn.item, { on: i.on })} key={i.id} data-x="1" />)`)
        assert.ok(out.includes(`<li key={i.id} {...cx(cn.item, cxData({`), out)
        const js = await transformWithEsbuild(out, "x.tsx", { loader: "tsx", jsx: "automatic" })
        assert.ok(!js.code.includes("createElement"), js.code)
    })

    test("key stays put when an author spread already precedes it", () => {
        const out = run(`${RT}const el = <li {...rest} {...cx(cn.item)} key={id} />`)
        assert.ok(out.includes(`<li {...rest} {...cx(cn.item)} key={id} />`), out)
    })
})

describe("runtime imports", () => {
    test("only the helpers actually used are imported, once, after the leading imports", () => {
        const out = run(`/*! header */\nimport * as React from "react"\nconst x = <elo-a {...r} data-a={b} />\nconst y = <elo-b {...s} data-b={c} />`)
        assert.ok(out.startsWith(`/*! header */\nimport * as React from "react";\nimport { hostProps, cxAttr } from "@livesession/libstylist/runtime";\n`), out)
        assert.equal(count(out, "@livesession/libstylist/runtime"), 1)
        assert.ok(!run(`${RT}const el = <span {...cx(cn.icon)} />`).includes("cxData"), "parts alone need no helper")
    })

    test("an author import shadowed by a local binding is not reused", () => {
        const out = run(`import { hostProps } from "@livesession/libstylist/runtime"\nfunction A({ hostProps, r }) { return <elo-a {...r} /> }`)
        assert.ok(out.includes(`import { hostProps, hostProps as _hostProps } from "@livesession/libstylist/runtime";`), out)
        assert.ok(out.includes(`{..._hostProps(r)}`), out)
    })

    test("the author's package import is reused when helpers come from the Vite virtual runtime", () => {
        const out = run(`import { cx, cxData } from "@livesession/libstylist/runtime"\nconst el = <elo-a {...cx({ a })} />`, { runtimeModule: "virtual:libstylist/runtime" })
        assert.equal(count(out, "import"), 1, out)
    })

    test("an author-written cxAttr call is recognized through its import alias and never double-wrapped", () => {
        const out = run(`import { cxAttr as attr } from "@livesession/libstylist/runtime"\nconst el = <elo-a data-x={attr(on)} />`)
        assert.ok(out.includes(`data-x={attr(on)}`), out)
        assert.ok(!out.includes("cxAttr(attr"), out)
    })

    test("runtimeModule is configurable", () => {
        const { code } = transform(`const el = <elo-a {...r} />`, { runtimeModule: "virtual:libstylist/runtime" })
        assert.ok(code.includes(`import { hostProps } from "virtual:libstylist/runtime";`))
    })
})

describe("registry validation of part-map members", () => {
    // app-3: part maps are recognized by package specifier only — a path in partMaps would silently match no import
    test("a relative or absolute partMaps value fails with the alias recipe", () => {
        assert.throws(() => run(`${RT}const x = cx({ a })`, { partMaps: { components: "../styles-dist/parts" } }), /partMaps\.components is the path "\.\.\/styles-dist\/parts" — part maps are recognized by their package specifier only[\s\S]*resolve\.alias/)
        assert.throws(() => run(`${RT}const x = cx({ a })`, { partMaps: { components: "/abs/parts.mjs" } }), /is the path "\/abs\/parts\.mjs"/)
        assert.ok(run(`${RT}const x = cx({ a })`, { partMaps: { components: "@app/styles" } }).includes("cxData"))
    })

    test("known parts pass; an unknown part fails with a frame", () => {
        assert.ok(run(`${RT}${MAPS}const el = <i {...cx(cn.icon)} />`, { registry: REGISTRY }).includes("cn.icon"))
        assert.throws(() => run(`${RT}${MAPS}const el = <i {...cx(cn.icn)} />`, { registry: REGISTRY }), /unknown part "icn" of cn \(sheet "alert"; known: group-label, icon, root, title\)/)
        assert.throws(() => run(`${RT}${MAPS}const s = cx(textInput.fild)`, { registry: REGISTRY }), /unknown part "fild"/, "cx() calls outside JSX spreads too")
    })

    test('onUnknownPart: "warn" reports and still compiles', () => {
        const warnings: string[] = []
        const prev = console.warn
        console.warn = (m: string) => void warnings.push(m)
        try {
            const out = run(`${RT}${MAPS}const el = <i {...cx(cn.icn, cn.nope)} />`, { registry: REGISTRY, onUnknownPart: "warn" })
            assert.ok(out.includes("cn.icn"))
        } finally {
            console.warn = prev
        }
        assert.equal(warnings.length, 2)
    })

    test("partMaps restricts which modules are part maps", () => {
        const partMaps = { components: "@livesession/eloquentui-css" }
        const out = run(`${RT}import { alert as cn } from "@other/css"\nconst el = <i {...cx(cn.whatever)} />`, { dev: true, registry: REGISTRY, partMaps })
        assert.ok(!out.includes("_cxpart"), "not a part map, so no label and no validation")
    })
})

describe("package configuration", () => {
    test("prefix/namespace resolve per file from package.json; unconfigured files only get branding", () => {
        const dir = mkdtempSync(join(tmpdir(), "libstylist-pkg-"))
        try {
            mkdirSync(join(dir, "player", "src"), { recursive: true })
            mkdirSync(join(dir, "plain", "src"), { recursive: true })
            writeFileSync(join(dir, "player", "package.json"), JSON.stringify({ libstylist: { prefix: "elo", namespace: "player" } }))
            writeFileSync(join(dir, "plain", "package.json"), JSON.stringify({ name: "plain" }))
            clearConventionsCache()
            const opts = { prefix: undefined, namespace: undefined, sourceRoot: dir }
            const out = run(`const el = <elo-player-x {...rest} />`, opts, join(dir, "player", "src", "Controls.tsx"))
            assert.ok(out.includes("hostProps(rest)"), out)

            const untouched = `const el = <elo-alert {...rest} data-a elo-button><circle cx={1} /></elo-alert>;`
            const plain = transform(untouched, opts, join(dir, "plain", "src", "x.tsx"))
            assert.equal(plain.code, untouched)
            assert.equal(plain.meta?.changed, false)
            assert.throws(() => run(`const el = <span cx="icon" />`, opts, join(dir, "plain", "src", "x.tsx")), /cx attribute was removed/)
        } finally {
            rmSync(dir, { recursive: true, force: true })
            clearConventionsCache()
        }
    })

    test("a prefix option that contradicts the file's package is refused, not mixed", () => {
        const dir = mkdtempSync(join(tmpdir(), "libstylist-review-"))
        try {
            mkdirSync(join(dir, "player", "src"), { recursive: true })
            writeFileSync(join(dir, "player", "package.json"), JSON.stringify({ libstylist: { prefix: "elo", namespace: "player" } }))
            clearConventionsCache()
            const file = join(dir, "player", "src", "Controls.tsx")
            assert.throws(() => run(`const el = <elo-x />`, { prefix: "app", namespace: undefined }, file), /configured with prefix "elo" \(namespace "player"\) but the transform was given prefix "app"/)
            assert.ok(run(`const el = <app-x {...r} />`, { prefix: "app", namespace: "web" }, file).includes("hostProps"))
        } finally {
            rmSync(dir, { recursive: true, force: true })
            clearConventionsCache()
        }
    })

    test("default and named exports are the same plugin", () => {
        assert.equal(libstylistBabel, named)
    })
})

describe("SPEC invariants", () => {
    const inputs = [
        `${RT}${MAPS}const el = <span {...cx(cn.icon, { on })} />`,
        `${RT}${MAPS}const el = <TextInput {...cx(cn.root)} inputCx={cx(textInput.field, { wide })} />`,
        `const el = <elo-alert {...rest} data-a aria-b={x} />`,
        `const el = <button elo-button />`,
        `function Alert() { return <elo-alert elo-x><i elo-icon /></elo-alert> }`,
    ]

    test("the transform never emits class/className and never emits a valued marker", () => {
        for (const dev of [false, true, "runtime"] as const) {
            for (const src of inputs) {
                const out = run(src, { dev })
                assert.ok(!/\bclass(Name)?\b/.test(out), `${src}\n${out}`)
                for (const m of out.matchAll(/(elo-[a-z]+)="([^"]*)"/g)) assert.equal(m[2], "", `${m[0]} in ${out}`)
            }
        }
    })

    test("output is deterministic across fresh plugin instances", () => {
        for (const src of inputs) assert.equal(run(src, { dev: "runtime" }), run(src, { dev: "runtime" }))
    })

    test("parts are never compiled: the transform emits no part attribute of its own", () => {
        for (const src of inputs) assert.ok(!run(src, { dev: true }).includes("_cxclass_"), src)
    })
})
