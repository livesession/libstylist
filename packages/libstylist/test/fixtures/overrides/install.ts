// Installs the fixture design system (./design-system, built by ./design-system.ts) into a scratch copy of
// ./workspace the way a package manager would: the css package (package.json with its libstylist groups,
// dist/stylist-registry.json, the aggregates styles.css and gram.css, one dist/components/<sheet>.css per
// sheet) and the component packages @ds/react (core) and @ds/gram (gram) under vendor/ds, linked into
// apps/web/node_modules/@ds — so every path Vite and the tooling resolve through them is a symlink.
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { clearConventionsCache } from "../../../src/conventions/index.js"
import { DS_GROUPS, designSystem } from "./design-system.js"

const HERE = dirname(fileURLToPath(import.meta.url))
export const WORKSPACE_FIXTURE = join(HERE, "workspace")
const LIBSTYLIST_MODULES = join(HERE, "..", "..", "..", "node_modules")

const scratchDirs: string[] = []
process.on("exit", () => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

export const write = (file: string, text: string): void => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** The installed design system's css package directory (the real path, not the link). */
export const designSystemDir = (root: string): string => join(root, "vendor", "ds", "css")

/** Writes the fixture design system into `root` (vendor/ds) and links it into apps/web/node_modules/@ds. */
export async function installDesignSystem(root: string): Promise<void> {
    const ds = await designSystem()
    const store = join(root, "vendor", "ds")
    write(
        join(store, "css", "package.json"),
        json({
            name: "@ds/css",
            private: true,
            exports: { "./styles.css": "./dist/styles.css", "./gram.css": "./dist/gram.css", "./components/*.css": "./dist/components/*.css" },
            libstylist: { prefix: "ds", groups: DS_GROUPS },
        }),
    )
    write(join(store, "css", "dist", "stylist-registry.json"), json(ds.registry))
    write(join(store, "css", "dist", "styles.css"), ds.styles)
    write(join(store, "css", "dist", "gram.css"), ds.gram)
    for (const [scope, info] of Object.entries(ds.registry.scopes)) {
        if (info.group === "components") write(join(store, "css", "dist", "components", `${scope}.css`), `@layer components {\n${ds.compiled[scope]}\n}\n`)
    }
    write(join(store, "react", "package.json"), json({ name: "@ds/react", private: true, libstylist: { prefix: "ds", namespace: "core" } }))
    write(join(store, "gram", "package.json"), json({ name: "@ds/gram", private: true, libstylist: { prefix: "ds", namespace: "gram" } }))
    const modules = join(root, "apps", "web", "node_modules", "@ds")
    mkdirSync(modules, { recursive: true })
    for (const name of ["css", "react", "gram"]) symlinkSync(join(store, name), join(modules, name), "dir")
}

/**
 * A scratch copy of the workspace fixture with the design system installed: a pnpm workspace root, react
 * and the other devDependencies reachable through node_modules. Removed on exit.
 */
export async function overridesWorkspace(): Promise<string> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "libstylist-overrides-ws-")))
    scratchDirs.push(root)
    cpSync(WORKSPACE_FIXTURE, root, { recursive: true })
    writeFileSync(join(root, "pnpm-workspace.yaml"), `packages:\n  - "packages/*"\n  - "apps/*"\n`)
    symlinkSync(LIBSTYLIST_MODULES, join(root, "node_modules"), "dir")
    await installDesignSystem(root)
    clearConventionsCache()
    return root
}
