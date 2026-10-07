// Old → new selector map for consumers and the dist comparison (`compare-dist --rename`):
// `.ls-alert` → `[_cxclass_…root]`, `.ls-alert__icon` → `[_cxclass_…icon]`, and optionally
// `@keyframes ls-loader-loading` → `elo-loader-…`.
import { partSelector } from "../hash/index.js"
import { exportName } from "./modules.js"
import { hasOwn, sortKeys, type Registry } from "./types.js"

/** Today's class maps: scope (or its camelCase export name) → local → legacy class name. */
export type LegacyClassMaps = Record<string, Record<string, string>>

export interface RenameMapOptions {
    /**
     * Also emit compare-dist's `"@keyframes <legacy>": "<emitted>"` entries. `true` assumes each
     * local keyframes name is still its legacy name (the legacy build never renamed keyframes);
     * a map gives scope → legacy name → local for sheets that renamed them.
     * @default false
     */
    keyframes?: boolean | Record<string, Record<string, string>>
}

/**
 * Maps every legacy class that corresponds to a registry part to that part's attribute
 * selector. The legacy root class (`ls-<scope>`, local `root`) maps to the scope's `root` part.
 * Legacy classes with no part (removed or renamed) are left out. Throws if one legacy class
 * (or keyframes name) would map to two different targets.
 */
export function toSelectorRenameMap(legacy: LegacyClassMaps, registry: Registry, options: RenameMapOptions = {}): Record<string, string> {
    const byExportName = new Map(Object.keys(registry.scopes).map(scope => [exportName(scope), scope]))
    const out: Record<string, string> = {}
    const put = (from: string, to: string) => {
        if (hasOwn(out, from) && out[from] !== to) throw new Error(`libstylist: legacy ${from} maps to both ${out[from]} and ${to}`)
        out[from] = to
    }
    for (const [key, classes] of Object.entries(legacy)) {
        const scope = hasOwn(registry.scopes, key) ? key : byExportName.get(key)
        if (scope === undefined) continue
        const parts = registry.scopes[scope].parts
        for (const [local, legacyClass] of Object.entries(classes)) {
            if (hasOwn(parts, local)) put(`.${legacyClass}`, partSelector(parts[local]))
        }
    }
    const { keyframes } = options
    if (keyframes) {
        for (const [scope, info] of Object.entries(registry.scopes)) {
            const legacyNames = keyframes === true ? Object.fromEntries(Object.keys(info.keyframes).map(k => [k, k])) : hasOwn(keyframes, scope) ? keyframes[scope] : {}
            for (const [legacyName, local] of Object.entries(legacyNames)) {
                if (hasOwn(info.keyframes, local)) put(`@keyframes ${legacyName}`, info.keyframes[local])
            }
        }
    }
    return sortKeys(out)
}
