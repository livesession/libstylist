// Override sheets in a workspace (SPEC §9): the design systems of `css.overrides.registries` loaded from
// the installed css packages, every override sheet of `css.overrides.dir` collected and resolved against
// them (`from "<package>"` → the installed component package's prefix and namespace), one override sheet
// compiled into the overrides layer, the reset report over the design systems' published stylesheets,
// and the generated module the app entry imports once. The resolution is `resolveOverrides`
// (`@livesession/libstylist/registry`), the sheet compiler `stylistOverride()` and the design-system reset
// `stylistReset()`/`resetCss()` (`@livesession/libstylist/postcss`); `libstylist build`, `libstylist check`
// and `stylistWorkspace()` all go through the functions here.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

import postcss, { type AtRule, type Container, type Root } from "postcss"

import type { CheckConfig } from "../check/config.js"
import { PART_MAP_HEADER } from "../conventions/index.js"
import { nearest } from "../eslint/suggest.js"
import { importantConflicts, importantDeclarations, type ImportantDeclaration } from "../postcss/important.js"
import { collectOverrideSheet, stylistOverride, wrapInLayer, type OverrideSheetInfo, type StylistOverrideOptions, type StylistOverrideSink } from "../postcss/override.js"
import { acknowledgedDeclarations, formatResetReports, resetCss, resetReports, type ResetReport, type ResetReportLine, type ResetStylesheet, type ResetTarget } from "../postcss/reset.js"
import { REGISTRY_VERSION, resolveOverrides, type OverrideLock, type Registry, type RegistryError, type ResolvePackage, type ResolvedOverrideSheet } from "../registry/index.js"
import { WorkspaceError, loadNesting } from "./base.js"
import { listSheets } from "./groups.js"
import { DEFAULT_OVERRIDES_LAYER, bundleLayerProblem, overridesLayerProblem, type DeclaredLayer } from "./layers.js"

export { DEFAULT_OVERRIDES_LAYER, bundleLayerProblem, overridesLayerProblem, type DeclaredLayer }

/** The generated module in the overrides directory that imports every override sheet. */
export const OVERRIDES_MODULE = "index.ts"
/** Where a design system's css package publishes its registry when its package.json names none (`libstylist.registry`). */
export const DEFAULT_DESIGN_SYSTEM_REGISTRY = "dist/stylist-registry.json"

const toPosix = (p: string) => p.split(sep).join("/")
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const readOrNull = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null)
const realpath = (file: string): string => {
    try {
        return realpathSync(file)
    } catch {
        return resolve(file)
    }
}

export interface CompileOverrideOptions {
    /** The override sheet's path (errors, the default sheet id). */
    from?: string
    /** The plugin options of the resolved sheet (`resolveOverrides(…).sheets[i].plugin`). */
    plugin: StylistOverrideOptions
    /** The `@layer` order statement the compiled sheet starts with. */
    statement: readonly string[]
    /** The overrides layer. @default "app.overrides" */
    layer?: string
}

export interface CompiledOverride {
    /** `@layer <statement>;` then the compiled sheet inside `@layer <overrides layer> { … }`. */
    css: string
    layer: string
    /** The parts the sheet reads, sorted. */
    uses: string[]
    /** Own keyframes: local → emitted name. */
    keyframes: Record<string, string>
    warnings: string[]
    /** The compiled sheet before the layer wrap; its nodes' sources are in the override sheet. */
    root: Root
}

/**
 * Compiles one override sheet: postcss-nesting, `stylistOverride()`, then the layer wrap
 * (`@layer <statement>;\n@layer <layer> {\n…\n}\n`, the shape of every compiled workspace sheet).
 * Throws the first compile error (a `CssSyntaxError` naming file and line).
 */
export async function compileOverride(css: string, options: CompileOverrideOptions): Promise<CompiledOverride> {
    const layer = options.layer ?? DEFAULT_OVERRIDES_LAYER
    const sink: StylistOverrideSink = {}
    const result = await postcss([(await loadNesting())(), stylistOverride({ ...options.plugin, sink })]).process(css, { from: options.from })
    return {
        css: wrapInLayer(result.css, options.statement, layer),
        layer,
        uses: sink.uses ?? [],
        keyframes: sink.keyframes ?? {},
        warnings: result.warnings().map(w => w.text),
        root: result.root,
    }
}

