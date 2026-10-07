// `libstylist build [--config <file>] [--check] [--watch]` — the workspace build (./build.ts) as a CLI:
// writes each package's part-map module, the overrides module, the lock and the registry JSON (or, with
// --check, fails on drift in the committed ones — the lock's changed entries listed — while still
// writing the gitignored registry), prints what each reset of the override sheets drops, and with
// --watch rebuilds on every change under the packages' sheet directories, the overrides directory and
// the design systems' registries.
import { watch, type FSWatcher } from "node:fs"
import { relative, sep } from "node:path"

import { diffLock, formatLockDiff, type StylistLock } from "../registry/index.js"
import { runWorkspaceBuild, type WorkspaceBuildReport, type WorkspaceOutput } from "./build.js"

export const BUILD_USAGE = "usage: libstylist build [--config <file>] [--check] [--watch]"

/** Output lines of the CLI. */
export interface BuildCliIo {
    out: (line: string) => void
    err: (line: string) => void
}

export interface BuildCliOptions {
    /** The directory the config is searched from and `--config` is relative to. @default process.cwd() */
    cwd?: string
    /** Ends `--watch` (closes the watchers and resolves 0); without it the watch runs until the process exits. */
    signal?: AbortSignal
}

const toPosix = (p: string) => p.split(sep).join("/")
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The entries a stale lock changes (`- override …`, `~ …`, `+ …`), or nothing when either side doesn't parse. */
function lockChanges(output: WorkspaceOutput): string[] {
    try {
        const before = output.current === null ? {} : (JSON.parse(output.current) as Partial<StylistLock>)
        const after = output.next === null ? {} : (JSON.parse(output.next) as Partial<StylistLock>)
        const text = formatLockDiff(diffLock(before, after))
        return text ? text.split("\n") : []
    } catch {
        return []
    }
}

/** Prints a report; returns the exit code (1 on a problem, or on drift in check mode). */
function printReport(report: WorkspaceBuildReport, check: boolean, io: BuildCliIo): number {
    const ws = report.build.workspace
    const rel = (file: string) => toPosix(relative(ws.root, file)) || "."
    for (const w of report.warnings) io.err(`warning ${w}`)
    const sheets = report.build.sheets.length
    const parts = Object.values(report.build.registry.scopes).reduce((n, s) => n + Object.keys(s.parts).length, 0)
    const overrides = report.build.overrides ? `, ${plural(report.build.overrides.sheets.length, "override sheet")}` : ""
    const counts = `${plural(ws.packages.length, "package")}, ${plural(sheets, "sheet")}, ${plural(parts, "part")}${overrides}`
    if (report.problems.length) {
        for (const p of report.problems) io.err(`error   ${p.message}`)
        io.err(`libstylist build: ${report.problems.length} error${report.problems.length === 1 ? "" : "s"} — nothing written (${counts})`)
        return 1
    }
    const written = new Set(report.written)
    for (const o of report.outputs) {
        if (check && o.kind !== "registry") {
            io.out(`${o.changed ? "stale  " : "ok     "} ${rel(o.file)}${o.changed ? " — run `libstylist build`" : ""}`)
            // a lock that drifted says what moved: a design-system change under an override shows up here
            if (o.changed && o.kind === "lock") for (const line of lockChanges(o)) io.out(`          ${line}`)
        } else io.out(`${written.has(o) ? (o.next === null ? "removed" : "wrote  ") : "ok     "} ${rel(o.file)}`)
    }
    for (const line of report.resetLines) io.out(`${line.level === "note" ? "note   " : "reset  "} ${line.text}`)
    if (check && report.drift.length) {
        io.err(`libstylist build --check: ${report.drift.length} file${report.drift.length === 1 ? "" : "s"} out of date — run \`libstylist build\` and commit the result`)
        return 1
    }
    io.out(`libstylist build${check ? " --check" : ""}: ${counts}`)
    return 0
}

/** Runs `libstylist build` with its arguments (without the command name); returns the exit code. */
export async function runBuildCli(argv: readonly string[], io: BuildCliIo, options: BuildCliOptions = {}): Promise<number> {
    const args = [...argv]
    let config: string | undefined
    let check = false
    let watching = false
    while (args.length) {
        const arg = args.shift() as string
        if (arg === "--check") check = true
        else if (arg === "--watch") watching = true
        else if (arg === "--config" && args.length && !args[0].startsWith("--")) config = args.shift()
        else {
            io.err(`libstylist build: unexpected argument ${JSON.stringify(arg)}\n${BUILD_USAGE}`)
            return 2
        }
    }
    if (check && watching) {
        io.err(`libstylist build: --check and --watch don't combine\n${BUILD_USAGE}`)
        return 2
    }
    const cwd = options.cwd ?? process.cwd()
    const once = async (): Promise<{ code: number; report: WorkspaceBuildReport | null }> => {
        try {
            const report = await runWorkspaceBuild({ config, root: cwd, check })
            return { code: printReport(report, check, io), report }
        } catch (err) {
            io.err(`libstylist build: ${err instanceof Error ? err.message : String(err)}`)
            return { code: 1, report: null }
        }
    }
    const first = await once()
    if (!watching) return first.code
    if (!first.report) return first.code

    // rebuild on any change under the sheet directories and the overrides directory, or to a design
    // system's registry (debounced; a failing build keeps watching)
    const ws = first.report.build.workspace
    const dirs = [...ws.packages.flatMap((p) => p.check.sheets), ...(ws.overrides && !ws.packages.some((p) => p.check.sheets.some((d) => ws.overrides?.dir.startsWith(d + sep))) ? [ws.overrides.dir] : [])]
    const registries = first.report.build.overrides?.designSystems.map((d) => d.registryFile) ?? []
    const watchers: FSWatcher[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    let running: Promise<unknown> = Promise.resolve()
    const schedule = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = null
            running = running.then(once)
        }, 50)
    }
    for (const dir of dirs) watchers.push(watch(dir, { recursive: true }, schedule))
    for (const file of registries) {
        try {
            watchers.push(watch(file, schedule))
        } catch {
            // a registry that went away: the next build reports it
        }
    }
    io.out(`libstylist build: watching ${dirs.length} sheet director${dirs.length === 1 ? "y" : "ies"}${registries.length ? ` and ${registries.length} design-system registr${registries.length === 1 ? "y" : "ies"}` : ""} for changes…`)
    return new Promise<number>((done) => {
        const stop = () => {
            if (timer) clearTimeout(timer)
            for (const w of watchers) w.close()
            void running.then(() => done(0))
        }
        if (options.signal?.aborted) stop()
        else options.signal?.addEventListener("abort", stop, { once: true })
    })
}
