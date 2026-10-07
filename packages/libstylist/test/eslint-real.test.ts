// The ESLint plugin on real inputs (the design-system checkout LIBSTYLIST_DESIGN_SYSTEM names — see
// ./design-system.ts; every test skips without it): every design-system source (read-only) lints clean and
// every story file lints without a crash, and real components on the cx() call API — written at their real
// package paths, so package configs, segment discovery and the registry built from the real sheets are all
// live — lint clean under `recommended`, while a deliberate mistake in each is reported exactly.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { after, describe, test } from "node:test"

import tsParser from "@typescript-eslint/parser"
import { ESLint, Linter } from "eslint"

import { clearContextCaches, configs } from "../src/eslint/index.js"
import { buildRegistry, type RegistryGroup } from "../src/registry/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

const skip = skipWithoutDesignSystem

const GROUPS: Record<string, RegistryGroup> = {
    components: { namespace: "core" },
    "app-ui": { namespace: "app" },
    player: { namespace: "player" },
    gram: { namespace: "gram" },
    infinity: { namespace: "inf" },
    ai: { namespace: "ai" },
}
const PACKAGES = ["components", "app-ui", "player", "gram", "infinity", "ai"]
const PART_MAPS = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, g === "components" ? "@livesession/eloquentui-css" : `@livesession/eloquentui-css/${g}`]))

interface RealRegistry {
    built: ReturnType<typeof buildRegistry>
    /** The registry written to a scratch file, the way `settings.libstylist.registry` names it. */
    registryPath: string
}

let cached: RealRegistry | undefined
let scratch: string | null = null
after(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
})

/** The registry built from the real sheets — once per process, and only when a gated test runs. */
function real(): RealRegistry {
    if (cached) return cached
    const cssSrc = designSystemPath("packages", "css", "src")
    const sheets = Object.keys(GROUPS).flatMap((group) =>
        readdirSync(join(cssSrc, group))
            .filter((f) => f.endsWith(".css"))
            .sort()
            .map((f) => ({ file: `packages/css/src/${group}/${f}`, group, css: readFileSync(join(cssSrc, group, f), "utf8") })),
    )
    const built = buildRegistry({ prefix: "elo", groups: GROUPS, sheets })
    scratch = mkdtempSync(join(tmpdir(), "libstylist-eslint-real-"))
    const registryPath = join(scratch, "stylist-registry.json")
    writeFileSync(registryPath, JSON.stringify(built.registry))
    return (cached = { built, registryPath })
}

const languageOptions = { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } }
const FILES = ["**/*.ts", "**/*.tsx"]

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir).sort()) {
        if (name === "node_modules" || name === "dist") continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path, out)
        else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path)
    }
    return out
}

function lint(code: string, filename: string, config: object = configs.recommended, settings: object = {}): Linter.LintMessage[] {
    const linter = new Linter({ configType: "flat", cwd: designSystemPath() })
    const libstylist = { registry: real().registryPath, partMaps: PART_MAPS, ...settings }
    return linter.verify(code, [{ files: FILES, ...config, languageOptions, settings: { libstylist } }] as Linter.Config[], { filename })
}

const ours = (messages: Linter.LintMessage[]) => messages.filter((m) => m.ruleId?.startsWith("libstylist/") || m.fatal)
/** The real path of a source in a design-system package. */
const at = (pkg: string, path: string) => designSystemPath("packages", pkg, "src", path)

test("the registry built from the real sheets has no errors", { skip }, () => {
    assert.deepEqual(real().built.errors, [])
})

