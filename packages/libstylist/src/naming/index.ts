// Identity naming (SPEC §2): custom tags and marker attributes derived from export paths.
import { GENERIC_ROOT_TAGS, TAG_RE, type PackageStylistConfig } from "../conventions/index.js"

type NamingConfig = Pick<PackageStylistConfig, "prefix" | "segment" | "word">

/** Drops a leading namespace word followed by an uppercase letter (`PlayerTopBar` → `TopBar`). */
export function stripNamespaceWord(name: string, word: string): string {
    if (!word || !name.startsWith(word)) return name
    const rest = name.slice(word.length)
    return rest.length > 0 && /^[A-Z]/.test(rest) ? rest : name
}

/**
 * The custom tag for an export path, e.g. `["Modal", "Header"]` → `elo-modal-header`,
 * `["PlayerTopBar", "Url"]` (player) → `elo-player-topbar-url`, `["ListCollection", "Root"]` (gram)
 * → `elo-gram-listcollection`.
 */
export function tagName(config: NamingConfig, path: readonly string[]): string {
    if (path.length === 0) throw new Error("tagName: empty export path")
    const members = path.slice(1)
    if (members.length > 0 && members[members.length - 1] === "Root") members.pop()
    const pieces = [config.prefix]
    if (config.segment) pieces.push(config.segment)
    pieces.push(stripNamespaceWord(path[0], config.word).toLowerCase())
    for (const m of members) pieces.push(m.toLowerCase())
    const tag = pieces.join("-")
    if (!TAG_RE.test(tag)) throw new Error(`tagName: "${tag}" (from ${path.join(".")}) is not a valid custom-element name`)
    return tag
}

/** The marker attribute for a semantic root — the same string as the tag (SPEC §2.2). */
export const markerAttr = (tag: string): string => tag

/** True when a lowercase element name is a custom element (contains a hyphen). */
export const isCustomElementName = (name: string): boolean => /^[a-z][a-z0-9]*-/.test(name)

/** True when a root on this tag must be expressed as a custom tag rather than a marker. */
export const isGenericTag = (name: string): boolean => GENERIC_ROOT_TAGS.includes(name)

/** True when `name` looks like an identity tag/marker of `prefix` (`elo-…`). */
export const isIdentityName = (name: string, prefix: string): boolean => name.startsWith(`${prefix}-`) && TAG_RE.test(name)

/** Splits a dotted component path (`Modal.Header`) into its members. */
export const splitPath = (path: string): string[] => path.split(".").filter(Boolean)
