// `libstylist migrate-selectors`: rewrites a consumer codebase's legacy design-system hooks
// (`.ls-*` classes, literal hooks, `[data-component]`, `[data-part]`, keyframes names) to their
// libstylist successors, driven entirely by a migration map (the design system publishes its own as
// `@livesession/eloquentui-css/migration/ls-to-elo.json`). What can't be rewritten mechanically —
// class usages, prop/data successors, removed hooks and props — is reported as a TODO with the map's
// replacement instruction. Dry run by default; `--write` applies, `--check` fails when anything would
// change. See docs/MIGRATING.md, "Migrating a consumer app".
import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { relative, resolve } from "node:path"

import { analyzeStylesheet, styleParser, type StyleSyntax } from "./css.js"
import { expandInputs, languageOf, type Language } from "./files.js"
import { analyzeScript } from "./js.js"
import { fileMayMatter, indexMap, loadMigrationMap, MapError, resolveMapPath, type AppliedHooks, type MapIndex, type MigrationMap } from "./map.js"
import { DEFAULT_OPTIONS, type Finding, type MigrateOptions, type Reason, type SelectorRewrite } from "./selector.js"
import { applyEdits, LineIndex } from "./text.js"

export { fileMayMatter, indexMap, loadMigrationMap, MapError, resolveMapPath, DEFAULT_MAP_SPECIFIER, type AppliedHooks, type MapIndex, type MigrationMap } from "./map.js"
export { analyzeSelector, DEFAULT_OPTIONS, type Finding, type MigrateOptions, type Reason, type SelectorAnalysis } from "./selector.js"
export { expandInputs, globToRegExp, languageOf } from "./files.js"

export interface Entry {
    kind: "rewrite" | "todo" | "unknown" | "error"
    line: number
    column: number
    /** Why a TODO / unknown was reported (absent on rewrites). */
    reason?: Reason
    old: string
    /** Rewrites: what was written. TODOs: the suggested replacement, when the map has one. */
    new?: string
    message?: string
    notes?: string[]
}

export interface FileResult {
    /** Path relative to the working directory. */
    file: string
    language: Language | null
    /** The parser that read a stylesheet (SCSS/LESS without their syntax packages say so). */
    parser?: string
    changed: boolean
    written: boolean
    entries: Entry[]
}

export interface MigrateSummary {
    files: number
    changed: number
    rewrites: number
    todos: number
    unknown: number
    errors: number
}

export interface MigrateResult {
    map: { file: string; prefix: string; version: number }
    mode: "dry-run" | "write" | "check"
    options: MigrateOptions
    files: FileResult[]
    unmatched: string[]
    summary: MigrateSummary
}

export interface CodeResult {
    output: string
    changed: boolean
    parser?: string
    entries: Entry[]
    /** Legacy classes / data-component values this (script) file puts on its own elements. */
    applied: Array<{ kind: "class" | "data-component"; name: string; line: number }>
}

export interface CodeContext {
    /** Legacy hooks the rest of the project puts on its own elements (`migrateSelectors` collects them). */
    applied?: AppliedHooks
}

/**
 * Migrates one source text. `filename` picks the language (and the parser plugins); `cwd` is where
 * postcss-scss / postcss-less are looked up for SCSS / LESS. A text that names nothing the map knows
 * is returned unparsed.
 */
