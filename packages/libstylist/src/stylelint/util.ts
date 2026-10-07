// Small helpers shared by the libstylist stylelint rules.
import { basename } from "node:path"

import type { AtRule, Node as PostcssNode, Root } from "postcss"
import type { PostcssResult } from "stylelint"

import { parseStylistDirective, type StylistDirective } from "./directives.js"

/** Plugin namespace: every rule is `libstylist/<name>`. */
export const PLUGIN_NAMESPACE = "libstylist" as const

/** Prefix assumed when no `prefix` option is given (the design system's). */
export const DEFAULT_PREFIX = "elo"

/**
 * Name of the directive at-rule. The PostCSS plugin matches it exactly (`@STYLIST` is not a
 * directive there), so the rules do too and `libstylist/directive-syntax` flags other spellings.
 */
export const DIRECTIVE_AT_RULE = "stylist"

/** The documentation anchor for a rule, used as stylelint `meta.url`. */
export const ruleUrl = (name: string): string =>
    `https://github.com/livesession/libstylist/blob/master/packages/libstylist/docs/RULES.md#${PLUGIN_NAMESPACE}${name}`

export const isString = (v: unknown): v is string => typeof v === "string"
export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean"
export const isRegExp = (v: unknown): v is RegExp => v instanceof RegExp

/** Normalizes a `string | string[]` option into an array. */
export const toArray = <T>(v: T | readonly T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? [...v] : [v as T])

/** The file a stylesheet came from, when stylelint knows it. */
export const sheetFile = (root: Root): string | undefined => root.source?.input.file

/** True for an `@stylist` statement the build treats as a directive: top level, spelled exactly. */
export const isTopLevelDirective = (node: PostcssNode): node is AtRule =>
    node.type === "atrule" && (node as AtRule).name === DIRECTIVE_AT_RULE && node.parent?.type === "root"

/**
 * The `@stylist override` of an override sheet (SPEC §9.2) — the first top-level, exactly spelled one
 * that parses — or null for a package sheet. What the sheet restyles decides how its `.root` reads.
 */
export function sheetOverride(root: Root): Extract<StylistDirective, { kind: "override" }> | null {
    let found: Extract<StylistDirective, { kind: "override" }> | null = null
    root.each((node) => {
        if (found || !isTopLevelDirective(node)) return
        const parsed = parseStylistDirective(node.params)
        if (parsed.ok && parsed.directive.kind === "override") found = parsed.directive
    })
    return found
}

/** True when the sheet has an override sheet's directive (`@stylist override` or `@stylist reset`) at its top level. */
export const isOverrideSheetRoot = (root: Root): boolean => (root.nodes ?? []).some((node) => isTopLevelDirective(node) && /^\s*(?:override|reset)(?:\s|$)/.test(node.params))

/** The sheet's scope id: an `@stylist scope` pin, else the basename without `.css` (SPEC §1). */
export function sheetScope(root: Root): string | null {
    let pinned: string | null = null
    root.each((node) => {
        if (pinned || !isTopLevelDirective(node)) return
        const parsed = parseStylistDirective(node.params)
        if (parsed.ok && parsed.directive.kind === "scope") pinned = parsed.directive.id
    })
    if (pinned) return pinned
    const file = sheetFile(root)
    return file ? basename(file).replace(/\.css$/i, "") : null
}

/**
 * True when a sheet matches an entry: a regex tested against the path, or a string equal to the
 * sheet's scope id (`scope`, e.g. an `@stylist scope` pin), its basename, its basename without
 * `.css`, or a trailing path segment run (`components/color.css`).
 */
export function matchesSheet(file: string | undefined, entries: ReadonlyArray<string | RegExp>, scope?: string | null): boolean {
    const normalized = file?.replace(/\\/g, "/")
    const name = normalized === undefined ? undefined : basename(normalized)
    const stem = name?.replace(/\.css$/i, "")
    return entries.some((entry) => {
        if (typeof entry !== "string") return normalized !== undefined && entry.test(normalized)
        if (scope && entry === scope) return true
        if (normalized === undefined) return false
        return entry === stem || entry === name || normalized === entry || normalized.endsWith(`/${entry.replace(/^\.?\//, "")}`)
    })
}

const parseErrorsSeen = new WeakMap<PostcssResult, Map<PostcssNode, Set<string>>>()

/**
 * Reports an unparseable selector the way stylelint's core rules do (a `parseError` warning,
 * which fails the run), at most once per node and message across all libstylist rules.
 */
export function reportParseError(result: PostcssResult, node: PostcssNode, text: string): void {
    let byNode = parseErrorsSeen.get(result)
    if (!byNode) parseErrorsSeen.set(result, (byNode = new Map()))
    let seen = byNode.get(node)
    if (!seen) byNode.set(node, (seen = new Set()))
    if (seen.has(text)) return
    seen.add(text)
    result.warn(text, { node, stylelintType: "parseError" })
}
