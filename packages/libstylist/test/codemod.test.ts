// `libstylist codemod`: the removed source API (pragma, cx attributes, forwardStylist, string slots, raw
// data-* attributes) → the cx() call API, on every form the design-system sources used; data values keep
// rendering exactly what they rendered (a value that can be `false` included); idempotent; TODOs for
// what it cannot decide. The pass over the design system's real sources runs against the checkout
// LIBSTYLIST_DESIGN_SYSTEM names (./design-system.ts) and skips without it.
import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"

import ts from "typescript"

import { runCodemod } from "../src/codemod/cli.js"
import { codemod, type CodemodOptions } from "../src/codemod/index.js"
import { dataTypesFor } from "../src/codemod/types.js"
import { clearConventionsCache } from "../src/conventions/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

/** The monorepo fixture: a design-system-shaped workspace whose packages declare their libstylist configs (test/fixtures/monorepo/README.md). */
const MONOREPO = join(import.meta.dirname, "fixtures", "monorepo")

const MODULES: Record<string, string> = {
    alert: "@x/css",
    button: "@x/css",
    "text-input": "@x/css",
    popover: "@x/css",
    "filter-editor": "@x/css/infinity",
    "filter-tree": "@x/css/infinity",
    "player-controls": "@x/css/player",
    "player-root": "@x/css/player",
    switch: "@x/css",
}
const moduleOf = (scope: string) => MODULES[scope] ?? null
const partMaps = { components: "@x/css", infinity: "@x/css/infinity", player: "@x/css/player" }

/** Type facts from an in-memory TypeScript program over `code`. */
function typesFor(code: string, file = "/virtual/src/X.tsx") {
    const options: ts.CompilerOptions = { strict: true, jsx: ts.JsxEmit.Preserve, noEmit: true, target: ts.ScriptTarget.ES2020, types: [] }
    const host = ts.createCompilerHost(options, true)
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (f, v, onError, create) => (f === file ? ts.createSourceFile(f, code, v, true) : getSourceFile(f, v, onError, create))
    const fileExists = host.fileExists.bind(host)
    host.fileExists = (f) => f === file || fileExists(f)
    return dataTypesFor(ts.createProgram({ rootNames: [file], options, host }), file)
}

function walkSources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walkSources(path, out)
        else if (/\.tsx?$/.test(name) && !/\.(d|stories|test|spec)\.tsx?$/.test(name)) out.push(path)
    }
    return out
}

const run = (code: string, options: CodemodOptions = {}, file = "/virtual/src/X.tsx") => codemod(code, file, { moduleOf, partMaps, types: typesFor(code, file), ...options })
const out = (code: string, options?: CodemodOptions) => run(code, options).code

