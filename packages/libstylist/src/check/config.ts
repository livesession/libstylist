// `libstylist.config.mjs` — the project config the checker, burndown and the workspace build read:
// prefix, packages with their namespaces, entries, source directories and sheets (a css package's group
// directory, or sheet directories of their own), the css directory (plus the built registry, the lock,
// the cascade layers, the unbound sheets and the app's override sheets of a design system), the
// exemption budgets and the aliases of the checker's TypeScript program. The loader validates strictly:
// unknown keys and wrong types are errors.
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

import {
    DEFAULT_HASH_LENGTH,
    DEFAULT_REGISTRY_FILE,
    DEFAULT_SOURCES,
    PREFIX_RE,
    normalizeNamespaces,
    normalizePackageConfig,
    normalizeSources,
    packageConfigOf,
    type DirectoryNamespace,
    type PackageStylistConfig,
    type RawNamespaceEntry,
} from "../conventions/index.js"
import { isRelativeSpecifier } from "../core/index.js"
import { packageGroups } from "../workspace/groups.js"
import { DESIGN_SYSTEM_LAYERS, DEFAULT_OVERRIDES_LAYER, overridesLayerProblem } from "../workspace/layers.js"

export const CONFIG_FILE = "libstylist.config.mjs"
export const DEFAULT_MIN_REASON_LENGTH = 12

export type ExemptionCategory = "none" | "multi" | "native"
export const EXEMPTION_CATEGORIES: readonly ExemptionCategory[] = ["none", "multi", "native"]

/** A package as written in the config file. */
export interface RawCheckPackage {
    /** npm name (`@livesession/eloquentui-react`); imports of it resolve to the entries' sources. */
    name: string
    /** Package directory, relative to the config file. */
    dir: string
    namespace: string
    segment?: string
    word?: string
    /**
     * Directory namespaces (package-relative directory → namespace or `{ namespace, segment?, word? }`),
     * equal to the package's `package.json` `libstylist.namespaces`: files under `src/render` hash and
     * name tags in the `render` namespace. Needs `sheets`.
     */
    namespaces?: Record<string, RawNamespaceEntry>
    /** Public entry points keyed like `package.json` `exports` (`"."`, `"./headless"`) → source file relative to `dir`. */
    entries: Record<string, string>
    /**
     * The package's source directories, relative to `dir`: the JSX `gen-types --config` scans for custom tags
     * and the modules the workspace transform owns. Equal to the package's `package.json` `libstylist.sources`
     * when that declares them; default those, else `["src"]`.
     */
    sources?: string[]
    /** The package's stylesheet group: the subdirectory of `css.dir` holding its sheets. Exactly one of `cssGroup` and `sheets`. */
    cssGroup?: string
    /**
     * The package's own sheet directories, relative to `dir` and searched recursively: one css group per
     * namespace, `<dir basename>` and `<dir basename>.<namespace>` (a workspace of app packages). An empty
     * array is a package without sheets yet.
     */
    sheets?: string | string[]
}

/** `css.layers`: the cascade layers the workspace build wraps each app sheet in (docs/CONFIG.md). */
export interface RawCheckLayers {
    /** The `@layer` order statement every compiled sheet starts with; default the design system's layers, then each namespace's. */
    statement?: string[]
    /** Namespace → the layer its sheets are wrapped in (`{ core: "app.core", render: "app.render" }`); default `app.<namespace>`. */
    namespaces?: Record<string, string>
}

/**
 * `css.overrides`: the app's override sheets of a design system's components (SPEC §9, docs/CONFIG.md
 * "Overriding the design system").
 */
export interface RawCheckOverrides {
    /** The directory holding every override sheet (searched recursively), relative to the config file. */
    dir: string
    /**
     * The design systems whose components the sheets override: a css package's specifier
     * (`@livesession/eloquentui-css`, its `dist/stylist-registry.json`) or a registry `.json` path relative
     * to the config file.
     */
    registries: string[]
    /** The cascade layer the sheets compile into. @default "app.overrides" */
    layer?: string
}

