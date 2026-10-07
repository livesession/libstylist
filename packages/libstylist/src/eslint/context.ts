// Per-file lint context: `settings.libstylist`, the file's package identity (prefix, namespace,
// segment), the stylist registry, the part-map modules and root-part bindings.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { clearConventionsCache, findRepoRoot, normalizeNamespaces, normalizePackageConfig, resolvePackageConfig, type RawPackageStylistConfig } from "../conventions/index.js"
import { normalizePartMaps, type PartMapModules } from "../core/index.js"
import { splitPath, tagName } from "../naming/index.js"
import type { AnyRuleContext as Context } from "./ast.js"

/** A `@stylist root` binding recorded in the registry (SPEC §7). */
export interface RegistryRoot {
    component: string
    local: string
    tag: string
    display?: string
}

/** One stylesheet in the registry (SPEC §7). */
export interface RegistryScope {
    namespace: string
    group?: string
    file?: string
    roots?: RegistryRoot[]
    parts: Record<string, string>
    globals?: string[]
    keyframes?: Record<string, string>
}

/** `stylist-registry.json` (SPEC §7). */
export interface StylistRegistry {
    version: number
    prefix: string
    hash?: { version: number; length: number }
    scopes: Record<string, RegistryScope>
}

/** `settings.libstylist` in an ESLint flat config. Every field is optional. */
export interface LibstylistSettings {
    /** Project prefix; defaults to the nearest `package.json` `libstylist.prefix`. */
    prefix?: string
    /**
     * Hash namespace; defaults to the file's namespace in the nearest `package.json` — the
     * `libstylist.namespaces` directory it sits in, else `libstylist.namespace`.
     */
    namespace?: string
    /** Tag segment override (default: derived from the namespace). */
    segment?: string
    /** Namespace word override (default: the capitalized segment). */
    word?: string
    /**
     * Tag segments of every package and directory namespace sharing the prefix (`["app", "player",
     * "render", …]`), used by `tag-name` to keep base-package tags out of other segments. Default:
     * discovered from the workspace packages' `libstylist` fields (their `namespaces` included).
     */
    segments?: string[]
    /** Path (relative to the ESLint cwd) to `stylist-registry.json`, or the registry object itself. */
    registry?: string | StylistRegistry
    /**
     * css group → the module its part map is imported from (`{ components: "@livesession/eloquentui-css" }`).
     * Unset: any package import whose name matches a registry scope's export name is a part map.
     */
    partMaps?: PartMapModules
    /**
     * Family-bound root locals, keyed by tag/marker (`elo-modal-header`) or component path
     * (`Modal.Header`): the part the identity element carries instead of `root` (`"header"` in the
     * file's own sheet, or qualified `"modal:header"`). `false` exempts the element from `root-part`.
     */
    rootLocals?: Record<string, string | false>
}

/** Everything the rules need to know about the file being linted. */
export interface FileStylist {
    settings: LibstylistSettings
    /** `null` when neither settings nor a package config name one — prefix-based rules then skip. */
    prefix: string | null
    /** The file's namespace: its package's, or that of the `namespaces` directory it sits in. */
    namespace: string | null
    /** `""` for the base package, `null` when unknown. */
    segment: string | null
    word: string | null
    /** Non-empty tag segments of all packages sharing the prefix. */
    segments: readonly string[]
}

const fileCache = new WeakMap<object, FileStylist>()

/**
 * Reads `settings.libstylist` (an empty object when absent). Throws a readable error on wrongly
 * typed fields. `null` means "unset" — flat config deep-merges settings, so a later config block can
 * only switch a field off (e.g. `registry: null`) by nulling it.
 */
