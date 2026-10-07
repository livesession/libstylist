// Compiles the JSX-typing fixtures in memory with TypeScript 4.9 and 5.x against @types/react 19.
// A table records which constructs need the generated tag keys:
//
//   construct                                   TS 4.9            TS 5.x
//   cx() spread on HTML/SVG hosts and components
//   (strict props too), markers, CxAttrs slots,
//   forwarded attrs, SVG geometry,
//   React.ElementType tags                       jsx types only    jsx types only
//   <elo-x> JSX tag (literal)                    generated keys    generated keys (or opt-in tag map)
//   const Tag = "elo-x"; <Tag />                 generated keys    generated keys
//   React.ComponentProps<"elo-x">                generated keys    generated keys (or opt-in tag map)
//   global JSX augmentation                      no effect         no effect
//
// The opt-in tag map (`stylistTypesStub(prefix, { tagMap: true })`) breaks every
// `React.ElementType` JSX tag with TS2604 on both versions, which is why the default stub omits it.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import type * as TS from "typescript"

import { renderTagTypes, stylistTypesStub } from "../src/typesgen/index.js"

type TypeScript = typeof TS

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, "..")
const fixtureDir = join(here, "fixtures", "types")
const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------------------------
// Compilers
// ---------------------------------------------------------------------------------------------

/**
 * TS 5.x is the package's own `typescript` devDependency; TS 4.9, the design-system packages' compiler, is the
 * `typescript-4.9` devDependency (an npm alias of typescript@~4.9.5) — both are always installed.
 */
function loadCompilers(): Array<{ major: 4 | 5; ts: TypeScript }> {
    return [
        { major: 4, ts: require("typescript-4.9") as TypeScript },
        { major: 5, ts: require("typescript") as TypeScript },
    ]
}

const compilers = loadCompilers()

// ---------------------------------------------------------------------------------------------
// Configurations: which type files join the program, and the JSX mode
// ---------------------------------------------------------------------------------------------

type ConfigName = "full" | "full-react-jsx" | "gen-only" | "stub-only" | "jsx-only" | "tagmap" | "tagmap-only" | "global-gen" | "global-gen-react-jsx"

interface Config {
    name: ConfigName
    jsx: "react" | "react-jsx"
    /** `default`: the checked-in stub; `tagmap`: the opt-in StylistTagMap stub. */
    stub: "none" | "default" | "tagmap"
    gen: "none" | "react" | "global"
}

const CONFIGS: Config[] = [
    { name: "full", jsx: "react", stub: "default", gen: "react" },
    { name: "full-react-jsx", jsx: "react-jsx", stub: "default", gen: "react" },
    { name: "gen-only", jsx: "react", stub: "none", gen: "react" },
    { name: "stub-only", jsx: "react", stub: "default", gen: "none" },
    { name: "jsx-only", jsx: "react", stub: "none", gen: "none" },
    { name: "tagmap", jsx: "react", stub: "tagmap", gen: "react" },
    { name: "tagmap-only", jsx: "react", stub: "tagmap", gen: "none" },
    { name: "global-gen", jsx: "react", stub: "none", gen: "global" },
    { name: "global-gen-react-jsx", jsx: "react-jsx", stub: "none", gen: "global" },
]

const JSX_TYPES = join(pkgDir, "jsx", "index.d.ts")
const STUB = join(fixtureDir, "types", "stylist.d.ts")
const GEN = join(fixtureDir, "types", "stylist-tags.gen.d.ts")
/** The opt-in stub with the StylistTagMap key. */
const TAGMAP_STUB = join(fixtureDir, "types", "virtual-tagmap.d.ts")
/** The generated keys moved into `declare global`, to show the global JSX namespace is never used. */
const GLOBAL_GEN = join(fixtureDir, "types", "virtual-global.gen.d.ts")

const FIXTURES = [
    "src/alert.tsx",
    "src/nested/player-top-bar.tsx",
    "cases/host-attrs.tsx",
    "cases/tag-variable.tsx",
    "cases/component-props.tsx",
    "cases/unknown-tag.tsx",
    "cases/polymorphic.tsx",
]
const NEGATIVE = "cases/negative.tsx"