/** The config file's default export. */
export interface RawCheckConfig {
    prefix: string
    hashLength?: number
    packages: RawCheckPackage[]
    /**
     * `dir`: one subdirectory per css group (required when a package has a `cssGroup`); `registry`: the
     * built `stylist-registry.json` (checked for drift); `unboundSheets`: sheets bound to no component,
     * relative to `dir` (to the config file's directory without one); `hostParts`:
     * `"scope:part"` → reason, for parts that code outside the design-system sources puts on its
     * own elements through the part map (engine-owned nodes, consumer-composed markup); `partMaps`:
     * css group → the module specifier its part map is imported from (sources import the maps and
     * spread `cx(map.part)`; unset, any package import named like a sheet's part map counts). The workspace
     * build (`libstylist build`) writes `registry` and the committed `lock` and wraps each sheet in its
     * namespace's cascade layer (`layers`); `overrides`: the app's override sheets of a design system.
     */
    css: {
        dir?: string
        registry?: string
        lock?: string
        layers?: RawCheckLayers
        unboundSheets?: string[]
        hostParts?: Record<string, string>
        partMaps?: Record<string, string>
        overrides?: RawCheckOverrides
    }
    exemptions?: { budget?: Partial<Record<ExemptionCategory, number>>; minReasonLength?: number }
    /**
     * The TypeScript program `check` and the codemod build over the packages: `paths` (tsconfig semantics,
     * targets relative to the config file) resolves the aliases the sources import each other by
     * (`"~/*": ["apps/webapp/app/*"]`), next to the package names, which always resolve to their entries.
     */
    typescript?: RawCheckTypeScript
}

/** `typescript`: what the checker's TypeScript program adds to its compiler options (docs/CONFIG.md). */
export interface RawCheckTypeScript {
    /** Module alias → targets, as tsconfig `compilerOptions.paths`; targets are relative to the config file. */
    paths?: Record<string, string[]>
}

export interface CheckPackage {
    name: string
    /** Absolute package directory. */
    dir: string
    /** The package's base namespace (files outside every `namespaces` directory). */
    namespace: string
    segment: string
    word: string
    /** Subpath → absolute source file. */
    entries: Record<string, string>
    /** Absolute source directories (`sources`; `<dir>/src` by default). */
    sources: string[]
    /** The subdirectory of `css.dir` holding the package's sheets, or null for a package with `sheets`. */
    cssGroup: string | null
    /** Absolute directories of the package's own sheets (`sheets`, searched recursively); empty with `cssGroup` or no sheets yet. */
    sheets: string[]
    /** Directory namespaces, longest directory first. */
    namespaces: DirectoryNamespace[]
    /** The package's css groups with their naming: its `cssGroup`, or one per namespace of a `sheets` package (base first). */
    groups: Array<{ name: string; naming: PackageStylistConfig }>
    /** Naming and hashing config of the package's base namespace (SPEC §8). */
    naming: PackageStylistConfig
}

export interface CheckConfig {
    /** Absolute directory everything else is relative to (the config file's directory). */
    root: string
    /** Absolute path of the config file, or null for a config given as an object. */
    file: string | null
    prefix: string
    hashLength: number
    packages: CheckPackage[]
    css: {
        /** Absolute directory holding one subdirectory per css group, or null when no package has a `cssGroup`. */
        dir: string | null
        /**
         * Absolute path of the built registry to compare against the sheets, or null. Unset in a config
         * with no css-group package, it is where the workspace build writes it (`DEFAULT_REGISTRY_FILE`).
         */
        registry: string | null
        /** Absolute path of the lock file the workspace build writes (committed), or null for its default. */
        lock: string | null
        /** The cascade layers of the workspace build as configured (defaults apply to what is unset), or null. */
        layers: { statement: string[] | null; namespaces: Record<string, string> } | null
        /** Sheets not bound to a component (`components/swatch.css`), relative to `css.dir` (or to `root` without one). */
        unboundSheets: string[]
        /** `scope:part` → reason: parts carried by host elements outside the design-system sources. */
        hostParts: Record<string, string>
        /** css group → part-map module specifier, or null when not configured. */
        partMaps: Record<string, string> | null
        /**
         * The app's override sheets of a design system (SPEC §9), or null: the absolute directory holding
         * them, the design systems (a css package specifier as written, or the absolute path of a registry
         * `.json`) and the cascade layer they compile into.
         */
        overrides: CheckOverrides | null
    }
    exemptions: {
        /** Maximum number of exemptions per category; `Infinity` when not budgeted. */
        budget: Record<ExemptionCategory, number>
        minReasonLength: number
    }
    typescript: {
        /** Alias → absolute targets (`typescript.paths`), merged into the checker's compiler options; `{}` when unset. */
        paths: Record<string, string[]>
    }
}

/** `css.overrides`, validated. */
export interface CheckOverrides {
    /** Absolute directory of the override sheets. */
    dir: string
    /** Each design system: a css package specifier, or the absolute path of a registry `.json`. */
    registries: string[]
    /** The cascade layer the override sheets compile into (`app.overrides` by default). */
    layer: string
}

/** A config problem; the message names the offending field. */
export class CheckConfigError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "CheckConfigError"
    }
}