describe("real sources", () => {
    test("every design-system source file (on the cx() call API) lints clean under `recommended`", { skip }, (t) => {
        const REPO = designSystemPath()
        clearContextCaches()
        const files = PACKAGES.flatMap((p) => walk(join(REPO, "packages", p, "src"))).filter((f) => !/\.(stories|test|spec)\.tsx?$/.test(f))
        assert.ok(files.length > 150, `found ${files.length} source files`)
        const reports: string[] = []
        for (const file of files) {
            for (const m of lint(readFileSync(file, "utf8"), file)) reports.push(`${relative(REPO, file)}:${m.line} ${m.ruleId}: ${m.message}`)
        }
        assert.deepEqual(reports, [])
        t.diagnostic(`${files.length} files lint clean`)
    })

    test("every story lints under `stories` without a crash or parse error", { skip }, (t) => {
        const REPO = designSystemPath()
        const files = [...walk(join(REPO, "apps", "eloquentui", "stories")), ...PACKAGES.flatMap((p) => walk(join(REPO, "packages", p, "src")))].filter((f) =>
            /\.stories\.tsx?$/.test(f),
        )
        assert.ok(files.length > 100, `found ${files.length} story files`)
        let reports = 0
        for (const file of files) {
            const messages = lint(readFileSync(file, "utf8"), file, configs.stories, { prefix: "elo" })
            assert.deepEqual(messages.filter((m) => m.fatal), [], relative(REPO, file))
            reports += ours(messages).length
        }
        t.diagnostic(`${files.length} stories, ${reports} reports`)
    })
})

const RT = `import { cx } from "@livesession/libstylist/runtime"\n`
const CSS = "@livesession/eloquentui-css"

/**
 * Migrated versions of real components, at the path of the real source (`packages/<pkg>/src/<path>`), and a
 * mistake each (applied to every occurrence).
 */
