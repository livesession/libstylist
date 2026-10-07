// Input expansion for `migrate-selectors`: files, directories (walked) and globs (`**`, `*`, `?`,
// `{a,b}`, `[…]`) — no glob dependency, so the CLI works in any consumer repo. Dependencies, VCS
// data and build output (node_modules, .git, dist, build, storybook-static, …) are never walked into
// unless a pattern names them.
import { existsSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

export type Language = "css" | "scss" | "less" | "js"

const EXTENSIONS: Record<string, Language> = {
    css: "css",
    pcss: "css",
    postcss: "css",
    scss: "scss",
    less: "less",
    js: "js",
    jsx: "js",
    mjs: "js",
    cjs: "js",
    ts: "js",
    tsx: "js",
    mts: "js",
    cts: "js",
}

/** The language of a file by extension, or null when migrate-selectors does not read it. */
export function languageOf(file: string): Language | null {
    if (/\.d\.[cm]?ts$/.test(file)) return null
    const ext = /\.([a-z]+)$/i.exec(file)?.[1]?.toLowerCase()
    return ext ? (EXTENSIONS[ext] ?? null) : null
}

/** Directories a walk never enters unless a pattern names them. */
export const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", "coverage", "storybook-static", ".next", ".nuxt", ".turbo", ".cache"])
const GLOB_CHARS = /[*?[\]{}]/

/** A glob as a RegExp over `/`-separated relative paths. */
export function globToRegExp(glob: string): RegExp {
    let re = ""
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i]
        if (ch === "*") {
            if (glob[i + 1] === "*") {
                const slash = glob[i + 2] === "/"
                re += slash ? "(?:[^/]*/)*" : ".*"
                i += slash ? 2 : 1
            } else re += "[^/]*"
        } else if (ch === "?") re += "[^/]"
        else if (ch === "{") {
            const close = glob.indexOf("}", i)
            if (close < 0) re += "\\{"
            else {
                re += `(?:${glob
                    .slice(i + 1, close)
                    .split(",")
                    .map((alt) => globToRegExp(alt).source.slice(1, -1))
                    .join("|")})`
                i = close
            }
        } else if (ch === "[") {
            const close = glob.indexOf("]", i)
            if (close < 0) re += "\\["
            else {
                re += `[${glob.slice(i + 1, close).replace(/^!/, "^")}]`
                i = close
            }
        } else re += /[.+^$()|\\]/.test(ch) ? `\\${ch}` : ch
    }
    return new RegExp(`^${re}$`)
}

const toPosix = (p: string) => p.split(sep).join("/")

function walk(dir: string, visit: (file: string) => void, includeSkipped: boolean): void {
    let entries: string[]
    try {
        entries = readdirSync(dir).sort()
    } catch {
        return
    }
    for (const name of entries) {
        const full = join(dir, name)
        let stat
        try {
            stat = statSync(full)
        } catch {
            continue
        }
        if (stat.isDirectory()) {
            if (!includeSkipped && SKIP_DIRS.has(name)) continue
            walk(full, visit, includeSkipped)
        } else if (stat.isFile()) visit(full)
    }
}

export interface Expanded {
    files: string[]
    /** Inputs that matched nothing. */
    unmatched: string[]
}

/**
 * Expands CLI inputs to absolute file paths (sorted, unique). A directory contributes every file
 * with a supported extension; a glob contributes its matches (filtered to supported extensions);
 * an explicit file is kept whatever its extension (the caller reports unsupported ones).
 */
export function expandInputs(inputs: readonly string[], cwd: string, ignore: readonly string[] = []): Expanded {
    const files = new Set<string>()
    const unmatched: string[] = []
    const ignores = ignore.map(globToRegExp)
    const ignored = (abs: string) => {
        const rel = toPosix(relative(cwd, abs))
        return ignores.some((re) => re.test(rel) || re.test(`${rel}/`))
    }
    for (const input of inputs) {
        const before = files.size
        if (!GLOB_CHARS.test(input)) {
            const abs = resolve(cwd, input)
            if (!existsSync(abs)) {
                unmatched.push(input)
                continue
            }
            if (statSync(abs).isDirectory()) walk(abs, (f) => languageOf(f) && !ignored(f) && files.add(f), false)
            else if (!ignored(abs)) files.add(abs)
            if (files.size === before && !statSync(abs).isFile()) unmatched.push(input)
            continue
        }
        const posix = toPosix(input)
        const segments = posix.split("/")
        const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s))
        const baseRel = segments.slice(0, firstGlob).join("/")
        const base = isAbsolute(input) ? baseRel || "/" : resolve(cwd, baseRel || ".")
        const pattern = globToRegExp(segments.slice(firstGlob).join("/"))
        const includeSkipped = segments.slice(firstGlob).some((s) => SKIP_DIRS.has(s))
        walk(
            base,
            (f) => {
                if (pattern.test(toPosix(relative(base, f))) && languageOf(f) && !ignored(f)) files.add(f)
            },
            includeSkipped,
        )
        if (files.size === before) unmatched.push(input)
    }
    return { files: [...files].sort(), unmatched }
}
