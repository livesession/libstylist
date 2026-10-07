// In-process tally of sanctioned `legacy(...)` className values, filled by `libstylist/no-classname`
// so a programmatic ESLint run (the burndown CLI) can report how many remain. Files served from
// the ESLint cache are not re-linted and therefore not counted.

const usage = new Map<string, number>()

/** Records one `legacy(...)` use in `file` (called by the rule once per lint of the file). */
export function recordLegacyUse(file: string, count: number): void {
    if (count > 0) usage.set(file, count)
    else usage.delete(file)
}

/** `legacy(...)` uses per file seen since the last reset. */
export function legacyUsage(): ReadonlyMap<string, number> {
    return usage
}

/** Total `legacy(...)` uses seen since the last reset. */
export function legacyUsageTotal(): number {
    let total = 0
    for (const n of usage.values()) total += n
    return total
}

/** Clears the tally (before a new lint run). */
export function resetLegacyUsage(): void {
    usage.clear()
}
