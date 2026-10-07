// The migration map `migrate-selectors` reads (the design system ships it as
// `@livesession/eloquentui-css/migration/ls-to-elo.json`), and the lookups built from it. Everything
// the codemod knows comes from the map — no class, literal or hook is hard-coded here.
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"

import selectorParser from "postcss-selector-parser"

/** The map a design-system css package publishes (only the fields the codemod reads). */
export interface MigrationMap {
    version: number
    prefix: string
    classes: Record<string, ClassEntry>
    literals?: Record<string, LiteralEntry>
    dataComponent?: Record<string, HookEntry>
    dataPart?: Record<string, HookEntry[]>
    keyframes?: Record<string, string>
    api?: ApiEntry[]
    /** Scope → the marker identity of a component its sheet binds no root for (a DOM-less delegate forwarding its marker, `[elo-tooltip]`). */
    markerIdentities?: Record<string, MarkerIdentity[]>
    selectorRewrites?: SelectorRewrite[]
}

export interface MarkerIdentity {
    component: string
    identity: string
    identityKind: "marker"
    identitySelector: string
    /** The elements the sources write the marker on (`Popover` for a forwarded marker, `span` for a native host). */
    hosts?: string[]
}

export interface ClassEntry {
    kind: "root" | "part" | "removed"
    package?: string | null
    component?: string
    scope?: string
    part?: string
    attr?: string
    selector?: string
    identity?: string
    identityKind?: "tag" | "marker"
    identitySelector?: string
    /** The component renders its custom tag for a div / span and a marker on other elements (`as`): identitySelector matches both. */
    polymorphic?: boolean
    note?: string
    pending?: string
    /** Where BASE exported the class: the css package subpath (`.`, `./player`) and the part map key. */
    legacy?: { export: string; local: string; sheet?: string }
    /** Where the part map exports the part attribute now: `import { <export> } from "<module>"`, `<export>[<key>]`. */
    partMap?: { module: string; export: string; key: string }
}

export type LiteralKind = "part" | "prop" | "data" | "tag" | "removed"

export interface LiteralEntry {
    kind: LiteralKind
    selector: string | null
    replacement: string
    note?: string
    pending?: string
    planned?: string
    plannedSelector?: string | null
    carriers?: string[]
    legacySheets?: string[]
    targetedBy?: string[]
}

export interface HookEntry {
    scope?: string | null
    selector: string
    partSelector?: string
    component?: string
    part?: string
    attr?: string
    identity?: string
    identityKind?: "tag" | "marker"
    identitySelector?: string
    polymorphic?: boolean
    components?: string[]
    note?: string
}

export interface ApiEntry {
    package: string
    component?: string
    removed: string
    replacement: string
    identity?: string
    identitySelector?: string
    note?: string
    pending?: string
}

export interface SelectorRewrite {
    scope: string
    kind: "rewrite" | "removed" | "added"
    old: string | null
    new: string | null
    why?: string
}

/** Where `--map` defaults to: the design system's published map, resolved from the working directory. */
export const DEFAULT_MAP_SPECIFIER = "@livesession/eloquentui-css/migration/ls-to-elo.json"

/** Resolves `--map` (a path) or, when omitted, the published map from `cwd`'s node_modules. */
export function resolveMapPath(mapOption: string | undefined, cwd: string): string {
    if (mapOption) {
        const file = resolve(cwd, mapOption)
        if (!existsSync(file)) throw new MapError(`--map ${mapOption}: no such file`)
        return file
    }
    try {
        return createRequire(join(cwd, "noop.js")).resolve(DEFAULT_MAP_SPECIFIER)
    } catch {
        throw new MapError(`no --map given and ${DEFAULT_MAP_SPECIFIER} is not installed here — pass --map <migration-map.json>`)
    }
}

export class MapError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "MapError"
    }
}

/** Reads and shape-checks a map file. */
export function loadMigrationMap(file: string): MigrationMap {
    let map: MigrationMap
    try {
        map = JSON.parse(readFileSync(file, "utf8")) as MigrationMap
    } catch (error) {
        throw new MapError(`${file}: not JSON (${error instanceof Error ? error.message : String(error)})`)
    }
    if (!map || typeof map !== "object") throw new MapError(`${file}: not a migration map`)
    if (map.version !== 1) throw new MapError(`${file}: map version ${String(map.version)} is not supported (this libstylist reads version 1)`)
    if (typeof map.prefix !== "string" || !/^[a-z][a-z0-9]*$/.test(map.prefix)) throw new MapError(`${file}: "prefix" is missing or invalid`)
    if (!map.classes || typeof map.classes !== "object") throw new MapError(`${file}: "classes" is missing`)
    return map
}

// ---------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------

