// Finds the custom tags a package renders in JSX (`<elo-alert>`), the input of the generated tag
// types. Sources are parsed with Babel, so tags inside comments, strings and templates are ignored.
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { parseSync } from "@babel/core"

import { DEFAULT_SOURCES } from "../conventions/index.js"
import { isIdentityName } from "../naming/index.js"

type ParserPlugin = "jsx" | "typescript" | "decorators-legacy"

interface AstNode {
    type: string
    [key: string]: unknown
}

const SOURCE_EXT = /\.(tsx|ts|jsx|mts|cts)$/
const DECLARATION = /\.d\.(ts|mts|cts)$/
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"])
/** AST keys that never hold JSX: positions and comments. */
const SKIP_KEYS = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments", "comments", "tokens"])

const parserPlugins = (filename: string): ParserPlugin[] => {
    if (/\.tsx$/.test(filename)) return ["jsx", "typescript", "decorators-legacy"]
    if (/\.(ts|mts|cts)$/.test(filename)) return ["typescript", "decorators-legacy"]
    return ["jsx", "decorators-legacy"]
}

const isNode = (value: unknown): value is AstNode =>
    typeof value === "object" && value !== null && typeof (value as AstNode).type === "string"

/**
 * Lists the TypeScript/JSX sources under `dir`, recursively and sorted. It skips declaration
 * files, dot-directories and dependency/build output (`node_modules`, `dist`, `build`,
 * `coverage`). A missing `dir` yields `[]`.
 */
export function listSourceFiles(dir: string): string[] {
    const out: string[] = []
    const visit = (current: string) => {
        let entries
        try {
            entries = readdirSync(current, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".")) continue
            const path = join(current, entry.name)
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) visit(path)
            } else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !DECLARATION.test(entry.name)) {
                out.push(path)
            }
        }
    }
    visit(dir)
    return out.sort()
}

/**
 * Every hyphenated intrinsic tag opened in one file's JSX (`<elo-alert>`, `<my-widget/>`), in
 * source order with duplicates. Member (`<Modal.Header>`) and namespaced (`<svg:rect>`) names are
 * not intrinsic custom tags and are skipped. Throws with the file name when the source doesn't parse.
 */
export function jsxTagNames(code: string, filename: string): string[] {
    let ast
    try {
        ast = parseSync(code, {
            filename,
            babelrc: false,
            configFile: false,
            browserslistConfigFile: false,
            sourceType: "module",
            parserOpts: { plugins: parserPlugins(filename) },
        })
    } catch (error) {
        throw new Error(`libstylist gen-types: cannot parse ${filename}: ${(error as Error).message}`)
    }
    const names: string[] = []
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item)
            return
        }
        if (!isNode(value)) return
        if (value.type === "JSXOpeningElement") {
            const name = value.name as AstNode
            if (name.type === "JSXIdentifier" && typeof name.name === "string" && name.name.includes("-")) names.push(name.name)
        }
        for (const key in value) {
            if (!SKIP_KEYS.has(key)) visit(value[key])
        }
    }
    visit(ast)
    return names
}

/**
 * The `<prefix>-…` custom tags opened in one file's JSX, sorted and deduplicated. Names that are
 * not valid identity tags (`<elo-Bad>`) are skipped; the tag-name lint rule reports those.
 */
export function collectJsxTags(code: string, filename: string, prefix: string): string[] {
    // Only files that mention the prefix are parsed. The test is on `elo-`, not `<elo-`: JSX allows
    // whitespace and comments between `<` and the name (`<\n  elo-x`, `</* … */elo-x>`).
    if (!code.includes(`${prefix}-`)) return []
    const tags = new Set(jsxTagNames(code, filename).filter((name) => isIdentityName(name, prefix)))
    return [...tags].sort()
}

/**
 * Every `<prefix>-…` custom tag rendered anywhere under the package's source directories (`sources`,
 * relative to `packageDir` or absolute; default `src`), sorted and deduplicated.
 */
export function scanCustomTags(packageDir: string, prefix: string, sources: readonly string[] = DEFAULT_SOURCES): string[] {
    const tags = new Set<string>()
    for (const dir of sources) {
        for (const file of listSourceFiles(resolve(packageDir, dir))) {
            for (const tag of collectJsxTags(readFileSync(file, "utf8"), file, prefix)) tags.add(tag)
        }
    }
    return [...tags].sort()
}