/**
 * The generated module of the overrides directory (committed as `<dir>/index.ts`, imported once by the
 * app entry): the generated-file header, a side-effect import of every override sheet sorted by posix
 * path, and `export {}` so it is a module under `isolatedModules` — also with no sheet left.
 */
export function renderOverridesModule(dir: string, sheets: readonly string[]): string {
    const specifiers = sheets.map(file => `./${relative(dir, file).split(sep).join("/")}`).sort()
    return `${[PART_MAP_HEADER, ...specifiers.map(s => `import ${JSON.stringify(s)}`)].join("\n")}\n\nexport {}\n`
}

// ─── installed packages ─────────────────────────────────────────────────────────────────────────

/** An installed package: its real directory and its parsed package.json. */
export interface InstalledPackage {
    /** Real path of the package directory (a pnpm or `link:` symlink followed). */
    dir: string
    json: Record<string, unknown>
}

const readJson = (file: string): Record<string, unknown> | null => {
    try {
        const value = JSON.parse(readFileSync(file, "utf8")) as unknown
        return isObject(value) ? value : null
    } catch {
        return null
    }
}

/**
 * The package `name` as Node would find it from `from`: the first `node_modules/<name>/package.json`
 * walking up the directories — a plain walk, never `require.resolve`, which fails on packages whose
 * `exports` leave out `./package.json` (the design system's). Null when none is installed there.
 */
export function findInstalledPackage(name: string, from: string): InstalledPackage | null {
    for (let dir = resolve(from); ; dir = dirname(dir)) {
        const file = join(dir, "node_modules", ...name.split("/"), "package.json")
        if (existsSync(file)) {
            const json = readJson(file)
            if (json) return { dir: realpath(dirname(file)), json }
        }
        if (dirname(dir) === dir) return null
    }
}

/** The installed package names next to where `name` would be (its npm scope's directory, or `node_modules`), for a did-you-mean. */
function siblingPackages(name: string, from: string): string[] {
    const scope = name.startsWith("@") ? name.slice(0, name.indexOf("/")) : null
    const out = new Set<string>()
    for (let dir = resolve(from); ; dir = dirname(dir)) {
        const parent = scope ? join(dir, "node_modules", scope) : join(dir, "node_modules")
        if (existsSync(parent)) {
            try {
                for (const entry of readdirSync(parent)) if (!entry.startsWith(".") && !entry.startsWith("@")) out.add(scope ? `${scope}/${entry}` : entry)
            } catch {
                // unreadable: no suggestion from here
            }
        }
        if (dirname(dir) === dir) return [...out]
    }
}

/** A package's `libstylist` field. */
const libstylistOf = (pkg: InstalledPackage): Record<string, unknown> | null => (isObject(pkg.json.libstylist) ? pkg.json.libstylist : null)

/**
 * The `resolvePackage` of a workspace (SPEC §9.2): `from "<package>"` of an override sheet (its path
 * relative to `root`) is the component package installed where the sheet is; its package.json
 * `libstylist.prefix` picks the design system and `libstylist.namespace` the namespace. A css package
 * (it declares `groups`) or a package without a prefix and a namespace is no component package.
 */
export function overridePackageResolver(root: string): ResolvePackage {
    return (specifier, file) => {
        const from = resolve(root, dirname(file))
        const pkg = findInstalledPackage(specifier, from)
        if (!pkg) {
            // the nearest installed name, when it is a component package too
            const near = nearest(specifier, siblingPackages(specifier, from))
            const nearPkg = near ? findInstalledPackage(near, from) : null
            const guess = nearPkg && typeof libstylistOf(nearPkg)?.namespace === "string" ? near : null
            return { error: `"${specifier}" is not installed where the sheet is (no node_modules/${specifier} above ${toPosix(relative(root, from)) || "."})${guess ? ` — did you mean "${guess}"?` : ""}` }
        }
        const field = libstylistOf(pkg)
        if (field && field.groups !== undefined) {
            return { error: `"${specifier}" is a css package (it publishes the design system's registry) — name the component package the component is imported from` }
        }
        if (!field || typeof field.prefix !== "string" || typeof field.namespace !== "string") {
            return { error: `"${specifier}" declares no libstylist prefix and namespace in its package.json — it is no design-system component package` }
        }
        return { prefix: field.prefix, namespace: field.namespace }
    }
}

// ─── design systems ─────────────────────────────────────────────────────────────────────────────

