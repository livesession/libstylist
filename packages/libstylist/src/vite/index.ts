// `@livesession/libstylist/vite` — runs the libstylist transform before any JSX compilation and serves the runtime;
// `stylistWorkspace()` (./workspace.ts) adds a workspace of app packages' sheets on top.
import { existsSync, readFileSync, statSync } from "node:fs"

import { transformAsync, type PluginItem } from "@babel/core"
import type { Plugin, Rollup } from "vite"

import { DEFAULT_RUNTIME_MODULE, type LibstylistBabelOptions, type StylistPartRegistry } from "../babel/options.js"
import { libstylistBabel, type LibstylistFileMetadata } from "../babel/plugin.js"
import { clearConventionsCache, resolvePackageConfig } from "../conventions/index.js"
import { runtimeSource } from "./runtime-source.js"

/** Import id of the runtime helpers inside Vite builds; bundled, so consumers never install libstylist. */
export const VIRTUAL_RUNTIME_ID = "virtual:libstylist/runtime"
const RESOLVED_RUNTIME_ID = `\0${VIRTUAL_RUNTIME_ID}`
/** Ids served by the virtual runtime: author imports of the package subpath share the one bundled copy. */
const RUNTIME_IDS = new Set([VIRTUAL_RUNTIME_ID, DEFAULT_RUNTIME_MODULE])

export interface StylistViteOptions extends Omit<LibstylistBabelOptions, "registry"> {
    /**
     * Registry to validate parts against: an object, a thunk, or the path of a `stylist-registry.json`
     * (re-read when it changes and added to Vite's watch list).
     */
    registry?: LibstylistBabelOptions["registry"] | string
    /** Only transform module ids matching this pattern (on top of the extension and node_modules checks). */
    include?: RegExp
    /** Never transform module ids matching this pattern. */
    exclude?: RegExp
}

const SOURCE_EXT = /\.(tsx|jsx|ts|js)$/
const NODE_MODULES = /[\\/]node_modules[\\/]/
/** The removed `cx`/slot attribute syntax — still transformed so the build reports it. */
const CX_ATTR = /\bcx\s*=|[a-z0-9]Cx\s*=/
/** An import of the runtime: its cx() calls need their data literals branded. */
const RUNTIME_IMPORT = /libstylist\/runtime/

/** Babel parser plugins per extension — `.ts` stays JSX-free so `<T>value` casts keep parsing. */
function parserPlugins(ext: string): Array<"jsx" | "typescript"> {
    if (ext === "tsx") return ["jsx", "typescript"]
    if (ext === "ts") return ["typescript"]
    return ["jsx"]
}

/** Cheap text check: can this module contain anything the transform touches? */
export function mayNeedTransform(code: string, prefix: string | undefined, runtimeModule?: string): boolean {
    return RUNTIME_IMPORT.test(code) || (!!runtimeModule && code.includes(runtimeModule)) || CX_ATTR.test(code) || (!!prefix && code.includes(`${prefix}-`))
}

/** A registry thunk over a JSON file, re-read whenever its mtime changes; null while the file is missing. */
function registryFile(path: string): () => StylistPartRegistry | null {
    let mtime = Number.NaN
    let value: StylistPartRegistry | null = null
    return () => {
        const m = existsSync(path) ? statSync(path).mtimeMs : -1
        if (m !== mtime) {
            // parse before recording the mtime: a registry caught mid-write throws now and is re-read next time
            value = m < 0 ? null : (JSON.parse(readFileSync(path, "utf8")) as StylistPartRegistry)
            mtime = m
        }
        return value
    }
}

type External = NonNullable<Rollup.InputOptions["external"]>
type ExternalFn = (source: string, importer: string | undefined, isResolved: boolean) => boolean | null | undefined | void

/**
 * Wraps Rollup's `external` so the runtime ids always resolve through this plugin. Rollup consults `external`
 * before any `resolveId` hook, so a package config externalizing `/^@livesession\//` would otherwise leave
 * author imports of `@livesession/libstylist/runtime` in the dist — and make consumers install libstylist.
 */
