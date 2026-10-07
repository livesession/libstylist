// The checker's view of the app's override sheets (`css.overrides`, SPEC §9): what `libstylist build`
// would stop on — a design system that can't be loaded, a sheet that doesn't resolve (its package, its
// component, its parts, `within`), a sheet that doesn't compile, a reset that drops nothing — as S310
// findings. Override sheets are no package's sheets, so no other rule ever sees them.
import { relative, sep } from "node:path"

import type { Registry } from "../registry/index.js"
import { resolveLayers } from "../workspace/build.js"
import { collectOverrides, compileOverrideSheet, overrideReports } from "../workspace/overrides.js"
import type { CheckConfig } from "./config.js"

/** One override-sheet problem, placed. */
export interface OverrideProblem {
    /** Stable within S310 (code and files; no line). */
    key: string
    /** `[code] …`, as `libstylist build` prints it. */
    message: string
    /** Relative to the config root; the config file for a problem of no sheet. */
    file: string
    line: number
}

const toPosix = (p: string) => p.split(sep).join("/")
const lineIn = (message: string): number => Number(/:(\d+)(?::\d+)?:/.exec(message)?.[1] ?? 0)

/**
 * Resolves, compiles and reset-checks the override sheets of `config` against its design systems and
 * the app's `registry` (the one the checker built from the sheets). Empty without `css.overrides`.
 */
export async function checkOverrides(config: CheckConfig, registry: Registry): Promise<OverrideProblem[]> {
    if (!config.css.overrides) return []
    const configFile = config.file ? toPosix(relative(config.root, config.file)) : "libstylist.config.mjs"
    const problems: OverrideProblem[] = []
    const overrides = collectOverrides(config, registry)
    if (!overrides) return []
    for (const e of overrides.errors) {
        problems.push({ key: `${e.code}:${e.files.join(",")}:${e.message.replace(/:\d+(?::\d+)?:/, ":")}`, message: `[${e.code}] ${e.message}`, file: e.files[0] ?? configFile, line: lineIn(e.message) })
    }
    if (overrides.errors.length) return problems
    let statement: string[]
    try {
        statement = resolveLayers(config).statement
    } catch (err) {
        return [{ key: "layers", message: (err as Error).message, file: configFile, line: 0 }]
    }
    const compiled = new Map<string, string>()
    for (const sheet of overrides.sheets) {
        try {
            compiled.set(sheet.rel, (await compileOverrideSheet(overrides, statement, sheet.file, sheet.css)).css)
        } catch (err) {
            const message = (err as Error).message.replace(sheet.file, sheet.rel)
            const line = (err as { line?: number }).line ?? lineIn(message)
            problems.push({ key: `compile:${sheet.rel}`, message: message.includes(sheet.rel) ? message : `${sheet.rel}: ${message}`, file: sheet.rel, line })
        }
    }
    if (problems.length || overrides.resets.length === 0) return problems
    for (const line of overrideReports(overrides, compiled).lines) {
        if (line.level !== "error") continue
        const file = /^\[[a-z-]+\] ([^:\s]+)/.exec(line.text)?.[1] ?? configFile
        problems.push({ key: `empty-reset:${line.text.replace(/:\d+:/, ":")}`, message: line.text, file, line: lineIn(line.text) })
    }
    return problems
}