/** A design system whose components an app's override sheets restyle (`css.overrides.registries`). */
export interface DesignSystem {
    /** The `css.overrides.registries` entry it comes from (a css package specifier, or a registry path). */
    entry: string
    prefix: string
    registry: Registry
    /** Real path of its registry file. */
    registryFile: string
    /** Real path of its css package's directory: the stylesheets a reset strips are the ones inside it. */
    packageDir: string
}

const registryCache = new Map<string, { mtime: number; value: Registry | string }>()

/** A registry file parsed and checked (cached by modification time), or why it can't be used. */
function readRegistry(file: string): Registry | string {
    const mtime = statSync(file).mtimeMs
    const cached = registryCache.get(file)
    if (cached && cached.mtime === mtime) return cached.value
    let value: Registry | string
    try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Registry
        value = !isObject(raw) || !isObject(raw.scopes) || typeof raw.prefix !== "string" ? "not a stylist-registry.json" : raw.version !== REGISTRY_VERSION ? `registry version ${String(raw.version)}, expected ${REGISTRY_VERSION} — update @livesession/libstylist or the design system` : raw
    } catch (err) {
        value = `not valid JSON (${(err as Error).message})`
    }
    registryCache.set(file, { mtime, value })
    return value
}

/** The nearest directory at or above `dir` holding a package.json. */
function packageDirOf(dir: string): string | null {
    for (let d = dir; ; d = dirname(d)) {
        if (existsSync(join(d, "package.json"))) return d
        if (dirname(d) === d) return null
    }
}

/**
 * The design systems of `css.overrides.registries` (SPEC §9.2): a css package — installed where the
 * override sheets are, else where the config is — whose package.json declares `libstylist.groups`, its
 * registry at `libstylist.registry` (package-relative) or `dist/stylist-registry.json`; or a registry
 * `.json` path, whose package is the nearest directory above it with a package.json. A registry must be
 * readable and of version 1, carry its package's prefix, and differ in prefix from the app and from every
 * other design system. Problems are `design-system` errors.
 */
export function loadDesignSystems(config: Pick<CheckConfig, "root" | "prefix" | "css">): { designSystems: DesignSystem[]; errors: RegistryError[] } {
    const designSystems: DesignSystem[] = []
    const errors: RegistryError[] = []
    const overrides = config.css.overrides
    if (!overrides) return { designSystems, errors }
    const rel = (file: string) => toPosix(relative(config.root, file)) || "."
    for (const entry of overrides.registries) {
        const label = `css.overrides.registries "${entry.startsWith("/") ? rel(entry) : entry}"`
        const fail = (message: string, files: string[] = []) => errors.push({ code: "design-system", message: `${label}: ${message}`, files })
        let registryFile: string
        let packageDir: string
        let declaredPrefix: unknown
        if (entry.endsWith(".json")) {
            if (!existsSync(entry)) {
                fail(`${rel(entry)} does not exist — build the design system's css package`)
                continue
            }
            registryFile = realpath(entry)
            packageDir = packageDirOf(dirname(registryFile)) ?? dirname(registryFile)
            const field = readJson(join(packageDir, "package.json"))?.libstylist
            declaredPrefix = isObject(field) ? field.prefix : undefined
        } else {
            const pkg = findInstalledPackage(entry, overrides.dir) ?? findInstalledPackage(entry, config.root)
            if (!pkg) {
                fail(`not installed (no node_modules/${entry} above ${rel(overrides.dir)} or the config) — add the design system's css package to the app's dependencies`)
                continue
            }
            const field = libstylistOf(pkg)
            if (!field || !isObject(field.groups)) {
                fail(`${entry} is no design system's css package (its package.json declares no libstylist.groups)${typeof field?.namespace === "string" ? " — it is a component package: list the css package that publishes stylist-registry.json" : ""}`)
                continue
            }
            const file = join(pkg.dir, typeof field.registry === "string" ? field.registry : DEFAULT_DESIGN_SYSTEM_REGISTRY)
            if (!existsSync(file)) {
                fail(`${toPosix(relative(pkg.dir, file))} does not exist in ${entry} — build the design system's css package`)
                continue
            }
            registryFile = realpath(file)
            packageDir = pkg.dir
            declaredPrefix = field.prefix
        }
        const registry = readRegistry(registryFile)
        if (typeof registry === "string") {
            fail(`${rel(registryFile)}: ${registry}`, [rel(registryFile)])
            continue
        }
        if (typeof declaredPrefix === "string" && declaredPrefix !== registry.prefix) {
            fail(`the registry's prefix is "${registry.prefix}" but its package declares libstylist.prefix "${declaredPrefix}" — rebuild the design system`, [rel(registryFile)])
            continue
        }
        if (registry.prefix === config.prefix) {
            fail(`the design system's prefix "${registry.prefix}" is the app's own — an app and its design system never share a prefix`)
            continue
        }
        const clash = designSystems.find(d => d.prefix === registry.prefix)
        if (clash) {
            fail(`prefix "${registry.prefix}" is also the prefix of "${clash.entry}" — list each design system once`)
            continue
        }
        designSystems.push({ entry, prefix: registry.prefix, registry, registryFile, packageDir })
    }
    return { designSystems, errors }
}

