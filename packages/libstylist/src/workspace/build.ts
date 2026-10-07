// The workspace build (`libstylist build`, `stylistWorkspace()`): the stylesheets of a workspace of app
// packages that keep their sheets next to their sources (docs/CONFIG.md, "A workspace of app
// packages"). Pass 1 is the css build's — every package's groups (the checker's grouping) → one
// registry, plus the export names each part-map module must keep apart. Pass 2 compiles one sheet at a
// time (the Vite plugin, at import time): nesting, the libstylist plugin, then the sheet wrapped in its
// namespace's cascade layer. The outputs are each package's generated part-map module (committed),
// the lock (committed) and the registry JSON (gitignored, for lint and the checker). A workspace with
// override sheets (`css.overrides`, SPEC §9) also resolves them against their design systems in pass 1,
// compiles each into the overrides layer, reports what its resets drop, locks what they read and writes
// the module that imports them (committed).
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import postcss from "postcss"

import { findCheckConfig, loadCheckConfig, validateCheckConfig, type CheckConfig, type CheckPackage, type RawCheckConfig } from "../check/config.js"
import { configSheets } from "../check/sheets.js"
import { DEFAULT_REGISTRY_FILE, PART_MAP_HEADER } from "../conventions/index.js"
import { collectSheet } from "../postcss/collect.js"
import { wrapInLayer } from "../postcss/override.js"
import { stylist } from "../postcss/plugin.js"
import type { ResetReport, ResetReportLine } from "../postcss/reset.js"
import { buildRegistry, exportName, partMapValue, sameComponent, stylistOptions, toLock, type Registry, type RegistryError, type RegistryGroup } from "../registry/index.js"
import { WorkspaceError, loadNesting } from "./base.js"
import { DESIGN_SYSTEM_LAYERS, overridesLayerProblem } from "./layers.js"
import { OVERRIDES_MODULE, collectOverrides, compileOverrideSheet, isOverrideSheet, overrideReports, renderOverridesModule, type WorkspaceOverrides } from "./overrides.js"

export { DEFAULT_REGISTRY_FILE, PART_MAP_HEADER, WorkspaceError, loadNesting }

export { DESIGN_SYSTEM_LAYERS }
/** Where the lock goes when `css.lock` is unset, relative to the workspace root. */
export const DEFAULT_LOCK_FILE = "stylist.lock.json"
/** The name of a package's generated part-map module, in its first sheet directory. */
export const PART_MAP_MODULE = "index.ts"

export interface WorkspacePackage {
    name: string
    /** Absolute package directory. */
    dir: string
    /** The checker's package: naming, directory namespaces, css groups, sheet directories. */
    check: CheckPackage
    /** Absolute path of the generated part-map module (`index.ts` in the first sheet directory), or null without a sheet directory. */
    module: string | null
    /** The specifier `css.partMaps` imports the package's groups by (`#css`), or null when none is configured. */
    specifier: string | null
}

/** The cascade layers every compiled sheet is wrapped in. */
export interface WorkspaceLayers {
    /** The `@layer` order statement each compiled sheet starts with. */
    statement: string[]
    /** Namespace → the layer its sheets are wrapped in. */
    namespaces: Record<string, string>
}

/** The override sheets of a workspace as configured (`css.overrides`), and where their generated module goes. */
export interface WorkspaceOverridesConfig {
    /** Absolute directory of the override sheets. */
    dir: string
    /** The cascade layer they compile into. */
    layer: string
    /** The design systems: css package specifiers, or absolute registry paths. */
    registries: string[]
    /** Absolute path of the generated module that imports them all (`<dir>/index.ts`). */
    module: string
}

/** A workspace ready to build: the validated config and what the build derives from it. */
export interface Workspace {
    config: CheckConfig
    /** Absolute directory of the config file; registry `file`s are relative to it. */
    root: string
    prefix: string
    packages: WorkspacePackage[]
    /** css group → namespace and naming: every package's groups (the registry's group table). */
    groups: Record<string, RegistryGroup>
    layers: WorkspaceLayers
    /** Absolute path of the committed lock (`css.lock`, default `stylist.lock.json`). */
    lock: string
    /** Absolute path of the registry JSON (`css.registry`, default `node_modules/.cache/libstylist/stylist-registry.json`). */
    registry: string
    /** The override sheets (`css.overrides`), or null without any. */
    overrides: WorkspaceOverridesConfig | null
}

