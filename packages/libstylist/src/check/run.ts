// `libstylist check`: export discovery, root analysis, the escape hatch, registry and CSS↔JSX
// checks — one run over every configured package plus the stylesheets — and the migration ratchet
// that splits findings into errors (hard rules, migrated components) and pending work (components
// not migrated yet, reported by `libstylist burndown`).
import { resolve } from "node:path"

import ts from "typescript"

import { CheckConfigError, EXEMPTION_CATEGORIES, findCheckConfig, loadCheckConfig, validateCheckConfig, type CheckConfig, type ExemptionCategory, type RawCheckConfig } from "./config.js"
import { crossCheck, type LegacyClassProp, type MemberRoot } from "./crosscheck.js"
import { CxReader } from "./cx.js"
import { collectExemptionTags, jsDocOwners, parseExemption, type ExemptionTag } from "./exemptions.js"
import { checkOverrides } from "./overrides.js"
import { discoverExports, type ComponentEntry } from "./exports.js"
import { LEGACY_HELPERS, collectFileFacts, type FileFacts, type LegacyHelper } from "./migration.js"
import { createCheckProgram } from "./program.js"
import { RenderEvaluator } from "./render.js"
import { RootAnalyzer, type RootAnalysis } from "./roots.js"
import { RULES, countByRule, dedupeFindings, finding, sortFindings, type Finding, type RuleId } from "./rules.js"
import { CSS_PACKAGE_FIX, WORKSPACE_BUILD_FIX, loadSheets, registryDrift } from "./sheets.js"
import { lineOf } from "./ts-util.js"

export interface RunCheckOptions {
    /**
     * A validated config, a raw config object (paths relative to `root`), or the path of a
     * `libstylist.config.mjs`. Default: the nearest `libstylist.config.mjs` above `root`.
     */
    config?: CheckConfig | RawCheckConfig | string
    /** Where raw configs resolve and the config search starts. Default: `process.cwd()`. */
    root?: string
}

/** Why a component counts as migrated (the ratchet), or `null` when it is still pending. */
export type MigrationReason = "cx" | "identity" | "exemption" | null

export interface ComponentStatus {
    /** `core/Modal.Header`. */
    id: string
    /** The namespace of its implementation file. */
    namespace: string
    /** npm name of the package holding it (several packages may share a namespace). */
    package: string
    tag: string | null
    /** Implementation file, relative to the config root. */
    file: string
    migrated: boolean
    reason: MigrationReason
    /** Findings that are errors (migrated) or pending (not migrated) for this component. */
    findings: number
}

export interface SheetStatus {
    scope: string
    /** Sheet path relative to the config root. */
    file: string
    group: string
    /** npm name of the package the sheet belongs to (its css group's package). */
    package: string
    /** Compiled by libstylist (`@stylist root|scope`). */
    flipped: boolean
    /** Listed in `css.unboundSheets` (bound to no component; never pending). */
    unbound: boolean
}

export interface LegacyUsage {
    /** Calls of each helper across the design-system sources. */
    calls: Record<LegacyHelper, number>
    /** Files calling a helper, with their counts, sorted by file. */
    files: Array<{ file: string } & Record<LegacyHelper, number>>
    /** `@deprecated` class props still accepted through `legacyClassName`. */
    classProps: LegacyClassProp[]
}

export interface CheckStats {
    packages: number
    components: number
    /** Components the ratchet counts as migrated. */
    migrated: number
    /** Design-system source files in the program. */
    files: number
    /** Registered stylesheet scopes. */
    scopes: number
    /** Sheets compiled by libstylist. */
    flippedScopes: number
    /** Sheets bound to components (`css.unboundSheets` excluded) and how many of them are flipped — what burndown counts. */
    sheets: { total: number; flipped: number }
    /** Findings reported now (errors and warnings). */
    findings: number
    errors: number
    warnings: number
    /** Findings on components (or files) that are not migrated yet. */
    pending: number
    /** Reported findings per rule id, sorted by id. */
    byRule: Partial<Record<RuleId, number>>
    /** Pending findings per rule id, sorted by id. */
    pendingByRule: Partial<Record<RuleId, number>>
    /** Valid exemptions per category, and their budgets (`null` = unbudgeted). */
    exemptions: Record<ExemptionCategory, { used: number; budget: number | null }>
    /** Migration helper calls and accepted legacy class props. */
    legacy: Record<LegacyHelper, number> & { classProps: number }
    /** `css.hostParts` entries (parts carried by elements outside the design-system sources). */
    hostParts: number
    /** Runtime cx() calls and named slot props read. */
    cxCalls: number
    identityOccurrences: number
    durationMs: number
}

