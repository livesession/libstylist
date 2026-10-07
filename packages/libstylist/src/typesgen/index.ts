// JSX tag types per package (`libstylist gen-types`): the generated
// `types/stylist-tags.gen.d.ts` and the hand-kept `types/stylist.d.ts` stub. See jsx/index.d.ts
// for why custom tags are declared as explicit keys rather than one template-literal key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

import { DEFAULT_SOURCES, PREFIX_RE, declaredSources, resolvePackageConfig } from "../conventions/index.js"
import { renderTagTypes, stylistTypesStub, type RenderTypesOptions, type StubOptions } from "./emit.js"
import { scanCustomTags } from "./scan.js"

export { JSX_TYPES_MODULE, normalizeTags, renderTagTypes, stylistTypesStub, type RenderTypesOptions, type StubOptions } from "./emit.js"
export { collectJsxTags, jsxTagNames, listSourceFiles, scanCustomTags } from "./scan.js"

/** Package-relative path of the generated tag types. */
export const TAG_TYPES_FILE = "types/stylist-tags.gen.d.ts"
/** Package-relative path of the hand-kept stub that loads the JSX typings. */
export const STUB_TYPES_FILE = "types/stylist.d.ts"

export interface GenTagTypesOptions extends RenderTypesOptions {
    /** Package root. Its source directories (`sources`) are scanned for JSX custom tags. */
    packageDir: string
    /**
     * The directories scanned for JSX custom tags, relative to `packageDir` (or absolute): a config
     * package's `sources`. Default: the package's `package.json` `libstylist.sources`, else `["src"]`.
     */
    sources?: readonly string[]
    /** Tag prefix (`elo`). Defaults to the `libstylist.prefix` in the nearest package.json. */
    prefix?: string
    /** Extra tags to declare that the scan can't see, e.g. tags only held in variables. */
    tags?: readonly string[]
}

export interface TagTypesFileOptions extends GenTagTypesOptions {
    /** Target file. @default "<packageDir>/types/stylist-tags.gen.d.ts" */
    file?: string
}

export interface TagTypesCheck {
    /** True when the file on disk equals the generated content (line endings aside). */
    ok: boolean
    /** Absolute path of the checked file. */
    file: string
    /** Freshly generated content. */
    expected: string
    /** Content on disk, or `null` when the file is missing. */
    actual: string | null
}

/**
 * Resolves the tag prefix for a package: the explicit `prefix`, or `libstylist.prefix` from the
 * nearest configured package.json at or above `packageDir`. Throws when neither yields a valid prefix.
 */
export function resolveTypesPrefix(packageDir: string, prefix?: string): string {
    const resolved = prefix ?? resolvePackageConfig(join(resolve(packageDir), "package.json"))?.config.prefix
    if (!resolved) throw new Error(`libstylist gen-types: no prefix given and no "libstylist" config with a namespace found for ${packageDir}`)
    if (!PREFIX_RE.test(resolved)) throw new Error(`libstylist gen-types: prefix "${resolved}" must match ${PREFIX_RE}`)
    return resolved
}

/**
 * The directories `gen-types` scans in a package: the `sources` given, else those its `package.json`
 * declares (`libstylist.sources`), else `src` — relative to `packageDir` (or absolute).
 */
export function resolveTypesSources(packageDir: string, sources?: readonly string[]): readonly string[] {
    return sources ?? declaredSources(packageDir) ?? DEFAULT_SOURCES
}

/**
 * Returns the content of `types/stylist-tags.gen.d.ts` for a package. It scans the package's source
 * directories (`sources`: default the `package.json`'s `libstylist.sources`, else `src`) for JSX custom
 * tags `<prefix-…>` in `**\/*.{tsx,ts,jsx}` and merges them with the extra `tags`, which must be
 * `<prefix>-*` tags too. The keys are sorted, typed `StylistHostProps`, and topped with a do-not-edit
 * header naming the directories scanned.
 */
export function genTagTypes(options: GenTagTypesOptions): string {
    const prefix = resolveTypesPrefix(options.packageDir, options.prefix)
    const sources = resolveTypesSources(options.packageDir, options.sources)
    const rel = sources.map((dir) => relative(resolve(options.packageDir), resolve(options.packageDir, dir)).split(sep).join("/") || ".")
    return renderTagTypes(prefix, [...scanCustomTags(options.packageDir, prefix, sources), ...(options.tags ?? [])], { ...options, sources: rel })
}

const targetFile = (options: TagTypesFileOptions): string => resolve(options.file ?? join(options.packageDir, TAG_TYPES_FILE))

/**
 * Compares the generated tag types with the file on disk (`--check`). Line endings are
 * normalized first, so a CRLF checkout doesn't count as stale.
 */
export function checkTagTypes(options: TagTypesFileOptions): TagTypesCheck {
    const file = targetFile(options)
    const expected = genTagTypes(options)
    const actual = existsSync(file) ? readFileSync(file, "utf8") : null
    return { ok: actual !== null && actual.replace(/\r\n/g, "\n") === expected, file, expected, actual }
}

/** Writes the generated tag types when they changed. Returns the file and whether it was (re)written. */
export function writeTagTypes(options: TagTypesFileOptions): { file: string; changed: boolean } {
    const check = checkTagTypes(options)
    if (check.ok) return { file: check.file, changed: false }
    mkdirSync(dirname(check.file), { recursive: true })
    writeFileSync(check.file, check.expected)
    return { file: check.file, changed: true }
}

/**
 * Creates `types/stylist.d.ts` for a package when it's missing. The stub is hand-kept, so an
 * existing file is left alone unless `force` is set.
 */
export function writeTypesStub(options: { packageDir: string; prefix?: string; force?: boolean } & StubOptions): { file: string; written: boolean } {
    const file = resolve(options.packageDir, STUB_TYPES_FILE)
    if (existsSync(file) && !options.force) return { file, written: false }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, stylistTypesStub(resolveTypesPrefix(options.packageDir, options.prefix), options))
    return { file, written: true }
}