export function bundleRuntime(external: External): ExternalFn {
    const test: ExternalFn =
        typeof external === "function"
            ? external
            : (source) => (Array.isArray(external) ? external : [external]).some((e) => (typeof e === "string" ? e === source : e.test(source)))
    return (source, importer, isResolved) => (RUNTIME_IDS.has(source) || source === RESOLVED_RUNTIME_ID ? false : test(source, importer, isResolved))
}

const cleanId = (id: string): string => id.replace(/[?#].*$/, "")
const isPackageJson = (file: string): boolean => /(^|[\\/])package\.json$/.test(file)

/**
 * The libstylist Vite plugin (`enforce: "pre"`): transforms `.tsx`/`.jsx`/`.ts`/`.js` sources outside
 * node_modules with the libstylist Babel plugin (per-file package config, output stays TSX/JSX for
 * esbuild or plugin-react), and serves `virtual:libstylist/runtime` — the default runtime module here,
 * also answering author imports of `@livesession/libstylist/runtime` (`cx`, `legacy`) and keeping
 * both ids out of Rollup's `external` — so library builds bundle one copy of the helpers and consumers never
 * install libstylist.
 */
export function stylist(options: StylistViteOptions = {}): Plugin {
    const { registry, include, exclude, ...rest } = options
    const registryPath = typeof registry === "string" ? registry : null
    const babelOptions: LibstylistBabelOptions = {
        ...rest,
        runtimeModule: options.runtimeModule ?? VIRTUAL_RUNTIME_ID,
        registry: registryPath ? registryFile(registryPath) : (registry as LibstylistBabelOptions["registry"]),
    }
    const plugin: PluginItem = [libstylistBabel, babelOptions]

    return {
        name: "libstylist",
        enforce: "pre",

        options(input) {
            return input.external ? { ...input, external: bundleRuntime(input.external) } : null
        },

        configureServer(server) {
            // per-directory package configs are cached; a package.json added, edited or removed in dev re-resolves them
            const onFile = (file: string) => {
                if (isPackageJson(file)) clearConventionsCache()
            }
            for (const event of ["add", "change", "unlink"] as const) server.watcher.on(event, onFile)
        },

        watchChange(id) {
            if (isPackageJson(id)) clearConventionsCache()
        },

        resolveId(id) {
            return RUNTIME_IDS.has(id) ? RESOLVED_RUNTIME_ID : null
        },

        async load(id) {
            if (id !== RESOLVED_RUNTIME_ID) return null
            return { code: await runtimeSource(), moduleSideEffects: false }
        },

        async transform(code, id) {
            if (id.startsWith("\0")) return null
            const file = cleanId(id)
            if (NODE_MODULES.test(file)) return null
            const ext = SOURCE_EXT.exec(file)
            if (!ext) return null
            if (include && !include.test(file)) return null
            if (exclude?.test(file)) return null
            const prefix = options.prefix ?? resolvePackageConfig(file)?.config.prefix
            if (!mayNeedTransform(code, prefix, babelOptions.runtimeModule)) return null
            if (registryPath) this.addWatchFile(registryPath)

            const result = await transformAsync(code, {
                filename: file,
                sourceFileName: file,
                babelrc: false,
                configFile: false,
                sourceMaps: true,
                // Vite chains maps itself; an input map picked up from a sourceMappingURL comment would be applied twice.
                // Babel validates `false` as the off switch; @types/babel__core only declares the object form.
                inputSourceMap: false as unknown as undefined,
                ast: false,
                parserOpts: { plugins: parserPlugins(ext[1]) },
                plugins: [plugin],
            })
            const meta = (result?.metadata as { libstylist?: LibstylistFileMetadata } | undefined)?.libstylist
            if (!result?.code || !meta?.changed) return null
            return { code: result.code, map: result.map ?? null }
        },
    }
}

export default stylist

export { stylistWorkspace, type StylistWorkspaceOptions } from "./workspace.js"