/** The design system whose css package holds `file` (a stylesheet the app bundles; symlinks followed), or null. */
export function designSystemOf(designSystems: readonly DesignSystem[], file: string): DesignSystem | null {
    const abs = realpath(file)
    return designSystems.find(d => abs.startsWith(d.packageDir + sep)) ?? null
}

/** Every stylesheet a design system publishes: the `.css` files under its registry's directory (`dist`), aggregates and per-sheet files alike. */
export function designSystemStylesheets(ds: DesignSystem): string[] {
    return listSheets(dirname(ds.registryFile))
}

// ─── the override sheets ────────────────────────────────────────────────────────────────────────

/** One override sheet of a workspace. */
export interface WorkspaceOverrideSheet {
    /** Absolute path. */
    file: string
    /** Posix path relative to the workspace root (how errors, the lock and the reset report name it). */
    rel: string
    css: string
    /** Pass 1: its directives, classes and keyframes. */
    info: OverrideSheetInfo
    /** The sheet resolved against its design system, or null when it didn't resolve (the errors say why). */
    resolved: ResolvedOverrideSheet | null
}

/** The override sheets of a workspace, resolved (SPEC §9.3). */
export interface WorkspaceOverrides {
    /** Absolute directory of the override sheets (`css.overrides.dir`). */
    dir: string
    /** The cascade layer they compile into. */
    layer: string
    /** Absolute path of the generated module that imports every override sheet (`<dir>/index.ts`). */
    module: string
    designSystems: DesignSystem[]
    /** Every `.css` file under `dir`, sorted by path. */
    sheets: WorkspaceOverrideSheet[]
    /** Every reset target, by label. */
    resets: ResetTarget[]
    /** The lock sections (`overrides`, `resets`). */
    lock: OverrideLock
    /** Fatal: a design system that can't be loaded, a hand-written `index.ts`, and every resolution error. */
    errors: RegistryError[]
}

export interface CollectOverridesOptions {
    /** Sheet contents to use instead of the files on disk (absolute path → css) — the Vite plugin's in-memory copies. */
    sources?: ReadonlyMap<string, string>
    /** How `from "<package>"` resolves; default {@link overridePackageResolver} (the installed package's package.json). */
    resolvePackage?: ResolvePackage
}

/** True when `file` is an override sheet of `dir`: a `.css` file under it that `listSheets` would list. */
export function isOverrideSheet(dir: string, file: string): boolean {
    const abs = resolve(file)
    if (!abs.endsWith(".css") || !abs.startsWith(dir + sep)) return false
    const segments = relative(dir, abs).split(sep).slice(0, -1)
    return !segments.some(s => s.startsWith(".") || ["node_modules", "dist", "build", "coverage"].includes(s))
}

/**
 * Pass 1 over a workspace's override sheets (SPEC §9.3): loads the design systems, reads every `.css`
 * under `css.overrides.dir` (`sources` wins over the disk), collects and resolves each against its
 * design system and the app's registry (`within`). Null when the config has no `css.overrides`. Every
 * error is fatal: nothing should be compiled, stripped or written while there is one.
 */