export interface MapIndex {
    map: MigrationMap
    prefix: string
    classes: Map<string, ClassEntry>
    literals: Map<string, LiteralEntry>
    /** Scopes a literal belongs to (its carriers, the sheets that targeted it, its successor). */
    literalScopes: Map<string, Set<string>>
    dataComponent: Map<string, HookEntry>
    /** `[data-part="x"]` / `[part="x"]` → one entry per scope that used the hook. */
    dataPart: Map<string, HookEntry[]>
    /** Attribute names the BASE attribute hooks used (`data-part`, `part`). */
    hookAttributes: Set<string>
    keyframes: Map<string, string>
    /** Normalized old selector → ledger entry (kinds rewrite / removed). */
    ledger: Map<string, SelectorRewrite>
    /** Part attribute → scope. */
    scopeOfAttr: Map<string, string>
    /** Identity tag / marker name → scope. */
    scopeOfIdentity: Map<string, string>
    /** Prefixes of the legacy class names (`ls-`), derived from the map's keys. */
    classPrefixes: string[]
    /** Prefixes of the legacy keyframes names. */
    keyframesPrefixes: string[]
    api: ApiEntry[]
    /** Scopes the design system removed (every class of the scope is `removed`): they anchor nothing. */
    removedScopes: Set<string>
    /**
     * The part maps a consumer imports (`import { alert } from "@livesession/eloquentui-css"`): module →
     * export → BASE key → the class it held. The values are part attribute names now, not classes.
     */
    partMaps: Map<string, Map<string, Map<string, PartMapKey>>>
}

export interface PartMapKey {
    /** The legacy class the key held. */
    name: string
    entry: ClassEntry
}

/** Classes and data-component values the app itself puts on its elements, with where (for messages). */
export interface AppliedHooks {
    classes: Map<string, string>
    dataComponent: Map<string, string>
}

const prefixesOf = (names: Iterable<string>): string[] => {
    const out = new Set<string>()
    for (const name of names) {
        const i = name.indexOf("-")
        if (i > 0) out.add(name.slice(0, i + 1))
    }
    return [...out].sort()
}

/** True when `name` starts with one of `prefixes`. */
export const hasPrefix = (name: string, prefixes: readonly string[]): boolean => prefixes.some((p) => name.startsWith(p) && name.length > p.length)

/** A strict prefix of a known legacy class (`ls-toast__`, but also a block name like `ls-filter-editor`). */
export const isPartialClass = (index: MapIndex, name: string): boolean => !index.classes.has(name) && [...index.classes.keys()].some((c) => c.startsWith(name))

/**
 * A legacy class name visibly cut short — `ls-toast__`, `ls-player-` + an expression: a strict prefix of
 * a known class ending at a separator. A complete-looking name (`ls-filter-editor`) is a class the map
 * does not know, not a fragment.
 */
export const isCutShort = (index: MapIndex, name: string): boolean => /[-_]$/.test(name) && isPartialClass(index, name)

/**
 * Why a legacy-looking class is not in the map, when the map can say: a block name the design system
 * never rendered as a class, whose element classes belong to one component (`ls-filter-editor` →
 * FilterEditor, elo-inf-filtereditor).
 */
export function unknownHint(index: MapIndex, name: string): string {
    const related = [...index.classes.entries()].filter(([c]) => c.startsWith(`${name}__`) || c.startsWith(`${name}-`))
    if (related.length === 0) return ""
    const components = new Set(related.map(([, e]) => e.component ?? e.scope).filter(Boolean))
    const identity = related.map(([, e]) => e.identitySelector).find(Boolean)
    const listed = related
        .slice(0, 3)
        .map(([c]) => c)
        .join(", ")
    if (components.size === 1) return ` — the design system never rendered it; its classes (${listed}${related.length > 3 ? ", …" : ""}) belong to ${[...components][0]}${identity ? `, whose element is ${identity}` : ""}`
    return ` — the design system never rendered it; classes that start with it: ${listed}${related.length > 3 ? ", …" : ""}`
}

/** Collapses a selector to a canonical spelling (no optional whitespace) for exact comparison. */
export function normalizeSelector(selector: string): string {
    try {
        return selectorParser((root) => {
            root.walk((node) => {
                node.spaces.before = ""
                node.spaces.after = ""
                if (node.type === "combinator") {
                    node.rawSpaceBefore = ""
                    node.rawSpaceAfter = ""
                    node.value = node.value.trim() || " "
                }
                if (node.type === "comment") node.remove()
            })
        }).processSync(selector.trim())
    } catch {
        return selector.replace(/\s+/g, " ").trim()
    }
}

const sheetScope = (sheet: string): string => sheet.split("/").pop()!.replace(/\.[a-z]+$/i, "")