describe("pragma and parts", () => {
    test("pragma → part-map import; cx strings, arrays and templates → member arguments", () => {
        const src = `/** @cxScope alert */
import * as React from "react"

import { Icon } from "@livesession/eloquentui-icons"
import { forwardStylist } from "@livesession/libstylist/runtime"

export function Alert({ ...rest }) {
    return (
        <elo-alert cx="root" {...forwardStylist(rest)}>
            <span cx="icon content" />
            <span cx={["title", "group-label"]} />
            <span cx={\`icon\`} />
        </elo-alert>
    )
}
`
        const r = run(src)
        assert.equal(
            r.code,
            `import * as React from "react"

import { Icon } from "@livesession/eloquentui-icons"
import { alert as cn } from "@x/css"
import { cx } from "@livesession/libstylist/runtime"

export function Alert({ ...rest }) {
    return (
        <elo-alert {...cx(cn.root, rest)}>
            <span {...cx(cn.icon, cn.content)} />
            <span {...cx(cn.title, cn["group-label"])} />
            <span {...cx(cn.icon)} />
        </elo-alert>
    )
}
`,
        )
        assert.deepEqual(r.todo, [])
        assert.deepEqual(r.scopes, ["alert"])
    })

    // T12: a pragma standing between blank lines (3a6807a's Popover) took one newline with it and left a
    // run of blank lines — the code around it keeps exactly one
    test("a pragma between blank lines leaves one blank line behind, none at the top of the file", () => {
        const imports = `import type { ReactNode } from "react"\n`
        const body = `const el = <span cx="icon" />\n`
        const maps = `import { alert as cn } from "@x/css"\nimport { cx } from "@livesession/libstylist/runtime"\n`
        const converted = `const el = <span {...cx(cn.icon)} />\n`
        const expected = `${imports}\n${maps}\n${converted}`
        assert.equal(out(`${imports}\n/** @cxScope alert */\n\n\n${body}`), expected)
        assert.equal(out(`${imports}\n\n/** @cxScope alert */\n${body}`), expected)
        assert.equal(out(`${imports}\n/** @cxScope alert */\n\n${body}`), expected)
        // at the top of the file the next line opens it; with no blank line around it none appears
        assert.equal(out(`/** @cxScope alert */\n\n${imports}\n${body}`), expected)
        assert.equal(out(`${imports}/** @cxScope alert */\n${body}`), `${imports}\n${maps}${converted}`)
    })

    test("qualified parts import their own map; one module gets one import; an existing map import is reused", () => {
        const src = `/** @cxScope filter-editor */
import { cx as _unused } from "./nothing"
import { forwardStylist } from "@livesession/libstylist/runtime"

export const a = <div cx="filter-tree:node"><span cx="filter-tree:connector" /><Button cx="row player-controls:button" /></div>
`
        assert.equal(
            out(src.replace('import { cx as _unused } from "./nothing"\n', "")),
            `import { filterTree, filterEditor as cn } from "@x/css/infinity"
import { playerControls } from "@x/css/player"
import { cx } from "@livesession/libstylist/runtime"

export const a = <div {...cx(filterTree.node)}><span {...cx(filterTree.connector)} /><Button {...cx(cn.row, playerControls.button)} /></div>
`,
        )
        const reuse = `/** @cxScope alert */
import { alert as a } from "@x/css"
import { cx } from "@livesession/libstylist/runtime"

const el = <span cx="icon" />
`
        assert.equal(out(reuse), `import { alert as a } from "@x/css"\nimport { cx } from "@livesession/libstylist/runtime"\n\nconst el = <span {...cx(a.icon)} />\n`)
    })

    test("components take a cx() spread; SVG geometry keeps its cx; a reserved word export gets its Classes name", () => {
        const src = `/** @cxScope switch */
const el = <svg cx="root"><circle cx={5} cy={5} /><ellipse cx="5" /><radialGradient cx="50%" /><Icon cx="thumb" /></svg>
`
        assert.equal(
            out(src),
            `import { switchClasses as cn } from "@x/css"
import { cx } from "@livesession/libstylist/runtime"

const el = <svg {...cx(cn.root)}><circle cx={5} cy={5} /><ellipse cx="5" /><radialGradient cx="50%" /><Icon {...cx(cn.thumb)} /></svg>
`,
        )
    })
})

