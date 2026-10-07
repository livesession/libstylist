// `stylist.lock.json` (SPEC §7): the flat projection of the registry that CI guards. An entry that
// changes or disappears is a breaking selector change and needs an explicit lock update. An app with
// override sheets (SPEC §9) also locks the design-system identities and parts they resolve.
import type { OverrideLock } from "./overrides.js"
import { sortKeys, type Registry } from "./types.js"

export interface StylistLock {
    /** `"ns/scope:part"` → part attribute. */
    parts: Record<string, string>
    /** `"ns/Component.Path"` → tag. */
    tags: Record<string, string>
    /** Override sheets: `"<prefix>:ns/Component.Path"` → tag and `"<prefix>:ns/scope:part"` → attribute they read or reset. Absent without override sheets. */
    overrides?: Record<string, string>
    /** Override sheets: `"<prefix>:ns/scope:part"` → attribute of every part a reset strips. Absent without resets. */
    resets?: Record<string, string>
}

export interface LockChange {
    kind: "part" | "tag" | "override" | "reset"
    key: string
    before?: string
    after?: string
}

export interface LockDiff {
    added: LockChange[]
    removed: LockChange[]
    changed: LockChange[]
    /** True when an entry changed or disappeared (a breaking selector change). Additions never break. */
    breaking: boolean
}

/**
 * Projects a registry to its lock file, with the override sections (`overrideLock`) when an app has
 * override sheets — each section only when it has an entry, so a lock without overrides is unchanged.
 * Keys are sorted.
 */
export function toLock(registry: Registry, overrides?: OverrideLock | null): StylistLock {
    const parts: Record<string, string> = {}
    const tags: Record<string, string> = {}
    for (const [scope, info] of Object.entries(registry.scopes)) {
        for (const [part, attr] of Object.entries(info.parts)) parts[`${info.namespace}/${scope}:${part}`] = attr
        for (const root of info.roots) tags[`${info.namespace}/${root.component}`] = root.tag
    }
    const lock: StylistLock = { parts: sortKeys(parts), tags: sortKeys(tags) }
    if (overrides && Object.keys(overrides.overrides).length > 0) lock.overrides = sortKeys(overrides.overrides)
    if (overrides && Object.keys(overrides.resets).length > 0) lock.resets = sortKeys(overrides.resets)
    return lock
}

/** Compares two lock files. A missing section of `prev` (first lock) counts as empty. */
export function diffLock(prev: Partial<StylistLock>, next: Partial<StylistLock>): LockDiff {
    const diff: LockDiff = { added: [], removed: [], changed: [], breaking: false }
    const sections: Array<[LockChange["kind"], Record<string, string>, Record<string, string>]> = [
        ["part", prev.parts ?? {}, next.parts ?? {}],
        ["tag", prev.tags ?? {}, next.tags ?? {}],
        ["override", prev.overrides ?? {}, next.overrides ?? {}],
        ["reset", prev.resets ?? {}, next.resets ?? {}],
    ]
    for (const [kind, before, after] of sections) {
        for (const key of Object.keys(before).sort()) {
            if (!Object.prototype.hasOwnProperty.call(after, key)) diff.removed.push({ kind, key, before: before[key] })
            else if (after[key] !== before[key]) diff.changed.push({ kind, key, before: before[key], after: after[key] })
        }
        for (const key of Object.keys(after).sort()) {
            if (!Object.prototype.hasOwnProperty.call(before, key)) diff.added.push({ kind, key, after: after[key] })
        }
    }
    diff.breaking = diff.removed.length > 0 || diff.changed.length > 0
    return diff
}

/** One line per change: `- part core/alert:icon _cxclass_…`, `~ tag core/Alert elo-a → elo-b`, `+ …`. */
export function formatLockDiff(diff: LockDiff): string {
    const lines = [
        ...diff.removed.map(c => `- ${c.kind} ${c.key} ${c.before}`),
        ...diff.changed.map(c => `~ ${c.kind} ${c.key} ${c.before} → ${c.after}`),
        ...diff.added.map(c => `+ ${c.kind} ${c.key} ${c.after}`),
    ]
    return lines.join("\n")
}
