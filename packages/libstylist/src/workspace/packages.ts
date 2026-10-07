// The `packages` of a workspace's `libstylist.config.mjs`, discovered instead of listed: every package
// the pnpm workspace globs (or the given ones) match whose `package.json` declares a libstylist
// namespace under the workspace's prefix becomes a checker package with its directory namespaces, its
// source directories, its layer barrels as entries and its sheet directory — and `partMapsFor` maps
// each package's css groups to the specifier its part maps are imported by (`#css`).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { normalizeNamespaces, normalizePackageConfig } from "../conventions/index.js"
import type { RawCheckPackage } from "../check/config.js"
import { packageGroups } from "./groups.js"

/** The package a `workspacePackages` callback is asked about. */
export interface DiscoveredPackage {
    /** npm name. */
    name: string
    /** Posix directory relative to the workspace root (`packages/crm-accounts`). */
    dir: string
    /** Absolute directory. */
    abs: string
    /** The parsed `package.json`. */
    packageJson: Record<string, unknown>
}

export interface WorkspacePackagesOptions {
    /** The workspace root — the directory of `libstylist.config.mjs` (`import.meta.dirname`, or a `file:` URL of it). */
    root: string | URL
    /** The project prefix: packages declaring a libstylist namespace must declare it (`crm`). */
    prefix: string
    /** Package directory globs relative to `root` (`packages/*`, `!packages/legacy`); default the `packages` of `pnpm-workspace.yaml`. */
    include?: readonly string[]
    /**
     * Each package's entries (subpath → package-relative source file), or a function answering them per
     * package. Default: the layer barrels that exist — `./components` (`src/components/index.ts`) and
     * `./render` (`src/render/index.ts`).
     */
    entries?: Readonly<Record<string, string>> | ((pkg: DiscoveredPackage) => Record<string, string>)
    /** Each package's sheet directory (package-relative); a package without it yet gets no sheets. @default "src/css" */
    sheets?: string
}

/** The layer barrels a package's entries default to. */
export const DEFAULT_ENTRIES: Readonly<Record<string, string>> = { "./components": "src/components/index.ts", "./render": "src/render/index.ts" }
/** The package-relative sheet directory a package's sheets default to. */
export const DEFAULT_SHEETS = "src/css"

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const toPosix = (p: string) => p.split(sep).join("/")
/** Directories a wildcard never descends into. */
const SKIPPED = new Set(["node_modules", ".git"])

const isDir = (path: string): boolean => existsSync(path) && statSync(path).isDirectory()

/**
 * The `packages` globs of a `pnpm-workspace.yaml` — the block list (`packages:` then `- "glob"` lines)
 * or a flow list (`packages: ["a/*", "b"]`); comments and quotes are dropped. Throws when the file has
 * no `packages` key.
 */
