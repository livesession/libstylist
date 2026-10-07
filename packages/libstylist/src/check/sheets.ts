// The checker's view of the stylesheets: the registry built from every group's source sheets
// (reusing the css build's pass 1) — a css package's group directories and the sheet directories of
// app packages, one group per (package, namespace) — which sheets are flipped (bound with
// `@stylist root|scope`), which locals of each sheet unconditionally set `display`, the root binding an
// identity element must carry, and the drift between the sheets and the built `stylist-registry.json`.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"

import postcss, { type Container, type Node as CssNode, type Rule } from "postcss"
import selectorParser from "postcss-selector-parser"

import { buildRegistry, type Registry, type RegistryError, type RegistryGroup, type RegistryScope } from "../registry/index.js"
import { packageSheetGroups } from "../workspace/groups.js"
import type { CheckConfig, CheckPackage } from "./config.js"

export interface SheetFacts {
    registry: Registry
    errors: RegistryError[]
    /** Scope → locals that some rule sets `display` on unconditionally (`.root { display: flex }`). */
    displayLocals: Map<string, Set<string>>
    /** Scopes of sheets listed in `css.unboundSheets`. */
    unboundScopes: Set<string>
    /**
     * Scopes of flipped sheets — those declaring `@stylist root` or `@stylist scope` (bound to their
     * components). Every sheet compiles to part attributes; the flip only gates S301 and burndown.
     */
    flippedScopes: Set<string>
    /** Scope → sheet path relative to the config root. */
    sheetFile: Map<string, string>
    /** Scope → sheet source. */
    sheetText: Map<string, string>
    /** Scope → the package whose sheets declare it. */
    sheetPackage: Map<string, CheckPackage>
}

const toPosix = (p: string) => p.split(sep).join("/")

/** One sheet of the config: where it is and the css group it belongs to. */
export interface ConfigSheet {
    /** Absolute path. */
    abs: string
    /** Posix path relative to the config root — the registry's `file`. */
    file: string
    group: string
    /** The package whose sheets hold it. */
    pkg: CheckPackage
}

/**
 * The css group table and every sheet of a config — a `cssGroup` package's group directory (flat), a
 * `sheets` package's directories (recursively, one group per namespace) — in package, then group, then
 * file order. The checker and the workspace build (`libstylist build`) group and name sheets through it,
 * so the registry one builds is the registry the other checks. The override sheets (`css.overrides.dir`,
 * which may sit inside a sheet directory) are no package's sheets and never listed.
 */
export function configSheets(config: Pick<CheckConfig, "root" | "packages" | "css">): { groups: Record<string, RegistryGroup>; sheets: ConfigSheet[] } {
    const groups: Record<string, RegistryGroup> = {}
    const sheets: ConfigSheet[] = []
    const overrides = config.css.overrides?.dir ?? null
    const add = (abs: string, group: string, pkg: CheckPackage) => {
        if (overrides && abs.startsWith(overrides + sep)) return
        sheets.push({ abs, file: toPosix(relative(config.root, abs)), group, pkg })
    }
    for (const pkg of config.packages) {
        for (const g of pkg.groups) groups[g.name] = { namespace: g.naming.namespace, segment: g.naming.segment, word: g.naming.word }
        if (pkg.cssGroup !== null) {
            const dir = join(config.css.dir as string, pkg.cssGroup)
            for (const name of readdirSync(dir).filter((f) => f.endsWith(".css")).sort()) add(join(dir, name), pkg.cssGroup, pkg)
        } else {
            for (const g of packageSheetGroups({ dir: pkg.dir, naming: pkg.naming, namespaces: pkg.namespaces, sheets: pkg.sheets })) for (const file of g.files) add(file, g.name, pkg)
        }
    }
    return { groups, sheets }
}

/**
 * Reads every group's sheets ({@link configSheets}) and builds the registry plus the display facts.
 */
