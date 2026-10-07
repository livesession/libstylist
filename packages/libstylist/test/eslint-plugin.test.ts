// The ESLint plugin as a whole: shape, configs, docs links, an end-to-end Linter run on migrated
// and pre-migration component source, legacy() counting, and the shared helpers (segment discovery over
// the real design system runs against the checkout LIBSTYLIST_DESIGN_SYSTEM names — ./design-system.ts).
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import tsParser from "@typescript-eslint/parser"
import { Linter } from "eslint"

import { PART_MAP_HEADER } from "../src/conventions/index.js"
import plugin, { clearContextCaches, configs, discoverSegments, legacyUsage, legacyUsageTotal, loadRegistry, resetLegacyUsage, ruleDocsUrl, rules, STORY_RULES } from "../src/eslint/index.js"
import { firstClassSelector } from "../src/eslint/rules/no-class-query.js"
import { hashLiteralMatch } from "../src/eslint/rules/no-hash-literal.js"
import { editDistance, nearest } from "../src/eslint/suggest.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

const RULE_IDS = [
    "no-classname",
    "cx-args",
    "cx-part-exists",
    "no-cx-attribute",
    "data-in-cx",
    "no-literal-class",
    "no-dev-attrs",
    "marker-attr",
    "tag-name",
    "forward-props",
    "root-part",
    "no-imperative-class",
    "no-anonymous-container",
    "no-class-query",
    "no-hash-literal",
    "reflected-props",
]

const registry = {
    version: 1,
    prefix: "elo",
    hash: { version: 1, length: 6 },
    scopes: {
        alert: {
            namespace: "core",
            group: "components",
            roots: [{ component: "Alert", local: "root", tag: "elo-alert" }],
            parts: Object.fromEntries(["root", "icon", "glyph", "content", "title", "close"].map((p) => [p, `_cxclass_elo-${p}`])),
        },
        button: {
            namespace: "core",
            group: "components",
            roots: [{ component: "Button", local: "root", tag: "elo-button" }],
            parts: Object.fromEntries(["root", "loading", "children", "label"].map((p) => [p, `_cxclass_elo-${p}`])),
        },
    },
}

const settings = { libstylist: { prefix: "elo", namespace: "core", segments: ["ai", "app", "gram", "inf", "player"], registry, partMaps: { components: "@livesession/eloquentui-css" } } }

function lint(code: string, config: object = configs.recommended, filename = "/virtual/src/Component.tsx") {
    const linter = new Linter({ configType: "flat", cwd: "/" })
    return linter.verify(
        code,
        [{ files: ["**/*.tsx"], ...config, languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } }, settings }] as Linter.Config[],
        { filename },
    )
}

const ids = (messages: Linter.LintMessage[]) => messages.map((m) => `${m.ruleId}:${m.line}`)

describe("plugin shape", () => {
    test("exports every rule with meta, docs url and messages", () => {
        assert.deepEqual(Object.keys(rules).sort(), [...RULE_IDS].sort())
        assert.equal(plugin.rules, rules)
        assert.equal(plugin.meta.name, "@livesession/libstylist")
        assert.equal(plugin.meta.namespace, "libstylist")
        assert.match(plugin.meta.version, /^\d+\.\d+\.\d+/)
        for (const [name, rule] of Object.entries(rules)) {
            assert.equal(rule.meta.docs?.url, ruleDocsUrl(name), name)
            assert.match(rule.meta.docs?.url ?? "", new RegExp(`docs/RULES\\.md#${name}$`))
            assert.ok(rule.meta.docs?.description, `${name} has a description`)
            assert.equal(rule.meta.type, "problem", name)
            assert.ok(Object.keys(rule.meta.messages).length > 0, name)
        }
    })

    test("recommended enables every rule as an error; stories is the story-safe subset", () => {
        assert.equal(configs, plugin.configs)
        assert.equal(configs.recommended.plugins?.libstylist, plugin)
        assert.deepEqual(configs.recommended.rules, Object.fromEntries(RULE_IDS.map((id) => [`libstylist/${id}`, "error"])))
        assert.deepEqual(Object.keys(configs.stories.rules ?? {}).sort(), STORY_RULES.map((r) => `libstylist/${r}`).sort())
        for (const r of ["no-classname", "no-literal-class", "forward-props", "root-part", "tag-name", "data-in-cx"]) assert.ok(!(`libstylist/${r}` in (configs.stories.rules ?? {})), r)
    })
})