const SUBPATH_RE = /^\.(\/[A-Za-z0-9._-]+)*$/
/** A cascade layer name, dotted for a sublayer (`app.render`). */
export const LAYER_RE = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/
const HOST_PART_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*:[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const PACKAGE_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new CheckConfigError(`${where}: unknown key "${key}" (allowed: ${allowed.join(", ")})`)
}

function str(obj: Record<string, unknown>, key: string, where: string, optional = false): string | undefined {
    const v = obj[key]
    if (v === undefined && optional) return undefined
    if (typeof v !== "string" || v === "") throw new CheckConfigError(`${where}.${key} must be a non-empty string`)
    return v
}

function count(v: unknown, where: string): number {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new CheckConfigError(`${where} must be a non-negative integer`)
    return v
}

function existingDir(path: string, where: string): string {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new CheckConfigError(`${where}: directory ${path} does not exist`)
    return path
}

/** The `libstylist` field of a package's `package.json`, when it has one. */
function packageJsonField(dir: string): Record<string, unknown> | null {
    const path = join(dir, "package.json")
    if (!existsSync(path)) return null
    try {
        const pkg = JSON.parse(readFileSync(path, "utf8"))
        return isObject(pkg?.libstylist) ? pkg.libstylist : null
    } catch {
        throw new CheckConfigError(`${path}: not valid JSON`)
    }
}

/** `src/render → render (segment "render", word "Render")` for messages; `none` for no directory namespaces. */
const describeNamespaces = (list: readonly DirectoryNamespace[]): string =>
    list.length ? list.map((d) => `${d.dir} → ${d.config.namespace} (segment "${d.config.segment}", word "${d.config.word}")`).join(", ") : "none"

/** True when two normalized namespace lists name the same directories with the same naming. */
const sameNamespaces = (a: readonly DirectoryNamespace[], b: readonly DirectoryNamespace[]): boolean =>
    a.length === b.length && a.every((x, i) => x.dir === b[i].dir && x.config.namespace === b[i].config.namespace && x.config.segment === b[i].config.segment && x.config.word === b[i].config.word)

/** Runs a conventions normalizer, turning its error into a config error. */
function configError<T>(fn: () => T): T {
    try {
        return fn()
    } catch (err) {
        throw err instanceof CheckConfigError ? err : new CheckConfigError((err as Error).message)
    }
}

/** The naming a source file or sheet of `pkg` uses: the longest `namespaces` directory it sits in, else the package's base naming. */
export function namingOf(pkg: Pick<CheckPackage, "dir" | "naming" | "namespaces">, file: string): PackageStylistConfig {
    return packageConfigOf({ dir: pkg.dir, base: pkg.naming, namespaces: pkg.namespaces }, file).config
}

/**
 * Validates a raw config object and resolves every path against `root`. Throws `CheckConfigError`
 * on unknown keys, wrong types, invalid identifiers, missing files, duplicate package names,
 * directories or css groups, overlapping sheet directories, a namespace named two ways, and when a
 * package's `package.json` `libstylist` field disagrees. Packages may share a namespace (a workspace
 * of app packages: every package's `core` and `render`); tags and scopes stay unique per prefix.
 */
