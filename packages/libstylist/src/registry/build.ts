// Pass 1 of the css build: every sheet → one registry (SPEC §7), with the build errors of SPEC
// §2.1 and §3.1 — duplicate scopes, hash collisions, duplicate tags, namespace compounds,
// invalid directives, unresolved :cx()/:component() references, and part-map export names
// that two scopes of one group would share.
import { DEFAULT_HASH_LENGTH, HASH_VERSION, PART_RE, PREFIX_RE, normalizePackageConfig, type PackageStylistConfig } from "../conventions/index.js"
import { partAttr } from "../hash/index.js"
import { splitPath, tagName } from "../naming/index.js"
import { collectSheet, type SheetInfo } from "../postcss/collect.js"
import { keyframesName } from "../postcss/keyframes.js"
import { exportName } from "./modules.js"
import { REGISTRY_VERSION, hasOwn, sameComponent, sortKeys, type Registry, type RegistryError, type RegistryGroup, type RegistryRoot, type RegistryScope } from "./types.js"

export interface RegistrySheet {
    /** Path recorded in the registry and in errors (repo- or package-relative). */
    file: string
    group: string
    css: string
    /** Default scope when the sheet doesn't pin one; its basename otherwise. */
    scope?: string
}

export interface BuildRegistryInput {
    prefix: string
    hashLength?: number
    /** css build group → namespace and naming (`components` → `{ namespace: "core" }`). */
    groups: Record<string, RegistryGroup>
    sheets: readonly RegistrySheet[]
}

export interface BuildRegistryResult {
    registry: Registry
    errors: RegistryError[]
}

/** The numeric hash version recorded in the registry (`"v1"` → 1). */
export const HASH_VERSION_NUMBER = Number(HASH_VERSION.replace(/^v/, ""))

/**
 * Normalizes the group table into per-group package configs. Throws on an invalid prefix,
 * namespace or hash length, and when two groups give one namespace different naming.
 */
export function resolveGroups(prefix: string, groups: Record<string, RegistryGroup>, hashLength = DEFAULT_HASH_LENGTH): Map<string, PackageStylistConfig> {
    if (!PREFIX_RE.test(prefix)) throw new Error(`libstylist registry: invalid prefix "${prefix}"`)
    const out = new Map<string, PackageStylistConfig>()
    const byNamespace = new Map<string, { group: string; config: PackageStylistConfig }>()
    for (const [group, raw] of Object.entries(groups)) {
        const config = normalizePackageConfig({ prefix, hashLength, namespace: raw.namespace, segment: raw.segment, word: raw.word }, `libstylist registry group "${group}"`)
        const prev = byNamespace.get(config.namespace)
        if (prev && (prev.config.segment !== config.segment || prev.config.word !== config.word)) {
            throw new Error(`libstylist registry: groups "${prev.group}" and "${group}" share namespace "${config.namespace}" but name tags differently`)
        }
        byNamespace.set(config.namespace, { group, config })
        out.set(group, config)
    }
    return out
}