const MIGRATED: Array<{ name: string; pkg: string; path: string; code: string; settings?: object; mistake: [string, string]; expect: string[] }> = [
    {
        name: "core Alert (custom tag)",
        pkg: "components",
        path: "components/Alert/Alert.tsx",
        code: `import { alert as cn } from "${CSS}"
${RT}import { Icon } from "../Icon"

export function Alert({ title, children, action, onClose, ...rest }: AlertProps) {
    return (
        <elo-alert {...cx(cn.root, rest, { hasTitle: !!title })} role="status">
            <span {...cx(cn.icon)}><Icon icon={InfoIcon} size="medium" /></span>
            <span {...cx(cn.content)}>
                {title && <span {...cx(cn.title)}>{title}</span>}
                {children}
            </span>
            {action && <span {...cx(cn.action)}>{action}</span>}
            {onClose ? <button type="button" {...cx(cn.close)} aria-label="Close" onClick={() => onClose()} /> : null}
        </elo-alert>
    )
}
`,
        mistake: [`cx(cn.icon)`, `cx(cn.icn)`],
        expect: ["libstylist/cx-part-exists"],
    },
    {
        name: "core Button (marker on a polymorphic element; state as data)",
        pkg: "components",
        path: "components/Button/Button.tsx",
        code: `import * as React from "react"

import { button as cn } from "${CSS}"
${RT}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ as: As = "button", loading, children, ...rest }, ref) {
    return (
        <As elo-button {...cx(cn.root, rest, { loading, kind: "primary" })} ref={ref}>
            <div {...cx(cn.content)}>
                <span {...cx(cn.children)}><span {...cx(cn.label)}>{children}</span></span>
            </div>
        </As>
    )
})
`,
        mistake: [`<As elo-button {...cx(cn.root, rest, { loading, kind: "primary" })}`, `<As elo-button="true" {...cx(rest, { loading, kind: "primary" })}`],
        expect: ["libstylist/marker-attr", "libstylist/root-part"],
    },
    {
        name: "core CopyButton (marker forwarded onto a child component, with its own parts)",
        pkg: "components",
        path: "components/CopyButton/CopyButton.tsx",
        code: `import { copyButton as cn } from "${CSS}"
${RT}import { Button } from "../Button"

export function CopyButton({ value, ...rest }: CopyButtonProps) {
    return (
        <Button elo-copybutton {...cx(cn.root, cn.button, rest)} onClick={() => copy(value)}>
            <span {...cx(cn.status)} aria-live="polite" />
        </Button>
    )
}
`,
        mistake: [`cn.button, rest)`, `cn.button)`],
        expect: ["libstylist/forward-props"],
    },
    {
        name: "core Modal family (member root bound through settings)",
        pkg: "components",
        path: "components/Modal/Modal.tsx",
        settings: { rootLocals: { "Modal.Header": "header" } },
        code: `import { modal as cn } from "${CSS}"
${RT}
export function Modal({ children, ...rest }: ModalProps) {
    return (
        <elo-modal {...cx(cn.root, rest)} role="dialog">
            <div {...cx(cn.frame)}>{children}</div>
        </elo-modal>
    )
}

function Header({ children, ...rest }: ModalHeaderProps) {
    return (
        <elo-modal-header {...cx(cn.header, rest)}>
            <span {...cx(cn.title)}>{children}</span>
        </elo-modal-header>
    )
}

Modal.Header = Header
`,
        mistake: [`<span {...cx(cn.title)}>`, `<span {...cx(cn.header)}>`],
        expect: ["libstylist/root-part"],
    },
    {
        name: "core TextInput (slot target) and a tooltip on a Radix-owned native host",
        pkg: "components",
        path: "components/TextInput/TextInput.tsx",
        code: `import { textInput as cn } from "${CSS}"
${RT}
export function TextInput({ inputCx, label, ...rest }: TextInputProps) {
    return (
        <elo-textinput {...cx(cn.root, rest)}>
            {label && <label {...cx(cn.label)}>{label}</label>}
            <div {...cx(cn.wrapper)}>
                <input {...cx(cn.field, inputCx)} />
            </div>
        </elo-textinput>
    )
}

/** @libstylistRoot native Radix owns this host and prints its boolean ARIA */
export function Hint(props: HintProps) {
    return <div elo-textinput-hint {...cx(props)} />
}
`,
        mistake: [`<input {...cx(cn.field, inputCx)} />`, `<input {...cx("field", inputCx)} />`],
        expect: ["libstylist/cx-args"],
    },
    {
        name: "inf FilterEditor (sheet root bound `as row`; TextInput through cx + a named slot; filter-tree parts on the plain indent wrapper)",
        pkg: "infinity",
        path: "components/FilterEditor/FilterEditor.tsx",
        code: `import { TextInput } from "@livesession/eloquentui-react"
import { filterEditor as cn, filterTree } from "${CSS}/infinity"
${RT}
export function FilterEditor({ indent, onDelete, ...rest }: FilterEditorProps) {
    const row = (
        <elo-inf-filtereditor {...cx(cn.row, rest)}>
            <TextInput {...cx(cn["value-input"])} inputCx={cx(cn.value)} />
            <button type="button" {...cx(cn["delete-chip"])} onClick={onDelete} />
        </elo-inf-filtereditor>
    )
    if (!indent) return row
    return (
        <div {...cx(filterTree.node)}>
            <span {...cx(filterTree.connector)} aria-hidden="true" />
            <div {...cx(filterTree.content)}>{row}</div>
        </div>
    )
}
`,
        mistake: [`elo-inf-filtereditor`, `elo-filtereditor`],
        expect: ["libstylist/tag-name"],
    },
    {
        name: "player PlayerTopBar with a member (namespace word stripped, member bound through settings)",
        pkg: "player",
        path: "components/PlayerTopBar/PlayerTopBar.tsx",
        settings: { rootLocals: { "PlayerTopBar.Url": "url" } },
        code: `import { playerTopBar as cn, playerControls } from "${CSS}/player"
${RT}
export function PlayerTopBar({ url, ...rest }: PlayerTopBarProps) {
    return (
        <elo-player-topbar {...cx(cn.root, rest)}>
            <div {...cx(cn.row)}>
                <Url href={url} />
            </div>
        </elo-player-topbar>
    )
}

function Url({ href, ...rest }: UrlProps) {
    return (
        <elo-player-topbar-url {...cx(cn.url, rest)}>
            <span {...cx(cn["url-label"])}>{href}</span>
        </elo-player-topbar-url>
    )
}

PlayerTopBar.Url = Url
`,
        mistake: [`<div {...cx(cn.row)}>`, `<div {...cx(playerControls.row)}>`],
        expect: ["libstylist/cx-part-exists"],
    },
    {
        name: "gram ListCollection.Root (a trailing Root member collapses into its parent)",
        pkg: "gram",
        path: "components/ListCollection/ListCollection.tsx",
        code: `import { listCollection as cn } from "${CSS}/gram"
${RT}
function Root({ children, ...rest }: ListCollectionRootProps) {
    return (
        <elo-gram-listcollection {...cx(cn.root, rest)}>
            <ul {...cx(cn.list)}>{children}</ul>
        </elo-gram-listcollection>
    )
}

export const ListCollection = { Root }
`,
        mistake: [`<ul {...cx(cn.list)}>`, `<ul className="list" {...cx(cn.list)}>`],
        expect: ["libstylist/no-classname", "libstylist/no-literal-class"],
    },
    {
        name: "app Dock (real list markup, app segment)",
        pkg: "app-ui",
        path: "components/Dock/Dock.tsx",
        code: `import { dock as cn } from "${CSS}/app-ui"
${RT}
export function Dock({ children, ...rest }: DockProps) {
    return (
        <elo-app-dock {...cx(cn.root, rest)}>
            <ul {...cx(cn.menu)}>{children}</ul>
        </elo-app-dock>
    )
}

Dock.MenuItem = function MenuItem({ href, selected, children, ...rest }: MenuItemProps) {
    return (
        <li elo-app-dock-menuitem {...cx(cn.item, rest)}>
            <a {...cx(cn.link, { selected: selected ? "true" : undefined })} href={href}>{children}</a>
        </li>
    )
}
`,
        mistake: [`<li elo-app-dock-menuitem {...cx(cn.item, rest)}`, `<li elo-app-dock-menuitem {...cx(cn.item, rest)} data-part="item"`],
        expect: ["libstylist/no-dev-attrs"],
    },
    {
        name: "ai ThinkingShader (SVG geometry cx untouched, portal host with a named tag)",
        pkg: "ai",
        path: "components/ThinkingShader/ThinkingShader.tsx",
        code: `import { thinkingShader as cn } from "${CSS}/ai"
${RT}
export function ThinkingShader(props: ThinkingShaderProps) {
    const host = document.createElement("elo-ai-thinkingshader-portal")
    host.setAttribute("data-open", "")
    return (
        <elo-ai-thinkingshader {...cx(cn.root, props)}>
            <svg viewBox="0 0 10 10"><circle cx={5} cy={5} r={4} /><radialGradient cx="50%" /></svg>
        </elo-ai-thinkingshader>
    )
}
`,
        mistake: [`host.setAttribute("data-open", "")`, `host.classList.add("open")`],
        expect: ["libstylist/no-imperative-class"],
    },
    {
        name: "a raw data-* attribute and a leftover cx attribute are reported with the call-API fix",
        pkg: "components",
        path: "components/Badge/Badge.tsx",
        code: `import { badge as cn } from "${CSS}"
${RT}
export function Badge({ size, children, ...rest }: BadgeProps) {
    return <elo-badge {...cx(cn.root, rest, { size })}>{children}</elo-badge>
}
`,
        mistake: [`{...cx(cn.root, rest, { size })}>`, `{...cx(cn.root, rest)} data-size={size} cx="text">`],
        expect: ["libstylist/data-in-cx", "libstylist/no-cx-attribute"],
    },
]