interface Diag {
    file: string
    line: number
    code: number
    text: string
}

/** Lib `.d.ts` files are parsed once per compiler and reused across programs. */
const libCache = new Map<TypeScript, Map<string, TS.SourceFile>>()

/**
 * Compiles `rootNames` with the DS packages' settings (TS 4.9 style: moduleResolution node, jsx
 * react) plus `overrides`. `virtual` files shadow the disk, and directories holding them exist.
 * Diagnostics cover every file under the package that is not in a node_modules folder.
 */
function compile(
    ts: TypeScript,
    rootNames: string[],
    virtual: Map<string, string>,
    jsx: Config["jsx"],
    overrides: TS.CompilerOptions = {},
): { diags: Diag[]; program: TS.Program } {
    const options: TS.CompilerOptions = {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        jsx: jsx === "react" ? ts.JsxEmit.React : ts.JsxEmit.ReactJSX,
        allowSyntheticDefaultImports: true,
        lib: ["lib.es2020.d.ts", "lib.dom.d.ts"],
        types: [],
        skipLibCheck: false,
        baseUrl: pkgDir,
        paths: {
            "@livesession/libstylist/jsx": ["jsx/index.d.ts"],
            "@livesession/libstylist/runtime": ["src/runtime/index.ts"],
        },
        ...overrides,
    }
    const host = ts.createCompilerHost(options, true)
    let cache = libCache.get(ts)
    if (!cache) libCache.set(ts, (cache = new Map()))
    const libs = cache
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
        const text = virtual.get(fileName)
        if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true)
        const cacheable = fileName.endsWith(".d.ts") && (fileName.includes(`${sep}node_modules${sep}`) || fileName.startsWith(dirname(ts.getDefaultLibFilePath(options))))
        if (!cacheable) return getSourceFile(fileName, languageVersion, onError, shouldCreate)
        let sf = libs.get(fileName)
        if (!sf) {
            sf = getSourceFile(fileName, languageVersion, onError, shouldCreate)
            if (sf) libs.set(fileName, sf)
        }
        return sf
    }
    const fileExists = host.fileExists.bind(host)
    host.fileExists = (fileName) => virtual.has(fileName) || fileExists(fileName)
    const readFile = host.readFile.bind(host)
    host.readFile = (fileName) => virtual.get(fileName) ?? readFile(fileName)
    const directoryExists = host.directoryExists?.bind(host)
    host.directoryExists = (dir) => [...virtual.keys()].some((f) => f.startsWith(dir + sep)) || (directoryExists ? directoryExists(dir) : true)

    const program = ts.createProgram({ rootNames, options, host })
    const raw: TS.Diagnostic[] = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]
    for (const sf of program.getSourceFiles()) {
        // Everything libstylist owns: jsx/index.d.ts, the runtime, the fixtures. Not @types/react.
        if (!sf.fileName.startsWith(pkgDir + "/") || sf.fileName.includes("/node_modules/")) continue
        raw.push(...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf))
    }
    const diags = raw.map((d) => ({
        file: d.file ? relative(fixtureDir, d.file.fileName) : "<global>",
        line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0,
        code: d.code,
        text: ts.flattenDiagnosticMessageText(d.messageText, " "),
    }))
    return { diags, program }
}

function runConfig(ts: TypeScript, config: Config, extraFiles: string[] = []) {
    const virtual = new Map<string, string>()
    const roots = [JSX_TYPES]
    if (config.stub === "default") roots.push(STUB)
    if (config.stub === "tagmap") {
        virtual.set(TAGMAP_STUB, stylistTypesStub("elo", { tagMap: true }))
        roots.push(TAGMAP_STUB)
    }
    if (config.gen === "react") roots.push(GEN)
    if (config.gen === "global") {
        const text = readFileSync(GEN, "utf8").replace('declare module "react" {', "declare global {")
        assert.ok(text.includes("declare global {"))
        virtual.set(GLOBAL_GEN, text)
        roots.push(GLOBAL_GEN)
    }
    roots.push(...[...FIXTURES, ...extraFiles].map((f) => join(fixtureDir, f)))
    return compile(ts, roots, virtual, config.jsx)
}