describe("forwarding and slots", () => {
    test("forwardStylist merges after the parts, or becomes cx(x) alone; casts are dropped", () => {
        const src = `/** @cxScope alert */
import { forwardStylist, unsetRef } from "@livesession/libstylist/runtime"

const a = <elo-alert {...forwardStylist(rest)} cx="root" ref={unsetRef({ title })} />
const b = <Modal elo-modalconfirm {...forwardStylist(props as Record<string, unknown>)} />
`
        assert.equal(
            out(src),
            `import { alert as cn } from "@x/css"
import { cx, unsetRef } from "@livesession/libstylist/runtime"

const a = <elo-alert {...cx(cn.root, rest)} ref={unsetRef({ title })} />
const b = <Modal elo-modalconfirm {...cx(props)} />
`,
        )
    })

    test("slot receivers merge into the inner element's call; string slots take a cx() value", () => {
        const src = `/** @cxScope text-input */
import { forwardStylist } from "@livesession/libstylist/runtime"

function TextInput({ inputCx, ...rest }) {
    return (
        <elo-textinput cx="root" {...forwardStylist(rest)}>
            <input {...(inputCx as Record<string, unknown> | undefined)} type="text" cx="field" {...rest} />
        </elo-textinput>
    )
}
const b = <Popover contentCx="popover" />
const c = <TextInput inputCx={["field", "root"]} />
`
        assert.equal(
            out(src),
            `import { textInput as cn } from "@x/css"
import { cx } from "@livesession/libstylist/runtime"

function TextInput({ inputCx, ...rest }) {
    return (
        <elo-textinput {...cx(cn.root, rest)}>
            <input {...cx(cn.field, inputCx)} type="text" {...rest} />
        </elo-textinput>
    )
}
const b = <Popover contentCx={cx(cn.popover)} />
const c = <TextInput inputCx={cx(cn.field, cn.root)} />
`,
        )
    })

    test("imports it rewrites or adds keep the file's semicolons", () => {
        const src = `/** @cxScope alert */
import * as React from "react";

import { forwardStylist } from "@livesession/libstylist/runtime";

export const a = <elo-alert cx="root" {...forwardStylist(rest)} />;
`
        assert.equal(
            out(src),
            `import * as React from "react";

import { alert as cn } from "@x/css";
import { cx } from "@livesession/libstylist/runtime";

export const a = <elo-alert {...cx(cn.root, rest)} />;
`,
        )
        const noRuntime = `import * as React from "react";\n\nexport const a = <Modal elo-modalconfirm data-open={open} />;\n`
        assert.match(out(noRuntime), /^import \{ cx \} from "@livesession\/libstylist\/runtime";$/m)
    })

    test("forwardStylist used outside a spread keeps its import and is reported", () => {
        const src = `import { forwardStylist } from "@livesession/libstylist/runtime"\nexport const f = (p: object) => forwardStylist(p as never)\nconst el = <elo-x {...forwardStylist(p)} />\n`
        const r = run(src)
        assert.ok(r.code.startsWith(`import { cx, forwardStylist } from "@livesession/libstylist/runtime"`), r.code)
        assert.match(r.todo.map((t) => t.message).join("\n"), /forwardStylist is used outside a JSX spread/)
    })
})