export async function migrateCode(code: string, filename: string, index: MapIndex, options: MigrateOptions = DEFAULT_OPTIONS, cwd = process.cwd(), context: CodeContext = {}): Promise<CodeResult> {
    const language = languageOf(filename)
    if (!language) throw new Error(`${filename}: not a stylesheet or script migrate-selectors reads`)
    if (!fileMayMatter(code, index, options.literals)) return { output: code, changed: false, entries: [], applied: [] }
    let analysis: { edits: { start: number; end: number; text: string }[]; rewrites: SelectorRewrite[]; findings: Finding[] }
    let parser: string | undefined
    const lines = new LineIndex(code)
    let applied: CodeResult["applied"] = []
    if (language === "js") {
        const a = analyzeScript(code, filename, { index, options, applied: context.applied })
        applied = a.applied.map((h) => ({ kind: h.kind, name: h.name, line: lines.position(h.start).line }))
        analysis = a
    } else {
        const p = await styleParser(language as StyleSyntax, cwd)
        let parsed: ReturnType<typeof p.parse>
        try {
            parsed = p.parse(code)
        } catch (error) {
            if (p.fallback && error instanceof Error) error.message = `${error.message} (read with ${p.name})`
            throw error
        }
        const { root, text } = parsed
        // `:global` only means something where classes are scoped (CSS Modules under any file name, the
        // webapp-next sheet pipeline, Svelte / Vue scoped styles): the other classes there are local. Such
        // a sheet keeps its `:global(…)` wrappers — they are how the next run still knows it is scoped.
        const byName = /\.module\.[a-z]+$/i.test(filename)
        const byGlobal = !byName && /:global\b/.test(text)
        analysis = analyzeStylesheet(text, root, { index, options, syntax: language as StyleSyntax, cssModule: byName || byGlobal, keepGlobal: byGlobal, applied: context.applied })
        parser = p.name
    }
    const output = applyEdits(code, analysis.edits)
    const entries: Array<Entry & { offset: number }> = []
    for (const r of analysis.rewrites) {
        entries.push({ kind: "rewrite", ...lines.position(r.start), offset: r.start, old: r.old, new: r.new, ...(r.notes.length > 0 ? { notes: r.notes } : {}) })
    }
    for (const f of analysis.findings) {
        entries.push({ kind: f.kind, ...lines.position(f.start), offset: f.start, reason: f.reason, old: f.old, ...(f.suggestion ? { new: f.suggestion } : {}), message: f.message })
    }
    entries.sort((a, b) => a.offset - b.offset || order(a.kind) - order(b.kind))
    return { output, changed: output !== code, ...(parser ? { parser } : {}), entries: entries.map(({ offset: _offset, ...e }) => e), applied }
}

const order = (kind: Entry["kind"]) => ["rewrite", "todo", "unknown", "error"].indexOf(kind)

export interface MigrateSelectorsOptions extends Partial<MigrateOptions> {
    inputs: string[]
    /** The migration map; defaults to the installed `@livesession/eloquentui-css` one. */
    map?: string
    cwd?: string
    write?: boolean
    check?: boolean
    ignore?: string[]
}