export function readPnpmWorkspaceGlobs(file: string): string[] {
    const lines = readFileSync(file, "utf8").split(/\r?\n/)
    const start = lines.findIndex((l) => /^packages\s*:/.test(l))
    if (start < 0) throw new Error(`${file}: no "packages" key — pass include globs to workspacePackages`)
    const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, "$2")
    const flow = /^packages\s*:\s*\[(.*)\]\s*(#.*)?$/.exec(lines[start])
    if (flow) return flow[1].split(",").map(unquote).filter(Boolean)
    const out: string[] = []
    for (const line of lines.slice(start + 1)) {
        if (/^\s*(#.*)?$/.test(line)) continue
        // the list ends at the next key (a sequence may sit at the key's own column: `- "a/*"`)
        if (!/^\s/.test(line) && !/^-\s/.test(line)) break
        const item = /^\s*-\s*(.+?)\s*(\s#.*)?$/.exec(line)
        if (item) out.push(unquote(item[1]))
    }
    return out
}

/** A glob segment as a regular expression: `*`, `?`, `[…]` and `{a,b}`. */
function segmentRegExp(segment: string): RegExp {
    let re = ""
    for (let i = 0; i < segment.length; i++) {
        const c = segment[i]
        if (c === "*") re += "[^/]*"
        else if (c === "?") re += "[^/]"
        else if (c === "[") {
            const end = segment.indexOf("]", i)
            if (end < 0) re += "\\["
            else {
                re += `[${segment.slice(i + 1, end).replace(/^!/, "^")}]`
                i = end
            }
        } else if (c === "{") {
            const end = segment.indexOf("}", i)
            if (end < 0) re += "\\{"
            else {
                re += `(?:${segment.slice(i + 1, end).split(",").map((a) => a.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`
                i = end
            }
        } else re += c.replace(/[.+^$()|\\]/g, "\\$&")
    }
    return new RegExp(`^${re}$`)
}

const hasMagic = (segment: string): boolean => /[*?[{]/.test(segment)

/** Every directory under `rel` (itself included), skipping `node_modules` and dot directories. */
function descendants(root: string, rel: string): string[] {
    const out = [rel]
    for (const name of readdirSync(join(root, rel)).sort()) {
        if (name.startsWith(".") || SKIPPED.has(name)) continue
        const child = rel ? `${rel}/${name}` : name
        if (isDir(join(root, child))) out.push(...descendants(root, child))
    }
    return out
}

/** The directories (posix, relative to `root`) a glob matches, segment by segment. */
export function expandDirectoryGlob(root: string, pattern: string): string[] {
    const segments = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/").filter((s) => s !== "" && s !== ".")
    let current = [""]
    for (const segment of segments) {
        const next: string[] = []
        for (const rel of current) {
            const abs = join(root, rel)
            if (!isDir(abs)) continue
            if (segment === "**") next.push(...descendants(root, rel))
            else if (hasMagic(segment)) {
                const re = segmentRegExp(segment)
                for (const name of readdirSync(abs).sort()) {
                    if (name.startsWith(".") || SKIPPED.has(name) || !re.test(name)) continue
                    const child = rel ? `${rel}/${name}` : name
                    if (isDir(join(root, child))) next.push(child)
                }
            } else if (isDir(join(abs, segment))) next.push(rel ? `${rel}/${segment}` : segment)
        }
        current = [...new Set(next)]
    }
    return current.filter((rel) => rel !== "")
}

/** True when a posix path matches a glob (for `!` exclusions). */
function matchesGlob(rel: string, pattern: string): boolean {
    const segments = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/").filter(Boolean)
    const parts = rel.split("/")
    const walk = (si: number, pi: number): boolean => {
        if (si === segments.length) return pi === parts.length
        if (segments[si] === "**") return walk(si + 1, pi) || (pi < parts.length && walk(si, pi + 1))
        return pi < parts.length && segmentRegExp(segments[si]).test(parts[pi]) && walk(si + 1, pi + 1)
    }
    return walk(0, 0)
}

const rootPath = (root: string | URL): string => resolve(typeof root === "string" ? (root.startsWith("file:") ? fileURLToPath(root) : root) : fileURLToPath(root))

/**
 * The checker packages of a workspace of app packages (docs/CONFIG.md, "A workspace of app packages"):
 * every directory the `include` globs (default: `pnpm-workspace.yaml`'s `packages`) match whose
 * `package.json` has a `libstylist` field with a namespace. Each becomes `{ name, dir, namespace,
 * segment?, word?, namespaces?, sources?, entries, sheets }` — the naming, namespaces and source
 * directories exactly as its `package.json` declares them (the config loader validates them), the
 * entries that exist, its sheet directory when it exists (else no sheets). Sorted by directory. Throws
 * on a package of another prefix, a package with no entry file and a missing workspace file.
 */
export function workspacePackages(options: WorkspacePackagesOptions): RawCheckPackage[] {
    const root = rootPath(options.root)
    const sheetsDir = options.sheets ?? DEFAULT_SHEETS
    let globs = options.include
    if (!globs) {
        const file = join(root, "pnpm-workspace.yaml")
        if (!existsSync(file)) throw new Error(`workspacePackages: ${file} does not exist — pass include globs`)
        globs = readPnpmWorkspaceGlobs(file)
    }
    const excluded = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1))
    const dirs = new Set<string>()
    for (const glob of globs) if (!glob.startsWith("!")) for (const dir of expandDirectoryGlob(root, glob)) if (!excluded.some((x) => matchesGlob(dir, x))) dirs.add(dir)

    const out: RawCheckPackage[] = []
    for (const dir of [...dirs].sort()) {
        const abs = join(root, dir)
        const pkgPath = join(abs, "package.json")
        if (!existsSync(pkgPath)) continue
        const packageJson = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>
        const field = packageJson.libstylist
        if (!isObject(field) || typeof field.namespace !== "string") continue
        const where = `${toPosix(relative(root, pkgPath))} libstylist`
        if (field.prefix !== options.prefix) throw new Error(`workspacePackages: ${where}.prefix is ${JSON.stringify(field.prefix)}, the workspace's is "${options.prefix}"`)
        if (typeof packageJson.name !== "string") throw new Error(`workspacePackages: ${toPosix(relative(root, pkgPath))} has no name`)
        const discovered: DiscoveredPackage = { name: packageJson.name, dir, abs, packageJson }
        const wanted = typeof options.entries === "function" ? options.entries(discovered) : (options.entries ?? DEFAULT_ENTRIES)
        const entries = Object.fromEntries(Object.entries(wanted).filter(([, file]) => existsSync(join(abs, file))))
        if (Object.keys(entries).length === 0) {
            throw new Error(`workspacePackages: ${dir} declares a libstylist namespace but has none of its entry files (${Object.values(wanted).join(", ")}) — add one, or pass entries`)
        }
        const pkg: RawCheckPackage = { name: packageJson.name, dir, namespace: field.namespace, entries, sheets: isDir(join(abs, sheetsDir)) ? sheetsDir : [] }
        if (typeof field.segment === "string") pkg.segment = field.segment
        if (typeof field.word === "string") pkg.word = field.word
        if (field.namespaces !== undefined) pkg.namespaces = field.namespaces as RawCheckPackage["namespaces"]
        if (field.sources !== undefined) pkg.sources = field.sources as RawCheckPackage["sources"]
        out.push(pkg)
    }
    return out
}

/** A package as `partMapsFor` reads it: a raw config package, or a validated one (with its `groups`). */
export type PartMapsPackage = Pick<RawCheckPackage, "dir" | "namespace" | "segment" | "word" | "namespaces"> | { dir: string; groups: ReadonlyArray<{ name: string }> }

/**
 * `css.partMaps` for packages that each import their own part maps by one specifier: every css group
 * of every package (`crm-accounts`, `crm-accounts.render`, …) → `specifier` (`"#css"`), or the
 * specifier a function answers for the package.
 */
export function partMapsFor(packages: readonly PartMapsPackage[], specifier: string | ((pkg: PartMapsPackage) => string)): Record<string, string> {
    const out: Record<string, string> = {}
    for (const pkg of packages) {
        const value = typeof specifier === "function" ? specifier(pkg) : specifier
        let names: string[]
        if ("groups" in pkg) names = pkg.groups.map((g) => g.name)
        else {
            // group names depend on the namespaces only: any valid prefix normalizes them
            const naming = normalizePackageConfig({ prefix: "x", namespace: pkg.namespace, segment: pkg.segment, word: pkg.word }, `package ${pkg.dir}`)
            const namespaces = normalizeNamespaces(pkg.namespaces, naming, `package ${pkg.dir}`)
            names = packageGroups({ dir: pkg.dir, naming, namespaces }).map((g) => g.name)
        }
        for (const name of names) out[name] = value
    }
    return out
}