export function validateCheckConfig(raw: unknown, root: string, where = "libstylist config", file: string | null = null): CheckConfig {
    if (!isObject(raw)) throw new CheckConfigError(`${where}: the config must be an object (the module's default export)`)
    onlyKeys(raw, ["prefix", "hashLength", "packages", "css", "exemptions", "typescript"], where)
    const prefix = str(raw, "prefix", where) as string
    if (!PREFIX_RE.test(prefix)) throw new CheckConfigError(`${where}.prefix must match ${PREFIX_RE}`)
    const hashLength = raw.hashLength === undefined ? DEFAULT_HASH_LENGTH : count(raw.hashLength, `${where}.hashLength`)

    if (!Array.isArray(raw.packages) || raw.packages.length === 0) throw new CheckConfigError(`${where}.packages must be a non-empty array`)
    const packages: CheckPackage[] = []
    const atOf = new Map<CheckPackage, string>()
    const seen = { name: new Map<string, string>(), dir: new Map<string, string>(), group: new Map<string, string>() }
    /** namespace → its naming and where it was first declared: a namespace names tags one way across packages */
    const namespaces = new Map<string, { naming: PackageStylistConfig; at: string }>()
    raw.packages.forEach((p, i) => {
        const at = `${where}.packages[${i}]`
        if (!isObject(p)) throw new CheckConfigError(`${at} must be an object`)
        onlyKeys(p, ["name", "dir", "namespace", "segment", "word", "namespaces", "entries", "sources", "cssGroup", "sheets"], at)
        const name = str(p, "name", at) as string
        if (!PACKAGE_NAME_RE.test(name)) throw new CheckConfigError(`${at}.name "${name}" is not a valid package name`)
        const dir = existingDir(resolve(root, str(p, "dir", at) as string), `${at}.dir`)
        const namespace = str(p, "namespace", at) as string
        const segment = p.segment === undefined ? undefined : typeof p.segment === "string" ? p.segment : str(p, "segment", at)
        const word = str(p, "word", at, true)
        const naming = configError(() => normalizePackageConfig({ prefix, namespace, segment, word, hashLength }, at))
        const dirNamespaces = configError(() => normalizeNamespaces(p.namespaces, naming, at))
        if (!isObject(p.entries) || Object.keys(p.entries).length === 0) throw new CheckConfigError(`${at}.entries must be a non-empty object of subpath → source file`)
        const entries: Record<string, string> = {}
        for (const [subpath, file] of Object.entries(p.entries)) {
            if (!SUBPATH_RE.test(subpath)) throw new CheckConfigError(`${at}.entries: "${subpath}" is not an exports subpath ("." or "./name")`)
            if (typeof file !== "string" || file === "") throw new CheckConfigError(`${at}.entries["${subpath}"] must be a source file path`)
            const abs = resolve(dir, file)
            if (!existsSync(abs)) throw new CheckConfigError(`${at}.entries["${subpath}"]: ${abs} does not exist`)
            entries[subpath] = abs
        }
        const sources = p.sources === undefined ? null : configError(() => normalizeSources(p.sources, at))

        // the sheets: a group directory of the css package, or directories of the package's own
        if ((p.cssGroup === undefined) === (p.sheets === undefined)) {
            throw new CheckConfigError(`${at} needs exactly one of cssGroup (its group directory under css.dir) and sheets (its own sheet directories)`)
        }
        const cssGroup = p.cssGroup === undefined ? null : (str(p, "cssGroup", at) as string)
        if (cssGroup !== null && dirNamespaces.length) {
            throw new CheckConfigError(`${at}.namespaces needs sheets: a cssGroup directory holds the sheets of one namespace — list the package's sheet directories in sheets instead`)
        }
        const sheets: string[] = []
        if (p.sheets !== undefined) {
            const list = typeof p.sheets === "string" ? [p.sheets] : p.sheets
            // an empty array: a package without sheets yet (git keeps no empty sheet directory)
            if (!Array.isArray(list) || !list.every((s) => typeof s === "string" && s !== "")) {
                throw new CheckConfigError(`${at}.sheets must be a directory or an array of directories, relative to the package`)
            }
            for (const s of list as string[]) {
                const abs = resolve(dir, s)
                const rel = relative(dir, abs)
                if (isAbsolute(s) || rel === ".." || rel.startsWith(`..${sep}`)) throw new CheckConfigError(`${at}.sheets: "${s}" is outside the package — sheet directories are package-relative`)
                sheets.push(existingDir(abs, `${at}.sheets "${s}"`))
            }
        }
        const groups = cssGroup !== null ? [{ name: cssGroup, naming }] : packageGroups({ dir, naming, namespaces: dirNamespaces })

        const unique = (field: keyof typeof seen, value: string, label: string) => {
            const other = seen[field].get(value)
            if (other) throw new CheckConfigError(`${at}.${label} "${value}" is already used by ${other}`)
            seen[field].set(value, at)
        }
        unique("name", name, "name")
        unique("dir", dir, "dir")
        for (const g of groups) unique("group", g.name, cssGroup !== null ? "cssGroup" : "sheets group")
        for (const n of [naming, ...dirNamespaces.map((d) => d.config)]) {
            const prev = namespaces.get(n.namespace)
            if (prev && (prev.naming.segment !== n.segment || prev.naming.word !== n.word)) {
                throw new CheckConfigError(
                    `${at} names namespace "${n.namespace}" with segment "${n.segment}" and word "${n.word}", but ${prev.at} uses segment "${prev.naming.segment}" and word "${prev.naming.word}" — a namespace names tags one way in every package`,
                )
            }
            if (!prev) namespaces.set(n.namespace, { naming: n, at })
        }

        const declared = packageJsonField(dir)
        let sourceDirs = sources
        if (declared) {
            const pkgJson = join(dir, "package.json")
            for (const field of ["prefix", "namespace", "segment", "word"] as const) {
                const mine = field === "prefix" ? prefix : naming[field]
                if (declared[field] !== undefined && declared[field] !== mine) {
                    throw new CheckConfigError(`${at}.${field} is "${mine}" but ${pkgJson} declares libstylist.${field} "${String(declared[field])}"`)
                }
            }
            // the transform and the lint read package.json: the checker must see the same namespaces
            const theirs = configError(() => normalizeNamespaces(declared.namespaces, naming, `${pkgJson} libstylist`))
            if (!sameNamespaces(dirNamespaces, theirs)) {
                throw new CheckConfigError(`${at}.namespaces is ${describeNamespaces(dirNamespaces)} but ${pkgJson} declares libstylist.namespaces ${describeNamespaces(theirs)} — list the same directories`)
            }
            // gen-types without a config reads package.json too: a package's sources are one list
            if (declared.sources !== undefined) {
                const theirSources = configError(() => normalizeSources(declared.sources, `${pkgJson} libstylist`))
                if (sources === null) sourceDirs = theirSources
                else if (JSON.stringify(sources) !== JSON.stringify(theirSources)) {
                    throw new CheckConfigError(`${at}.sources is ${JSON.stringify(sources)} but ${pkgJson} declares libstylist.sources ${JSON.stringify(theirSources)} — list the same directories`)
                }
            }
        }
        // declared sources must exist; the default `src` may not (a package of declaration files only)
        const sourceAbs = sourceDirs === null ? DEFAULT_SOURCES.map((s) => join(dir, s)) : sourceDirs.map((s) => existingDir(join(dir, s), `${at}.sources "${s}"`))
        const pkg: CheckPackage = { name, dir, namespace: naming.namespace, segment: naming.segment, word: naming.word, entries, sources: sourceAbs, cssGroup, sheets, namespaces: dirNamespaces, groups, naming }
        packages.push(pkg)
        atOf.set(pkg, at)
    })

    if (!isObject(raw.css)) throw new CheckConfigError(`${where}.css must be an object`)
    onlyKeys(raw.css, ["dir", "registry", "lock", "layers", "unboundSheets", "hostParts", "partMaps", "overrides"], `${where}.css`)
    const grouped = packages.filter((p) => p.cssGroup !== null)
    if (raw.css.dir === undefined && grouped.length) {
        throw new CheckConfigError(`${where}.css.dir is required: ${grouped.map((p) => atOf.get(p)).join(", ")} keep${grouped.length === 1 ? "s" : ""} its sheets in a css group (cssGroup)`)
    }
    const cssDir = raw.css.dir === undefined ? null : existingDir(resolve(root, str(raw.css, "dir", `${where}.css`) as string), `${where}.css.dir`)
    const registryFile = str(raw.css, "registry", `${where}.css`, true)
    if (registryFile !== undefined && !registryFile.endsWith(".json")) throw new CheckConfigError(`${where}.css.registry must name the built stylist-registry.json`)
    const lockFile = str(raw.css, "lock", `${where}.css`, true)
    if (lockFile !== undefined && !lockFile.endsWith(".json")) throw new CheckConfigError(`${where}.css.lock must name the lock file (stylist.lock.json)`)
    const layers = raw.css.layers === undefined ? null : validateLayers(raw.css.layers, packages, `${where}.css.layers`)
    const unbound = raw.css.unboundSheets ?? []
    const unboundBase = cssDir ?? resolve(root)
    if (!Array.isArray(unbound) || !unbound.every((s) => typeof s === "string" && s !== "")) throw new CheckConfigError(`${where}.css.unboundSheets must be an array of sheet paths relative to css.dir`)
    for (const sheet of unbound as string[]) {
        if (isAbsolute(sheet) || !existsSync(join(unboundBase, sheet))) throw new CheckConfigError(`${where}.css.unboundSheets: "${sheet}" is not a sheet under ${unboundBase}`)
    }
    const sheetDirs: Array<{ dir: string; label: string }> = []
    for (const pkg of packages) {
        if (pkg.cssGroup !== null) sheetDirs.push({ dir: existingDir(join(cssDir as string, pkg.cssGroup), `${where}.packages cssGroup "${pkg.cssGroup}"`), label: `${atOf.get(pkg)}.cssGroup "${pkg.cssGroup}"` })
        for (const d of pkg.sheets) sheetDirs.push({ dir: d, label: `${atOf.get(pkg)}.sheets "${relative(pkg.dir, d).split(sep).join("/") || "."}"` })
    }
    // no sheet is read twice: sheet directories never repeat or nest (a cssGroup directory is read
    // flat, but a sheets directory above it would read it again)
    sheetDirs.forEach((a, i) => {
        for (const b of sheetDirs.slice(0, i)) {
            if (a.dir === b.dir || a.dir.startsWith(b.dir + sep) || b.dir.startsWith(a.dir + sep)) {
                throw new CheckConfigError(`${a.label} overlaps ${b.label} — sheet directories must not repeat or nest (a sheet would belong to two groups)`)
            }
        }
    })
    const overrides = raw.css.overrides === undefined ? null : validateOverrides(raw.css.overrides, { root, packages, layers, sheetDirs, cssDir }, `${where}.css.overrides`)
    const knownGroups = packages.flatMap((p) => p.groups.map((g) => g.name))
    let partMaps: Record<string, string> | null = null
    if (raw.css.partMaps !== undefined) {
        if (!isObject(raw.css.partMaps)) throw new CheckConfigError(`${where}.css.partMaps must be an object of css group → part-map module specifier`)
        partMaps = {}
        for (const [group, module] of Object.entries(raw.css.partMaps)) {
            if (typeof module !== "string" || module === "") throw new CheckConfigError(`${where}.css.partMaps["${group}"] must be a module specifier`)
            if (!knownGroups.includes(group)) throw new CheckConfigError(`${where}.css.partMaps: "${group}" is not a css group of any package (the groups: ${knownGroups.join(", ")})`)
            if (isRelativeSpecifier(module)) {
                throw new CheckConfigError(
                    `${where}.css.partMaps["${group}"] is the path "${module}" — part maps are recognized by their package specifier only (imports are matched by specifier); expose them under one (a css package, or a resolve.alias + tsconfig paths entry) and list that specifier (docs/CONFIG.md)`,
                )
            }
            partMaps[group] = module
        }
    }
    const hostParts: Record<string, string> = {}
    if (raw.css.hostParts !== undefined) {
        if (!isObject(raw.css.hostParts)) throw new CheckConfigError(`${where}.css.hostParts must be an object of "scope:part" → reason`)
        for (const [key, reason] of Object.entries(raw.css.hostParts)) {
            if (!HOST_PART_RE.test(key)) throw new CheckConfigError(`${where}.css.hostParts: "${key}" is not a "scope:part" reference`)
            if (typeof reason !== "string") throw new CheckConfigError(`${where}.css.hostParts["${key}"] must be a reason string`)
            hostParts[key] = reason.replace(/\s+/g, " ").trim()
        }
    }

    const budget: Record<ExemptionCategory, number> = { none: Infinity, multi: Infinity, native: Infinity }
    let minReasonLength = DEFAULT_MIN_REASON_LENGTH
    if (raw.exemptions !== undefined) {
        const ex = raw.exemptions
        if (!isObject(ex)) throw new CheckConfigError(`${where}.exemptions must be an object`)
        onlyKeys(ex, ["budget", "minReasonLength"], `${where}.exemptions`)
        if (ex.budget !== undefined) {
            if (!isObject(ex.budget)) throw new CheckConfigError(`${where}.exemptions.budget must be an object`)
            onlyKeys(ex.budget, EXEMPTION_CATEGORIES, `${where}.exemptions.budget`)
            for (const cat of EXEMPTION_CATEGORIES) {
                if (ex.budget[cat] === undefined) throw new CheckConfigError(`${where}.exemptions.budget.${cat} is missing — budget every category (0 forbids it)`)
                budget[cat] = count(ex.budget[cat], `${where}.exemptions.budget.${cat}`)
            }
        }
        if (ex.minReasonLength !== undefined) minReasonLength = count(ex.minReasonLength, `${where}.exemptions.minReasonLength`)
    }
    const typescript = { paths: raw.typescript === undefined ? {} : validateTypeScript(raw.typescript, root, packages, `${where}.typescript`) }
    for (const [key, reason] of Object.entries(hostParts)) {
        if (reason.length < minReasonLength) throw new CheckConfigError(`${where}.css.hostParts["${key}"] needs a reason of at least ${minReasonLength} characters — say which host element carries it`)
    }

    return {
        root: resolve(root),
        file,
        prefix,
        hashLength,
        packages,
        css: {
            dir: cssDir,
            // unset in a workspace of app packages (no css-group package): where `libstylist build` writes it
            registry: registryFile !== undefined ? resolve(root, registryFile) : grouped.length ? null : resolve(root, DEFAULT_REGISTRY_FILE),
            lock: lockFile === undefined ? null : resolve(root, lockFile),
            layers,
            unboundSheets: [...(unbound as string[])].sort(),
            hostParts: Object.fromEntries(Object.entries(hostParts).sort(([a], [b]) => (a < b ? -1 : 1))),
            partMaps,
            overrides,
        },
        exemptions: { budget, minReasonLength },
        typescript,
    }
}