export function loadSheets(config: CheckConfig): SheetFacts {
    const unbound = new Set(config.css.unboundSheets.map(toPosix))
    const unboundBase = config.css.dir ?? config.root
    const listed = configSheets(config)
    const { groups } = listed
    const sheets = listed.sheets.map((s) => ({ file: s.file, group: s.group, css: readFileSync(s.abs, "utf8"), unbound: unbound.has(toPosix(relative(unboundBase, s.abs))), pkg: s.pkg }))
    const { registry, errors } = buildRegistry({ prefix: config.prefix, hashLength: config.hashLength, groups, sheets })
    const displayLocals = new Map<string, Set<string>>()
    const unboundScopes = new Set<string>()
    const flippedScopes = new Set<string>()
    const sheetFile = new Map<string, string>()
    const sheetText = new Map<string, string>()
    const sheetPackage = new Map<string, CheckPackage>()
    for (const [scope, info] of Object.entries(registry.scopes)) {
        sheetFile.set(scope, info.file)
        const sheet = sheets.find((s) => s.file === info.file)
        if (!sheet) continue
        sheetText.set(scope, sheet.css)
        sheetPackage.set(scope, sheet.pkg)
        if (sheet.unbound) unboundScopes.add(scope)
        if (isFlippedSheet(sheet.css)) flippedScopes.add(scope)
        displayLocals.set(scope, unconditionalDisplayLocals(sheet.css))
    }
    return { registry, errors, displayLocals, unboundScopes, flippedScopes, sheetFile, sheetText, sheetPackage }
}

/** True when the sheet declares `@stylist root` or `@stylist scope` (bound to its components). */
export const isFlippedSheet = (css: string): boolean => /@stylist\s+(root|scope)\b/.test(css)

export interface RegistryDrift {
    /** `missing` (no built registry), `unreadable`, or the scope that differs. */
    key: string
    message: string
}

/** What S309 tells the author to run: build the registry when it is missing, rebuild it when it is stale. */
export interface RegistryDriftFix {
    build: string
    rebuild: string
}

/** A css package's build writes the registry (the design system). */
export const CSS_PACKAGE_FIX: RegistryDriftFix = { build: "build the css package", rebuild: "rebuild the css package" }
/** `libstylist build` writes it (a workspace of app packages). */
export const WORKSPACE_BUILD_FIX: RegistryDriftFix = { build: "run `libstylist build`", rebuild: "run `libstylist build`" }

/**
 * Differences between the built registry (the css build publishes every sheet's scope, flipped or
 * not) and the one the sheets produce now: scopes added or removed, and changed roots, parts or
 * keyframes. `fix` words what the messages tell the author to run.
 */
export function registryDrift(file: string, sheets: SheetFacts, fix: RegistryDriftFix = CSS_PACKAGE_FIX): RegistryDrift[] {
    if (!existsSync(file)) return [{ key: "missing", message: `${file} does not exist — ${fix.build} so lint and consumers see the current parts` }]
    let built: Registry
    try {
        built = JSON.parse(readFileSync(file, "utf8")) as Registry
        if (!built || typeof built.scopes !== "object") throw new Error("no scopes")
    } catch (err) {
        return [{ key: "unreadable", message: `${file} is not a stylist registry: ${(err as Error).message}` }]
    }
    const out: RegistryDrift[] = []
    const { rebuild } = fix
    const current = sheets.registry
    if (built.prefix !== current.prefix || built.hash?.length !== current.hash.length) {
        out.push({ key: "header", message: `the built registry has prefix "${built.prefix}"/hash length ${built.hash?.length}, the sheets "${current.prefix}"/${current.hash.length} — ${rebuild}` })
    }
    const expected = Object.keys(current.scopes).sort()
    for (const scope of expected) {
        const have = Object.prototype.hasOwnProperty.call(built.scopes, scope) ? built.scopes[scope] : undefined
        if (!have) {
            out.push({ key: scope, message: `sheet ${scope} is missing from the built registry — ${rebuild}` })
            continue
        }
        const want = current.scopes[scope]
        const diffs: string[] = []
        if (JSON.stringify(have.roots ?? []) !== JSON.stringify(want.roots)) diffs.push("roots")
        if (JSON.stringify(have.parts ?? {}) !== JSON.stringify(want.parts)) diffs.push("parts")
        if (JSON.stringify(have.keyframes ?? {}) !== JSON.stringify(want.keyframes)) diffs.push("keyframes")
        if (diffs.length) out.push({ key: scope, message: `the built registry's ${scope} differs from the sheet (${diffs.join(", ")}) — ${rebuild}` })
    }
    for (const scope of Object.keys(built.scopes).sort()) {
        if (!expected.includes(scope)) out.push({ key: scope, message: `the built registry has scope ${scope}, which no sheet declares any more — ${rebuild}` })
    }
    return out
}