describe("end to end (Linter + recommended)", () => {
    test("a migrated component is clean", () => {
        const code = `import * as React from "react"

import { CloseIcon, InfoIcon } from "@livesession/eloquentui-icons"
import { alert as cn } from "@livesession/eloquentui-css"
import { cx } from "@livesession/libstylist/runtime"

import { Icon } from "../Icon"

export function Alert({ variant = "info", title, children, onClose, role = "status", ...props }: AlertProps) {
    const ref = React.useRef<HTMLElement>(null)
    React.useEffect(() => {
        ref.current?.querySelector("[data-autofocus]")
        ref.current?.setAttribute("data-ready", "true")
    }, [])
    return (
        <elo-alert {...cx(cn.root, props, { variant, hasTitle: !!title })} role={role}>
            <span {...cx(cn.icon)}>
                <Icon {...cx(cn.glyph)} icon={InfoIcon} size="medium" />
            </span>
            <span {...cx(cn.content)}>{title ? <span {...cx(cn.title)}>{title}</span> : null}{children}</span>
            {onClose ? (
                <button type="button" {...cx(cn.close)} aria-label="Close" onClick={() => onClose()}>
                    <Icon icon={CloseIcon} size="medium" />
                </button>
            ) : null}
            <svg viewBox="0 0 4 4"><circle cx={2} cy={2} r={1} /></svg>
        </elo-alert>
    )
}
`
        assert.deepEqual(lint(code), [])
    })

    test("a migrated semantic root (marker on a polymorphic element) is clean", () => {
        const code = `import { button as cn } from "@livesession/eloquentui-css"
import { cx } from "@livesession/libstylist/runtime"

export function Button({ as: As = "button", loading, children, ...props }: ButtonProps) {
    return (
        <As elo-button {...cx(cn.root, props, { kind: "primary", loading })}>
            <span {...cx(cn.children)}><span {...cx(cn.label)}>{children}</span></span>
        </As>
    )
}
`
        assert.deepEqual(lint(code), [])
    })

    test("pre-migration source reports the definite violations only", () => {
        const code = `import * as React from "react"

import { alert as cn } from "@livesession/eloquentui-css"

import { cx } from "../../utils/cx"

export function Alert({ className, open }: AlertProps) {
    React.useEffect(() => {
        document.body.classList.add("modal-open")
        const host = document.createElement("div")
        host.querySelector(".ls-alert__icon")
    }, [])
    return (
        <div className={cx(cn.root, open && "open", className)} data-component="Alert">
            <span className={cn.icon} data-part="icon" />
        </div>
    )
}
`
        assert.deepEqual(ids(lint(code)).sort(), [
            "libstylist/no-anonymous-container:10",
            "libstylist/no-class-query:11",
            "libstylist/no-classname:14",
            "libstylist/no-classname:15",
            "libstylist/no-dev-attrs:14",
            "libstylist/no-dev-attrs:15",
            "libstylist/no-hash-literal:11",
            "libstylist/no-imperative-class:9",
            "libstylist/no-literal-class:14",
        ])
    })

    test("stories config leaves story layout classes alone but bans hooks and hashes", () => {
        const code = `export const Grid = () => (
    <table className="sb-table">
        <tr><td className="small" data-component="Cell">x</td></tr>
    </table>
)
export const play = ({ canvasElement }) => canvasElement.querySelector("[_cxclass_elo-or4d4l]")
`
        assert.deepEqual(ids(lint(code, configs.stories, "/virtual/Grid.stories.tsx")).sort(), ["libstylist/no-dev-attrs:3", "libstylist/no-hash-literal:6"])
    })

    test("the removed syntax is reported by no-cx-attribute", () => {
        const code = `/** @cxScope alert */\nconst el = <span cx="icon" />\n`
        assert.deepEqual(ids(lint(code)).filter((i) => i.startsWith("libstylist/no-cx-attribute")), ["libstylist/no-cx-attribute:1", "libstylist/no-cx-attribute:2"])
    })

    test("autofix pass normalizes root parts, data attributes, markers and dev attributes", () => {
        const linter = new Linter({ configType: "flat", cwd: "/" })
        const code = `import { button as cn } from "@livesession/eloquentui-css"
import { cx } from "@livesession/libstylist/runtime"
const b = <button elo-button={true} {...cx(props)} _cxpart="x" data-kind="primary"><span {...cx(cn.label)} data-open /></button>
`
        const out = linter.verifyAndFix(
            code,
            [{ files: ["**/*.tsx"], ...configs.recommended, languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } }, settings }] as Linter.Config[],
            { filename: "/virtual/Button.tsx" },
        )
        assert.equal(
            out.output,
            `import { button as cn } from "@livesession/eloquentui-css"
import { cx } from "@livesession/libstylist/runtime"
const b = <button elo-button {...cx(cn.root, props, { kind: "primary" })}><span {...cx(cn.label, { open: true })} /></button>
`,
        )
        assert.deepEqual(out.messages, [])
    })
})