/** A `paths` pattern or target: tsconfig allows at most one `*` in each. */
const oneWildcard = (s: string): boolean => s.indexOf("*") === s.lastIndexOf("*")

/**
 * Validates `typescript` and returns its `paths` with every target resolved against `root`: an object of
 * alias pattern → non-empty array of targets, tsconfig's rules (at most one `*` in a pattern and in each
 * target). A pattern equal to a configured package's name or subpath is an error — the package's entries
 * already resolve it.
 */
function validateTypeScript(raw: unknown, root: string, packages: readonly CheckPackage[], where: string): Record<string, string[]> {
    if (!isObject(raw)) throw new CheckConfigError(`${where} must be an object of { paths? }`)
    onlyKeys(raw, ["paths"], where)
    if (raw.paths === undefined) return {}
    if (!isObject(raw.paths)) throw new CheckConfigError(`${where}.paths must be an object of alias pattern → target paths (tsconfig "paths"; targets relative to the config file)`)
    const entries = new Map(packages.flatMap((p) => Object.keys(p.entries).map((subpath) => [subpath === "." ? p.name : `${p.name}/${subpath.slice(2)}`, p.name] as const)))
    const paths: Record<string, string[]> = {}
    for (const [pattern, targets] of Object.entries(raw.paths)) {
        const at = `${where}.paths["${pattern}"]`
        if (pattern === "") throw new CheckConfigError(`${where}.paths: an alias pattern must be a non-empty string`)
        if (!oneWildcard(pattern)) throw new CheckConfigError(`${where}.paths: "${pattern}" has more than one "*" — a pattern has at most one`)
        const owner = entries.get(pattern)
        if (owner !== undefined) throw new CheckConfigError(`${where}.paths: "${pattern}" is an entry of the configured package ${owner} — its entries resolve it already`)
        if (!Array.isArray(targets) || targets.length === 0) throw new CheckConfigError(`${at} must be a non-empty array of target paths, relative to the config file`)
        paths[pattern] = targets.map((target) => {
            if (typeof target !== "string" || target === "") throw new CheckConfigError(`${at}: ${JSON.stringify(target)} is not a target path`)
            if (!oneWildcard(target)) throw new CheckConfigError(`${at}: "${target}" has more than one "*" — a target has at most one`)
            return resolve(root, target)
        })
    }
    return paths
}