describe("data attributes", () => {
    // The fixture's packages stand in for the design system's: a file in packages/components resolves the core
    // package's config from disk, one in packages/app-ui the app package's. The design-system component library
    // the app package imports (@livesession/eloquentui-react) has to be installed where the file is, so the fixture
    // is copied to a scratch workspace and the library written into that package's node_modules — as a package
    // manager would, and as fixtures/overrides/install.ts does for the override tests.
    const scratch = mkdtempSync(join(tmpdir(), "libstylist-codemod-monorepo-"))
    cpSync(MONOREPO, scratch, { recursive: true })
    const installed = join(scratch, "packages", "app-ui", "node_modules", "@livesession", "eloquentui-react")
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "@livesession/eloquentui-react", libstylist: { prefix: "elo", namespace: "core" } }))
    clearConventionsCache()
    after(() => rmSync(scratch, { recursive: true, force: true }))
    /** A source file of the scratch workspace's `components` (core) or `app-ui` (app) package. */
    const probe = (pkg: string) => join(scratch, "packages", pkg, "src", "components", "Probe", "Probe.tsx")

    const PRE = `/** @cxScope alert */\ndeclare const size: "small" | "large" | undefined\ndeclare const isOpen: boolean | undefined\ndeclare const on: boolean\ndeclare const label: string\ndeclare const count: number\ndeclare function side(): string | undefined\ndeclare const item: { disabled?: boolean; kind: "a" | "b" }\n`
    const convert = (jsx: string) => {
        const r = run(`${PRE}const el = ${jsx}\n`)
        return { code: r.code.slice(r.code.indexOf("const el = ") + "const el = ".length).trimEnd(), r }
    }

    test("keys are camelCase; value-less → true; strings, ternaries and non-boolean values move as written", () => {
        assert.equal(
            convert(`<div cx="icon" data-has-title="yes" data-dropdown-item data-size={size} data-kind={item.kind} data-side={side() || "top"} data-a1-b2="x" data-open={isOpen ? "true" : undefined} data-n={count} />`).code,
            `<div {...cx(cn.icon, { hasTitle: "yes", dropdownItem: true, size, kind: item.kind, side: side() || "top", a1B2: "x", open: isOpen ? "true" : undefined, n: count })} />`,
        )
    })

    test("`x || undefined` → x when x can't be \"\" or 0 — kept as written when it can", () => {
        assert.equal(convert(`<div data-open={isOpen || undefined} data-on={!!on || undefined} data-size={size || undefined} />`).code, `<div {...cx({ open: isOpen, on: !!on, size })} />`)
        assert.equal(convert(`<div data-label={label || undefined} data-n={count || undefined} />`).code, `<div {...cx({ label: label || undefined, n: count || undefined })} />`)
    })

    test("a value that can be false renders \"false\" today — rewritten to keep rendering it, and listed", () => {
        const { code, r } = convert(`<i data-active={isOpen} data-on={on} data-disabled={item.disabled} data-checked={!on} />`)
        assert.equal(
            code,
            `<i {...cx({ active: isOpen === undefined ? undefined : String(isOpen), on: String(on), disabled: item.disabled === undefined ? undefined : String(item.disabled), checked: String(!on) })} />`,
        )
        assert.deepEqual(
            r.falseAttributes.map((f) => [f.attr, f.value]),
            [
                ["data-active", "isOpen"],
                ["data-on", "on"],
                ["data-disabled", "item.disabled"],
                ["data-checked", "!on"],
            ],
        )
    })

    test("an impure maybe-false value, and one whose type is unknown, move as written with a TODO", () => {
        const r = run(`${PRE}declare function f(): boolean | undefined\ndeclare const u: any\nconst el = <div data-x={f()} data-y={u} />\n`)
        assert.ok(r.code.includes(`<div {...cx({ x: f(), y: u })} />`), r.code)
        assert.deepEqual(r.todo.map((t) => t.message.split(" ")[0]), ["data-x={f()}", "data-y={u}:"])
    })

    // T1: without type facts `x || undefined` is stripped only when its shape says x is boolean — any other
    // x may be 0 or "", which `|| undefined` omits and the data literal would render
    test("without type facts, `|| undefined` is kept unless the shape is boolean, and every non-literal value is reported", () => {
        const r = codemod(`${PRE}const el = <div data-open={isOpen || undefined} data-count={count || undefined} data-label={label || undefined} data-on={!!on || undefined} data-eq={a === b || undefined} data-size={size} />\n`, "/virtual/X.tsx", { moduleOf })
        assert.ok(r.code.includes(`<div {...cx({ open: isOpen || undefined, count: count || undefined, label: label || undefined, on: !!on, eq: a === b, size })} />`), r.code)
        assert.equal(r.todo.length, 1)
    })

    // T2: a JSX attribute string decodes entities and has no escapes — the data literal gets the decoded value
    test("string attribute values are carried over decoded (entities, backslashes, quotes, newlines)", () => {
        assert.equal(
            convert(`<div data-label="Tom &amp; Jerry" data-path="C:\\new" data-quote='say "hi"' data-text="two\nlines" />`).code,
            `<div {...cx({ label: "Tom & Jerry", path: "C:\\\\new", quote: "say \\"hi\\"", text: "two\\nlines" })} />`,
        )
    })

    test("data attributes join the element's cx() call, next to parts and forwarded props", () => {
        assert.equal(
            convert(`<elo-alert cx="root" {...forwardStylist(rest)} role="status" data-variant={size}></elo-alert>`).code,
            `<elo-alert {...cx(cn.root, rest, { variant: size })} role="status"></elo-alert>`,
        )
    })

    test("dev annotations and removed hooks are reported, never moved", () => {
        const { code, r } = convert(`<div data-component="Tabs" data-file-source="x" />`)
        assert.equal(code, `<div data-component="Tabs" data-file-source="x" />`)
        assert.equal(r.todo.length, 2)
    })

    test("on a libstylist component a data attribute is a prop and stays (as data-in-cx leaves it)", () => {
        // a relative import in a libstylist package, and a package declaring a libstylist prefix, render
        // components whose cx() would drop a data literal; a third-party or unresolved name is not one
        const components = probe("components")
        const appUi = probe("app-ui")
        const src = `/** @cxScope alert */
import { Button } from "../Button"
import { Alert } from "@livesession/eloquentui-react"
import * as RadixPopover from "@radix-ui/react-popover"
declare const open: boolean | undefined
const a = <Button cx="close" data-open={open}>x</Button>
const b = <Alert data-testid="x">y</Alert>
const c = <RadixPopover.Content data-side="top" />
const d = <Modal data-size="small" />
`
        const inComponents = codemod(src, components, { moduleOf, partMaps }).code
        assert.ok(inComponents.includes(`<Button {...cx(cn.close)} data-open={open}>x</Button>`), inComponents)
        assert.ok(inComponents.includes(`<RadixPopover.Content {...cx({ side: "top" })} />`), inComponents)
        assert.ok(inComponents.includes(`<Modal {...cx({ size: "small" })} />`), inComponents)
        const inAppUi = codemod(src, appUi, { moduleOf, partMaps }).code
        assert.ok(inAppUi.includes(`<Alert data-testid="x">y</Alert>`), inAppUi)
        // outside any libstylist package a relative import is not known to be one
        assert.ok(out(`/** @cxScope alert */\nimport { Button } from "../Button"\nconst a = <Button data-open />\n`).includes(`<Button {...cx({ open: true })} />`))
        // a subpath import (`#components`, package.json `imports`) is the package's own module, like a relative one
        const own = `import { AccountsList } from "#components"\ndeclare const open: boolean | undefined\nconst a = <AccountsList data-open={open} />\n`
        assert.ok(codemod(own, components, { moduleOf, partMaps }).code.includes(`<AccountsList data-open={open} />`))
        // outside a libstylist package it is not known to be one: the attribute moves into the element's data
        assert.ok(!out(own).includes("data-open"), out(own))
    })

    // review open issue: a component defined in the same file is a libstylist component too (its cx()
    // drops a data literal); a polymorphic `As` or a tag held in a const is not
    test("a component defined in the same file keeps its data attribute as a prop; a polymorphic As does not", () => {
        const file = probe("components")
        const src = `/** @cxScope alert */
declare const open: boolean | undefined
function Item(props: object) { return <elo-item cx="root" {...forwardStylist(props)} /> }
const Row = React.memo((props: object) => <li cx="icon" {...forwardStylist(props)} />)
const Tag = open ? "p" : "div"
export function List({ as: As = "div" }: { as?: "div" }) {
    return <>
        <Item data-open={open} />
        <Row data-size="s" />
        <As data-kind="x" />
        <Tag data-tone="y" />
    </>
}
`
        const code = codemod(src, file, { moduleOf, partMaps }).code
        assert.ok(code.includes(`<Item data-open={open} />`), code)
        assert.ok(code.includes(`<Row data-size="s" />`), code)
        assert.ok(code.includes(`<As {...cx({ kind: "x" })} />`), code)
        assert.ok(code.includes(`<Tag {...cx({ tone: "y" })} />`), code)
    })

    test("a data attribute moving across another spread is reported", () => {
        const r = run(`${PRE}const el = <div cx="icon" {...rest} data-size={size} />\n`)
        assert.ok(r.code.includes(`<div {...cx(cn.icon, { size })} {...rest} />`), r.code)
        assert.match(r.todo.map((t) => t.message).join("\n"), /data-size moved across \{\.\.\.rest\}/)
    })
})