export interface CheckResult {
    /** Errors and warnings: hard rules everywhere, every rule on migrated components. */
    findings: Finding[]
    /** Findings on not-yet-migrated components and files — counted by burndown, not errors. */
    pending: Finding[]
    stats: CheckStats
    config: CheckConfig
    components: ComponentStatus[]
    sheets: SheetStatus[]
    memberRoots: MemberRoot[]
    legacy: LegacyUsage
    /** Per-component root analyses (for tooling and tests). */
    analyses: Map<ComponentEntry, RootAnalysis>
}

/** What each exemption category excuses (the waivers the root analysis attaches to its problems). */
const EXEMPTION_SCOPE: Record<ExemptionCategory, string> = {
    none: "a root with no DOM of its own (nothing, passed-through children, an unknown call, text, a DOM-less third-party wrapper)",
    multi: "unstyled sibling roots next to the identity element",
    native: "a marker on a generic or third-party-managed host",
}

const isValidated = (c: unknown): c is CheckConfig =>
    !!c && typeof c === "object" && "root" in c && Array.isArray((c as CheckConfig).packages) && (c as CheckConfig).packages.every((p) => !!p.naming && Array.isArray(p.groups))

/** Resolves the `config` option. */
export async function resolveCheckConfig(options: RunCheckOptions = {}): Promise<CheckConfig> {
    const root = resolve(options.root ?? process.cwd())
    const { config } = options
    if (typeof config === "string") return loadCheckConfig(resolve(root, config))
    if (config && isValidated(config)) return config
    if (config) return validateCheckConfig(config, root)
    const found = findCheckConfig(root)
    if (!found) throw new CheckConfigError(`no libstylist.config.mjs found in ${root} or above`)
    return loadCheckConfig(found)
}