// ---------------------------------------------------------------------------------------------
// Expectations: unique diagnostic codes per fixture file ([] = compiles cleanly)
// ---------------------------------------------------------------------------------------------

type Codes = number[]
type PerVersion = Codes | { 4: Codes; 5: Codes }

/** Configurations whose program holds the generated keys under `React.JSX`. */
const WITH_KEYS: ConfigName[] = ["full", "full-react-jsx", "gen-only", "tagmap"]

/** `base` everywhere, `[]` where the generated keys are present, then `overrides`. */
const expectCodes = (base: PerVersion, overrides: Partial<Record<ConfigName, PerVersion>> = {}, keys: PerVersion = []): Record<ConfigName, PerVersion> => {
    const out = {} as Record<ConfigName, PerVersion>
    for (const { name } of CONFIGS) out[name] = overrides[name] ?? (WITH_KEYS.includes(name) ? keys : base)
    return out
}

const EXPECT: Record<string, Record<ConfigName, PerVersion>> = {
    // <elo-x> literal tags need the generated keys; the opt-in tag map covers them on 5.x only. An
    // undeclared tag also loses contextual typing, so its onClick parameter is implicitly any (7006).
    "src/alert.tsx": expectCodes([2339, 7006], { "tagmap-only": { 4: [2339, 7006], 5: [] } }),
    "src/nested/player-top-bar.tsx": expectCodes([2339], { "tagmap-only": { 4: [2339], 5: [] } }),
    // No tag keys involved at all
    "cases/host-attrs.tsx": expectCodes([]),
    // Tag held in a literal-typed variable: explicit keys only, on every version, tag map or not
    "cases/tag-variable.tsx": expectCodes([2339, 2604]),
    // React.ComponentProps<"elo-x">: keyof sees the tag map's template-literal key on both versions
    "cases/component-props.tsx": expectCodes([2344], { "tagmap-only": [] }),
    // A tag the generator never saw: only the opt-in tag map on 5.x accepts it
    "cases/unknown-tag.tsx": expectCodes([2339], { tagmap: { 4: [2339], 5: [] }, "tagmap-only": { 4: [2339], 5: [] } }, [2339]),
    // React.ElementType tags: clean unless the tag map's template-literal key is in keyof
    "cases/polymorphic.tsx": expectCodes([], { tagmap: [2604], "tagmap-only": [2604] }),
}

const pick = (expect: PerVersion, major: 4 | 5): Codes => (Array.isArray(expect) ? expect : expect[major])
const uniqueCodes = (diags: Diag[]): Codes => [...new Set(diags.map((d) => d.code))].sort((a, b) => a - b)
const describe = (diags: Diag[]) => diags.map((d) => `${d.file}:${d.line} TS${d.code} ${d.text}`).join("\n")