/** One sheet of a built workspace. */
export interface WorkspaceSheet {
    /** Absolute path. */
    file: string
    /** Posix path relative to the workspace root (the registry's `file`). */
    rel: string
    group: string
    package: WorkspacePackage
    css: string
    /** The scope the registry gave it, or null when it was rejected (a duplicate scope, an invalid sheet). */
    scope: string | null
}

/** Pass 1 over a workspace. */
export interface WorkspaceBuild {
    workspace: Workspace
    registry: Registry
    /** Fatal: registry errors (SPEC §7), part-map export names two scopes of one module share, and the override sheets' errors. */
    errors: RegistryError[]
    sheets: WorkspaceSheet[]
    /** The override sheets resolved against their design systems, or null (no `css.overrides`, or not collected). */
    overrides: WorkspaceOverrides | null
}

const toPosix = (p: string) => p.split(sep).join("/")
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isValidated = (c: object): c is CheckConfig => "root" in c && Array.isArray((c as CheckConfig).packages) && (c as CheckConfig).packages.every((p) => !!p.naming && Array.isArray(p.groups))

/**
 * The layers of a config: `css.layers.namespaces` over the default `app.<namespace>`, and the order
 * statement `css.layers.statement`, by default the design system's layers, the overrides layer when the
 * config has override sheets (`css.overrides.layer`), then each namespace's layer in the order the
 * packages declare the namespaces. Throws when a namespace's layer is missing from the statement — its
 * place in the cascade would depend on which sheet the browser parses first — and when the overrides
 * layer is not after `components` and before every namespace's layer (`overridesLayerProblem`).
 */
export function resolveLayers(config: Pick<CheckConfig, "packages" | "css">): WorkspaceLayers {
    const namespaces: string[] = []
    for (const pkg of config.packages) for (const g of pkg.groups) if (!namespaces.includes(g.naming.namespace)) namespaces.push(g.naming.namespace)
    const configured = config.css.layers ?? null
    const overrides = config.css.overrides ?? null
    const map: Record<string, string> = {}
    for (const ns of namespaces) map[ns] = configured?.namespaces[ns] ?? `app.${ns}`
    const namespaceLayers = [...new Set(namespaces.map((ns) => map[ns]))]
    const statement = configured?.statement ?? [...DESIGN_SYSTEM_LAYERS, ...(overrides ? [overrides.layer] : []), ...namespaceLayers]
    for (const ns of namespaces) {
        if (!statement.includes(map[ns])) {
            throw new WorkspaceError(`css.layers.statement does not declare "${map[ns]}", the layer of namespace "${ns}" — add it, or map the namespace to a declared layer in css.layers.namespaces`)
        }
    }
    const problem = overrides ? overridesLayerProblem(statement, overrides.layer, namespaceLayers) : null
    if (problem) throw new WorkspaceError(problem)
    return { statement: [...statement], namespaces: map }
}

/** The string a package.json `imports` entry resolves to (the `default`/`import` condition of a conditional one), or null. */
function importTarget(value: unknown): string | null {
    if (typeof value === "string") return value
    if (!isObject(value)) return null
    for (const key of ["default", "import", "types"]) {
        const hit = importTarget(value[key])
        if (hit) return hit
    }
    return null
}

/**
 * The workspace a validated config describes. Throws `WorkspaceError` when a package keeps its sheets
 * in a css package's group (`cssGroup` — the css package's own build compiles those), when a package's
 * `#` part-map specifier resolves (package.json `imports`) to another file than the module the build
 * writes, and on layers `resolveLayers` rejects.
 */