export function collectOverrides(config: Pick<CheckConfig, "root" | "prefix" | "css">, appRegistry: Registry | null, options: CollectOverridesOptions = {}): WorkspaceOverrides | null {
    const cfg = config.css.overrides
    if (!cfg) return null
    const rel = (file: string) => toPosix(relative(config.root, file))
    const module = join(cfg.dir, OVERRIDES_MODULE)
    const { designSystems, errors } = loadDesignSystems(config)
    const current = readOrNull(module)
    if (current !== null && !current.startsWith(PART_MAP_HEADER)) {
        errors.push({
            code: "overrides-index",
            message: `${rel(module)} is not the module libstylist generates there (it imports every override sheet; the app entry imports it once) — move what it holds elsewhere and delete it`,
            files: [rel(module)],
        })
    }
    const read = (abs: string) => options.sources?.get(abs) ?? readFileSync(abs, "utf8")
    const sheets: WorkspaceOverrideSheet[] = listSheets(cfg.dir).map(file => {
        const css = read(file)
        return { file, rel: rel(file), css, info: collectOverrideSheet(css, { file: rel(file) }), resolved: null }
    })
    const out: WorkspaceOverrides = { dir: cfg.dir, layer: cfg.layer, module, designSystems, sheets, resets: [], lock: { overrides: {}, resets: {} }, errors }
    if (errors.some(e => e.code === "design-system")) {
        // without its design system a sheet can't resolve: report what pass 1 found, not a missing registry per sheet
        for (const s of sheets) for (const e of s.info.errors) errors.push({ code: "invalid-override", message: `${s.rel}${e.line ? `:${e.line}` : ""}: ${e.message}`, files: [s.rel] })
        return out
    }
    const resolved = resolveOverrides({
        sheets: sheets.map(s => s.info),
        designSystems: designSystems.map(d => d.registry),
        resolvePackage: options.resolvePackage ?? overridePackageResolver(config.root),
        app: { prefix: config.prefix, registry: appRegistry },
    })
    const byFile = new Map(resolved.sheets.map(s => [s.file, s]))
    for (const s of sheets) s.resolved = byFile.get(s.rel) ?? null
    out.resets = resolved.resets
    out.lock = resolved.lock
    errors.push(...resolved.errors)
    return out
}

/** A compiled override sheet of a workspace. */
export interface CompiledOverrideSheet extends CompiledOverride {
    sheet: WorkspaceOverrideSheet
}

/**
 * Compiles one override sheet of a workspace into the overrides layer, behind the order `statement`
 * ({@link compileOverride} with the options its resolution carries). A declaration that a design-system
 * `!important` of the same element beats — it can never take effect ({@link importantWarnings}) — is a
 * warning. Throws a `WorkspaceError` for a file that is no override sheet of `overrides` or that didn't
 * resolve (with its errors), and the first compile error.
 */
export async function compileOverrideSheet(overrides: WorkspaceOverrides, statement: readonly string[], file: string, css: string): Promise<CompiledOverrideSheet> {
    const abs = resolve(file)
    const sheet = overrides.sheets.find(s => s.file === abs)
    if (!sheet) throw new WorkspaceError(`${file} is no override sheet of the workspace — override sheets are the .css files under css.overrides.dir`)
    if (!sheet.resolved) {
        const own = overrides.errors.filter(e => e.files.includes(sheet.rel))
        const why = (own.length ? own : overrides.errors).map(e => `[${e.code}] ${e.message}`).join("\n")
        throw new WorkspaceError(`${sheet.rel} did not resolve against its design system${why ? `:\n${why}` : ""}`)
    }
    const compiled = await compileOverride(css, { from: abs, plugin: sheet.resolved.plugin, statement, layer: overrides.layer })
    const ds = overrides.designSystems.find(d => d.prefix === sheet.resolved?.target.prefix)
    if (ds) compiled.warnings.push(...importantWarnings(compiled.root, sheet.resolved, ds, resetsOf(overrides, ds.prefix)))
    return { ...compiled, sheet }
}

// ─── the design system's !important declarations ────────────────────────────────────────────────

const importantCache = new Map<string, { key: string; value: ImportantDeclaration[] }>()

/**
 * The `!important` declarations of every stylesheet a design system publishes (aggregates first, one per
 * selector, property and value; cached until a stylesheet changes). A stylesheet that doesn't parse is
 * left out.
 */