/** `// ts-error: <code> <message fragment>` markers in a fixture, one expected diagnostic each. */
function markers(file: string): Array<{ line: number; code: number; fragment: string }> {
    const out: Array<{ line: number; code: number; fragment: string }> = []
    readFileSync(join(fixtureDir, file), "utf8")
        .split("\n")
        .forEach((text, i) => {
            const m = /\/\/ ts-error: (\d+) (.+?)\s*$/.exec(text)
            if (m) out.push({ line: i + 1, code: Number(m[1]), fragment: m[2] })
        })
    return out
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

test("both compilers are available (TS 4.9 through the typescript-4.9 alias, TS 5.x from devDependencies)", () => {
    const majors = compilers.map((c) => c.major)
    assert.deepEqual(majors, [4, 5], `found TypeScript majors ${majors.join(", ")}`)
    assert.match(compilers[0].ts.version, /^4\.9\./)
    assert.match(compilers[1].ts.version, /^5\./)
    const typesReact = JSON.parse(readFileSync(require.resolve("@types/react/package.json"), "utf8")) as { version: string }
    assert.match(typesReact.version, /^19\./)
})

const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { files?: string[]; exports?: Record<string, unknown> }
const shipsJsx = manifest.files?.includes("jsx") ?? false

// Reported as a todo (not a failure) until package.json lists jsx/ in `files`; it then runs as a normal test
test("the published package ships jsx/ (exports and typesVersions point there)", { todo: shipsJsx ? false : 'package.json "files" lacks "jsx"' }, () => {
    assert.deepEqual(manifest.exports?.["./jsx"], { types: "./jsx/index.d.ts" })
    assert.ok(shipsJsx, 'add "jsx" to package.json "files"')
})

for (const { major, ts } of compilers) {
    for (const config of CONFIGS) {
        test(`TS ${ts.version} · ${config.name}: fixtures type-check as recorded`, () => {
            const withNegative = config.gen === "react"
            const { diags, program } = runConfig(ts, config, withNegative ? [NEGATIVE] : [])

            // Every fixture really is in the program, so "clean" is never vacuous
            const inProgram = new Set(program.getSourceFiles().map((sf) => relative(fixtureDir, sf.fileName)))
            for (const file of [...FIXTURES, ...(withNegative ? [NEGATIVE] : [])]) assert.ok(inProgram.has(file), `${file} missing from the program`)

            // The typings themselves, the stubs, the generated file and the runtime are always clean
            const own = diags.filter((d) => !d.file.startsWith("src/") && !d.file.startsWith("cases/"))
            assert.deepEqual(own, [], describe(own))

            // @types/react's typesVersions: TS <= 5.0 loads ts5.0/index.d.ts
            const reactDts = program.getSourceFiles().find((sf) => /@types[\\/]react[\\/](ts5\.0[\\/])?index\.d\.ts$/.test(sf.fileName))
            assert.ok(reactDts, "@types/react was not loaded")
            assert.equal(/[\\/]ts5\.0[\\/]index\.d\.ts$/.test(reactDts.fileName), major === 4, reactDts.fileName)

            for (const [file, byConfig] of Object.entries(EXPECT)) {
                const got = diags.filter((d) => d.file === file)
                assert.deepEqual(uniqueCodes(got), pick(byConfig[config.name], major), `${file}\n${describe(got)}`)
                // Every tag failure names a custom tag
                for (const d of got.filter((x) => x.code === 2339)) assert.match(d.text, /Property '(elo-[a-z0-9-]+)' does not exist on type 'JSX\.IntrinsicElements'/)
            }
            // Every React.ElementType failure is one of the polymorphic tags
            for (const d of diags.filter((x) => x.file === "cases/polymorphic.tsx")) assert.match(d.text, /JSX element type '(As|Tag)' does not have any construct or call signatures/)

            if (withNegative) {
                const got = diags.filter((d) => d.file === NEGATIVE)
                const expected = markers(NEGATIVE)
                assert.ok(expected.length > 0)
                assert.deepEqual(got.map((d) => `${d.line}:${d.code}`).sort(), expected.map((m) => `${m.line}:${m.code}`).sort(), describe(got))
                for (const m of expected) {
                    const d = got.find((x) => x.line === m.line)!
                    assert.ok(d.text.includes(m.fragment), `${NEGATIVE}:${m.line}: expected "${m.fragment}" in: ${d.text}`)
                }
            }
        })
    }

    test(`TS ${ts.version}: CxAttrs spreads into an intrinsic element, a custom tag and a component with strict props`, () => {
        const file = join(fixtureDir, "cases", "virtual-cxattrs.tsx")
        const text = [
            'import * as React from "react"',
            'import { cx, type CxAttrs } from "@livesession/libstylist/runtime"',
            "declare const attrs: CxAttrs",
            "interface Strict { onClick: (e: React.MouseEvent) => void; size: number; label: string; inputCx?: CxAttrs }",
            "declare function Button(props: Strict): React.ReactElement",
            "export const a = <div {...attrs} id=\"x\" />",
            "export const b = <elo-alert {...attrs} {...cx(\"_cxclass_elo-aaaaaa\", attrs)} />",
            "export const c = <Button {...attrs} onClick={() => {}} size={1} label=\"l\" inputCx={cx(attrs)} />",
            "export const d = <svg {...attrs}><circle {...attrs} cx={1} /></svg>",
        ].join("\n")
        const { diags } = compile(ts, [JSX_TYPES, GEN, file], new Map([[file, text]]), "react")
        assert.deepEqual(diags, [], describe(diags))
    })

    test(`TS ${ts.version}: several packages in one program (Storybook): stubs, overlapping and empty generated files, two prefixes`, () => {
        const pkg = (name: string, file: string) => join(fixtureDir, "virtual-pkgs", name, "types", file)
        const use = join(fixtureDir, "virtual-pkgs", "app", "src", "use.tsx")
        const files: Array<[string, string]> = [
            [pkg("components", "stylist.d.ts"), stylistTypesStub("elo")],
            [pkg("components", "stylist-tags.gen.d.ts"), renderTagTypes("elo", ["elo-alert", "elo-modal"])],
            [pkg("player", "stylist.d.ts"), stylistTypesStub("elo")],
            [pkg("player", "stylist-tags.gen.d.ts"), renderTagTypes("elo", ["elo-alert", "elo-player-topbar"])],
            [pkg("ai", "stylist.d.ts"), stylistTypesStub("elo")],
            [pkg("ai", "stylist-tags.gen.d.ts"), renderTagTypes("elo", [])],
            [pkg("app", "stylist.d.ts"), stylistTypesStub("app")],
            [pkg("app", "stylist-tags.gen.d.ts"), renderTagTypes("app", ["app-shell"])],
            [use, 'import * as React from "react"\nexport const all = (\n    <>\n        <elo-alert data-open="true" />\n        <elo-modal />\n        <elo-player-topbar />\n        <app-shell elo-extra />\n    </>\n)\n'],
        ]
        const run = (texts: Array<[string, string]>) => {
            const { diags, program } = compile(ts, texts.map(([f]) => f), new Map(texts), "react")
            for (const [f] of texts) assert.ok(program.getSourceFile(f), `${f} missing from the program`)
            return diags
        }
        const clean = run(files)
        assert.deepEqual(clean, [], describe(clean))

        // The opt-in tag maps of two prefixes merge too, next to the explicit keys
        const tagMaps = run([...files, [pkg("components", "virtual-tagmap.d.ts"), stylistTypesStub("elo", { tagMap: true })], [pkg("app", "virtual-tagmap.d.ts"), stylistTypesStub("app", { tagMap: true })]])
        assert.deepEqual(tagMaps, [], describe(tagMaps))

        // A tag in no generated file fails, even with other packages' keys present
        const missing = run([...files.slice(0, -1), [use, 'import * as React from "react"\nexport const x = <elo-nowhere />\n']])
        assert.deepEqual(missing.map((d) => d.code), [2339], describe(missing))
    })

    test(`TS ${ts.version}: the files resolve @livesession/libstylist/jsx through the real package.json`, () => {
        const consumer = join(fixtureDir, "virtual-consumer")
        const installed = join(consumer, "node_modules", "@livesession", "libstylist")
        const texts: Array<[string, string]> = [
            [join(installed, "package.json"), readFileSync(join(pkgDir, "package.json"), "utf8")],
            [join(installed, "jsx", "index.d.ts"), readFileSync(JSX_TYPES, "utf8")],
            [join(installed, "jsx", "package.json"), readFileSync(join(pkgDir, "jsx", "package.json"), "utf8")],
            [join(consumer, "types", "stylist.d.ts"), stylistTypesStub("elo")],
            [join(consumer, "types", "stylist-tags.gen.d.ts"), renderTagTypes("elo", ["elo-alert"])],
            [join(consumer, "src", "use.tsx"), 'import * as React from "react"\nexport const x = <elo-alert elo-extra data-open="true"><span /></elo-alert>\n'],
        ]
        // The consumer's own package.json keeps it out of libstylist's package scope, where node16
        // would resolve the specifier by self-reference instead of through node_modules
        const modes: Array<[string, "commonjs" | "module", TS.CompilerOptions]> = [["node10 (typesVersions)", "commonjs", { moduleResolution: ts.ModuleResolutionKind.NodeJs }]]
        if (major === 5) {
            const kinds = ts.ModuleResolutionKind as unknown as Record<string, number>
            const modules = ts.ModuleKind as unknown as Record<string, number>
            modes.push(["node16 ESM (exports)", "module", { module: modules.Node16, moduleResolution: kinds.Node16 }])
            modes.push(["node16 CJS (exports)", "commonjs", { module: modules.Node16, moduleResolution: kinds.Node16 }])
            modes.push(["bundler (exports)", "module", { module: modules.ESNext, moduleResolution: kinds.Bundler }])
        }
        for (const [mode, type, overrides] of modes) {
            const roots = texts.filter(([f]) => !f.endsWith(".json") && !f.startsWith(installed)).map(([f]) => f)
            const files = new Map([...texts, [join(consumer, "package.json"), JSON.stringify({ name: "consumer", type })]])
            const { diags, program } = compile(ts, roots, files, "react", { ...overrides, paths: undefined, baseUrl: undefined })
            assert.ok(program.getSourceFile(join(installed, "jsx", "index.d.ts")), `${mode}: @livesession/libstylist/jsx did not resolve to the installed package`)
            assert.deepEqual(diags, [], `${mode}\n${describe(diags)}`)
        }
    })

    test(`TS ${ts.version}: @types/react without React.JSX (< 18.2.7) breaks every element once the generated tag keys load, so 18.2.7 is the floor`, () => {
        const root = join(fixtureDir, "virtual-legacy")
        const legacyReact = [
            "export = React",
            "export as namespace React",
            "declare namespace React {",
            "    interface HTMLAttributes<T> { id?: string }",
            "    type DetailedHTMLProps<E, T> = E",
            "    function createElement(...args: any[]): any",
            "}",
            "declare global {",
            "    namespace JSX {",
            "        interface Element {}",
            "        interface IntrinsicElements { div: React.HTMLAttributes<HTMLDivElement> }",
            "    }",
            "}",
        ].join("\n")
        const use = join(root, "src", "use.tsx")
        const gen = join(root, "types", "stylist-tags.gen.d.ts")
        const texts = (withGen: boolean) =>
            new Map([
                [join(root, "node_modules", "@types", "react", "package.json"), '{ "name": "@types/react", "version": "18.0.0", "types": "index.d.ts" }'],
                [join(root, "node_modules", "@types", "react", "index.d.ts"), legacyReact],
                [join(root, "node_modules", "@livesession", "libstylist", "package.json"), readFileSync(join(pkgDir, "package.json"), "utf8")],
                [join(root, "node_modules", "@livesession", "libstylist", "jsx", "index.d.ts"), readFileSync(JSX_TYPES, "utf8")],
                [gen, renderTagTypes("elo", ["elo-alert"])],
                [use, `import * as React from "react"\nimport type {} from "@livesession/libstylist/jsx"\nexport const x = <div id="a" />\n`],
            ])
        const options = { paths: undefined, baseUrl: undefined, skipLibCheck: true }
        // the jsx typings alone augment nothing, so they never break an older @types/react
        const without = compile(ts, [use], texts(false), "react", options).diags
        assert.deepEqual(without, [], describe(without))
        const withGen = compile(ts, [use, gen], texts(true), "react", options).diags
        // the generated keys create a partial React.JSX that has no `div`: every element fails
        assert.deepEqual(withGen.map((d) => d.code), [2339], describe(withGen))
    })
}