export function workspaceOf(config: CheckConfig): Workspace {
    const grouped = config.packages.filter((p) => p.cssGroup !== null)
    if (grouped.length) {
        throw new WorkspaceError(
            `${grouped.map((p) => p.name).join(", ")} keep${grouped.length === 1 ? "s" : ""} its sheets in a css group (cssGroup) — the workspace build compiles packages that list their own sheet directories (sheets); build a css package with its own build`,
        )
    }
    const groups: Record<string, RegistryGroup> = {}
    const packages = config.packages.map((pkg): WorkspacePackage => {
        for (const g of pkg.groups) groups[g.name] = { namespace: g.naming.namespace, segment: g.naming.segment, word: g.naming.word }
        const module = pkg.sheets.length ? join(pkg.sheets[0], PART_MAP_MODULE) : null
        const specifiers = [...new Set(pkg.groups.map((g) => config.css.partMaps?.[g.name]).filter((s): s is string => !!s))]
        // a `#` specifier must reach the module the build writes (a package without sheets has none to reach)
        for (const spec of module ? specifiers.filter((s) => s.startsWith("#")) : []) {
            const pkgJson = join(pkg.dir, "package.json")
            const imports = existsSync(pkgJson) ? (JSON.parse(readFileSync(pkgJson, "utf8")) as { imports?: Record<string, unknown> }).imports : undefined
            const target = importTarget(imports?.[spec])
            const where = toPosix(relative(config.root, pkgJson))
            const want = `./${toPosix(relative(pkg.dir, module as string))}`
            if (!target) throw new WorkspaceError(`${where}: css.partMaps imports ${pkg.name}'s part maps from "${spec}", which its "imports" does not declare — add "${spec}": "${want}"`)
            if (resolve(pkg.dir, target) !== module) {
                throw new WorkspaceError(`${where}: imports["${spec}"] is "${target}", but the build writes ${pkg.name}'s part maps to ${toPosix(relative(config.root, module as string))} — point it at "${want}"`)
            }
        }
        return { name: pkg.name, dir: pkg.dir, check: pkg, module, specifier: specifiers[0] ?? null }
    })
    return {
        config,
        root: config.root,
        prefix: config.prefix,
        packages,
        groups,
        layers: resolveLayers(config),
        lock: config.css.lock ?? join(config.root, DEFAULT_LOCK_FILE),
        registry: config.css.registry ?? join(config.root, DEFAULT_REGISTRY_FILE),
        overrides: config.css.overrides ? { ...config.css.overrides, registries: [...config.css.overrides.registries], module: join(config.css.overrides.dir, OVERRIDES_MODULE) } : null,
    }
}

export interface LoadWorkspaceOptions {
    /** A config file (relative to `root`), a validated config, or a raw config object (paths relative to `root`); default: `libstylist.config.mjs` found upward from `root`. */
    config?: string | CheckConfig | RawCheckConfig
    /** Where relative paths start and the search begins. @default process.cwd() */
    root?: string
}

/** Loads the workspace config ({@link LoadWorkspaceOptions}) and derives the workspace ({@link workspaceOf}). */
export async function loadWorkspace(options: LoadWorkspaceOptions = {}): Promise<Workspace> {
    const root = resolve(options.root ?? process.cwd())
    const { config } = options
    if (typeof config === "string") return workspaceOf(await loadCheckConfig(resolve(root, config)))
    if (config && isValidated(config)) return workspaceOf(config)
    if (config) return workspaceOf(validateCheckConfig(config, root))
    const found = findCheckConfig(root)
    if (!found) throw new WorkspaceError(`no libstylist.config.mjs found in ${root} or above`)
    return workspaceOf(await loadCheckConfig(found))
}

export interface BuildWorkspaceOptions {
    /** Sheet contents to use instead of the files on disk (absolute path → css) — the Vite plugin's in-memory copies, override sheets included. */
    sources?: ReadonlyMap<string, string>
    /**
     * Collect and resolve the override sheets (`css.overrides`) — their design systems must be installed.
     * `false` leaves them out (`build.overrides` is null): the JSX transform of a test runner needs none.
     * @default true
     */
    overrides?: boolean
}