export function designSystemImportants(ds: DesignSystem): ImportantDeclaration[] {
    const base = dirname(ds.registryFile)
    const depth = (file: string) => relative(base, file).split(sep).length
    const files = designSystemStylesheets(ds).sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))
    const key = files.map(f => `${f}:${statSync(f).mtimeMs}`).join("\n")
    const cached = importantCache.get(ds.packageDir)
    if (cached && cached.key === key) return cached.value
    const seen = new Set<string>()
    const value: ImportantDeclaration[] = []
    for (const file of files) {
        let found: ImportantDeclaration[]
        try {
            found = importantDeclarations(readFileSync(file, "utf8"), toPosix(relative(base, file)))
        } catch {
            continue
        }
        for (const d of found) {
            const id = `${d.selector}\u0000${d.prop}\u0000${d.value}`
            if (!seen.has(id)) value.push(d), seen.add(id)
        }
    }
    importantCache.set(ds.packageDir, { key, value })
    return value
}

/**
 * The warnings of a compiled override sheet whose declarations a design-system `!important` of the same
 * element beats (SPEC §9.4), without the sheet's path (the callers print it first): an `!important` in an
 * earlier cascade layer wins over every later layer, so the override's declaration never applies. A reset part's own `!important`s are stripped (`resets`); an
 * `!important` of another component's rule for the target's identity is kept by a reset too.
 */
export function importantWarnings(compiled: string | Root, sheet: ResolvedOverrideSheet, ds: DesignSystem, resets: readonly ResetTarget[]): string[] {
    const scope = ds.registry.scopes[sheet.target.scope]
    if (!scope) return []
    const reset = new Set(resets.map(t => t.attr.toLowerCase()))
    const partOf = new Map(Object.entries(scope.parts).map(([part, attr]) => [attr.toLowerCase(), part]))
    const tagOf = new Map(scope.roots.map(r => [r.local, r.tag.toLowerCase()]))
    // an element's names as the override writes them → as the design system's rules may name it
    const elements = new Map<string, string[]>()
    for (const [part, attr] of Object.entries(scope.parts)) {
        const tag = tagOf.get(part)
        const names = [...(reset.has(attr.toLowerCase()) ? [] : [attr.toLowerCase()]), ...(tag ? [tag] : [])]
        elements.set(attr.toLowerCase(), names)
        if (tag) elements.set(tag, names)
    }
    const importants = designSystemImportants(ds).filter(d => d.names.some(n => partOf.has(n) || [...tagOf.values()].includes(n)))
    const out = new Map<string, string>()
    for (const c of importantConflicts(compiled, elements, importants)) {
        const part = partOf.get(c.name)
        const way = part !== undefined
            ? `@stylist reset ${part === sheet.target.rootPart && sheet.target.kind === "component" ? "root" : part}; removes it`
            : "it is another component's rule for this element, which a reset keeps — the design system has to drop the !important"
        const key = `${c.line ?? 0}\u0000${c.prop}`
        if (!out.has(key)) {
            out.set(key, `[important] ${c.line ? `line ${c.line}: ` : ""}${c.prop} can't take effect — the design system declares ${c.important.prop}: ${c.important.value} !important for the same element (${c.important.selector}, ${c.important.file}${c.important.line ? `:${c.important.line}` : ""}), and an !important of an earlier cascade layer beats every later layer: ${way}`)
        }
    }
    return [...out.values()]
}

// ─── resets ─────────────────────────────────────────────────────────────────────────────────────

/** The reset targets of one design system. */
export const resetsOf = (overrides: WorkspaceOverrides | null, prefix: string): ResetTarget[] => (overrides?.resets ?? []).filter(t => t.prefix === prefix)

/**
 * What identifies a reset set for a transformed stylesheet: every target's label, attribute, identity
 * and override sheet (not its line — moving a directive changes no stylesheet).
 */
export const resetKey = (targets: readonly ResetTarget[]): string => JSON.stringify(targets.map(t => [t.label, t.attr, t.tag, t.sheet, !!t.whole]))

/**
 * The reset targets a build stripped from no bundled stylesheet (`stripped`: labels, from
 * `touchedTargets` — a selector dropped or guarded for them): a part reset must
 * drop something somewhere, a whole reset (`@stylist reset;`) in at least one of its parts. One entry per
 * part reset, and one (its first part) per whole reset.
 */