/** 1-based line of the first match of `re` in `text` outside comments, or 0. */
export function lineIn(text: string | undefined, re: RegExp): number {
    if (!text) return 0
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    const m = re.exec(code)
    return m ? code.slice(0, m.index).split("\n").length : 0
}

/** Only these at-rules keep a rule unconditional (they group, they don't gate). */
const TRANSPARENT_AT_RULES = new Set(["layer"])

/** The selector list of a rule as plain strings, or null when unparsable. */
function selectorsOf(rule: Rule): string[] | null {
    try {
        const out: string[] = []
        selectorParser((root) => {
            root.each((sel) => {
                out.push(String(sel).trim())
            })
        }).processSync(rule.selector)
        return out
    } catch {
        return null
    }
}

/**
 * Locals whose own rule sets `display` with no condition: a top-level (or `@layer`) rule whose
 * selector list contains exactly `.local`, or a nested `&` rule directly under one.
 */
export function unconditionalDisplayLocals(css: string): Set<string> {
    const out = new Set<string>()
    let root
    try {
        root = postcss.parse(css)
    } catch {
        return out
    }
    const unconditionalParent = (node: CssNode): boolean => {
        let p: Container | undefined = node.parent as Container | undefined
        while (p && p.type !== "root") {
            if (p.type === "atrule" && TRANSPARENT_AT_RULES.has((p as postcss.AtRule).name.toLowerCase())) p = p.parent as Container | undefined
            else return false
        }
        return true
    }
    const localsOf = (rule: Rule): string[] => {
        const sels = selectorsOf(rule) ?? []
        const own = sels.map((s) => /^\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(s)?.[1]).filter((x): x is string => !!x)
        if (own.length) return unconditionalParent(rule) ? own : []
        if (sels.length === 1 && sels[0] === "&" && rule.parent?.type === "rule") return localsOf(rule.parent as Rule)
        return []
    }
    root.walkDecls(/^display$/i, (decl) => {
        if (decl.parent?.type !== "rule") return
        for (const local of localsOf(decl.parent as Rule)) out.add(local)
    })
    return out
}

export interface RootBinding {
    scope: string
    local: string
    display?: string
    /** `registry`: a `@stylist root` names the component; `default`: the file's own sheet's implied `root`. */
    source: "registry" | "default"
}

/**
 * The part an identity element must carry (SPEC §4.1): the `@stylist root` binding of its tag
 * (preferring the file's own scope), else the file scope's `root` part when that sheet binds
 * `root` to no other component. `null` when nothing can be derived.
 */
export function rootBindingFor(registry: Registry, tag: string, fileScope: string | null): RootBinding | null {
    let other: RootBinding | null = null
    for (const [scope, info] of Object.entries(registry.scopes)) {
        const root = info.roots.find((r) => r.tag === tag)
        if (!root) continue
        const binding: RootBinding = { scope, local: root.local, source: "registry", ...(root.display ? { display: root.display } : {}) }
        if (scope === fileScope) return binding
        other ??= binding
    }
    if (other) return other
    const own: RegistryScope | undefined = fileScope !== null && Object.prototype.hasOwnProperty.call(registry.scopes, fileScope) ? registry.scopes[fileScope] : undefined
    if (!own || own.roots.some((r) => r.local === "root")) return null
    return Object.prototype.hasOwnProperty.call(own.parts, "root") ? { scope: fileScope as string, local: "root", source: "default" } : null
}