describe("legacy() tally", () => {
    test("counts sanctioned legacy() className values per file", () => {
        resetLegacyUsage()
        const code = `import { legacy } from "@livesession/libstylist/runtime"
const a = <div className={legacy("hover")} />
const b = <div inputClassName={legacy("x", on && "y")} />
`
        assert.deepEqual(lint(code, { plugins: { libstylist: plugin }, rules: { "libstylist/no-classname": "error" } }, "/virtual/A.tsx"), [])
        assert.equal(legacyUsage().get("/virtual/A.tsx"), 2)
        assert.equal(legacyUsageTotal(), 2)
        // A const props object spread twice is one use.
        lint(`import { legacy } from "@livesession/libstylist/runtime"\nconst p = { className: legacy("x") }\nconst a = <i {...p} />\nconst b = <b {...p} />`, { plugins: { libstylist: plugin }, rules: { "libstylist/no-classname": "error" } }, "/virtual/B.tsx")
        assert.equal(legacyUsage().get("/virtual/B.tsx"), 1)
        // A literal hook with a nested caller pass-through is two uses.
        lint(`import { legacy, legacyClassName } from "@livesession/libstylist/runtime"\nconst a = <i className={legacy("icon-wrapper", legacyClassName(className))} />`, { plugins: { libstylist: plugin }, rules: { "libstylist/no-classname": "error" } }, "/virtual/C.tsx")
        assert.equal(legacyUsage().get("/virtual/C.tsx"), 2)
        lint(`const a = 1`, { plugins: { libstylist: plugin }, rules: { "libstylist/no-classname": "error" } }, "/virtual/A.tsx")
        assert.equal(legacyUsage().has("/virtual/A.tsx"), false)
        resetLegacyUsage()
        assert.equal(legacyUsageTotal(), 0)
    })
})

describe("settings validation", () => {
    const withSettings = (libstylist: object) => {
        const linter = new Linter({ configType: "flat", cwd: "/" })
        return linter.verify(`<div />`, [{ files: ["**/*.tsx"], ...configs.recommended, languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } }, settings: { libstylist } }] as Linter.Config[], {
            filename: "/virtual/A.tsx",
        })
    }

    test("wrongly typed fields fail with a readable error instead of a TypeError deep in a rule", () => {
        assert.throws(() => withSettings({ prefix: "elo", rootLocals: { "Modal.Header": true } }), /settings\.libstylist\.rootLocals must be a map/)
        assert.throws(() => withSettings({ prefix: "elo", segments: "app" }), /settings\.libstylist\.segments must be an array of strings/)
        assert.throws(() => withSettings({ prefix: 1 }), /settings\.libstylist\.prefix must be a string/)
        assert.throws(() => withSettings({ prefix: "elo", registry: 3 }), /settings\.libstylist\.registry must be a path or a registry object/)
        assert.deepEqual(withSettings({ prefix: "elo", namespace: "core", segments: [], rootLocals: { "elo-alert": false, "Modal.Header": "header" } }), [])
        // null switches a field off (flat config can only override merged settings, never delete them).
        assert.deepEqual(withSettings({ prefix: "elo", namespace: "core", segments: null, registry: null, rootLocals: null }), [])
    })

    // app-3: part maps are recognized by package specifier only — a path would silently match no import
    test("a relative or absolute partMaps value fails with the alias recipe", () => {
        assert.throws(() => withSettings({ prefix: "elo", partMaps: { app: "../styles-dist/parts" } }), /settings\.libstylist\.partMaps\.app is the path "\.\.\/styles-dist\/parts" — part maps are recognized by their package specifier only[\s\S]*tsconfig paths/)
        assert.deepEqual(withSettings({ prefix: "elo", namespace: "core", segments: [], partMaps: { app: "@app/styles" } }), [])
    })
})