export function readSettings(context: Context): LibstylistSettings {
    const raw = (context.settings as Record<string, unknown> | undefined)?.libstylist
    if (raw === undefined || raw === null) return {}
    if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("libstylist: settings.libstylist must be an object")
    const settings: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined) settings[k] = v
    const fail = (field: string, expected: string) => {
        throw new Error(`libstylist: settings.libstylist.${field} must be ${expected}`)
    }
    for (const field of ["prefix", "namespace", "segment", "word"] as const) if (settings[field] !== undefined && typeof settings[field] !== "string") fail(field, "a string")
    const { segments, registry, rootLocals, partMaps } = settings
    if (segments !== undefined && !(Array.isArray(segments) && segments.every((x) => typeof x === "string"))) fail("segments", "an array of strings")
    if (registry !== undefined && typeof registry !== "string" && typeof registry !== "object") fail("registry", "a path or a registry object")
    if (partMaps !== undefined && !(typeof partMaps === "object" && !Array.isArray(partMaps) && Object.values(partMaps as object).every((v) => typeof v === "string"))) {
        fail("partMaps", "a map of css group → part-map module specifier")
    }
    // a relative/absolute path is never matched against an import: fail with the alias recipe
    normalizePartMaps(partMaps, "settings.libstylist.partMaps")
    if (rootLocals !== undefined) {
        if (typeof rootLocals !== "object" || Array.isArray(rootLocals)) fail("rootLocals", "an object")
        for (const v of Object.values(rootLocals as object)) if (typeof v !== "string" && v !== false) fail("rootLocals", "a map of tag/component → local (string) or false")
    }
    return settings as LibstylistSettings
}

/** The lint context of the current file, computed once per file and shared by all rules. */
export function fileStylist(context: Context): FileStylist {
    const key = context.sourceCode
    const hit = fileCache.get(key)
    if (hit) return hit
    const settings = readSettings(context)
    const filename = context.filename
    const pkg = isAbsolute(filename) ? (resolvePackageConfig(filename)?.config ?? null) : null
    const prefix = settings.prefix ?? pkg?.prefix ?? null
    let namespace: string | null = null
    let segment: string | null = settings.segment ?? null
    let word: string | null = settings.word ?? null
    if (settings.namespace) {
        const cfg = normalizePackageConfig(
            { prefix: prefix ?? "x", namespace: settings.namespace, segment: settings.segment, word: settings.word },
            "settings.libstylist",
        )
        namespace = cfg.namespace
        segment = cfg.segment
        word = cfg.word
    } else if (pkg) {
        namespace = pkg.namespace
        segment = settings.segment ?? pkg.segment
        word = settings.word ?? pkg.word
    }
    const segments = settings.segments ?? (prefix && isAbsolute(filename) ? discoverSegments(findRepoRoot(dirname(filename)), prefix) : [])
    const out: FileStylist = { settings, prefix, namespace, segment, word, segments }
    fileCache.set(key, out)
    return out
}

// --- workspace segment discovery -------------------------------------------------------------

const segmentsCache = new Map<string, string[]>()

/**
 * Non-empty tag segments declared by the workspace packages that use `prefix`: each package's own, its
 * directory namespaces' (`namespaces: { "src/render": "render" }` → `render`) and a stylesheet
 * package's groups'.
 */
export function discoverSegments(root: string, prefix: string): string[] {
    const key = `${root}\u0000${prefix}`
    const hit = segmentsCache.get(key)
    if (hit) return hit
    const found = new Set<string>()
    for (const dir of workspaceDirs(root)) {
        const raw = readLibstylistField(join(dir, "package.json"))
        if (!raw) continue
        const entries: RawPackageStylistConfig[] = []
        if (raw.namespace) entries.push(raw)
        const groups = (raw as { groups?: Record<string, RawPackageStylistConfig> }).groups
        if (groups && typeof groups === "object") for (const g of Object.values(groups)) entries.push({ prefix: raw.prefix, ...g })
        for (const entry of entries) {
            try {
                const cfg = normalizePackageConfig({ ...entry, prefix: entry.prefix ?? prefix })
                if (cfg.prefix !== prefix) continue
                if (cfg.segment) found.add(cfg.segment)
                if (entry === raw) for (const ns of normalizeNamespaces(raw.namespaces, cfg)) if (ns.config.segment) found.add(ns.config.segment)
            } catch {
                // A malformed sibling config is the build's problem, not this file's.
            }
        }
    }
    const out = [...found].sort()
    segmentsCache.set(key, out)
    return out
}

