// Registry-backed options for pass 2 of the css build (the plugin), so :cx()/:component()
// resolve against real parts and roots and root tags use the same naming as the registry.
import type { StylistNaming, StylistOptions } from "../postcss/plugin.js"
import { resolveGroups } from "./build.js"
import { hasOwn, sameComponent, type Registry, type RegistryGroup } from "./types.js"

export interface RegistryResolvers {
    resolvePart: (scope: string, part: string) => string | undefined
    resolveTag: (namespace: string | null, path: string) => string | undefined
}

/**
 * Resolvers for a sheet in `namespace`: `:cx(scope:part)` → attribute, `:component([ns/]Path)` →
 * tag (`Path` and `Path.Root` resolve alike).
 */
export function createResolvers(registry: Registry, namespace: string): RegistryResolvers {
    return {
        resolvePart(scope, part) {
            if (!hasOwn(registry.scopes, scope)) return undefined
            const parts = registry.scopes[scope].parts
            return hasOwn(parts, part) ? parts[part] : undefined
        },
        resolveTag(ns, path) {
            const target = ns ?? namespace
            for (const info of Object.values(registry.scopes)) {
                if (info.namespace !== target) continue
                const root = info.roots.find(r => sameComponent(r.component, path))
                if (root) return root.tag
            }
            return undefined
        },
    }
}

/** Tag naming per namespace from the registry's group table (SPEC §8 defaults otherwise). */
export function namingFromGroups(prefix: string, groups: Record<string, RegistryGroup>): (namespace: string) => StylistNaming {
    const byNamespace = new Map<string, StylistNaming>()
    for (const config of resolveGroups(prefix, groups).values()) byNamespace.set(config.namespace, { segment: config.segment, word: config.word })
    return namespace => {
        const hit = byNamespace.get(namespace)
        if (!hit) throw new Error(`libstylist: namespace "${namespace}" is not configured in the group table`)
        return hit
    }
}

/**
 * Complete plugin options for one registered scope: prefix, namespace, hash length, naming and
 * registry resolvers. `groups` must be the table the registry was built with.
 */
export function stylistOptions(registry: Registry, scope: string, groups: Record<string, RegistryGroup>): StylistOptions {
    if (!hasOwn(registry.scopes, scope)) throw new Error(`libstylist: scope "${scope}" is not in the registry`)
    const { namespace } = registry.scopes[scope]
    return {
        prefix: registry.prefix,
        namespace,
        scope,
        hashLength: registry.hash.length,
        naming: namingFromGroups(registry.prefix, groups),
        ...createResolvers(registry, namespace),
    }
}
