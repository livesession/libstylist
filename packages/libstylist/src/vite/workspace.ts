// `stylistWorkspace()` — the Vite plugins of a workspace of app packages (docs/CONFIG.md, "A workspace of
// app packages"): the libstylist JSX transform over the workspace packages' sources, and their sheets
// compiled at import time into their cascade layers against a registry kept in memory. In dev it keeps
// each package's generated part-map module (and the lock and the registry JSON) in step with the sheets
// and reloads the sheets that read a changed one. With override sheets (`css.overrides`, SPEC §9) it also
// compiles each into the overrides layer and strips the design system's stylesheets of the resets as the
// app bundles them, reloading them when the resets change.
import { readFileSync, realpathSync } from "node:fs"
import { relative, resolve, sep } from "node:path"

import type { Plugin, ViteDevServer } from "vite"

import { resetCss, touchedTargets, type ResetTarget } from "../postcss/reset.js"
import type { Registry } from "../registry/index.js"
import {
    buildWorkspace,
    changedScopes,
    compileSheet,
    dependentSheets,
    loadWorkspace,
    planWorkspaceOutputs,
    workspaceOverrideSheet,
    workspaceSheetOwner,
    workspaceSourcePattern,
    writeWorkspaceOutputs,
    type Workspace,
    type WorkspaceBuild,
    type WorkspacePackage,
} from "../workspace/build.js"
import { bundleLayerProblem, compileOverrideSheet, declaredLayerOrder, designSystemOf, overrideReports, resetKey, unbundledResets, type WorkspaceOverrides } from "../workspace/overrides.js"
import { stylist, type StylistViteOptions } from "./index.js"

export interface StylistWorkspaceOptions extends Pick<StylistViteOptions, "dev" | "sourceRoot" | "onUnknownPart" | "runtimeModule"> {
    /** The workspace's `libstylist.config.mjs`, relative to Vite's root; default: the one found upward from Vite's root. */
    config?: string
    /** Compile the workspace's sheets; `false` keeps the JSX transform only (Vitest, which loads no CSS). @default true */
    css?: boolean
    /**
     * Compile the override sheets (`css.overrides`) and strip the design system's stylesheets of their
     * resets. `false` leaves both alone — a build that bundles the design system without the app's
     * overrides (a Storybook of the app's packages). Needs `css`. @default true
     */
    overrides?: boolean
    /** In dev, rewrite a package's part-map module, the overrides module, the lock and the registry JSON when the sheets change (only files that differ). @default true */
    write?: boolean
    /** Module ids to transform besides the workspace packages' source directories (`sources`, default `src`): an app outside the workspace's packages. */
    include?: RegExp
    /** Module ids never transformed; anything under the workspace root's `3rd-party/` never is. */
    exclude?: RegExp
}