// app-8: the CONFIG.md lint snippet, copied as written, must parse TypeScript/TSX and run the rules
describe("the CONFIG.md lint snippet", () => {
    test("copied as written, it lints a .tsx file (a TS parser is configured) and the libstylist rules fire", async () => {
        const doc = readFileSync(fileURLToPath(new URL("../docs/CONFIG.md", import.meta.url)), "utf8")
        const section = doc.slice(doc.indexOf("\n## Lint\n"))
        const snippet = /```js\n(\/\/ eslint\.config\.mjs\n[\s\S]*?)```/.exec(section)?.[1]
        assert.ok(snippet, "the eslint.config.mjs snippet")
        assert.match(snippet, /import tseslint from "typescript-eslint"/)
        // run it as a module: its imports resolved to this package's sources and its typescript-eslint devDependency
        const dir = mkdtempSync(join(tmpdir(), "libstylist-config-snippet-"))
        try {
            const code = snippet
                .replace(`"@livesession/libstylist/eslint"`, JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/eslint/index.ts", import.meta.url))).href))
                .replace(`"typescript-eslint"`, JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("typescript-eslint")).href))
            writeFileSync(join(dir, "eslint.config.mjs"), code)
            const config = (await import(pathToFileURL(join(dir, "eslint.config.mjs")).href)).default as Linter.Config[]
            const linter = new Linter({ configType: "flat", cwd: dir })
            const source = `import { cx } from "@livesession/libstylist/runtime"\ntype P = { open?: boolean }\nexport function A({ open }: P) {\n    return <span className="x" data-open={open ? "true" : undefined} {...cx({ a: 1 })} />\n}\n`
            const messages = linter.verify(source, config, { filename: join(dir, "packages/ui/src/A.tsx") })
            assert.ok(!messages.some((m) => m.fatal), JSON.stringify(messages))
            const fired = new Set(messages.map((m) => m.ruleId))
            for (const rule of ["libstylist/no-classname", "libstylist/data-in-cx"]) assert.ok(fired.has(rule), `${rule} in ${JSON.stringify(messages)}`)
            const story = linter.verify(`const s: number = 1\nexport const S = () => <div data-part="x" />\n`, config, { filename: join(dir, "src/A.stories.tsx") })
            assert.ok(!story.some((m) => m.fatal), JSON.stringify(story))
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

// A workspace of app packages: each package's src/render is the `render` namespace (tags <crm-render-…>),
// the rest its base `core` namespace; components of the package are imported through `#components`.
describe("directory namespaces (a workspace of app packages)", () => {
    const root = mkdtempSync(join(tmpdir(), "libstylist-crm-"))
    after(() => rmSync(root, { recursive: true, force: true }))
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
    mkdirSync(join(root, "packages", "accounts"), { recursive: true })
    writeFileSync(
        join(root, "packages", "accounts", "package.json"),
        JSON.stringify({ name: "@crm/accounts", imports: { "#components": "./src/components/index.ts" }, libstylist: { prefix: "crm", namespace: "core", namespaces: { "src/render": "render" } } }),
    )
    const lintAt = (rel: string, code: string, ruleIds: string[]) => {
        clearContextCaches()
        const linter = new Linter({ configType: "flat", cwd: root })
        return linter.verify(
            code,
            [
                {
                    files: ["**/*.tsx"],
                    plugins: { libstylist: plugin },
                    rules: Object.fromEntries(ruleIds.map((id) => [`libstylist/${id}`, "error"])),
                    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
                    // no prefix, namespace or segments: everything comes from the package.json
                    settings: { libstylist: { partMaps: { accounts: "#css", "accounts.render": "#css" } } },
                },
            ] as Linter.Config[],
            { filename: join(root, "packages", "accounts", rel) },
        )
    }
    const found = (messages: Linter.LintMessage[]) => messages.map((m) => `${m.ruleId}:${m.messageId}`)

    test("segment discovery finds the render segment of the package's directory namespace", () => {
        clearContextCaches()
        assert.deepEqual(discoverSegments(root, "crm"), ["render"])
    })

    test("tag-name: a src/render file writes <crm-render-…>; a base-namespace file never starts a tag with the render segment", () => {
        const F = `import { cx } from "@livesession/libstylist/runtime"\n`
        assert.deepEqual(found(lintAt("src/render/RenderAccounts.tsx", `${F}export const RenderAccounts = (p: object) => <crm-render-accounts {...cx(p)} />`, ["tag-name"])), [])
        assert.deepEqual(found(lintAt("src/render/RenderAccounts.tsx", `${F}export const RenderAccounts = (p: object) => <crm-accounts {...cx(p)} />`, ["tag-name"])), ["libstylist/tag-name:segment"])
        assert.deepEqual(found(lintAt("src/components/Accounts.tsx", `${F}export const Accounts = (p: object) => <crm-accounts {...cx(p)} />`, ["tag-name"])), [])
        assert.deepEqual(found(lintAt("src/components/Accounts.tsx", `${F}export const Accounts = (p: object) => <crm-render-x {...cx(p)} />`, ["tag-name"])), ["libstylist/tag-name:foreignSegment"])
        // src/renderer is not src/render: its files are in the base namespace
        assert.deepEqual(found(lintAt("src/renderer/Row.tsx", `${F}export const Row = (p: object) => <crm-render-row {...cx(p)} />`, ["tag-name"])), ["libstylist/tag-name:foreignSegment"])
        assert.match(lintAt("src/render/RenderAccounts.tsx", `<crm-accounts />`, ["tag-name"])[0].message, /render tags start with `crm-render-`/)
    })

    test("data-in-cx and cx-args: a component imported through #components is this package's libstylist component", () => {
        const own = `import { cx } from "@livesession/libstylist/runtime"\nimport { AccountsList } from "#components"\n`
        const vendor = `import { cx } from "@livesession/libstylist/runtime"\nimport { DataGrid } from "data-grid"\n`
        // a data-* attribute on it is one of its props, not the element's data
        assert.deepEqual(found(lintAt("src/render/A.tsx", `${own}export const A = (p: { open: boolean }) => <AccountsList data-open={p.open} {...cx(p)} />`, ["data-in-cx"])), [])
        assert.deepEqual(found(lintAt("src/render/A.tsx", `${vendor}export const A = (p: { open: boolean }) => <DataGrid data-open={p.open} {...cx(p)} />`, ["data-in-cx"])), ["libstylist/data-in-cx:move"])
        // and a data literal spread on it renders nothing (its cx() forwards parts and markers only)
        assert.deepEqual(found(lintAt("src/render/A.tsx", `${own}export const A = (p: { open: boolean }) => <AccountsList {...cx(p, { open: p.open })} />`, ["cx-args"])), ["libstylist/cx-args:componentData"])
        assert.deepEqual(found(lintAt("src/render/A.tsx", `${vendor}export const A = (p: { open: boolean }) => <DataGrid {...cx(p, { open: p.open })} />`, ["cx-args"])), [])
    })
})

describe("helpers", () => {
    test("edit distance counts transpositions once; nearest only suggests plausible typos", () => {
        assert.equal(editDistance("titel", "title"), 1)
        assert.equal(editDistance("kitten", "sitting"), 3)
        assert.equal(editDistance("", "abc"), 3)
        assert.equal(editDistance("icon", "icon"), 0)
        assert.equal(nearest("icn", ["content", "icon", "root"]), "icon")
        assert.equal(nearest("inputwrapper", ["wrapper", "input-wrapper"]), "input-wrapper")
        assert.equal(nearest("zzzz", ["icon", "root"]), null)
        assert.equal(nearest("icon", ["icon"]), null)
    })

    test("firstClassSelector parses selectors and ignores attribute values", () => {
        assert.equal(firstClassSelector(".a b"), "a")
        assert.equal(firstClassSelector("div > span.b:hover"), "b")
        assert.equal(firstClassSelector(`[x=".y"]`), null)
        assert.equal(firstClassSelector("[elo-button], elo-alert"), null)
        assert.equal(firstClassSelector("["), null)
    })

    test("no-hash-literal skips a part-map module the workspace build generated (its header), not a hand-written one", () => {
        const map = `import "./accounts-list.css"\n\nexport const accountsList = {\n    root: "_cxclass_crm-3k2j9a",\n} as const\n`
        const hashes = (code: string) => ids(lint(code, configs.recommended, "/virtual/src/css/index.tsx")).filter((id) => id.startsWith("libstylist/no-hash-literal"))
        assert.deepEqual(hashes(`${PART_MAP_HEADER}\n${map}`), [])
        assert.deepEqual(hashes(`// part maps\n${map}`), ["libstylist/no-hash-literal:5"])
    })

    test("hashLiteralMatch finds part hashes and retired ls-* classes", () => {
        assert.deepEqual(hashLiteralMatch("[_cxclass_elo-or4d4l]"), { kind: "hash", match: "_cxclass_elo-or4d4l" })
        assert.deepEqual(hashLiteralMatch("a .ls-alert b"), { kind: "legacyClass", match: ".ls-alert" })
        assert.deepEqual(hashLiteralMatch("ls-text-input__wrapper"), { kind: "legacyClass", match: "ls-text-input__wrapper" })
        assert.equal(hashLiteralMatch("ls-checkbox-label"), null)
        assert.equal(hashLiteralMatch("tools-a__b"), null)
    })

    test("segment discovery reads pnpm workspace packages and css groups", () => {
        const root = mkdtempSync(join(tmpdir(), "libstylist-ws-"))
        after(() => rmSync(root, { recursive: true, force: true }))
        const pkg = (dir: string, libstylist: object) => {
            mkdirSync(join(root, dir), { recursive: true })
            writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir, libstylist }))
        }
        writeFileSync(join(root, "pnpm-workspace.yaml"), `packages:\n  - "libs/*"\n  - 'tools/one' # comment\n\nonlyBuiltDependencies:\n  - esbuild\n`)
        pkg("libs/core", { prefix: "elo", namespace: "core" })
        pkg("libs/player", { prefix: "elo", namespace: "player" })
        pkg("libs/infinity", { prefix: "elo", namespace: "inf" })
        pkg("libs/other", { prefix: "app", namespace: "shop" })
        pkg("libs/css", { prefix: "elo", groups: { extra: { namespace: "gram" } } })
        pkg("tools/one", { prefix: "elo", namespace: "ai", segment: "aix" })
        pkg("tools/two", { prefix: "elo", namespace: "skipped" })
        // directory namespaces add their segments (a core package with a render layer: `render`)
        pkg("libs/crm", { prefix: "elo", namespace: "core", namespaces: { "src/render": "render", "src/legacy": { namespace: "old", segment: "legacy" } } })
        assert.deepEqual(discoverSegments(root, "elo"), ["aix", "gram", "inf", "legacy", "player", "render"])
        assert.deepEqual(discoverSegments(root, "app"), ["shop"])
    })

    test("segment discovery on the design-system repository", { skip: skipWithoutDesignSystem }, () => {
        assert.deepEqual(discoverSegments(designSystemPath(), "elo"), ["ai", "app", "charts", "clickmaps", "code", "devtools", "gram", "inf", "player", "replayinspector", "rich", "unity"])
    })

    test("loadRegistry: object, path relative to cwd, missing file, reload on change, bad JSON", () => {
        const dir = mkdtempSync(join(tmpdir(), "libstylist-reg-"))
        after(() => rmSync(dir, { recursive: true, force: true }))
        assert.equal(loadRegistry({}, dir), null)
        assert.equal(loadRegistry({ registry }, dir), registry)
        assert.equal(loadRegistry({ registry: "missing.json" }, dir), null)
        const file = join(dir, "stylist-registry.json")
        writeFileSync(file, JSON.stringify(registry))
        assert.deepEqual(Object.keys(loadRegistry({ registry: "stylist-registry.json" }, dir)?.scopes ?? {}), ["alert", "button"])
        writeFileSync(file, JSON.stringify({ ...registry, scopes: { alert: registry.scopes.alert } }))
        utimesSync(file, new Date(), new Date(Date.now() + 5000))
        assert.deepEqual(Object.keys(loadRegistry({ registry: file }, "/")?.scopes ?? {}), ["alert"])
        writeFileSync(file, "{ nope")
        utimesSync(file, new Date(), new Date(Date.now() + 10000))
        assert.throws(() => loadRegistry({ registry: file }, dir), /cannot read the stylist registry/)
        assert.throws(() => loadRegistry({ registry: { version: 1 } as never }, dir), /not a stylist registry/)
    })
})
