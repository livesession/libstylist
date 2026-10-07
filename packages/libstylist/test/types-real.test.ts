// Smoke over the real design-system packages (the checkout LIBSTYLIST_DESIGN_SYSTEM names — see
// ./design-system.ts; skipped without it): each package's `src` is compiled with its own tsconfig
// (TS 4.9, moduleResolution node, jsx react), on TS 4.9 and 5.x, once as is and once with the
// libstylist typings loaded the way the packages will load them: jsx/index.d.ts, the default stub
// and the generated tag keys for that package. The typings must add no diagnostics to code that
// compiles today, and must themselves be clean under the packages' compiler options (skipLibCheck off).
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import type * as TS from "typescript"

import { STUB_TYPES_FILE, TAG_TYPES_FILE, genTagTypes, stylistTypesStub } from "../src/typesgen/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

type TypeScript = typeof TS

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, "..")
const require = createRequire(import.meta.url)

const PACKAGES = ["components", "app-ui", "player", "gram", "infinity", "ai"]
/** An absolute specifier, because the DS packages don't depend on libstylist yet. */
const JSX_MODULE = join(pkgDir, "jsx", "index")

/**
 * TS 4.9, the design-system packages' compiler, is the `typescript-4.9` devDependency (an npm alias of
 * typescript@~4.9.5); TS 5.x is the package's own `typescript` — the same pair types-compile.test.ts loads.
 */
const compilers = (): TypeScript[] => [require("typescript-4.9") as TypeScript, require("typescript") as TypeScript]

/** Sources are parsed once per compiler and file, and shared by every program. */
const sourceCache = new Map<TypeScript, Map<string, TS.SourceFile>>()

function program(ts: TypeScript, options: TS.CompilerOptions, rootNames: string[], virtual: Map<string, string>): TS.Program {
    const host = ts.createCompilerHost(options, true)
    let cache = sourceCache.get(ts)
    if (!cache) sourceCache.set(ts, (cache = new Map()))
    const files = cache
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
        const text = virtual.get(fileName)
        if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true)
        let sf = files.get(fileName)
        if (!sf) {
            sf = getSourceFile(fileName, languageVersion, onError, shouldCreate)
            if (sf) files.set(fileName, sf)
        }
        return sf
    }
    const fileExists = host.fileExists.bind(host)
    host.fileExists = (fileName) => virtual.has(fileName) || fileExists(fileName)
    const readFile = host.readFile.bind(host)
    host.readFile = (fileName) => virtual.get(fileName) ?? readFile(fileName)
    return ts.createProgram({ rootNames, options, host })
}

/**
 * `file:line TScode` (file relative to `repoRoot`, the design-system checkout) for the options, global and
 * per-file diagnostics of the files under `dirs` (outside node_modules): the package's sources and the
 * typings. Library files aren't checked, which keeps each program to about a second. Messages are left
 * out: they may print augmented types.
 */
function diagnostics(prog: TS.Program, dirs: string[], repoRoot: string): string[] {
    const raw: TS.Diagnostic[] = [...prog.getOptionsDiagnostics(), ...prog.getGlobalDiagnostics()]
    for (const sf of prog.getSourceFiles()) {
        if (sf.fileName.includes(`${sep}node_modules${sep}`) || !dirs.some((d) => sf.fileName.startsWith(d + sep))) continue
        raw.push(...prog.getSyntacticDiagnostics(sf), ...prog.getSemanticDiagnostics(sf))
    }
    return raw.map((d) => {
        const file = d.file ? relative(repoRoot, d.file.fileName) : "<global>"
        const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0
        return `${file}:${line} TS${d.code}`
    })
}

for (const ts of compilers()) {
    test(`TS ${ts.version}: the typings add no diagnostics to the real DS packages`, { skip: skipWithoutDesignSystem }, () => {
        const repoRoot = designSystemPath()
        let checked = 0
        for (const name of PACKAGES) {
            const dir = join(repoRoot, "packages", name)
            const configFile = join(dir, "tsconfig.json")
            if (!existsSync(configFile)) continue
            const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configFile, ts.sys.readFile).config, ts.sys, dir)
            assert.deepEqual(parsed.errors, [], `${name}: tsconfig`)
            const options = { ...parsed.options, noEmit: true, declaration: false, declarationDir: undefined }

            const stub = join(dir, STUB_TYPES_FILE)
            const gen = join(dir, TAG_TYPES_FILE)
            const virtual = new Map([
                [stub, stylistTypesStub("elo", { jsxModule: JSX_MODULE })],
                [gen, genTagTypes({ packageDir: dir, jsxModule: JSX_MODULE })],
            ])
            const dirs = [dir, join(pkgDir, "jsx")]
            const before = diagnostics(program(ts, options, parsed.fileNames, new Map()), dirs, repoRoot)
            const withTypes = program(ts, options, [...parsed.fileNames, stub, gen], virtual)
            assert.ok(withTypes.getSourceFile(`${JSX_MODULE}.d.ts`), `${name}: jsx/index.d.ts not loaded`)
            const after = diagnostics(withTypes, dirs, repoRoot)

            const own = after.filter((d) => d.startsWith(relative(repoRoot, join(pkgDir, "jsx")) + sep) || d.startsWith(relative(repoRoot, join(dir, "types")) + sep))
            assert.deepEqual(own, [], `${name}: the typings themselves`)
            const added = after.filter((d) => !before.includes(d))
            assert.deepEqual(added, [], `${name}: diagnostics the typings introduce`)
            checked += parsed.fileNames.length
        }
        assert.ok(checked > 100, `compiled only ${checked} DS source files`)
    })
}