function readLibstylistField(pkgPath: string): RawPackageStylistConfig | null {
    try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
        return pkg && typeof pkg.libstylist === "object" ? pkg.libstylist : null
    } catch {
        return null
    }
}

/** Package directories of a pnpm/npm workspace (`dir/*` and plain-directory patterns). */
function workspaceDirs(root: string): string[] {
    const patterns = workspacePatterns(root)
    const dirs: string[] = []
    for (const pattern of patterns) {
        if (pattern.startsWith("!")) continue
        const clean = pattern.replace(/\/+$/, "")
        const star = clean.match(/^(.*?)\/\*{1,2}$/)
        if (star) {
            const base = join(root, star[1])
            let names: string[] = []
            try {
                names = readdirSync(base)
            } catch {
                continue
            }
            for (const n of names) if (existsSync(join(base, n, "package.json"))) dirs.push(join(base, n))
        } else if (!clean.includes("*") && existsSync(join(root, clean, "package.json"))) dirs.push(join(root, clean))
    }
    return dirs
}

function workspacePatterns(root: string): string[] {
    try {
        const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
        const out: string[] = []
        let inPackages = false
        for (const line of yaml.split(/\r?\n/)) {
            if (/^packages\s*:/.test(line)) {
                inPackages = true
                continue
            }
            if (!inPackages) continue
            const item = line.match(/^\s+-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/)
            if (item) out.push(item[1])
            else if (/^\S/.test(line)) break
        }
        if (out.length) return out
    } catch {
        // Not a pnpm workspace.
    }
    try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
        const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages
        if (Array.isArray(ws)) return ws
    } catch {
        // No root package.json.
    }
    return ["packages/*"]
}

// --- registry --------------------------------------------------------------------------------

const registryCache = new Map<string, { mtimeMs: number; size: number; registry: StylistRegistry }>()

/**
 * The registry named by `settings.libstylist.registry`: the object itself, or the JSON file at that
 * path (relative to `cwd`), re-read when it changes. `null` when unset or when the file does not
 * exist yet (before the first css build); malformed JSON throws.
 */
export function loadRegistry(settings: LibstylistSettings, cwd: string): StylistRegistry | null {
    const reg = settings.registry
    if (!reg) return null
    if (typeof reg === "object") return validateRegistry(reg, "settings.libstylist.registry")
    const path = isAbsolute(reg) ? reg : resolve(cwd, reg)
    let stat
    try {
        stat = statSync(path)
    } catch {
        return null
    }
    const cached = registryCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.registry
    let raw: unknown
    try {
        raw = JSON.parse(readFileSync(path, "utf8"))
    } catch (e) {
        throw new Error(`libstylist: cannot read the stylist registry at ${path}: ${(e as Error).message}`)
    }
    const registry = validateRegistry(raw, path)
    registryCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, registry })
    return registry
}

function validateRegistry(raw: unknown, where: string): StylistRegistry {
    const r = raw as Partial<StylistRegistry> | null
    if (!r || typeof r !== "object" || !r.scopes || typeof r.scopes !== "object") throw new Error(`libstylist: ${where} is not a stylist registry (missing "scopes")`)
    return r as StylistRegistry
}

/** The registry entry for a scope id — own properties only, so ids like `constructor` never hit `Object.prototype`. */
export function registryScope(registry: StylistRegistry | null, id: string | null): RegistryScope | undefined {
    if (!registry || !id || !Object.prototype.hasOwnProperty.call(registry.scopes, id)) return undefined
    const entry = registry.scopes[id]
    return entry && typeof entry === "object" ? entry : undefined
}

/** The part names of a registry scope. */
export function scopeParts(scope: RegistryScope): string[] {
    const parts = scope.parts as unknown
    if (Array.isArray(parts)) return parts.map(String)
    return parts && typeof parts === "object" ? Object.keys(parts) : []
}

/** True when the registry scope declares `part`. */
export const scopeHasPart = (scope: RegistryScope, part: string): boolean => scopeParts(scope).includes(part)