/**
 * Pass 1: lists every package's sheets (the checker's grouping, `configSheets`), builds the registry
 * and reports what would make a package's part-map module ambiguous — two scopes exporting one name
 * (`switch` and `switch-classes` both export `switchClasses`) from one package's module or from one
 * `css.partMaps` specifier — then collects the override sheets against their design systems and the
 * registry (`collectOverrides`). Every error is fatal: nothing should be written or served from a
 * registry that has one.
 */
export function buildWorkspace(input: CheckConfig | Workspace, options: BuildWorkspaceOptions = {}): WorkspaceBuild {
    const ws = "config" in input && "layers" in input ? input : workspaceOf(input)
    const byCheck = new Map(ws.packages.map((p) => [p.check, p]))
    const listed = configSheets(ws.config)
    const read = (abs: string) => options.sources?.get(abs) ?? readFileSync(abs, "utf8")
    const sheets: WorkspaceSheet[] = listed.sheets.map((s) => ({ file: s.abs, rel: s.file, group: s.group, package: byCheck.get(s.pkg) as WorkspacePackage, css: read(s.abs), scope: null }))
    const { registry, errors } = buildRegistry({ prefix: ws.prefix, hashLength: ws.config.hashLength, groups: listed.groups, sheets: sheets.map((s) => ({ file: s.rel, group: s.group, css: s.css })) })
    const scopeOfFile = new Map(Object.entries(registry.scopes).map(([scope, info]) => [info.file, scope]))
    for (const s of sheets) s.scope = scopeOfFile.get(s.rel) ?? null

    // export names per module: a package's module serves all its groups, a specifier all the groups mapped to it
    const packageOfGroup = new Map(ws.packages.flatMap((p) => p.check.groups.map((g) => [g.name, p] as const)))
    const owners = new Map<string, Map<string, { scope: string; file: string; group: string }>>()
    const reported = new Set<string>()
    for (const [scope, info] of Object.entries(registry.scopes)) {
        const pkg = packageOfGroup.get(info.group)
        const modules: Array<[string, string]> = []
        if (pkg) modules.push([`package\u0000${pkg.name}`, `${pkg.name}'s part-map module`])
        const spec = ws.config.css.partMaps?.[info.group]
        if (spec) modules.push([`specifier\u0000${spec}`, `the "${spec}" part maps`])
        const name = exportName(scope)
        for (const [key, label] of modules) {
            const names = owners.get(key) ?? new Map<string, { scope: string; file: string; group: string }>()
            owners.set(key, names)
            const owner = names.get(name)
            if (!owner) {
                names.set(name, { scope, file: info.file, group: info.group })
                continue
            }
            // two scopes of one group: buildRegistry reported them already
            const pair = [owner.scope, scope].sort().join("\u0000")
            if (owner.group === info.group || reported.has(pair)) continue
            reported.add(pair)
            errors.push({
                code: "duplicate-export",
                message: `scopes "${owner.scope}" (${owner.file}) and "${scope}" (${info.file}) both export as "${name}" from ${label} — rename one sheet or pin a scope with @stylist scope <id>;`,
                files: [owner.file, info.file],
            })
        }
    }
    const overrides = options.overrides === false ? null : collectOverrides(ws.config, registry, { sources: options.sources })
    if (overrides) errors.push(...overrides.errors)
    return { workspace: ws, registry, errors, sheets, overrides }
}

/**
 * The package whose sheet directories hold `file` — a `.css` file `listSheets` would list (no dot,
 * `node_modules` or build-output directory on the way) — or null.
 */
export function workspaceSheetOwner(ws: Workspace, file: string): WorkspacePackage | null {
    const abs = resolve(file)
    if (!abs.endsWith(".css")) return null
    // the overrides directory may sit inside a sheet directory: its sheets are no package's
    if (ws.overrides && abs.startsWith(ws.overrides.dir + sep)) return null
    for (const pkg of ws.packages) {
        for (const dir of pkg.check.sheets) {
            const rel = relative(dir, abs)
            if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
            const segments = rel.split(sep).slice(0, -1)
            if (segments.some((s) => s.startsWith(".") || ["node_modules", "dist", "build", "coverage"].includes(s))) continue
            return pkg
        }
    }
    return null
}

