// Options of the Babel transform and their per-file resolution (SPEC §5, §8).
import { normalizePackageConfig, resolvePackageConfig, type PackageStylistConfig } from "../conventions/index.js"
import type { PartMapModules } from "../core/index.js"

/** The subset of `stylist-registry.json` (SPEC §7) the transform resolves part maps and validates parts against. */
export interface StylistPartRegistry {
    scopes: Record<string, { namespace: string; group?: string; parts: Record<string, string> }>
}

export type DevMode = "runtime" | boolean

export interface LibstylistBabelOptions {
    /** Project prefix (`elo`, `app`). Defaults to the nearest package.json `libstylist` field. */
    prefix?: string
    /**
     * Hash namespace (`core`, `player`, …). Defaults to the file's namespace in its package config (the
     * `namespaces` directory it sits in, else the package's), then `core` when only a prefix is given.
     */
    namespace?: string
    /** Tag segment (only carried through; tags are authored explicitly). */
    segment?: string
    /** Namespace word (only carried through; tags are authored explicitly). */
    word?: string
    /** Part hash length. @default 6 */
    hashLength?: number
    /**
     * Dev annotations (SPEC §5.5): `"runtime"` appends a `process.env.NODE_ENV` guarded spread, `true` plain
     * attributes, `false` nothing.
     * @default "runtime"
     */
    dev?: DevMode
    /** Root that `data-file-source` paths are relative to. Defaults to the repo root above each file. */
    sourceRoot?: string
    /** Module the runtime helpers are imported from. @default "@livesession/libstylist/runtime" */
    runtimeModule?: string
    /**
     * Registry the part maps are resolved against (`cn.icon` → scope `alert`, for `_cxpart` labels)
     * and part-map members validated with — an object, or a function called once per file.
     */
    registry?: StylistPartRegistry | (() => StylistPartRegistry | null | undefined) | null
    /**
     * css group → the module its part map is imported from (`{ components: "@livesession/eloquentui-css" }`).
     * Unset: any package import whose name matches a registry scope's export name is a part map.
     */
    partMaps?: PartMapModules | null
    /** What a part-map member naming no part of its sheet does when a registry is given. @default "error" */
    onUnknownPart?: "error" | "warn"
}

export const DEFAULT_RUNTIME_MODULE = "@livesession/libstylist/runtime"

/**
 * The package config for one file: explicit options win, then the nearest package.json `libstylist`
 * field — the file's effective config, its `namespaces` directory's when it sits in one. Returns null
 * when neither supplies a prefix (the file is outside every configured package).
 * Throws when a `prefix` option contradicts the file's package and no `namespace` option says which
 * namespace to hash with — namespaces are per prefix, so the package's one can't be borrowed.
 */
export function resolveFileConfig(options: LibstylistBabelOptions, filename: string | undefined): PackageStylistConfig | null {
    const explicit = options.prefix !== undefined && options.namespace !== undefined
    const pkg = filename && !explicit ? resolvePackageConfig(filename)?.config : undefined
    const prefix = options.prefix ?? pkg?.prefix
    if (!prefix) return null
    if (pkg && pkg.prefix !== prefix && options.namespace === undefined) {
        // a namespace belongs to its prefix: mixing them would hash parts no stylesheet was compiled with
        throw new Error(
            `libstylist: ${filename} belongs to a package configured with prefix "${pkg.prefix}" (namespace "${pkg.namespace}") but the transform was given prefix "${prefix}" — pass a namespace too, or drop the prefix option`,
        )
    }
    const namespace = options.namespace ?? pkg?.namespace ?? "core"
    // segment/word follow the namespace they were derived for; re-derive them when the namespace is overridden.
    const inherit = options.namespace === undefined || options.namespace === pkg?.namespace
    return normalizePackageConfig(
        {
            prefix,
            namespace,
            segment: options.segment ?? (inherit ? pkg?.segment : undefined),
            word: options.word ?? (inherit ? pkg?.word : undefined),
            hashLength: options.hashLength ?? pkg?.hashLength,
        },
        filename ? `libstylist config for ${filename}` : "libstylist babel options",
    )
}

/** Evaluates the `registry` option (object or thunk). */
export function loadRegistry(option: LibstylistBabelOptions["registry"]): StylistPartRegistry | null {
    if (!option) return null
    const reg = typeof option === "function" ? option() : option
    return reg ?? null
}
