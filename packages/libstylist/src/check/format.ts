// Text report of `libstylist check` and its command-line entry (argument parsing, exit code).
import { EXEMPTION_CATEGORIES } from "./config.js"
import { RULES, type Finding, type RuleId } from "./rules.js"
import { runCheck, type CheckResult, type CheckStats } from "./run.js"

export interface CliIO {
    cwd?: string
    stdout?: (text: string) => void
    stderr?: (text: string) => void
}

/** One line per finding: `file:line  RULE  message  [key]`. */
export const formatFinding = (f: Finding): string => `${f.file}${f.line ? `:${f.line}` : ""}  ${f.rule}${f.severity === "warning" ? " (warning)" : ""}  ${f.message}  [${f.key}]`

/** Per-rule count lines, aligned. */
export function formatRuleCounts(byRule: Partial<Record<RuleId, number>>, indent = "  "): string[] {
    const rules = Object.entries(byRule) as Array<[RuleId, number]>
    const width = Math.max(0, ...rules.map(([id]) => `${id} ${RULES[id].title}`.length))
    return rules.map(([id, n]) => `${indent}${`${id} ${RULES[id].title}`.padEnd(width)}  ${n}`)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The exemption budget summary (`none 0/0, multi 1/1, native 1/1`). */
export const formatExemptions = (stats: Pick<CheckStats, "exemptions">): string =>
    EXEMPTION_CATEGORIES.map((c) => `${c} ${stats.exemptions[c].used}${stats.exemptions[c].budget === null ? "" : `/${stats.exemptions[c].budget}`}`).join(", ")

/** The one-line summary every check run ends with. */
export function formatSummary(stats: CheckStats): string {
    return (
        `libstylist check: ${plural(stats.errors, "error")}, ${plural(stats.warnings, "warning")} — ` +
        `${stats.migrated}/${stats.components} components migrated (${stats.components - stats.migrated} pending with ${plural(stats.pending, "finding")}: libstylist burndown), ` +
        `${stats.sheets.flipped}/${stats.sheets.total} sheets flipped; exemptions ${formatExemptions(stats)}; ` +
        `legacy() ${stats.legacy.legacy}, legacyClassName() ${stats.legacy.legacyClassName}; ${stats.durationMs} ms`
    )
}

/** A readable report: one line per finding (pending ones too with `pending`), per-rule counts and the summary line. */
export function formatReport(result: Pick<CheckResult, "findings" | "pending" | "stats">, options: { pending?: boolean } = {}): string {
    const { findings, stats } = result
    const lines: string[] = findings.map(formatFinding)
    if (findings.length) lines.push("", ...formatRuleCounts(stats.byRule))
    if (options.pending && result.pending.length) {
        lines.push("", `pending (not migrated yet — not errors):`, ...result.pending.map((f) => `  ${formatFinding(f)}`), "", ...formatRuleCounts(stats.pendingByRule))
    }
    if (lines.length) lines.push("")
    lines.push(formatSummary(stats))
    return lines.join("\n")
}

export const CHECK_USAGE = `usage: libstylist check [--config <file>] [--json] [--pending]
  --config <file>   libstylist.config.mjs to use (default: the nearest one above the cwd)
  --json            print { findings, pending, stats, components, sheets, legacy } as JSON
  --pending         also list the findings of components that are not migrated yet`

/**
 * `libstylist check [flags]` — returns the exit code: 0 when no error remains (pending work and
 * warnings don't fail), 1 on errors, 2 on bad usage or a config problem.
 */
export async function runCheckCli(argv: readonly string[], io: CliIO = {}): Promise<number> {
    const out = io.stdout ?? ((t: string) => process.stdout.write(`${t}\n`))
    const err = io.stderr ?? ((t: string) => process.stderr.write(`${t}\n`))
    let config: string | undefined
    let json = false
    let pending = false
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === "--config" || arg.startsWith("--config=")) {
            config = arg === "--config" ? argv[++i] : arg.slice("--config=".length)
            if (!config) {
                err(`libstylist check: --config needs a file\n${CHECK_USAGE}`)
                return 2
            }
        } else if (arg === "--json") json = true
        else if (arg === "--pending") pending = true
        else if (arg === "--help" || arg === "-h") {
            out(CHECK_USAGE)
            return 0
        } else {
            err(`libstylist check: unknown argument "${arg}"\n${CHECK_USAGE}`)
            return 2
        }
    }
    let result: CheckResult
    try {
        result = await runCheck({ config, root: io.cwd })
    } catch (e) {
        err(`libstylist check: ${(e as Error).message}`)
        return 2
    }
    if (json) {
        const { findings, pending: pendingFindings, stats, components, sheets, memberRoots, legacy } = result
        out(JSON.stringify({ findings, pending: pendingFindings, stats, components, sheets, memberRoots: memberRoots.map(({ owner, ...m }) => ({ ...m, owner: owner.id })), legacy }, null, 2))
    } else out(formatReport(result, { pending }))
    return result.stats.errors > 0 ? 1 : 0
}
