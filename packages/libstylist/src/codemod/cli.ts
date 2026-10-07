// `libstylist codemod [--write] [--config <file>] [--no-types] <file.tsx...>`: converts files to the
// cx() call API. The project config (libstylist.config.mjs) supplies the part-map module of every
// scope (`css.partMaps` + the registry) and the compiler options for the type facts that keep data
// values rendering exactly what they render today.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import ts from "typescript"

import type { PartMapRegistry } from "../core/index.js"
import { findCheckConfig, loadCheckConfig, type CheckConfig } from "../check/config.js"
import { checkCompilerOptions } from "../check/program.js"
import { loadSheets } from "../check/sheets.js"
import { codemod, type CodemodResult } from "./index.js"
import { dataTypesFor } from "./types.js"

export interface CodemodIo {
    out: (line: string) => void
    err: (line: string) => void
}

const flag = (args: string[], name: string): boolean => {
    const i = args.indexOf(name)
    if (i < 0) return false
    args.splice(i, 1)
    return true
}

const option = (args: string[], name: string): string | undefined => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    const value = args[i + 1]
    args.splice(i, 2)
    return value
}

/** The registry the codemod resolves scopes with: the built one when present, else the sheets'. */
function registryOf(config: CheckConfig): PartMapRegistry {
    if (config.css.registry && existsSync(config.css.registry)) return JSON.parse(readFileSync(config.css.registry, "utf8")) as PartMapRegistry
    return loadSheets(config).registry
}

/** Converts `files` and reports per file; returns every result. */
export async function runCodemod(files: string[], options: { write?: boolean; config?: string; types?: boolean; cwd?: string } = {}): Promise<Array<{ file: string; result: CodemodResult }>> {
    const cwd = resolve(options.cwd ?? process.cwd())
    const configFile = options.config ? resolve(cwd, options.config) : findCheckConfig(cwd)
    const config = configFile ? await loadCheckConfig(configFile) : null
    const registry = config ? registryOf(config) : null
    const partMaps = config?.css.partMaps ?? null
    const moduleOf = (scope: string): string | null => {
        const group = registry && Object.prototype.hasOwnProperty.call(registry.scopes, scope) ? registry.scopes[scope].group : undefined
        return group && partMaps ? (partMaps[group] ?? null) : null
    }
    const abs = files.map((f) => resolve(cwd, f))
    const program = options.types === false ? null : ts.createProgram({ rootNames: abs, options: config ? checkCompilerOptions(config) : { jsx: ts.JsxEmit.Preserve, strict: true, noEmit: true, skipLibCheck: true } })
    const out: Array<{ file: string; result: CodemodResult }> = []
    for (const file of abs) {
        const result = codemod(readFileSync(file, "utf8"), file, { moduleOf, registry, partMaps, types: program ? dataTypesFor(program, file) : null })
        if (options.write && result.changed) writeFileSync(file, result.code)
        out.push({ file, result })
    }
    return out
}

/** The CLI entry. */
export async function runCodemodCli(args: string[], io: CodemodIo): Promise<number> {
    const write = flag(args, "--write")
    const noTypes = flag(args, "--no-types")
    const config = option(args, "--config")
    if (args.length === 0) {
        io.err("usage: libstylist codemod [--write] [--config libstylist.config.mjs] [--no-types] <file.tsx...>")
        return 2
    }
    const results = await runCodemod(args, { write, config, types: !noTypes })
    let falseCount = 0
    for (const { file, result } of results) {
        const rel = file.startsWith(process.cwd()) ? file.slice(process.cwd().length + 1) : file
        io.out(`${result.changed ? (write ? "rewrote" : "would rewrite") : "unchanged"} ${rel}${result.scopes.length ? ` (${result.scopes.join(", ")})` : ""}`)
        for (const item of result.todo) io.out(`  ${item.line ? `L${item.line}` : "  -"}: TODO ${item.message}`)
        for (const f of result.falseAttributes) {
            falseCount++
            io.out(`  L${f.line}: renders "false" today — ${f.attr}={${f.value}}${f.rewritten ? ` kept as ${f.rewritten}` : " (left for a decision)"}`)
        }
    }
    if (falseCount) io.out(`${falseCount} data attribute(s) render "false" today and were kept that way — review them (latent "false"-attribute footguns)`)
    return 0
}