export function indexMap(map: MigrationMap): MapIndex {
    const classes = new Map(Object.entries(map.classes))
    const scopeOfAttr = new Map<string, string>()
    const scopeOfIdentity = new Map<string, string>()
    const noteHook = (e: { scope?: string | null; attr?: string; identity?: string }) => {
        if (!e.scope) return
        for (const attr of (e.attr ?? "").split(/\s+/).filter(Boolean)) if (!scopeOfAttr.has(attr)) scopeOfAttr.set(attr, e.scope)
        if (e.identity && !scopeOfIdentity.has(e.identity)) scopeOfIdentity.set(e.identity, e.scope)
    }
    for (const entry of classes.values()) noteHook(entry)
    const dataComponent = new Map(Object.entries(map.dataComponent ?? {}))
    for (const entry of dataComponent.values()) noteHook(entry)
    const dataPart = new Map(Object.entries(map.dataPart ?? {}))
    const hookAttributes = new Set<string>()
    for (const [key, list] of dataPart) {
        const m = /^\[([a-z-]+)=/.exec(key)
        if (m) hookAttributes.add(m[1])
        for (const entry of list) noteHook(entry)
    }

    const literals = new Map(Object.entries(map.literals ?? {}))
    const literalScopes = new Map<string, Set<string>>()
    const namesIn = (selector: string | null | undefined): string[] => [
        ...(selector ?? "").matchAll(new RegExp(`_cxclass_[a-z0-9]+-[a-z0-9]+|(?<![\\w-])${map.prefix}-[a-z0-9]+(?:-[a-z0-9]+)*`, "g")),
    ].map((m) => m[0])
    for (const [name, entry] of literals) {
        const scopes = new Set<string>()
        for (const carrier of entry.carriers ?? []) {
            for (const m of carrier.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
                const scope = classes.get(m[1])?.scope
                if (scope) scopes.add(scope)
            }
        }
        for (const sheet of entry.legacySheets ?? []) scopes.add(sheetScope(sheet))
        for (const scope of entry.targetedBy ?? []) scopes.add(scope)
        for (const hook of [...namesIn(entry.selector), ...namesIn(entry.plannedSelector)]) {
            const scope = scopeOfAttr.get(hook) ?? scopeOfIdentity.get(hook)
            if (scope) scopes.add(scope)
        }
        literalScopes.set(name, scopes)
    }

    const ledger = new Map<string, SelectorRewrite>()
    for (const entry of map.selectorRewrites ?? []) {
        if ((entry.kind === "rewrite" || entry.kind === "removed") && entry.old) ledger.set(normalizeSelector(entry.old), entry)
    }

    const keyframes = new Map(Object.entries(map.keyframes ?? {}))

    const scopeKinds = new Map<string, Set<string>>()
    for (const entry of classes.values()) if (entry.scope) (scopeKinds.get(entry.scope) ?? scopeKinds.set(entry.scope, new Set()).get(entry.scope)!).add(entry.kind)
    const removedScopes = new Set([...scopeKinds].filter(([, k]) => k.size === 1 && k.has("removed")).map(([s]) => s))

    // BASE exported each class from a part map under the same module and export name; the key is the
    // BASE local (a renamed local — dropdown root → menu — is a different key now)
    const partMaps = new Map<string, Map<string, Map<string, PartMapKey>>>()
    for (const [name, entry] of classes) {
        if (!entry.partMap || !entry.legacy) continue
        const exports = partMaps.get(entry.partMap.module) ?? partMaps.set(entry.partMap.module, new Map()).get(entry.partMap.module)!
        const keys = exports.get(entry.partMap.export) ?? exports.set(entry.partMap.export, new Map()).get(entry.partMap.export)!
        keys.set(entry.legacy.local, { name, entry })
    }
    return {
        map,
        prefix: map.prefix,
        classes,
        literals,
        literalScopes,
        dataComponent,
        dataPart,
        hookAttributes,
        keyframes,
        ledger,
        scopeOfAttr,
        scopeOfIdentity,
        classPrefixes: prefixesOf(classes.keys()),
        keyframesPrefixes: prefixesOf(keyframes.keys()),
        api: map.api ?? [],
        removedScopes,
        partMaps,
    }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Can this file hold anything the map rewrites or reports? A file that names no legacy class,
 * `data-component`, attribute hook, design-system package or (for anchored literals) part attribute or
 * identity is skipped without being parsed — a LESS file full of mixins needs no postcss-less when
 * there is nothing in it to migrate.
 */
export function fileMayMatter(text: string, index: MapIndex, literals: "anchored" | "all" | "off"): boolean {
    if (literals === "all") return true
    const words = [...index.classPrefixes, ...index.keyframes.keys()].map(escapeRe)
    if (words.length > 0 && new RegExp(`(?<![\\w$-])(?:${words.join("|")})`).test(text)) return true
    if (text.includes("data-component") || /\bdataset\b/.test(text)) return true
    for (const attr of index.hookAttributes) if (new RegExp(`(?<![\\w-])${escapeRe(attr)}(?![\\w-])\\s*[~|^$*]?=|["'\`]${escapeRe(attr)}["'\`]`).test(text)) return true
    if (/\[\s*class\s*[~|^$*]?=/i.test(text)) return true
    if (literals !== "off" && (text.includes("_cxclass_") || new RegExp(`(?<![\\w-])${index.prefix}-[a-z]`).test(text))) return true
    for (const pkg of new Set([...index.api.map((e) => e.package), ...index.partMaps.keys()])) if (text.includes(pkg)) return true
    // a ledger selector the map matches exactly always names a legacy class; be safe if one does not
    for (const entry of index.ledger.values()) if (entry.old && !index.classPrefixes.some((p) => entry.old!.includes(p))) return true
    return false
}