/** Runs the codemod over files / directories / globs. Writes only with `write: true`. */
export async function migrateSelectors(opts: MigrateSelectorsOptions): Promise<MigrateResult> {
    const cwd = resolve(opts.cwd ?? process.cwd())
    const mapFile = resolveMapPath(opts.map, cwd)
    const map = loadMigrationMap(mapFile)
    const index = indexMap(map)
    const options: MigrateOptions = { roots: opts.roots ?? DEFAULT_OPTIONS.roots, literals: opts.literals ?? DEFAULT_OPTIONS.literals }
    const { files, unmatched } = expandInputs(opts.inputs, cwd, opts.ignore)
    const runs: Array<{ abs: string; file: string; language: Language | null; code?: string; result?: CodeResult; error?: Entry }> = []
    const run = async (item: (typeof runs)[number], context: CodeContext) => {
        try {
            item.result = await migrateCode(item.code!, item.abs, index, options, cwd, context)
            item.error = undefined
        } catch (error) {
            const e = error as Error & { loc?: { line: number; column: number }; line?: number; column?: number }
            const line = e.loc?.line ?? e.line ?? 0
            const column = (e.loc?.column ?? (e.column !== undefined ? e.column - 1 : 0)) + 1
            item.result = undefined
            item.error = { kind: "error", line, column: line ? column : 0, old: "", message: `could not parse: ${e.message.split("\n")[0]}` }
        }
    }
    // pass 1: every file on its own, collecting the legacy hooks the app puts on its own elements
    const applied: AppliedHooks = { classes: new Map(), dataComponent: new Map() }
    for (const abs of files) {
        const item: (typeof runs)[number] = { abs, file: shown(abs, cwd), language: languageOf(abs) }
        runs.push(item)
        if (!item.language) continue
        item.code = readFileSync(abs, "utf8")
        await run(item, {})
        for (const h of item.result?.applied ?? []) {
            const into = h.kind === "class" ? applied.classes : applied.dataComponent
            if (!into.has(h.name)) into.set(h.name, `${item.file}:${h.line}`)
        }
    }
    // pass 2: a file naming a hook another file applies — its selectors style that element too
    const names = [...applied.classes.keys(), ...applied.dataComponent.keys()]
    if (names.length > 0) {
        for (const item of runs) {
            if (!item.code || !names.some((n) => item.code!.includes(n))) continue
            await run(item, { applied })
        }
    }
    const results: FileResult[] = []
    for (const item of runs) {
        const { file, language, result: r } = item
        if (!language) {
            results.push({ file, language, changed: false, written: false, entries: [{ kind: "error", line: 0, column: 0, old: "", message: "not a stylesheet or script migrate-selectors reads (css, scss, less, js, jsx, ts, tsx, mjs, cjs) — skipped" }] })
            continue
        }
        if (!r) {
            results.push({ file, language, changed: false, written: false, entries: [item.error!] })
            continue
        }
        const written = Boolean(opts.write && r.changed)
        if (written) writeFileSync(item.abs, r.output)
        results.push({ file, language, ...(r.parser && r.parser !== "postcss" ? { parser: r.parser } : {}), changed: r.changed, written, entries: r.entries })
    }
    const count = (kind: Entry["kind"]) => results.reduce((n, f) => n + f.entries.filter((e) => e.kind === kind).length, 0)
    return {
        map: { file: mapFile, prefix: map.prefix, version: map.version },
        mode: opts.write ? "write" : opts.check ? "check" : "dry-run",
        options,
        files: results,
        unmatched,
        summary: {
            files: results.length,
            changed: results.filter((f) => f.changed).length,
            rewrites: count("rewrite"),
            todos: count("todo"),
            unknown: count("unknown"),
            errors: count("error"),
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** A path relative to `cwd` (or to its real path — resolved modules come back real), else absolute. */
function shown(file: string, cwd: string): string {
    let real = cwd
    try {
        real = realpathSync(cwd)
    } catch {
        // keep cwd
    }
    const candidates = [relative(cwd, file), relative(real, file)].filter((p) => p && !p.startsWith(".."))
    return candidates[0] ?? file
}

/** The human report: per-file rewrites, then the TODO, unknown and error lists, then the summary. */
export function formatReport(result: MigrateResult, cwd = process.cwd()): string[] {
    const out: string[] = []
    const mapShown = shown(result.map.file, cwd)
    out.push(`libstylist migrate-selectors — map ${mapShown} (prefix ${result.map.prefix}, v${result.map.version}) · ${plural(result.summary.files, "file")} · ${result.mode}`)
    for (const u of result.unmatched) out.push(`warning: ${u} matched no file`)
    const verb = result.mode === "write" ? "rewrote" : "would rewrite"
    for (const f of result.files) {
        if (f.entries.length === 0) continue
        const n = (kind: Entry["kind"]) => f.entries.filter((e) => e.kind === kind).length
        const parts = [n("rewrite") > 0 ? `${verb} ${plural(n("rewrite"), "selector")}` : "unchanged", n("todo") > 0 ? plural(n("todo"), "TODO") : "", n("unknown") > 0 ? `${n("unknown")} unknown` : "", n("error") > 0 ? plural(n("error"), "error") : ""].filter(Boolean)
        out.push("", `${f.file}  ${parts.join(" · ")}${f.parser ? `  [parsed with ${f.parser}]` : ""}`)
        for (const e of f.entries.filter((x) => x.kind === "rewrite")) {
            out.push(`  ${`${e.line}:${e.column}`.padEnd(7)} ${e.old}`, `  ${"".padEnd(7)} → ${e.new}`)
            for (const note of e.notes ?? []) out.push(`  ${"".padEnd(7)}   note: ${note}`)
        }
    }
    const listed = (kind: Entry["kind"], title: string) => {
        const rows = result.files.flatMap((f) => f.entries.filter((e) => e.kind === kind).map((e) => ({ f, e })))
        if (rows.length === 0) return
        out.push("", `${title} (${rows.length})`)
        for (const { f, e } of rows) {
            const where = e.line ? `${f.file}:${e.line}:${e.column}` : f.file
            out.push(`  ${where}  ${e.old}${e.new ? `  →  ${e.new}` : ""}`)
            if (e.message) out.push(`      ${e.reason ? `${e.reason}: ` : ""}${e.message}`)
        }
    }
    listed("todo", "TODO — needs a decision")
    listed("unknown", "Unknown legacy tokens — not in the map")
    listed("error", "Errors")
    const s = result.summary
    out.push(
        "",
        `${plural(s.files, "file")} · ${s.changed} ${result.mode === "write" ? "changed" : "would change"} (${plural(s.rewrites, "rewrite")}) · ${plural(s.todos, "TODO")} · ${s.unknown} unknown · ${plural(s.errors, "error")}${result.mode === "dry-run" && s.changed > 0 ? " — pass --write to apply" : ""}`,
    )
    return out
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export const USAGE = `usage: libstylist migrate-selectors [--map <migration-map.json>] [--write | --check [--strict]] [--json]
                                  [--roots part|identity] [--literals anchored|all|off] [--ignore <glob>]... <file|dir|glob...>`

interface Io {
    out: (line: string) => void
    err: (line: string) => void
}

/** `libstylist migrate-selectors …` — returns the exit code. */
export async function runMigrateSelectorsCli(argv: string[], io: Io, cwd = process.cwd()): Promise<number> {
    const inputs: string[] = []
    const ignore: string[] = []
    let map: string | undefined
    let write = false
    let check = false
    let strict = false
    let json = false
    let roots: MigrateOptions["roots"] = DEFAULT_OPTIONS.roots
    let literals: MigrateOptions["literals"] = DEFAULT_OPTIONS.literals
    const usage = (message: string) => {
        io.err(`libstylist migrate-selectors: ${message}`)
        io.err(USAGE)
        return 2
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const value = () => {
            const v = argv[++i]
            if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`)
            return v
        }
        try {
            if (arg === "--map") map = value()
            else if (arg === "--write") write = true
            else if (arg === "--check") check = true
            else if (arg === "--strict") strict = check = true
            else if (arg === "--json") json = true
            else if (arg === "--ignore") ignore.push(value())
            else if (arg === "--roots") {
                const v = value()
                if (v !== "part" && v !== "identity") return usage(`--roots is part or identity, not ${v}`)
                roots = v
            } else if (arg === "--literals") {
                const v = value()
                if (v !== "anchored" && v !== "all" && v !== "off") return usage(`--literals is anchored, all or off, not ${v}`)
                literals = v
            } else if (arg === "--help" || arg === "-h") {
                io.out(USAGE)
                return 0
            } else if (arg.startsWith("--")) return usage(`unknown option ${arg}`)
            else inputs.push(arg)
        } catch (error) {
            return usage((error as Error).message)
        }
    }
    if (write && check) return usage("--write and --check exclude each other")
    if (inputs.length === 0) return usage("pass the files, directories or globs to migrate")
    let result: MigrateResult
    try {
        result = await migrateSelectors({ inputs, map, cwd, write, check, ignore, roots, literals })
    } catch (error) {
        if (error instanceof MapError) {
            io.err(`libstylist migrate-selectors: ${error.message}`)
            return 2
        }
        throw error
    }
    if (result.files.length === 0) {
        io.err(`libstylist migrate-selectors: no file matched ${inputs.join(" ")}`)
        return 2
    }
    if (json) io.out(JSON.stringify(result, null, 2))
    else for (const line of formatReport(result, cwd)) io.out(line)
    const s = result.summary
    if (check) return s.changed > 0 || s.errors > 0 || (strict && (s.todos > 0 || s.unknown > 0)) ? 1 : 0
    if (write) return s.errors > 0 ? 1 : 0
    return 0
}