describe("what it leaves alone", () => {
    test("a conditional cx is left untouched with the state-rule TODO; the rest of the file converts", () => {
        const src = `/** @cxScope alert */\nconst a = <span cx={["icon", open && "open"]} {...forwardStylist(p)} />\nconst b = <span cx={{ icon: on }} />\nconst c = <span cx={on ? "a" : "b"} />\nconst d = <span cx="icon" />\n`
        const r = run(src)
        assert.ok(r.code.includes(`const a = <span cx={["icon", open && "open"]} {...forwardStylist(p)} />`), r.code)
        assert.ok(r.code.includes(`const d = <span {...cx(cn.icon)} />`), r.code)
        assert.equal(r.todo.filter((t) => /move the state to a data-\* attribute/.test(t.message)).length, 3)
    })

    test("an unknown part-map module, and a cx binding that is not the runtime's, are reported", () => {
        const unknown = run(`/** @cxScope nowhere */\nconst a = <span cx="icon" />\n`)
        assert.equal(unknown.changed, true, "the pragma still goes")
        assert.ok(unknown.code.includes(`<span cx="icon" />`))
        assert.match(unknown.todo[0].message, /no part-map module is known for scope "nowhere"/)
        const taken = run(`/** @cxScope alert */\nconst cx = (s: string) => s;\nconst a = <span cx="icon" />\n`)
        assert.equal(taken.changed, false)
        assert.match(taken.todo[0].message, /`cx` is bound to something other than the runtime cx\(\)/)
    })

    test("a class map's className={cn.x} (a file not flipped yet) → a cx() spread; the old helper's import goes", () => {
        const registry = { scopes: { alert: { group: "components" } } }
        const src = `import { alert as cn } from "@x/css"\nimport { cx } from "../utils/cx"\n\nconst a = <span className={cn.icon} />\nconst b = <span className={cx(cn.icon, cn.title)} />\n`
        assert.equal(run(src, { registry }).code, `import { alert as cn } from "@x/css"\n\nimport { cx } from "@livesession/libstylist/runtime"\n\nconst a = <span {...cx(cn.icon)} />\nconst b = <span {...cx(cn.icon, cn.title)} />\n`)
        // a conditional className keeps the helper, so nothing can take its name yet
        const conditional = run(`${src}const c = <span className={cx(cn.icon, open && cn.open)} />\n`, { registry })
        assert.equal(conditional.changed, false)
        assert.match(conditional.todo.map((t) => t.message).join("\n"), /helper imported as `cx` is still called[\s\S]*not a plain list of part-map members/)
    })

    test("idempotent: a converted file (or one already on the call API) is left as it is", () => {
        const src = `/** @cxScope alert */\nimport { forwardStylist } from "@livesession/libstylist/runtime"\nconst a = <elo-alert cx="root" {...forwardStylist(rest)} data-open={open || undefined} />\n`
        const once = run(src).code
        const twice = run(once)
        assert.equal(twice.changed, false)
        assert.equal(twice.code, once)
        assert.deepEqual(twice.todo, [])
    })
})

