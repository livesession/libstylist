// `stylist-registry.json` (SPEC §7).

export const REGISTRY_VERSION = 1

export interface RegistryRoot {
    /** Dotted export path (`Modal.Header`). */
    component: string
    /** Local class bound to the identity element. */
    local: string
    tag: string
    display?: string
}

export interface RegistryScope {
    namespace: string
    group: string
    file: string
    roots: RegistryRoot[]
    /** part → part attribute, sorted by part. */
    parts: Record<string, string>
    /** `:global()` hooks still in the sheet (legacy). */
    globals: string[]
    /** local keyframes name → emitted name. */
    keyframes: Record<string, string>
}

export interface Registry {
    version: typeof REGISTRY_VERSION
    prefix: string
    hash: { version: number; length: number }
    /** Sorted by scope. */
    scopes: Record<string, RegistryScope>
}

/** A css build group's namespace and tag naming (SPEC §8 defaults apply to omitted fields). */
export interface RegistryGroup {
    namespace: string
    segment?: string
    word?: string
}

export type RegistryErrorCode =
    | "unknown-group"
    | "invalid-sheet"
    | "invalid-directive"
    | "duplicate-scope"
    | "hash-collision"
    | "duplicate-tag"
    | "duplicate-export"
    | "namespace-compound"
    | "unresolved-ref"
    // override sheets (SPEC §9)
    | "invalid-override"
    | "unresolved-package"
    | "unknown-target"
    | "unknown-part"
    | "unknown-within"
    | "duplicate-override"
    | "shared-reset"
    | "reset-within"
    | "keyframes-clash"
    // a workspace's override sheets (css.overrides)
    | "design-system"
    | "overrides-index"

export interface RegistryError {
    code: RegistryErrorCode
    message: string
    /** Every file involved (both sides of a collision or duplicate). */
    files: string[]
}

/**
 * True when two dotted component paths name the same identity element: a trailing `Root` member
 * collapses into its parent (SPEC §2.1), so `ListCollection` and `ListCollection.Root` are one.
 */
export const sameComponent = (a: string, b: string): boolean => a.replace(/\.Root$/, "") === b.replace(/\.Root$/, "")

/** Own-property lookup that is safe for keys like `constructor`. */
export const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key)

/** A copy of `obj` with keys in code-unit order (stable JSON and lock output). */
export function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
    const out: Record<string, T> = {}
    for (const key of Object.keys(obj).sort()) out[key] = obj[key]
    return out
}