export function unbundledResets(targets: readonly ResetTarget[], stripped: ReadonlySet<string>): ResetTarget[] {
    const out: ResetTarget[] = []
    const wholes = new Map<string, ResetTarget[]>()
    for (const t of targets) {
        if (!t.whole) {
            if (!stripped.has(t.label)) out.push(t)
            continue
        }
        const key = `${t.sheet}\u0000${t.prefix}\u0000${t.scope}`
        wholes.set(key, [...(wholes.get(key) ?? []), t])
    }
    for (const group of wholes.values()) if (!group.some(t => stripped.has(t.label))) out.push(group[0])
    return out
}

/** The reset report of a workspace's override sheets. */
export interface OverrideReports {
    reports: ResetReport[]
    /** `reset` and `note` lines, and an `error` line per `[empty-reset]`. */
    lines: ResetReportLine[]
}

/**
 * The reset report (SPEC §9.5) over every stylesheet each design system publishes
 * ({@link designSystemStylesheets}: aggregates and per-sheet files, deduplicated by rule and
 * declaration) — independent of which ones the app imports. `compiled` (override sheet path relative to
 * the workspace root → its compiled CSS) says which layout declarations an override re-declares; without
 * it every dropped layout declaration is a note. A stylesheet the reset can't process (a local `@import`)
 * is left out: bundling it fails where it is transformed.
 */
export function overrideReports(overrides: WorkspaceOverrides, compiled: ReadonlyMap<string, string> = new Map()): OverrideReports {
    const reports: ResetReport[] = []
    const parsed = new Map<string, Root>()
    const compiledRoot = (sheet: string): Root | null => {
        const css = compiled.get(sheet)
        if (css === undefined) return null
        let root = parsed.get(sheet)
        if (!root) parsed.set(sheet, (root = postcss.parse(css)))
        return root
    }
    for (const ds of overrides.designSystems) {
        const targets = resetsOf(overrides, ds.prefix)
        if (targets.length === 0) continue
        const base = dirname(ds.registryFile)
        const stylesheets: ResetStylesheet[] = []
        // the aggregates first (what an app imports), then the per-sheet files: a note points at the first
        const depth = (file: string) => relative(base, file).split(sep).length
        for (const file of designSystemStylesheets(ds).sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))) {
            try {
                const { outcome } = resetCss(readFileSync(file, "utf8"), targets, { from: file, comment: false })
                if (outcome.changed) stylesheets.push({ file: toPosix(relative(base, file)), outcome })
            } catch {
                // a stylesheet the reset refuses ([reset-import]) fails where it is bundled
            }
        }
        reports.push(
            ...resetReports(targets, stylesheets, {
                acknowledged: target => {
                    const root = compiledRoot(target.sheet)
                    return root ? acknowledgedDeclarations(root, target) : []
                },
            }),
        )
    }
    return { reports, lines: formatResetReports(reports) }
}

// ─── the layer order a bundle declares ──────────────────────────────────────────────────────────

/**
 * The cascade layers a stylesheet declares, in cascade order: each by its first declaration (an `@layer`
 * statement or block, inside `@media`/`@supports` too), dotted names and nested blocks as sublayers
 * right after their parent. Anonymous layers are left out.
 */
export function declaredLayerOrder(css: string | Root): DeclaredLayer[] {
    interface LayerNode {
        at: string
        children: Map<string, LayerNode>
    }
    const top: LayerNode = { at: "", children: new Map() }
    const declare = (parent: LayerNode, name: string, at: string): LayerNode => {
        let node = parent
        for (const segment of name.split(".")) {
            let next = node.children.get(segment)
            if (!next) node.children.set(segment, (next = { at, children: new Map() }))
            node = next
        }
        return node
    }
    const visit = (container: Container, parent: LayerNode) => {
        container.each(child => {
            if (child.type !== "atrule") return
            const at = child as AtRule
            if (at.name.toLowerCase() !== "layer") {
                if (at.nodes) visit(at, parent)
                return
            }
            const names = at.params.split(",").map(n => n.trim()).filter(Boolean)
            const text = `@layer ${names.join(", ")}`
            if (!at.nodes) for (const name of names) declare(parent, name, text)
            else if (names.length === 1) visit(at, declare(parent, names[0], text))
        })
    }
    visit(typeof css === "string" ? postcss.parse(css) : css, top)
    const out: DeclaredLayer[] = []
    const flatten = (node: LayerNode, prefix: string) => {
        for (const [segment, child] of node.children) {
            const name = prefix ? `${prefix}.${segment}` : segment
            out.push({ name, at: child.at })
            flatten(child, name)
        }
    }
    flatten(top, "")
    return out
}