describe("the design-system sources", () => {
    test("are on the cx() call API: the codemod has nothing left to convert or report", { skip: skipWithoutDesignSystem }, async () => {
        const repo = designSystemPath()
        const files = ["components", "app-ui", "player", "gram", "infinity", "ai"].flatMap((p) => walkSources(join(repo, "packages", p, "src")))
        assert.ok(files.length > 150, `found ${files.length} source files`)
        const results = await runCodemod(files, { cwd: repo, config: "libstylist.config.mjs" })
        const rel = (f: string) => f.slice(repo.length + 1)
        assert.deepEqual(results.filter((r) => r.result.changed).map((r) => rel(r.file)), [])
        assert.deepEqual(results.flatMap((r) => r.result.todo.map((t) => `${rel(r.file)}:${t.line} ${t.message}`)), [])
        assert.deepEqual(results.flatMap((r) => r.result.falseAttributes.map((f) => `${rel(r.file)}:${f.line} ${f.attr}`)), [])
    })
})

describe("the CLI", () => {
    test("reads the project config for part-map modules and type facts; --write rewrites", async () => {
        const dir = mkdtempSync(join(tmpdir(), "libstylist-codemod-"))
        try {
            const fixture = join(dir, "Badge.tsx")
            writeFileSync(fixture, `/** @cxScope badge */\nimport { forwardStylist } from "@livesession/libstylist/runtime"\nexport function Badge({ active, ...rest }: { active?: boolean }) {\n    return <elo-badge cx="root" {...forwardStylist(rest)} data-active={active} />\n}\n`)
            const config = join(import.meta.dirname, "fixtures", "check", "zero", "libstylist.config.mjs")
            const [dry] = await runCodemod([fixture], { config, cwd: dir })
            assert.equal(readFileSync(fixture, "utf8").includes("@cxScope"), true, "a dry run writes nothing")
            assert.deepEqual(dry.result.falseAttributes.map((f) => f.rewritten), ["active === undefined ? undefined : String(active)"])
            await runCodemod([fixture], { config, cwd: dir, write: true })
            assert.equal(
                readFileSync(fixture, "utf8"),
                `import { badge as cn } from "@fx/css"\nimport { cx } from "@livesession/libstylist/runtime"\nexport function Badge({ active, ...rest }: { active?: boolean }) {\n    return <elo-badge {...cx(cn.root, rest, { active: active === undefined ? undefined : String(active) })} />\n}\n`,
            )
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
