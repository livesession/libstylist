// `libstylist burndown`: what the migration still has to do — components not migrated yet, sheets
// not flipped, their pending findings per rule, and the sanctioned migration helpers (`legacy()`,
// `legacyClassName()`, `@deprecated` class props) still in use. `--expect-zero` is the final-flip
// switch: it fails while anything is pending, any helper remains or `check` has errors.
import { EXEMPTION_CATEGORIES } from "./config.js"
import { formatExemptions, formatRuleCounts } from "./format.js"
import { RULES, type RuleId } from "./rules.js"
import { runCheck, type CheckResult, type CheckStats, type LegacyUsage, type RunCheckOptions } from "./run.js"

export interface BurndownOptions extends RunCheckOptions {
    /** A check result to report on instead of running the checker again. */
    result?: CheckResult
}

export interface BurndownPackage {
    /** The package's base namespace. */
    namespace: string
    /** npm name. */
    name: string
    components: number
    migrated: number
    /** Ids of the components still pending, sorted. */
    pending: string[]
    /** Pending findings of this package's components. */
    pendingFindings: number
    /** Sheets of the package's css groups, excluding unbound ones. */
    sheets: number
    flippedSheets: number
}

export interface BurndownReport {
    packages: BurndownPackage[]
    components: { total: number; migrated: number; pending: number }
    /** Sheets bound to components (unbound sheets excluded). */
    sheets: { total: number; flipped: number; pending: string[] }
    pendingFindings: number
    pendingByRule: Partial<Record<RuleId, number>>
    legacy: LegacyUsage
    exemptions: CheckStats["exemptions"]
    /** `css.hostParts`: parts carried by elements outside the design-system sources (not blockers). */
    hostParts: Array<{ part: string; reason: string }>
    /** `check` errors and warnings right now. */
    errors: number
    warnings: number
    /** True when the migration is finished: nothing pending, no helpers left, no errors. */
    zero: boolean
    /** Why `zero` is false, one line each. */
    blockers: string[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** Builds the burndown report from a check result. */
export function burndownReport(result: CheckResult): BurndownReport {
    const { config, components, sheets, legacy, stats } = result
    const pendingOf = new Map<string, number>()
    for (const f of result.pending) if (f.component) pendingOf.set(f.component, (pendingOf.get(f.component) ?? 0) + 1)
    const bound = sheets.filter((s) => !s.unbound)
    // per package, never per namespace: the packages of a workspace share their namespaces
    const packages: BurndownPackage[] = config.packages.map((pkg) => {
        const mine = components.filter((c) => c.package === pkg.name)
        const groupSheets = bound.filter((s) => s.package === pkg.name)
        return {
            namespace: pkg.namespace,
            name: pkg.name,
            components: mine.length,
            migrated: mine.filter((c) => c.migrated).length,
            pending: mine.filter((c) => !c.migrated).map((c) => c.id).sort(),
            pendingFindings: mine.reduce((n, c) => n + (pendingOf.get(c.id) ?? 0), 0),
            sheets: groupSheets.length,
            flippedSheets: groupSheets.filter((s) => s.flipped).length,
        }
    })
    const pendingSheets = bound.filter((s) => !s.flipped).map((s) => s.file)
    const migrated = components.filter((c) => c.migrated).length
    const blockers: string[] = []
    if (components.length > migrated) blockers.push(`${plural(components.length - migrated, "component")} not migrated`)
    if (pendingSheets.length) blockers.push(`${plural(pendingSheets.length, "sheet")} not flipped to libstylist`)
    if (result.pending.length) blockers.push(`${plural(result.pending.length, "pending finding")}`)
    if (legacy.calls.legacy) blockers.push(`${legacy.calls.legacy} legacy() call${legacy.calls.legacy === 1 ? "" : "s"}`)
    if (legacy.calls.legacyClassName) blockers.push(`${legacy.calls.legacyClassName} legacyClassName() call${legacy.calls.legacyClassName === 1 ? "" : "s"}`)
    if (legacy.classProps.length) blockers.push(`${plural(legacy.classProps.length, "@deprecated class prop")}`)
    if (stats.errors) blockers.push(`${plural(stats.errors, "check error")}`)
    return {
        packages,
        components: { total: components.length, migrated, pending: components.length - migrated },
        sheets: { total: bound.length, flipped: bound.length - pendingSheets.length, pending: pendingSheets },
        pendingFindings: result.pending.length,
        pendingByRule: stats.pendingByRule,
        legacy,
        exemptions: stats.exemptions,
        hostParts: Object.entries(config.css.hostParts).map(([part, reason]) => ({ part, reason })),
        errors: stats.errors,
        warnings: stats.warnings,
        zero: blockers.length === 0,
        blockers,
    }
}

/** Runs the checker (unless a result is given) and builds the burndown report. */
export async function runBurndown(options: BurndownOptions = {}): Promise<{ report: BurndownReport; result: CheckResult }> {
    const result = options.result ?? (await runCheck(options))
    return { report: burndownReport(result), result }
}

const pct = (n: number, of: number) => (of === 0 ? "100%" : `${Math.floor((n / of) * 100)}%`)

/** The report as plain text (terminal) or GitHub-flavored markdown (job summaries). */
export function formatBurndown(report: BurndownReport, format: "text" | "markdown" = "text"): string {
    const { components: c, sheets: s, legacy } = report
    const status = report.zero ? "zero — the migration is complete" : `not zero: ${report.blockers.join(", ")}`
    if (format === "text") {
        const lines = [
            `libstylist burndown: ${c.migrated}/${c.total} components migrated (${pct(c.migrated, c.total)}), ${s.flipped}/${s.total} sheets flipped, ${plural(report.pendingFindings, "pending finding")}`,
            "",
            "packages:",
            ...report.packages.map((p) => `  ${p.name.padEnd(34)} ${`${p.migrated}/${p.components}`.padStart(7)} components  ${`${p.flippedSheets}/${p.sheets}`.padStart(7)} sheets  ${String(p.pendingFindings).padStart(4)} pending findings`),
        ]
        if (Object.keys(report.pendingByRule).length) lines.push("", "pending findings by rule:", ...formatRuleCounts(report.pendingByRule))
        lines.push(
            "",
            `migration helpers: legacy() ${legacy.calls.legacy}, legacyClassName() ${legacy.calls.legacyClassName}, @deprecated class props ${legacy.classProps.length}`,
            ...legacy.files.map((f) => `  ${f.file}  legacy ${f.legacy}, legacyClassName ${f.legacyClassName}`),
            ...legacy.classProps.map((p) => `  ${p.component}.${p.prop}  (${p.file}:${p.line})`),
            `exemptions: ${formatExemptions(report)}`,
            `host parts: ${report.hostParts.length}${report.hostParts.length ? ` (${report.hostParts.map((h) => h.part).join(", ")})` : ""}`,
            `check: ${plural(report.errors, "error")}, ${plural(report.warnings, "warning")}`,
            `status: ${status}`,
        )
        return lines.join("\n")
    }
    const row = (cells: Array<string | number>) => `| ${cells.join(" | ")} |`
    const lines = [
        "## libstylist burndown",
        "",
        `**${c.migrated}/${c.total}** components migrated (${pct(c.migrated, c.total)}) · **${s.flipped}/${s.total}** sheets flipped · **${report.pendingFindings}** pending findings · ${report.zero ? "**zero**" : "not zero yet"}`,
        "",
        row(["Package", "Components migrated", "Sheets flipped", "Pending findings"]),
        row(["---", "---:", "---:", "---:"]),
        ...report.packages.map((p) => row([`\`${p.name}\``, `${p.migrated}/${p.components}`, `${p.flippedSheets}/${p.sheets}`, p.pendingFindings])),
    ]
    const rules = Object.entries(report.pendingByRule) as Array<[RuleId, number]>
    if (rules.length) {
        lines.push("", "<details><summary>Pending findings by rule</summary>", "", row(["Rule", "Title", "Pending"]), row(["---", "---", "---:"]), ...rules.map(([id, n]) => row([id, RULES[id].title, n])), "", "</details>")
    }
    const pendingComponents = report.packages.flatMap((p) => p.pending)
    if (pendingComponents.length) lines.push("", `<details><summary>Components not migrated (${pendingComponents.length})</summary>`, "", pendingComponents.map((id) => `\`${id}\``).join(", "), "", "</details>")
    lines.push(
        "",
        row(["Migration helper", "Remaining"]),
        row(["---", "---:"]),
        row(["`legacy()` calls", legacy.calls.legacy]),
        row(["`legacyClassName()` calls", legacy.calls.legacyClassName]),
        row(["`@deprecated` class props", legacy.classProps.length]),
        "",
        `Exemptions: ${EXEMPTION_CATEGORIES.map((cat) => `\`${cat}\` ${report.exemptions[cat].used}${report.exemptions[cat].budget === null ? "" : `/${report.exemptions[cat].budget}`}`).join(", ")} · host parts: ${report.hostParts.length} · check: ${plural(report.errors, "error")}, ${plural(report.warnings, "warning")}`,
        "",
        `Status: ${status}`,
    )
    return lines.join("\n")
}

export const BURNDOWN_USAGE = `usage: libstylist burndown [--config <file>] [--format text|markdown] [--json] [--expect-zero]
  --config <file>         libstylist.config.mjs to use (default: the nearest one above the cwd)
  --format text|markdown  output format (markdown suits a CI job summary); default text
  --json                  print the report as JSON
  --expect-zero           exit 1 while anything is pending, any legacy()/legacyClassName() remains or check has errors`

/** `libstylist burndown [flags]` — 0 (report only, or zero reached), 1 when `--expect-zero` fails, 2 on bad usage or config. */
export async function runBurndownCli(argv: readonly string[], io: { cwd?: string; stdout?: (t: string) => void; stderr?: (t: string) => void } = {}): Promise<number> {
    const out = io.stdout ?? ((t: string) => process.stdout.write(`${t}\n`))
    const err = io.stderr ?? ((t: string) => process.stderr.write(`${t}\n`))
    let config: string | undefined
    let format: "text" | "markdown" = "text"
    let json = false
    let expectZero = false
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const value = (name: string) => (arg === name ? argv[++i] : arg.slice(name.length + 1))
        if (arg === "--config" || arg.startsWith("--config=")) config = value("--config")
        else if (arg === "--format" || arg.startsWith("--format=")) {
            const f = value("--format")
            if (f !== "text" && f !== "markdown") {
                err(`libstylist burndown: --format must be text or markdown\n${BURNDOWN_USAGE}`)
                return 2
            }
            format = f
        } else if (arg === "--json") json = true
        else if (arg === "--expect-zero") expectZero = true
        else if (arg === "--help" || arg === "-h") {
            out(BURNDOWN_USAGE)
            return 0
        } else {
            err(`libstylist burndown: unknown argument "${arg}"\n${BURNDOWN_USAGE}`)
            return 2
        }
        if (arg === "--config" && !config) {
            err(`libstylist burndown: --config needs a file\n${BURNDOWN_USAGE}`)
            return 2
        }
    }
    let report: BurndownReport
    try {
        report = (await runBurndown({ config, root: io.cwd })).report
    } catch (e) {
        err(`libstylist burndown: ${(e as Error).message}`)
        return 2
    }
    out(json ? JSON.stringify(report, null, 2) : formatBurndown(report, format))
    if (expectZero && !report.zero) {
        err(`libstylist burndown --expect-zero: ${report.blockers.join(", ")}`)
        return 1
    }
    return 0
}