/** True when `file` is an override sheet of the workspace: a `.css` file under `css.overrides.dir`. */
export function workspaceOverrideSheet(ws: Workspace, file: string): boolean {
    return !!ws.overrides && isOverrideSheet(ws.overrides.dir, file)
}

/** The module ids the JSX transform owns: everything under a workspace package's source directories (`sources`, default `src`). */
export function workspaceSourcePattern(ws: Workspace): RegExp {
    const dirs = ws.packages.flatMap((p) => p.check.sources.map((dir) => `${toPosix(dir)}/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    return dirs.length ? new RegExp(`^(?:${dirs.join("|")})`) : /(?!)/
}

/** The scopes whose registry entry differs between two registries (added, removed, or changed file, group, roots, parts or keyframes). */
export function changedScopes(prev: Registry | null, next: Registry): Set<string> {
    const out = new Set<string>()
    const before = prev?.scopes ?? {}
    for (const scope of new Set([...Object.keys(before), ...Object.keys(next.scopes)])) {
        const a = Object.prototype.hasOwnProperty.call(before, scope) ? before[scope] : undefined
        const b = Object.prototype.hasOwnProperty.call(next.scopes, scope) ? next.scopes[scope] : undefined
        if (JSON.stringify(a) !== JSON.stringify(b)) out.add(scope)
    }
    return out
}

/**
 * The sheets that read a scope of `scopes` through `:cx(scope:part)` or `:component(Path)` (a root of
 * the scope, in `registry` or `previous`) — their compiled output changes with it. The sheets of
 * `scopes` themselves are left out. Absolute paths, sorted.
 */
export function dependentSheets(build: WorkspaceBuild, scopes: ReadonlySet<string>, previous?: Registry | null): string[] {
    if (scopes.size === 0) return []
    const registries = [build.registry, previous].filter((r): r is Registry => !!r)
    const ownerOf = (namespace: string, path: string): string[] =>
        registries.flatMap((r) => Object.entries(r.scopes).filter(([, s]) => s.namespace === namespace && s.roots.some((root) => sameComponent(root.component, path))).map(([scope]) => scope))
    const out: string[] = []
    for (const sheet of build.sheets) {
        if (sheet.scope !== null && scopes.has(sheet.scope)) continue
        const info = collectSheet(sheet.css, { file: sheet.rel, group: sheet.group })
        const namespace = build.workspace.groups[sheet.group]?.namespace
        const reads = info.cx.some((ref) => scopes.has(ref.scope)) || info.components.some((ref) => ownerOf(ref.namespace ?? namespace, ref.path).some((scope) => scopes.has(scope)))
        if (reads) out.push(sheet.file)
    }
    return out.sort()
}

/** A compiled sheet: the CSS to serve and where it sits in the cascade. */
export interface CompiledSheet {
    /** `@layer <statement>;` then the compiled sheet inside `@layer <namespace's layer> { … }`. */
    css: string
    scope: string
    namespace: string
    layer: string
    /** The plugin's warnings (legacy `:global()` hooks). */
    warnings: string[]
}

/**
 * Pass 2 for one sheet: rejects an authored `@layer` or `@import` (the build places every sheet in its
 * layer, and Vite would inline an import from disk untransformed), compiles it with postcss-nesting and
 * the libstylist plugin against the registry (`stylistOptions`), and wraps it:
 * `@layer <statement>;\n@layer <layerOf(namespace)> { … }`. Throws the first compile error (a
 * `CssSyntaxError` naming file and line), or a `WorkspaceError` for a sheet the registry doesn't hold —
 * an override sheet among them: `compileOverrideSheet` compiles those into the overrides layer.
 */
export async function compileSheet(ws: Workspace, registry: Registry, file: string, css: string): Promise<CompiledSheet> {
    const abs = resolve(file)
    const rel = toPosix(relative(ws.root, abs))
    if (workspaceOverrideSheet(ws, abs)) throw new WorkspaceError(`${rel} is an override sheet (css.overrides.dir), no package's sheet — compileOverrideSheet compiles it into the overrides layer`)
    const scope = Object.keys(registry.scopes).find((s) => registry.scopes[s].file === rel)
    if (scope === undefined) throw new WorkspaceError(`${rel} is not a sheet of the workspace registry — a sheet directory of a configured package holds it, and its scope is unique`)
    const root = postcss.parse(css, { from: abs })
    root.walkAtRules((at) => {
        const name = at.name.toLowerCase()
        if (name === "layer") throw at.error(`@layer — the build wraps every sheet in its namespace's layer (css.layers); remove it`)
        if (name === "import") throw at.error(`@import — a sheet is compiled alone; import the other sheet's part map in the component instead`)
    })
    const result = await postcss([(await loadNesting())(), stylist(stylistOptions(registry, scope, ws.groups))]).process(root, { from: abs })
    const { namespace } = registry.scopes[scope]
    const layer = ws.layers.namespaces[namespace] ?? `app.${namespace}`
    return {
        css: wrapInLayer(result.css, ws.layers.statement, layer),
        scope,
        namespace,
        layer,
        warnings: result.warnings().map((w) => w.text),
    }
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/

/** An object literal in the committed modules' shape (4 spaces, trailing commas, identifier keys bare). */
function renderObject(value: Record<string, string | Record<string, string>>, indent = ""): string {
    const entries = Object.entries(value)
    if (entries.length === 0) return "{}"
    const inner = `${indent}    `
    const key = (k: string) => (IDENTIFIER_RE.test(k) ? k : JSON.stringify(k))
    return `{\n${entries.map(([k, v]) => `${inner}${key(k)}: ${typeof v === "string" ? JSON.stringify(v) : renderObject(v, inner)},`).join("\n")}\n${indent}}`
}

/**
 * The generated part-map module of a package (committed at `pkg.module`, imported as its `#css`): the
 * header, a side-effect import of every sheet — the base namespace's group first, then each directory
 * namespace's (`src/css/render`), files sorted within a group — so importing a map brings the CSS
 * along, and one `as const` map per sheet in the same order: `{ [part]: attr, $tags: { [Component]: tag } }`.
 * Null when the package has no sheet (a module on disk is then stale).
 */
export function renderPartMapModule(ws: Workspace, registry: Registry, pkg: WorkspacePackage): string | null {
    if (!pkg.module) return null
    const order = new Map(pkg.check.groups.map((g, i) => [g.name, i]))
    const scopes = Object.entries(registry.scopes)
        .filter(([, s]) => order.has(s.group))
        .sort(([, a], [, b]) => (order.get(a.group) as number) - (order.get(b.group) as number) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    if (scopes.length === 0) return null
    const from = dirname(pkg.module)
    const specifier = (file: string) => {
        const rel = toPosix(relative(from, resolve(ws.root, file)))
        return rel.startsWith("../") ? rel : `./${rel}`
    }
    const imports = scopes.map(([, s]) => `import ${JSON.stringify(specifier(s.file))}`)
    const maps = scopes.map(([scope, s]) => `/** ${specifier(s.file).replace(/^\.\//, "")} */\nexport const ${exportName(scope)} = ${renderObject(partMapValue(s))} as const`)
    return `${[[PART_MAP_HEADER, ...imports].join("\n"), ...maps].join("\n\n")}\n`
}

/** One file the build writes. */
export interface WorkspaceOutput {
    /** Absolute path. */
    file: string
    /** `overrides`: the generated module of the override sheets. */
    kind: "part-map" | "overrides" | "lock" | "registry"
    /** What the build wants in it, or null for a generated file to remove (a package with no sheet left). */
    next: string | null
    /** The file on disk, or null when it is missing. */
    current: string | null
    /** True when writing (or removing) it changes the disk. */
    changed: boolean
    /** The package of a part-map module. */
    package?: WorkspacePackage
}

const readOrNull = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null)
const sameText = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n"))

/** JSON with sorted keys, or null when `text` doesn't parse. */
function canonicalJson(text: string): string | null {
    const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v)
    try {
        return JSON.stringify(sort(JSON.parse(text)))
    } catch {
        return null
    }
}

/** True when two JSON files hold the same data, however they are formatted (a project formatter may rewrite the lock). */
const sameJson = (a: string | null, b: string | null): boolean => {
    if (a === null || b === null) return a === b
    const [x, y] = [canonicalJson(a), canonicalJson(b)]
    return x !== null && x === y
}

/** `value` as JSON indented like the file on disk (a formatter's 4 spaces, a tab), 2 spaces for a new file. */
function jsonLike(value: unknown, current: string | null): string {
    const indent = current ? /^[{[]\r?\n([ \t]+)\S/.exec(current)?.[1] : undefined
    return `${JSON.stringify(value, null, indent ?? 2)}\n`
}

export interface PlanOutputsOptions {
    /** Only these packages' part-map modules (default every package's); the overrides module, the lock and the registry are always planned. */
    packages?: Iterable<WorkspacePackage>
}

/**
 * The files a build writes: each package's part-map module (removed when the package has no sheet
 * left and the file on disk is a generated one — a hand-written module is never touched), the module
 * importing the override sheets (with `css.overrides`), the lock (`toLock`, with the override sections)
 * and the registry JSON — each with its content on disk and whether it differs. The JSON files differ
 * only in their data: they are written with the indentation of the file on disk, so a formatter that
 * reindented the lock (4 spaces) and `libstylist build --check` agree. A build whose override sheets
 * were not collected (`buildWorkspace(…, { overrides: false })`) plans neither the overrides module nor
 * the lock: their contents depend on them.
 */
export function planWorkspaceOutputs(build: WorkspaceBuild, options: PlanOutputsOptions = {}): WorkspaceOutput[] {
    const ws = build.workspace
    const out: WorkspaceOutput[] = []
    for (const pkg of options.packages ?? ws.packages) {
        if (!pkg.module) continue
        const next = renderPartMapModule(ws, build.registry, pkg)
        const current = readOrNull(pkg.module)
        if (next === null && (current === null || !current.startsWith(PART_MAP_HEADER))) continue
        out.push({ file: pkg.module, kind: "part-map", next, current, changed: !sameText(current, next), package: pkg })
    }
    const overrides = build.overrides
    if (overrides) {
        const next = renderOverridesModule(overrides.dir, overrides.sheets.map((s) => s.file))
        const current = readOrNull(overrides.module)
        // a hand-written module there is an `overrides-index` error, never overwritten
        if (current === null || current.startsWith(PART_MAP_HEADER)) out.push({ file: overrides.module, kind: "overrides", next, current, changed: !sameText(current, next) })
    }
    const lockKnown = !ws.overrides || !!overrides
    // the JSON outputs keep the file's indentation and compare as data: a formatter's rewrite is no drift
    for (const [kind, file, value] of [
        ...(lockKnown ? [["lock", ws.lock, toLock(build.registry, overrides?.lock)] as const] : []),
        ["registry", ws.registry, build.registry] as const,
    ]) {
        const current = readOrNull(file)
        const next = jsonLike(value, current)
        out.push({ file, kind, next, current, changed: !sameJson(current, next) })
    }
    return out
}

/** Writes (or removes) the outputs that changed; returns them. */
export function writeWorkspaceOutputs(outputs: readonly WorkspaceOutput[]): WorkspaceOutput[] {
    const written = outputs.filter((o) => o.changed)
    for (const o of written) {
        if (o.next === null) {
            if (existsSync(o.file)) unlinkSync(o.file)
            continue
        }
        mkdirSync(dirname(o.file), { recursive: true })
        writeFileSync(o.file, o.next)
    }
    return written
}

/** A problem that stops a build: a registry error or a sheet that doesn't compile. */
export interface WorkspaceBuildProblem {
    message: string
    /** Files involved, relative to the workspace root. */
    files: string[]
}

export interface RunWorkspaceBuildOptions extends LoadWorkspaceOptions {
    /** Compare instead of write: the committed outputs (part maps, the overrides module, lock) that differ are the drift; the registry JSON is still written. */
    check?: boolean
    /** Compile every sheet and override sheet too, so a sheet that would fail in Vite fails the build. @default true */
    compile?: boolean
}

export interface WorkspaceBuildReport {
    build: WorkspaceBuild
    /** Every planned output. */
    outputs: WorkspaceOutput[]
    /** Registry errors, override errors, compile errors and `[empty-reset]`s; nothing is written when there is one. */
    problems: WorkspaceBuildProblem[]
    /** Compile warnings (`<file>: <text>`). */
    warnings: string[]
    /** Check mode: the committed outputs that differ from the build. */
    drift: WorkspaceOutput[]
    /** The files written or removed. */
    written: WorkspaceOutput[]
    /** What each reset of the override sheets drops from the design system's stylesheets (SPEC §9.5); empty without resets. */
    reports: ResetReport[]
    /** The report's `reset` and `note` lines (its `[empty-reset]` errors are problems). */
    resetLines: ResetReportLine[]
}

/** A compile error as a problem: the sheet's path relative to the workspace root, once. */
function compileProblem(err: unknown, sheet: { file: string; rel: string }): WorkspaceBuildProblem {
    const message = err instanceof Error ? err.message : String(err)
    return { message: message.includes(sheet.rel) || message.includes(sheet.file) ? message.replace(sheet.file, sheet.rel) : `${sheet.rel}: ${message}`, files: [sheet.rel] }
}

/**
 * `libstylist build`: loads the workspace, builds the registry, compiles every sheet and override sheet,
 * reports what the resets drop, and writes the outputs that changed — or, with `check`, reports the
 * committed ones that drifted (writing only the gitignored registry). Nothing is written when there is
 * a problem.
 */
export async function runWorkspaceBuild(options: RunWorkspaceBuildOptions = {}): Promise<WorkspaceBuildReport> {
    const ws = await loadWorkspace(options)
    const build = buildWorkspace(ws)
    const problems: WorkspaceBuildProblem[] = build.errors.map((e) => ({ message: `[${e.code}] ${e.message}`, files: e.files }))
    const warnings: string[] = []
    const compiledOverrides = new Map<string, string>()
    if (options.compile !== false) {
        for (const sheet of build.sheets) {
            if (sheet.scope === null) continue
            try {
                const compiled = await compileSheet(ws, build.registry, sheet.file, sheet.css)
                for (const w of compiled.warnings) warnings.push(`${sheet.rel}: ${w}`)
            } catch (err) {
                problems.push(compileProblem(err, sheet))
            }
        }
        for (const sheet of build.overrides?.sheets ?? []) {
            if (!sheet.resolved) continue
            try {
                const compiled = await compileOverrideSheet(build.overrides as WorkspaceOverrides, ws.layers.statement, sheet.file, sheet.css)
                compiledOverrides.set(sheet.rel, compiled.css)
                for (const w of compiled.warnings) warnings.push(`${sheet.rel}: ${w}`)
            } catch (err) {
                problems.push(compileProblem(err, sheet))
            }
        }
    }
    const reports: ResetReport[] = []
    const resetLines: ResetReportLine[] = []
    if (build.overrides && build.overrides.errors.length === 0 && build.overrides.resets.length > 0) {
        const report = overrideReports(build.overrides, compiledOverrides)
        reports.push(...report.reports)
        for (const line of report.lines) {
            if (line.level !== "error") resetLines.push(line)
            else problems.push({ message: line.text, files: [/^\[[a-z-]+\] ([^:\s]+)/.exec(line.text)?.[1] ?? ""].filter(Boolean) })
        }
    }
    const outputs = planWorkspaceOutputs(build)
    const report = { build, outputs, problems, warnings, reports, resetLines }
    if (problems.length) return { ...report, drift: [], written: [] }
    if (options.check) {
        const drift = outputs.filter((o) => o.kind !== "registry" && o.changed)
        return { ...report, drift, written: writeWorkspaceOutputs(outputs.filter((o) => o.kind === "registry")) }
    }
    return { ...report, drift: [], written: writeWorkspaceOutputs(outputs) }
}