describe("migrated real components lint clean against the real registry", () => {
    for (const c of MIGRATED) {
        test(c.name, { skip }, () => {
            const file = at(c.pkg, c.path)
            assert.deepEqual(ours(lint(c.code, file, configs.recommended, c.settings)), [])
            const [from, to] = c.mistake
            assert.ok(c.code.includes(from), `mistake anchor present: ${from}`)
            const broken = ours(lint(c.code.split(from).join(to), file, configs.recommended, c.settings))
            assert.deepEqual([...new Set(broken.map((m) => m.ruleId))].sort(), [...c.expect].sort(), JSON.stringify(broken.map((m) => `${m.ruleId}: ${m.message}`)))
        })
    }
})

test("the plugin loads through the ESLint class and reports on a real package path", { skip }, async () => {
    const eslint = new ESLint({
        cwd: designSystemPath(),
        overrideConfigFile: true,
        overrideConfig: [{ files: FILES, ...configs.recommended, languageOptions, settings: { libstylist: { registry: real().registryPath, partMaps: PART_MAPS } } }] as Linter.Config[],
    })
    const [result] = await eslint.lintText(`/** @cxScope alert */\nexport const A = () => <div className="x" data-component="Alert" />\n`, {
        filePath: at("components", "components/Alert/Probe.tsx"),
    })
    assert.deepEqual(result.messages.map((m) => m.ruleId).sort(), ["libstylist/no-classname", "libstylist/no-cx-attribute", "libstylist/no-dev-attrs", "libstylist/no-literal-class"])
})
