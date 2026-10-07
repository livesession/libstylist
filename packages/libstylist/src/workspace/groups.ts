// Stylesheet groups of an app package that keeps its sheets in its own directories (`sheets` in
// libstylist.config.mjs) instead of a css package's group directory: one css group per (package,
// namespace), named after the package directory — `crm-accounts` for its base namespace and
// `crm-accounts.render` for the `render` directory namespace. A sheet's namespace is the one of the
// longest `namespaces` directory it sits in (`src/css/render/row.css` → `render`), exactly as for
// source files. Shared by the checker and the workspace tooling that builds such packages' sheets.
import { readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"

import { packageConfigOf, type DirectoryNamespace, type PackageStylistConfig } from "../conventions/index.js"

/** What grouping a package's sheets needs to know about the package. */
export interface GroupedPackage {
    /** Absolute package directory; its basename names the groups. */
    dir: string
    /** The package's base config (its top-level namespace). */
    naming: PackageStylistConfig
    /** Its directory namespaces, longest first (`normalizeNamespaces`). */
    namespaces: readonly DirectoryNamespace[]
    /** Absolute directories holding its sheets, each searched recursively. */
    sheets: readonly string[]
}

/** One css group of a package: the sheets of one namespace. */
export interface PackageSheetGroup {
    /** `<package dir basename>` for the base namespace, `<package dir basename>.<namespace>` for another. */
    name: string
    /** Namespace and tag naming of the group's sheets. */
    naming: PackageStylistConfig
    /** Absolute sheet files, sorted. */
    files: string[]
}

/** Directories never searched for sheets. */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage"])

/**
 * The css group name of a package's namespace: the package directory's basename for its base
 * namespace (`packages/crm-accounts` → `crm-accounts`), `<basename>.<namespace>` for a directory
 * namespace (`crm-accounts.render`). Unique per package directory basename, so a workspace's packages
 * never share a group even when they share namespaces.
 */
export function sheetGroupName(packageDir: string, namespace: string, baseNamespace: string): string {
    const name = basename(packageDir)
    return namespace === baseNamespace ? name : `${name}.${namespace}`
}

/** Every `.css` file under `dir` (recursively; `node_modules`, build output and dot directories skipped), sorted. */
export function listSheets(dir: string): string[] {
    const out: string[] = []
    const walk = (d: string): void => {
        for (const name of readdirSync(d).sort()) {
            if (name.startsWith(".")) continue
            const abs = join(d, name)
            if (statSync(abs).isDirectory()) {
                if (!SKIPPED_DIRS.has(name)) walk(abs)
            } else if (name.endsWith(".css")) out.push(abs)
        }
    }
    walk(dir)
    return out.sort()
}

/** The namespace config a sheet of `pkg` is compiled with: its directory namespace's, else the package's. */
export function sheetNaming(pkg: Pick<GroupedPackage, "dir" | "naming" | "namespaces">, file: string): PackageStylistConfig {
    return packageConfigOf({ dir: pkg.dir, base: pkg.naming, namespaces: pkg.namespaces }, file).config
}

/**
 * The css groups a package's namespaces make: the base namespace's first, then each directory
 * namespace's once, by namespace. Every namespace the package declares has a group, even one without
 * a sheet yet (its part maps may already be imported).
 */
export function packageGroups(pkg: Pick<GroupedPackage, "dir" | "naming" | "namespaces">): Array<{ name: string; naming: PackageStylistConfig }> {
    const namings = new Map<string, PackageStylistConfig>([[pkg.naming.namespace, pkg.naming]])
    const others = [...pkg.namespaces].map((d) => d.config).sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0))
    for (const naming of others) if (!namings.has(naming.namespace)) namings.set(naming.namespace, naming)
    return [...namings.values()].map((naming) => ({ name: sheetGroupName(pkg.dir, naming.namespace, pkg.naming.namespace), naming }))
}

/**
 * A package's css groups ({@link packageGroups}), each with the sheets its `sheets` directories hold
 * under that namespace.
 */
export function packageSheetGroups(pkg: GroupedPackage): PackageSheetGroup[] {
    const groups = new Map(packageGroups(pkg).map((g) => [g.naming.namespace, { ...g, files: [] as string[] }]))
    for (const file of [...new Set(pkg.sheets.flatMap(listSheets))].sort()) groups.get(sheetNaming(pkg, file).namespace)?.files.push(file)
    return [...groups.values()]
}