/**
 * Validates `css.layers`: an optional order statement (unique layer names) and an optional namespace →
 * layer map over the packages' namespaces, whose layers the statement (when given) declares. Defaults
 * are the workspace build's (`resolveLayers` in `@livesession/libstylist/workspace`).
 */
function validateLayers(raw: unknown, packages: readonly CheckPackage[], where: string): NonNullable<CheckConfig["css"]["layers"]> {
    if (!isObject(raw)) throw new CheckConfigError(`${where} must be an object of { statement?, namespaces? }`)
    onlyKeys(raw, ["statement", "namespaces"], where)
    let statement: string[] | null = null
    if (raw.statement !== undefined) {
        const list = raw.statement
        if (!Array.isArray(list) || list.length === 0) throw new CheckConfigError(`${where}.statement must be a non-empty array of layer names (the @layer order statement)`)
        for (const name of list) if (typeof name !== "string" || !LAYER_RE.test(name)) throw new CheckConfigError(`${where}.statement: ${JSON.stringify(name)} is not a layer name`)
        const dup = list.find((name, i) => list.indexOf(name) !== i)
        if (dup !== undefined) throw new CheckConfigError(`${where}.statement lists "${dup}" twice`)
        statement = [...(list as string[])]
    }
    const known = new Set(packages.flatMap((p) => p.groups.map((g) => g.naming.namespace)))
    const namespaces: Record<string, string> = {}
    if (raw.namespaces !== undefined) {
        if (!isObject(raw.namespaces)) throw new CheckConfigError(`${where}.namespaces must be an object of namespace → layer`)
        for (const [namespace, layer] of Object.entries(raw.namespaces)) {
            if (!known.has(namespace)) throw new CheckConfigError(`${where}.namespaces: "${namespace}" is not a namespace of any package (the namespaces: ${[...known].join(", ")})`)
            if (typeof layer !== "string" || !LAYER_RE.test(layer)) throw new CheckConfigError(`${where}.namespaces["${namespace}"] must be a layer name`)
            if (statement && !statement.includes(layer)) throw new CheckConfigError(`${where}.namespaces["${namespace}"] is "${layer}", which ${where}.statement does not declare — its order would depend on which sheet loads first`)
            namespaces[namespace] = layer
        }
    }
    return { statement, namespaces }
}