/** Runs the conventions checker. */
export async function runCheck(options: RunCheckOptions = {}): Promise<CheckResult> {
    const started = Date.now()
    const config = await resolveCheckConfig(options)
    const raw: Finding[] = []

    // stylesheets → registry (+ drift against the built one)
    const sheets = loadSheets(config)
    for (const e of sheets.errors) raw.push(finding("S300", `${e.code}:${e.files.join(",")}`, e.message, e.files[0] ?? "", Number(/:(\d+):/.exec(e.message)?.[1] ?? 0)))
    if (config.css.registry) {
        const rel = relPath(config, config.css.registry)
        // a config with no css-group package is a workspace of app packages: `libstylist build` writes it
        const fix = config.packages.every((p) => p.cssGroup === null) ? WORKSPACE_BUILD_FIX : CSS_PACKAGE_FIX
        for (const d of registryDrift(config.css.registry, sheets, fix)) raw.push(finding("S309", d.key, d.message.replace(config.css.registry, rel), rel, 0))
    }
    // the app's override sheets of a design system: what `libstylist build` would stop on
    for (const p of await checkOverrides(config, sheets.registry)) raw.push(finding("S310", p.key, p.message, p.file, p.line))

    // program → exports → roots
    const cp = createCheckProgram(config)
    const index = discoverExports(config, cp)
    raw.push(...index.findings)
    const evaluator = new RenderEvaluator(cp, index)
    const cx = new CxReader(cp.checker, sheets.registry, config.css.partMaps)
    const analyzer = new RootAnalyzer(evaluator, sheets.registry, config.prefix, cp.checker, cx)
    const analyses = new Map<ComponentEntry, RootAnalysis>()
    for (const c of index.components) analyses.set(c, analyzer.analyze(c))

    // per-file ratchet facts
    const factsCache = new Map<ts.SourceFile, FileFacts>()
    const facts = (sf: ts.SourceFile): FileFacts => {
        let f = factsCache.get(sf)
        if (!f) factsCache.set(sf, (f = collectFileFacts(sf, cp.checker, config.prefix, cx)))
        return f
    }

    // exemptions
    const tags = collectExemptionTags(cp.files)
    const tagsByComponent = new Map<ComponentEntry, ExemptionTag[]>()
    const claimed = new Set<ExemptionTag>()
    for (const c of index.components) {
        const owners = new Set(c.docHosts.flatMap(jsDocOwners))
        const mine = tags.filter((t) => owners.has(t.owner))
        for (const t of mine) claimed.add(t)
        if (mine.length) tagsByComponent.set(c, mine)
    }
    const used: Record<ExemptionCategory, ComponentEntry[]> = { none: [], multi: [], native: [] }
    const at = (node: ts.Node) => ({ file: cp.rel(node.getSourceFile().fileName), line: lineOf(node) })
    for (const c of index.components) {
        const analysis = analyses.get(c) as RootAnalysis
        const own = tagsByComponent.get(c) ?? []
        let cat: ExemptionCategory | null = null
        for (const [i, t] of own.entries()) {
            const { file, line } = at(t.tag)
            if (i > 0) {
                raw.push(finding("X121", `${c.id}#${i}`, `${c.path.join(".")} has more than one @libstylistRoot tag — keep one`, file, line))
                continue
            }
            const parsed = parseExemption(t.text, config.exemptions.minReasonLength)
            if (!parsed.ok) raw.push(finding("X121", c.id, `@libstylistRoot on ${c.path.join(".")} ${parsed.problem}`, file, line))
            else cat = parsed.category
        }
        let waived = 0
        for (const p of analysis.problems) {
            if (cat && p.waivers.includes(cat)) {
                waived++
                continue
            }
            const { file, line } = at(p.node)
            raw.push(finding(p.rule, c.id, p.message, file, line, c.id))
        }
        if (cat) {
            used[cat].push(c)
            if (!waived) {
                const { file, line } = at(own[0].tag)
                const rules = [...new Set(analysis.problems.map((p) => p.rule))].sort()
                const why = rules.length
                    ? `it excuses none of the component's findings (${rules.join(", ")}): \`${cat}\` only covers ${EXEMPTION_SCOPE[cat]}; fix the findings and remove the tag`
                    : `the component has no ${EXEMPTION_SCOPE[cat]} it would excuse; remove the tag`
                raw.push(finding("X122", c.id, `@libstylistRoot ${cat} on ${c.path.join(".")} is stale — ${why}`, file, line, c.id))
            }
        }
    }
    for (const t of tags) {
        if (claimed.has(t)) continue
        const { file, line } = at(t.tag)
        raw.push(finding("X121", `${file}#${ownerName(t.owner)}`, `@libstylistRoot must sit on an exported component — ${ownerName(t.owner)} is not one`, file, line))
    }
    for (const cat of EXEMPTION_CATEGORIES) {
        const budget = config.exemptions.budget[cat]
        if (used[cat].length <= budget) continue
        const first = used[cat][budget] ?? used[cat][0]
        const { file, line } = at(tagsByComponent.get(first)?.[0].tag ?? first.impl)
        raw.push(finding("X123", cat, `${used[cat].length} \`${cat}\` exemptions exceed the budget of ${budget} (${used[cat].map((c) => c.path.join(".")).join(", ")})`, file, line))
    }

    // registry and CSS↔JSX
    const configFile = config.file ? relPath(config, config.file) : "libstylist.config.mjs"
    const cross = crossCheck({ cp, index, analyses, analyzer, evaluator, sheets, prefix: config.prefix, facts, hostParts: config.css.hostParts, configFile })
    raw.push(...cross.findings)

    // the ratchet: which components are migrated
    const reasonOf = (c: ComponentEntry): MigrationReason => {
        const f = facts(c.impl.getSourceFile())
        if (f.cxCalls > 0) return "cx"
        if (f.identities.size || analyses.get(c)?.sawIdentity) return "identity"
        if (tagsByComponent.has(c)) return "exemption"
        return null
    }
    const reasons = new Map(index.components.map((c) => [c.id, reasonOf(c)] as const))
    const aliasOf = new Map<string, string>()
    for (const c of index.components) for (const a of c.aliases) aliasOf.set(a, c.id)
    const fileMigrated = new Map<string, boolean>(cp.files.map((sf) => [cp.rel(sf.fileName), facts(sf).migrated]))
    /** The component a finding belongs to: its own, an alias's canonical one, or the nearest exported parent path. */
    const ownerId = (f: Finding): string | undefined => {
        if (f.component) return f.component
        if (!(f.rule === "C001" || f.rule === "C003")) return undefined
        if (aliasOf.has(f.key)) return aliasOf.get(f.key)
        const [ns, path] = [f.key.slice(0, f.key.indexOf("/")), f.key.slice(f.key.indexOf("/") + 1)]
        const parts = path.split(".")
        for (let n = parts.length; n > 0; n--) {
            const id = `${ns}/${parts.slice(0, n).join(".")}`
            if (reasons.has(id)) return id
        }
        return undefined
    }
    const isPending = (f: Finding): boolean => {
        const scope = RULES[f.rule].scope
        if (scope === "hard") return false
        const owner = scope === "component" ? ownerId(f) : undefined
        if (owner !== undefined) return reasons.get(owner) === null
        // file-scoped rules, and component rules with no exported owner: the file decides
        return fileMigrated.get(f.file) === false
    }

    const all = dedupeFindings(raw).map((f) => {
        const owner = ownerId(f)
        return owner && !f.component ? { ...f, component: owner } : f
    })
    const findings = sortFindings(all.filter((f) => !isPending(f)))
    const pending = sortFindings(all.filter(isPending))

    const perComponent = new Map<string, number>()
    for (const f of all) if (f.component) perComponent.set(f.component, (perComponent.get(f.component) ?? 0) + 1)
    const components: ComponentStatus[] = index.components.map((c) => ({
        id: c.id,
        namespace: c.namespace,
        package: c.pkg.name,
        tag: c.tag,
        file: cp.rel(c.impl.getSourceFile().fileName),
        migrated: reasons.get(c.id) !== null,
        reason: reasons.get(c.id) ?? null,
        findings: perComponent.get(c.id) ?? 0,
    }))
    const sheetStatus: SheetStatus[] = Object.entries(sheets.registry.scopes)
        .map(([scope, info]) => ({
            scope,
            file: info.file,
            group: info.group,
            package: sheets.sheetPackage.get(scope)?.name ?? "",
            flipped: sheets.flippedScopes.has(scope),
            unbound: sheets.unboundScopes.has(scope),
        }))
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

    const legacyCalls: Record<LegacyHelper, number> = { legacy: 0, legacyClassName: 0 }
    const legacyFiles: LegacyUsage["files"] = []
    for (const sf of cp.files) {
        const f = facts(sf)
        if (!LEGACY_HELPERS.some((h) => f.calls[h] > 0)) continue
        for (const h of LEGACY_HELPERS) legacyCalls[h] += f.calls[h]
        legacyFiles.push({ file: cp.rel(sf.fileName), ...f.calls })
    }

    const stats: CheckStats = {
        packages: config.packages.length,
        components: index.components.length,
        migrated: components.filter((c) => c.migrated).length,
        files: cp.files.length,
        scopes: Object.keys(sheets.registry.scopes).length,
        flippedScopes: sheets.flippedScopes.size,
        sheets: { total: sheetStatus.filter((x) => !x.unbound).length, flipped: sheetStatus.filter((x) => !x.unbound && x.flipped).length },
        findings: findings.length,
        errors: findings.filter((f) => f.severity === "error").length,
        warnings: findings.filter((f) => f.severity === "warning").length,
        pending: pending.length,
        byRule: countByRule(findings),
        pendingByRule: countByRule(pending),
        exemptions: Object.fromEntries(EXEMPTION_CATEGORIES.map((cat) => [cat, { used: used[cat].length, budget: Number.isFinite(config.exemptions.budget[cat]) ? config.exemptions.budget[cat] : null }])) as CheckStats["exemptions"],
        legacy: { ...legacyCalls, classProps: cross.legacyClassProps.length },
        hostParts: Object.keys(config.css.hostParts).length,
        cxCalls: cross.stats.cxCalls,
        identityOccurrences: cross.stats.identityOccurrences,
        durationMs: Date.now() - started,
    }
    return {
        findings,
        pending,
        stats,
        config,
        components,
        sheets: sheetStatus,
        memberRoots: cross.memberRoots,
        legacy: { calls: legacyCalls, files: legacyFiles, classProps: cross.legacyClassProps },
        analyses,
    }
}

/** A path relative to the config root, with forward slashes. */
function relPath(config: CheckConfig, abs: string): string {
    const r = abs.startsWith(config.root) ? abs.slice(config.root.length).replace(/^[\\/]+/, "") : abs
    return r.split("\\").join("/")
}

/** A stable, readable name for the node owning a JSDoc block. */
function ownerName(owner: ts.Node): string {
    if (ts.isVariableStatement(owner)) {
        const d = owner.declarationList.declarations[0]
        return d && ts.isIdentifier(d.name) ? d.name.text : "a variable"
    }
    if ((ts.isFunctionDeclaration(owner) || ts.isClassDeclaration(owner) || ts.isMethodDeclaration(owner) || ts.isPropertyAssignment(owner)) && owner.name && ts.isIdentifier(owner.name)) return owner.name.text
    if (ts.isExpressionStatement(owner)) return owner.expression.getText().split("=")[0].trim()
    return `line ${lineOf(owner)}`
}