// --- root bindings ---------------------------------------------------------------------------

/** The part an identity element must carry (`scope:local`), and how that was determined. */
export interface RootBinding {
    scope: string
    local: string
    /** `settings`/`registry` are explicit; `default` is the implied `<file's sheet>.root`. */
    source: "settings" | "registry" | "default"
}

/**
 * The root part an identity element must carry. `fileScope` is the file's own sheet (the scope most
 * of its part-map members read). `null` means no requirement can be derived (no scope, or the
 * registry binds `root` elsewhere); `false` means the settings exempt the element.
 */
export function rootBinding(file: FileStylist, registry: StylistRegistry | null, identity: string, fileScope: string | null): RootBinding | null | false {
    const configured = settingsBinding(file, identity, fileScope)
    if (configured !== undefined) return configured
    if (registry) {
        let other: RootBinding | null = null
        for (const [scopeId, scope] of Object.entries(registry.scopes)) {
            const root = scope.roots?.find((r) => r.tag === identity)
            if (!root) continue
            const binding: RootBinding = { scope: scopeId, local: root.local, source: "registry" }
            if (scopeId === fileScope) return binding
            other ??= binding
        }
        if (other) return other
        const own = registryScope(registry, fileScope)
        if (own) {
            if (own.roots?.some((r) => r.local === "root")) return null
            return scopeHasPart(own, "root") ? { scope: fileScope as string, local: "root", source: "default" } : null
        }
    }
    return fileScope ? { scope: fileScope, local: "root", source: "default" } : null
}

function settingsBinding(file: FileStylist, identity: string, fileScope: string | null): RootBinding | false | null | undefined {
    const locals = file.settings.rootLocals
    if (!locals) return undefined
    for (const [key, value] of Object.entries(locals)) {
        if (settingsKeyTag(file, key) !== identity) continue
        if (value === false) return false
        const { scope, local } = splitLocal(value, fileScope)
        return scope ? { scope, local, source: "settings" } : null
    }
    return undefined
}

/** `"modal:header"` → `{ scope: "modal", local: "header" }`; a bare local takes `fallbackScope`. */
function splitLocal(value: string, fallbackScope: string | null): { scope: string | null; local: string } {
    const colon = value.indexOf(":")
    return colon >= 0 ? { scope: value.slice(0, colon), local: value.slice(colon + 1) } : { scope: fallbackScope, local: value }
}

function settingsKeyTag(file: FileStylist, key: string): string | null {
    if (!/[A-Z.]/.test(key)) return key
    if (!file.prefix || file.segment === null) return null
    try {
        return tagName({ prefix: file.prefix, segment: file.segment, word: file.word ?? "" }, splitPath(key))
    } catch {
        return null
    }
}

/** Clears the package-config, workspace-segment and registry caches (watch mode, editor servers, tests). */
export function clearContextCaches(): void {
    clearConventionsCache()
    segmentsCache.clear()
    registryCache.clear()
}

/**
 * Locals of `scope` reserved for identity elements: `root`, every local the registry binds with
 * `@stylist root … as <local>`, and every local `settings.libstylist.rootLocals` binds in that
 * scope. A qualified setting (`"modal:header"`) applies in every file; a bare one (`"header"`)
 * only in a file that renders the identity element it names (listed in `identities`), since only
 * there does it resolve to the file's own sheet (`fileScope`).
 */
export function reservedLocals(
    file: FileStylist,
    registry: StylistRegistry | null,
    scope: string | null,
    identities: ReadonlySet<string> = new Set(),
    fileScope: string | null = null,
): Set<string> {
    const out = new Set(["root"])
    for (const r of registryScope(registry, scope)?.roots ?? []) out.add(r.local)
    for (const [key, value] of Object.entries(file.settings.rootLocals ?? {})) {
        if (typeof value !== "string") continue
        const bare = !value.includes(":")
        if (bare && !identities.has(settingsKeyTag(file, key) ?? "")) continue
        const bound = splitLocal(value, fileScope)
        if (bound.scope !== null && bound.scope === scope) out.add(bound.local)
    }
    return out
}