/** True when `dir` is `parent` or inside it. */
const within = (dir: string, parent: string): boolean => dir === parent || dir.startsWith(parent + sep)

/**
 * Validates `css.overrides` (SPEC §9): an existing directory that neither is nor contains a sheet
 * directory (a package's `sheets`, `css.dir`) — inside one it is fine: its sheets are then override sheets,
 * never the package's —, the design systems (css package specifiers or registry `.json` paths; resolved
 * at build time, so the loader needs no design system installed), and the overrides layer: a layer name
 * of its own, which a configured order statement declares after `components` and before every
 * namespace's layer.
 */
function validateOverrides(
    raw: unknown,
    ctx: { root: string; packages: readonly CheckPackage[]; layers: CheckConfig["css"]["layers"]; sheetDirs: ReadonlyArray<{ dir: string; label: string }>; cssDir: string | null },
    where: string,
): CheckOverrides {
    if (!isObject(raw)) throw new CheckConfigError(`${where} must be an object of { dir, registries, layer? }`)
    onlyKeys(raw, ["dir", "registries", "layer"], where)
    const dir = existingDir(resolve(ctx.root, str(raw, "dir", where) as string), `${where}.dir`)
    for (const other of [...ctx.sheetDirs, ...(ctx.cssDir ? [{ dir: ctx.cssDir, label: "css.dir" }] : [])]) {
        if (within(other.dir, dir)) {
            throw new CheckConfigError(`${where}.dir ${relative(ctx.root, dir).split(sep).join("/") || "."} ${other.dir === dir ? "is" : "contains"} ${other.label} — override sheets are no package's sheets: give them a directory of their own (apps/<app>/styles/overrides)`)
        }
    }
    if (!Array.isArray(raw.registries) || raw.registries.length === 0) {
        throw new CheckConfigError(`${where}.registries must be a non-empty array: the design systems' css packages ("@livesession/eloquentui-css") or registry .json paths`)
    }
    const registries: string[] = []
    for (const entry of raw.registries) {
        if (typeof entry !== "string" || entry === "") throw new CheckConfigError(`${where}.registries: ${JSON.stringify(entry)} is not a css package or a registry .json path`)
        if (entry.endsWith(".json")) registries.push(resolve(ctx.root, entry))
        else if (isRelativeSpecifier(entry) || !PACKAGE_NAME_RE.test(entry)) {
            throw new CheckConfigError(`${where}.registries: "${entry}" is neither a css package name ("@livesession/eloquentui-css") nor a registry .json path`)
        } else registries.push(entry)
    }
    const dup = registries.find((r, i) => registries.indexOf(r) !== i)
    if (dup !== undefined) throw new CheckConfigError(`${where}.registries lists "${dup}" twice`)
    const layer = str(raw, "layer", where, true) ?? DEFAULT_OVERRIDES_LAYER
    if (!LAYER_RE.test(layer)) throw new CheckConfigError(`${where}.layer "${layer}" is not a layer name`)
    const namespaces = [...new Set(ctx.packages.flatMap((p) => p.groups.map((g) => g.naming.namespace)))]
    const namespaceLayers = [...new Set(namespaces.map((ns) => ctx.layers?.namespaces[ns] ?? `app.${ns}`))]
    const statement = ctx.layers?.statement ?? [...DESIGN_SYSTEM_LAYERS, layer, ...namespaceLayers]
    const problem = overridesLayerProblem(statement, layer, namespaceLayers)
    if (problem) throw new CheckConfigError(`${where}.layer: ${problem}`)
    return { dir, registries, layer }
}

/**
 * Loads and validates a `libstylist.config.mjs` (or `.js`/`.json`). Paths in the config are
 * relative to the file's directory.
 */
export async function loadCheckConfig(path: string): Promise<CheckConfig> {
    const abs = resolve(path)
    if (!existsSync(abs)) throw new CheckConfigError(`libstylist config not found: ${abs}`)
    let raw: unknown
    if (abs.endsWith(".json")) raw = JSON.parse(readFileSync(abs, "utf8"))
    else {
        const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown }
        raw = mod.default
    }
    return validateCheckConfig(raw, dirname(abs), abs, abs)
}

/** Walks up from `from` to the nearest directory holding `libstylist.config.mjs`. */
export function findCheckConfig(from: string): string | null {
    let dir = resolve(from)
    for (;;) {
        const candidate = join(dir, CONFIG_FILE)
        if (existsSync(candidate)) return candidate
        const parent = dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}