const PLUGIN_CSS = "libstylist:workspace-css"
const cleanId = (id: string): string => id.replace(/[?#].*$/, "")
const toPosix = (p: string) => p.split(sep).join("/")
/** CSS imports Vite serves as text or as a URL — not a stylesheet to compile. */
const RAW_CSS_QUERY = /[?&](?:raw|url)(?:[&=]|$)/
const realpath = (file: string): string => {
    try {
        return realpathSync(file)
    } catch {
        return file
    }
}

type Hook = ((this: unknown, ...args: unknown[]) => unknown) | { handler: (this: unknown, ...args: unknown[]) => unknown } | undefined

/** Calls a plugin hook (a function or `{ handler }`) of the inner `stylist()` plugin with the caller's context. */
function callHook(hook: unknown, ctx: unknown, ...args: unknown[]): unknown {
    const h = hook as Hook
    const fn = typeof h === "function" ? h : h?.handler
    return fn ? fn.apply(ctx, args) : null
}

/**
 * True when `file` sits under the workspace root's own `3rd-party/` (submodules, a linked design-system
 * dist). Only that directory: a package's `src/render/3rd-party/` is the package's own code.
 */
function inThirdParty(ws: Workspace, file: string): boolean {
    const rel = toPosix(relative(ws.root, file))
    return rel === "3rd-party" || rel.startsWith("3rd-party/")
}

/**
 * The libstylist Vite plugins of a workspace of app packages. Loads the workspace from the
 * `libstylist.config.mjs` found upward from Vite's root (or `config`) and returns:
 *
 * - `libstylist:workspace` — `stylist()` over the source directories of the workspace's packages
 *   (`sources`, default `src`; plus `include`; never `node_modules`, never the workspace root's
 *   `3rd-party/`), with the workspace's `css.partMaps` and its in-memory registry, so part-map members
 *   are validated and labelled;
 * - `libstylist:workspace-css` (`css !== false`, `enforce: "pre"`) — every workspace sheet compiled at
 *   import time (`compileSheet`: nesting, the libstylist plugin, the namespace's cascade layer). A sheet
 *   whose text differs from the in-memory copy rebuilds the registry inside the transform, so a sheet
 *   is never compiled against the registry of its previous version. With `css.overrides`, every
 *   override sheet compiled into the overrides layer (`compileOverrideSheet`), and every stylesheet of a
 *   configured design system's css package (`styles.css`, `gram.css`, `components/button.css`, `?inline`
 *   included) stripped of the reset parts' declarations (`resetCss`) — so a reset takes effect without the
 *   app touching the design system. In dev the sheet directories, the overrides directory and the
 *   design systems' registries are watched: a sheet added, removed or edited rewrites the owning
 *   package's part-map module when it differs (and the overrides module, the lock and the registry JSON;
 *   `write: false` only warns), reloads the sheets whose `:cx()`/`:component()` read a changed scope, and
 *   sends errors to the overlay; a change of the resets reloads the design-system stylesheets served so
 *   far and prints what each reset drops (while an override sheet has an error they keep the last good
 *   resets). `vite build` fails on a registry or override error, on a stale part-map or overrides
 *   module (run `libstylist build`), on a reset that drops nothing (`[empty-reset]`), on a reset the
 *   build strips from no bundled design-system stylesheet (`[unbundled-reset]`), on override sheets
 *   a build that bundles CSS never imports (`[overrides-not-imported]`) and on a CSS asset that declares
 *   the overrides layer out of place (`[layer-order]`); it warns about override declarations a
 *   design-system `!important` beats. `vite build --watch` re-reads a changed override sheet before the
 *   rebuild and re-transforms the override sheets and the design-system stylesheets every time.
 */
export async function stylistWorkspace(options: StylistWorkspaceOptions = {}): Promise<Plugin[]> {
    const { config: configFile, css = true, overrides: withOverrides = true, write = true, include, exclude, ...babel } = options
    const overridesOn = css && withOverrides
    let ws: Workspace | null = null
    let current: WorkspaceBuild | null = null
    // dev: the last error-free build whose outputs were synced. Nothing is written while the registry
    // has errors, so the rebuild that fixes them diffs against this one, not against the errored build
    let synced: WorkspaceBuild | null = null
    // package sheets and override sheets, as last read (the watcher) or transformed
    let sources = new Map<string, string>()
    let sourcePattern: RegExp = /(?!)/
    let command: "serve" | "build" = "serve"
    let server: ViteDevServer | null = null
    // css: false (Vitest) watches no sheet directory: a changed sheet only marks the registry stale
    let stale = false
    let log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } = { info: () => {}, warn: () => {}, error: () => {} }
    // the transform before the config is loaded: the runtime ids and the external wrapping need no config
    let inner: Plugin = stylist(babel)

    // overrides: the last error-free resolution, whose resets the design system's stylesheets are stripped of
    let applied: WorkspaceOverrides | null = null
    let resets: ResetTarget[] = []
    let resetsKey = resetKey([])
    /** Design-system stylesheet modules served so far (reloaded when the resets change). */
    const designSystemModules = new Set<string>()
    /** Override sheets whose transform failed (reloaded once the overrides resolve again). */
    const failedOverrides = new Set<string>()
    /** vite build: the override sheets compiled, the reset targets stripped somewhere, the design-system stylesheets bundled. */
    let bundled = { overrides: new Set<string>(), stripped: new Set<string>(), stylesheets: 0 }
    let reportRun = 0

    const rel = (file: string) => (ws ? toPosix(relative(ws.root, file)) : file)
    const format = (build: WorkspaceBuild) => build.errors.map((e) => `[${e.code}] ${e.message}`).join("\n")
    const overlay = (srv: ViteDevServer, message: string) => srv.ws.send({ type: "error", err: { message, stack: "", plugin: PLUGIN_CSS } })
    /** What the committed override outputs depend on: the lock sections and the set of override sheets. */
    const overridesSignature = (build: WorkspaceBuild | null): string => (build?.overrides ? JSON.stringify([build.overrides.lock, build.overrides.sheets.map((s) => s.file)]) : "")

    /** Rebuilds the registry from the in-memory sheets (the files on disk for the rest); in dev, applies what changed. */
    const refresh = (): WorkspaceBuild => {
        const prev = current
        const next = buildWorkspace(ws as Workspace, { sources, overrides: overridesOn })
        sources = new Map([...next.sheets, ...(next.overrides?.sheets ?? [])].map((s) => [s.file, s.css]))
        current = next
        stale = false
        if (server && css) afterRebuild(server, prev, next)
        else if (next.overrides && next.overrides.errors.length === 0) adopt(next.overrides)
        return next
    }

    const registry = (): Registry | null => (ws && stale ? refresh() : current)?.registry ?? null

    /** Takes an error-free override resolution: its resets are the ones the design system's stylesheets lose. Returns whether they changed. */
    const adopt = (overrides: WorkspaceOverrides): boolean => {
        applied = overrides
        const key = resetKey(overrides.resets)
        if (key === resetsKey) return false
        resets = overrides.resets
        resetsKey = key
        return true
    }

    /**
     * Dev: a new error-free override resolution. Override sheets whose compile inputs changed while their
     * text did not (a design system's registry, a `within` component) and the ones that failed are
     * reloaded; a change of the resets reloads every design-system stylesheet served so far and reprints
     * the report.
     */
    const applyOverrides = (srv: ViteDevServer, next: WorkspaceOverrides) => {
        const before = applied
        const changed = adopt(next)
        const was = new Map((before?.sheets ?? []).map((s) => [s.file, s]))
        const reloads = new Set(failedOverrides)
        failedOverrides.clear()
        for (const s of next.sheets) {
            const old = was.get(s.file)
            if (old && old.css === s.css && JSON.stringify(old.resolved?.plugin ?? null) !== JSON.stringify(s.resolved?.plugin ?? null)) reloads.add(s.file)
        }
        if (changed) for (const file of designSystemModules) reloads.add(file)
        for (const file of [...reloads].sort()) reload(srv, file)
        if (changed || (before?.designSystems.map((d) => d.registry) ?? []).some((r, i) => r !== next.designSystems[i]?.registry)) void report(next)
    }

    /**
     * Prints what each reset drops (the `libstylist build` report); an `[empty-reset]` goes to the overlay
     * in dev and fails `vite build`. Compiles the override sheets first: a layout declaration an override
     * re-declares is no note.
     */
    const report = async (overrides: WorkspaceOverrides): Promise<string[]> => {
        const run = ++reportRun
        if (overrides.resets.length === 0 || !ws) return []
        const compiled = new Map<string, string>()
        for (const s of overrides.sheets) {
            if (!s.resolved) continue
            try {
                compiled.set(s.rel, (await compileOverrideSheet(overrides, ws.layers.statement, s.file, s.css)).css)
            } catch {
                // the sheet's own transform reports its error
            }
        }
        if (run !== reportRun) return []
        const errors: string[] = []
        for (const line of overrideReports(overrides, compiled).lines) {
            if (line.level === "reset") log.info(`[libstylist] reset ${line.text}`)
            else if (line.level === "note") log.warn(`[libstylist] note ${line.text}`)
            else errors.push(line.text)
        }
        if (errors.length && command === "serve") {
            log.error(`[libstylist] ${errors.join("\n")}`)
            if (server) overlay(server, errors.join("\n"))
        }
        return errors
    }

    /**
     * Dev: the outputs of the packages whose sheets changed since the last synced build (every package's
     * when none was synced yet: the server started with a registry error), the dependents to reload,
     * the errors to show — and the override sheets' resolution, applied whenever it has no error of its own.
     */
    const afterRebuild = (srv: ViteDevServer, prev: WorkspaceBuild | null, next: WorkspaceBuild) => {
        if (next.overrides && next.overrides.errors.length === 0) applyOverrides(srv, next.overrides)
        if (next.errors.length) {
            const message = format(next)
            log.error(`[libstylist] ${message}`)
            overlay(srv, message)
            return
        }
        const base = synced
        const scopes = changedScopes(base?.registry ?? null, next.registry)
        // a sheet served while the registry had errors compiled against `prev`, not against `base`
        const errored = prev !== null && prev !== base ? prev : null
        const changed = errored ? new Set([...scopes, ...changedScopes(errored.registry, next.registry)]) : scopes
        const dependents = new Set([...dependentSheets(next, changed, base?.registry), ...(errored ? dependentSheets(next, changed, errored.registry) : [])])
        if (!base) sync(next)
        else {
            const sheetsOf = (b: WorkspaceBuild) => new Set(b.sheets.map((s) => s.file))
            const before = sheetsOf(base)
            const after = sheetsOf(next)
            const packages = new Set<WorkspacePackage>()
            for (const s of next.sheets) if ((s.scope !== null && scopes.has(s.scope)) || !before.has(s.file)) packages.add(s.package)
            for (const s of base.sheets) if (!after.has(s.file)) packages.add(next.workspace.packages.find((p) => p.name === s.package.name) ?? s.package)
            if (packages.size || scopes.size || overridesSignature(base) !== overridesSignature(next)) sync(next, packages)
            else synced = next
        }
        for (const file of [...dependents].sort()) reload(srv, file)
    }

    /**
     * Writes (or, with `write: false`, reports) the outputs that differ: the given packages' part maps
     * (default every package's), the overrides module, the lock, the registry. The build is then the
     * synced one.
     */
    const sync = (build: WorkspaceBuild, packages?: Iterable<WorkspacePackage>) => {
        const outputs = planWorkspaceOutputs(build, { packages }).filter((o) => o.changed)
        if (outputs.length && !write) {
            const maps = outputs.filter((o) => o.kind === "part-map")
            if (maps.length) log.warn(`[libstylist] stale part maps (write: false): ${maps.map((o) => rel(o.file)).join(", ")} — run \`libstylist build\``)
            const index = outputs.find((o) => o.kind === "overrides")
            if (index) log.warn(`[libstylist] stale overrides module (write: false): ${rel(index.file)} — run \`libstylist build\``)
        } else if (outputs.length) {
            for (const o of writeWorkspaceOutputs(outputs)) log.info(`[libstylist] ${o.next === null ? "removed" : "wrote"} ${rel(o.file)}`)
        }
        synced = build
    }

    /**
     * Re-transforms a module whose compiled output depends on something that changed. The module graph
     * is keyed by Vite's normalized (forward-slash) paths — a Windows path is looked up posix.
     */
    const reload = (srv: ViteDevServer, file: string) => {
        const graph = srv.moduleGraph
        for (const mod of graph.getModulesByFile(toPosix(file)) ?? []) {
            graph.invalidateModule(mod)
            void srv.reloadModule(mod).catch((err: unknown) => log.error(`[libstylist] reloading ${rel(file)}: ${String(err)}`))
        }
    }

    /**
     * A watcher event: a package sheet's or an override sheet's text (or its removal) into the in-memory
     * set, then a rebuild when it changed; a design system's registry changing (rebuilt in watch mode)
     * rebuilds too.
     */
    const onFile = (event: "add" | "change" | "unlink", file: string) => {
        if (!ws) return
        const abs = resolve(file)
        if (workspaceSheetOwner(ws, abs) || (overridesOn && workspaceOverrideSheet(ws, abs))) {
            if (event === "unlink") {
                if (!sources.has(abs)) return
                sources.delete(abs)
            } else {
                let text: string
                try {
                    text = readFileSync(abs, "utf8")
                } catch {
                    return
                }
                if (sources.get(abs) === text) return
                sources.set(abs, text)
            }
        } else if (!(current?.overrides?.designSystems ?? []).some((d) => d.registryFile === abs || d.registryFile === realpath(abs))) return
        try {
            refresh()
        } catch (err) {
            log.error(`[libstylist] ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    const transformPlugin: Plugin = {
        name: "libstylist:workspace",
        enforce: "pre",

        async configResolved(resolved) {
            // a second copy (a vitest config merged over a vite config concatenates their plugins) would
            // compile every sheet twice — the second pass reads the first one's output
            const copies = resolved.plugins.filter((p) => p.name === "libstylist:workspace" || p.name === "libstylist").length
            if (copies > 1) {
                throw new Error(`libstylist: the transform is registered ${copies} times (stylistWorkspace() and/or stylist()) — keep one stylistWorkspace() in the resolved config`)
            }
            command = resolved.command
            log = resolved.logger
            ws = await loadWorkspace({ config: configFile, root: resolved.root })
            refresh()
            sourcePattern = workspaceSourcePattern(ws)
            inner = stylist({ ...babel, registry, partMaps: ws.config.css.partMaps })
            if (current?.errors.length && !(css && command === "build")) log.warn(`[libstylist] ${format(current)}`)
        },

        options(input) {
            return callHook(inner.options, this, input) as never
        },

        configureServer(srv) {
            callHook(inner.configureServer, this, srv)
        },

        watchChange(id, change) {
            callHook(inner.watchChange, this, id, change)
            // without the css part nothing watches the sheet directories: the registry is rebuilt on next use
            if (!css && ws && workspaceSheetOwner(ws, id)) {
                sources.delete(resolve(id))
                stale = true
            }
        },

        resolveId(id, importer, opts) {
            return callHook(inner.resolveId, this, id, importer, opts) as never
        },

        load(id, opts) {
            return callHook(inner.load, this, id, opts) as never
        },

        transform(code, id, opts) {
            if (!ws || id.startsWith("\0")) return null
            const file = toPosix(cleanId(id))
            if (!(sourcePattern.test(file) || include?.test(file)) || exclude?.test(file) || inThirdParty(ws, file)) return null
            return callHook(inner.transform, this, code, id, opts) as never
        },
    }
    if (!css) return [transformPlugin]

    const cssPlugin: Plugin = {
        name: PLUGIN_CSS,
        enforce: "pre",

        configureServer(srv) {
            server = srv
            if (!ws) return
            const workspace = ws
            for (const dir of workspace.packages.flatMap((p) => p.check.sheets)) srv.watcher.add(dir)
            if (overridesOn && workspace.overrides) srv.watcher.add(workspace.overrides.dir)
            for (const ds of current?.overrides?.designSystems ?? []) srv.watcher.add(ds.registryFile)
            srv.watcher.on("add", (file: string) => onFile("add", file))
            srv.watcher.on("change", (file: string) => onFile("change", file))
            srv.watcher.on("unlink", (file: string) => onFile("unlink", file))
            // a server starts from the sheets as they are: bring the part maps, lock and registry up to date
            if (current && !current.errors.length) sync(current)
            else if (current) overlay(srv, format(current))
            if (applied) void report(applied)
        },

        async buildStart() {
            bundled = { overrides: new Set(), stripped: new Set(), stylesheets: 0 }
            if (command !== "build" || !current) return
            // --watch: a rebuilt design system (its registry) rebuilds the app too
            if (this.meta.watchMode) for (const ds of current.overrides?.designSystems ?? []) this.addWatchFile(ds.registryFile)
            if (current.errors.length) this.error(`libstylist: the workspace registry has errors\n${format(current)}`)
            const outputs = planWorkspaceOutputs(current)
            const drift = outputs.filter((o) => o.kind === "part-map" && o.changed)
            if (drift.length) this.error(`libstylist: stale part maps — run \`libstylist build\` and commit them: ${drift.map((o) => rel(o.file)).join(", ")}`)
            const index = outputs.find((o) => o.kind === "overrides" && o.changed)
            if (index) this.error(`libstylist: the overrides module is stale — run \`libstylist build\` and commit it: ${rel(index.file)}`)
            if (applied) {
                const errors = await report(applied)
                if (errors.length) this.error(`libstylist: ${errors.join("\n")}`)
            }
        },

        // `vite build --watch`: nothing else watches the override sheets and the registries — read a
        // change before the rebuild starts, so the design system's stylesheets are stripped of the new resets
        watchChange(id, change) {
            if (command === "build") onFile(change.event === "delete" ? "unlink" : change.event === "create" ? "add" : "change", id)
        },

        // `vite build --watch` keeps unchanged modules' transforms: an override sheet and a design-system
        // stylesheet depend on more than their text (the registries, every sheet's resets), and the build's
        // guards count them as they are transformed — they are transformed on every build
        shouldTransformCachedModule({ id }) {
            if (!ws || !overridesOn || id.startsWith("\0") || RAW_CSS_QUERY.test(id)) return null
            const file = resolve(cleanId(id))
            if (workspaceOverrideSheet(ws, file)) return true
            const designSystems = applied?.designSystems ?? current?.overrides?.designSystems ?? []
            return file.endsWith(".css") && designSystemOf(designSystems, file) ? true : null
        },

        async transform(code, id) {
            if (!ws || id.startsWith("\0") || RAW_CSS_QUERY.test(id)) return null
            const file = resolve(cleanId(id))

            // an override sheet: compiled into the overrides layer against its design system
            if (overridesOn && workspaceOverrideSheet(ws, file)) {
                let build = current as WorkspaceBuild
                if (sources.get(file) !== code || !build.overrides?.sheets.some((s) => s.file === file)) {
                    sources.set(file, code)
                    build = refresh()
                }
                const overrides = build.overrides as WorkspaceOverrides
                const own = overrides.errors.filter((e) => e.files.includes(rel(file)))
                let compiled
                try {
                    if (own.length) throw new Error(own.map((e) => `[${e.code}] ${e.message}`).join("\n"))
                    compiled = await compileOverrideSheet(overrides, ws.layers.statement, file, code)
                } catch (err) {
                    failedOverrides.add(file)
                    return this.error(err instanceof Error ? err.message : String(err))
                }
                failedOverrides.delete(file)
                bundled.overrides.add(file)
                for (const w of compiled.warnings) this.warn(`${rel(file)}: ${w}`)
                return { code: compiled.css, map: null }
            }

            // a package sheet: compiled into its namespace's layer
            if (workspaceSheetOwner(ws, file)) {
                // compile against the registry of this very text (the watcher may not have seen the change yet)
                let build = current as WorkspaceBuild
                if (sources.get(file) !== code || !build.sheets.some((s) => s.file === file)) {
                    sources.set(file, code)
                    build = refresh()
                }
                const errors = build.errors.filter((e) => e.files.includes(rel(file)))
                if (errors.length) this.error(errors.map((e) => `[${e.code}] ${e.message}`).join("\n"))
                const compiled = await compileSheet(ws, build.registry, file, code)
                for (const w of compiled.warnings) this.warn(`${rel(file)}: ${w}`)
                return { code: compiled.css, map: null }
            }

            // a design system's stylesheet: stripped of the reset parts' declarations
            const designSystems = overridesOn && file.endsWith(".css") ? (applied?.designSystems ?? current?.overrides?.designSystems ?? []) : []
            const ds = designSystems.length ? designSystemOf(designSystems, file) : null
            if (!ds) return null
            designSystemModules.add(file)
            bundled.stylesheets++
            const targets = resets.filter((t) => t.prefix === ds.prefix)
            if (targets.length === 0) return null
            let result
            try {
                result = resetCss(code, targets, { from: file })
            } catch (err) {
                return this.error(err instanceof Error ? err.message : String(err))
            }
            for (const t of touchedTargets(targets, result.outcome)) bundled.stripped.add(t.label)
            return result.css === null ? null : { code: result.css, map: null }
        },

        // after Vite's own hooks: a library build emits its CSS asset in generateBundle
        generateBundle: { order: "post", handler(_, bundle) {
            if (command !== "build" || !overridesOn || !applied || !ws) return
            // a build that bundles no override sheet and no design-system stylesheet has no CSS of the app's
            if (bundled.overrides.size === 0 && bundled.stylesheets === 0) return
            const missing = applied.sheets.filter((s) => !bundled.overrides.has(s.file))
            if (missing.length) {
                this.error(
                    `libstylist: [overrides-not-imported] the build bundles the design system but not the override sheet${missing.length === 1 ? "" : "s"} ${missing.map((s) => s.rel).join(", ")} — import ${rel(applied.module)} once in the app's entry (or pass overrides: false to a build that must not apply them)`,
                )
            }
            const unbundled = unbundledResets(resets, bundled.stripped)
            if (unbundled.length) {
                const which = unbundled.map((t) => `${t.whole ? `${t.prefix}:${t.namespace}/${t.scope} (whole)` : t.label} (${t.sheet}${t.line ? `:${t.line}` : ""})`).join(", ")
                this.error(
                    `libstylist: [unbundled-reset] the build bundles no design-system stylesheet that styles ${which} — import the design system's CSS through Vite (import "<css package>/styles.css" in the app's entry) so the reset can strip it, or remove the reset`,
                )
            }
            // the order the bundle's first @layer statements fix, not the one css.layers.statement promises
            const namespaceLayers = [...new Set(Object.values(ws.layers.namespaces))]
            for (const asset of Object.values(bundle)) {
                if (asset.type !== "asset" || !asset.fileName.endsWith(".css")) continue
                let problem: string | null = null
                try {
                    problem = bundleLayerProblem(declaredLayerOrder(String(asset.source)), applied.layer, namespaceLayers)
                } catch {
                    // a CSS asset that doesn't parse is Vite's to report
                }
                if (problem) this.error(`libstylist: [layer-order] ${asset.fileName}: ${problem}`)
            }
        } },
    }
    return [transformPlugin, cssPlugin]
}