/** Builds the registry from source sheets. Sheet-level problems are reported in `errors`; bad config throws. */
export function buildRegistry(input: BuildRegistryInput): BuildRegistryResult {
    const { prefix } = input
    const hashLength = input.hashLength ?? DEFAULT_HASH_LENGTH
    const configs = resolveGroups(prefix, input.groups, hashLength)
    const errors: RegistryError[] = []
    const report = (code: RegistryError["code"], message: string, ...files: string[]) => errors.push({ code, message, files: [...new Set(files)] })

    // collect, reject duplicate scopes (the first sheet keeps the scope)
    const accepted: Array<{ info: SheetInfo; config: PackageStylistConfig }> = []
    const scopeOwners = new Map<string, string>()
    for (const sheet of input.sheets) {
        const config = configs.get(sheet.group)
        if (!config) {
            report("unknown-group", `${sheet.file}: group "${sheet.group}" is not configured`, sheet.file)
            continue
        }
        const info = collectSheet(sheet.css, { file: sheet.file, group: sheet.group, scope: sheet.scope })
        for (const e of info.errors) report(e.kind === "directive" ? "invalid-directive" : "invalid-sheet", `${sheet.file}${e.line ? `:${e.line}` : ""}: ${e.message}`, sheet.file)
        if (!PART_RE.test(info.scope)) continue
        const owner = scopeOwners.get(info.scope)
        if (owner !== undefined) {
            report("duplicate-scope", `scope "${info.scope}" is declared by ${owner} and ${sheet.file} — rename one sheet or pin a scope with @stylist scope <id>;`, owner, sheet.file)
            continue
        }
        scopeOwners.set(info.scope, sheet.file)
        accepted.push({ info, config })
    }

    // parts, roots, keyframes
    const segments = new Set([...configs.values()].map(c => c.segment).filter(Boolean))
    const attrOwners = new Map<string, { key: string; file: string }>()
    const tagOwners = new Map<string, { key: string; file: string }>()
    const scopes: Record<string, RegistryScope> = {}
    for (const { info, config } of accepted) {
        const parts: Record<string, string> = {}
        for (const part of [...new Set([...info.classes, ...info.roots.map(r => r.local)])].sort()) {
            const attr = partAttr({ prefix, namespace: config.namespace, scope: info.scope, part }, hashLength)
            parts[part] = attr
            const key = `${config.namespace}/${info.scope}:${part}`
            const owner = attrOwners.get(attr)
            if (owner) report("hash-collision", `${owner.key} (${owner.file}) and ${key} (${info.file}) both hash to ${attr} — rename one of the two parts`, owner.file, info.file)
            else attrOwners.set(attr, { key, file: info.file })
        }

        const roots: RegistryRoot[] = []
        for (const r of info.roots) {
            const where = `${info.file}${r.line ? `:${r.line}` : ""}`
            let tag: string
            try {
                tag = tagName(config, splitPath(r.component))
            } catch (err) {
                report("invalid-directive", `${where}: ${(err as Error).message}`, info.file)
                continue
            }
            const pieces = tag.slice(prefix.length + 1).split("-")
            if (!config.segment && pieces.length > 1 && segments.has(pieces[0])) {
                report("namespace-compound", `${where}: ${r.component} → <${tag}> reads as a tag of the "${pieces[0]}" segment — rename the compound's parent`, info.file)
            }
            const key = `${config.namespace}/${r.component}`
            const owner = tagOwners.get(tag)
            if (owner) report("duplicate-tag", `${owner.key} (${owner.file}) and ${key} (${info.file}) both map to <${tag}>`, owner.file, info.file)
            else tagOwners.set(tag, { key, file: info.file })
            roots.push({ component: r.component, local: r.local, tag, ...(r.display ? { display: r.display } : {}) })
        }

        const keyframes: Record<string, string> = {}
        for (const local of info.keyframes) keyframes[local] = keyframesName(prefix, info.scope, local)

        scopes[info.scope] = { namespace: config.namespace, group: info.group, file: info.file, roots, parts, globals: info.globals, keyframes }
    }

    // part-map export names (one module per group)
    const exportOwners = new Map<string, { scope: string; file: string }>()
    for (const { info } of accepted) {
        const key = `${info.group}\u0000${exportName(info.scope)}`
        const owner = exportOwners.get(key)
        if (owner) report("duplicate-export", `scopes "${owner.scope}" (${owner.file}) and "${info.scope}" (${info.file}) both export as "${exportName(info.scope)}" from the ${info.group} part map — rename one sheet or pin a scope`, owner.file, info.file)
        else exportOwners.set(key, { scope: info.scope, file: info.file })
    }

    // cross-sheet references
    for (const { info, config } of accepted) {
        for (const ref of info.cx) {
            if (!hasOwn(scopes, ref.scope) || !hasOwn(scopes[ref.scope].parts, ref.part)) {
                report("unresolved-ref", `${info.file}${ref.line ? `:${ref.line}` : ""}: :cx(${ref.scope}:${ref.part}) names no registered part`, info.file)
            }
        }
        for (const ref of info.components) {
            const namespace = ref.namespace ?? config.namespace
            const found = Object.values(scopes).some(s => s.namespace === namespace && s.roots.some(r => sameComponent(r.component, ref.path)))
            if (!found) {
                report("unresolved-ref", `${info.file}${ref.line ? `:${ref.line}` : ""}: :component(${ref.namespace ? `${ref.namespace}/` : ""}${ref.path}) names no @stylist root in namespace "${namespace}"`, info.file)
            }
        }
    }

    const registry: Registry = {
        version: REGISTRY_VERSION,
        prefix,
        hash: { version: HASH_VERSION_NUMBER, length: hashLength },
        scopes: sortKeys(scopes),
    }
    return { registry, errors }
}
