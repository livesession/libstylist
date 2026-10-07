// One ts.Program over every configured package: entries are the roots, and `paths` maps each
// package name (and subpath) to its source entry so cross-package imports resolve to source, plus the
// config's own aliases (`typescript.paths`: `~/*` → an app's directory).
import { relative, sep } from "node:path"

import ts from "typescript"

import type { CheckConfig, CheckPackage } from "./config.js"

export interface CheckProgram {
    program: ts.Program
    checker: ts.TypeChecker
    /** Every design-system source file of the program (inside a package dir, outside node_modules), sorted. */
    files: ts.SourceFile[]
    /** The configured package a file belongs to, or null (node_modules, other dirs). */
    packageOf(file: string): CheckPackage | null
    /** Path relative to the config root, with forward slashes. */
    rel(file: string): string
}

/**
 * The compiler options the checker (and the codemod) analyzes with: strict, bundler resolution, JSX
 * preserved; `paths` maps every package name and subpath to its entry, next to the config's
 * `typescript.paths` (absolute targets; the loader refuses one that names a package entry).
 */
export function checkCompilerOptions(config: CheckConfig): ts.CompilerOptions {
    const paths: Record<string, string[]> = {}
    for (const pkg of config.packages) {
        for (const [subpath, file] of Object.entries(pkg.entries)) paths[subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`] = [file]
    }
    // a config validated before `typescript` existed (an object built by hand) has none
    for (const [pattern, targets] of Object.entries(config.typescript?.paths ?? {})) paths[pattern] = [...targets]
    return {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowJs: false,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true,
        allowImportingTsExtensions: true,
        types: [],
        paths,
    }
}

const inNodeModules = (file: string) => file.split(/[\\/]/).includes("node_modules")

/** Builds the program for a validated config. */
export function createCheckProgram(config: CheckConfig): CheckProgram {
    const roots = [...new Set(config.packages.flatMap((p) => Object.values(p.entries)))]
    const program = ts.createProgram({ rootNames: roots, options: checkCompilerOptions(config) })
    const checker = program.getTypeChecker()
    const dirs = config.packages.map((p) => ({ pkg: p, prefix: p.dir.endsWith(sep) ? p.dir : p.dir + sep })).sort((a, b) => b.prefix.length - a.prefix.length)
    const packageOf = (file: string): CheckPackage | null => {
        const abs = file.split("/").join(sep)
        if (inNodeModules(abs)) return null
        return dirs.find((d) => abs.startsWith(d.prefix))?.pkg ?? null
    }
    const files = program
        .getSourceFiles()
        .filter((sf) => !sf.isDeclarationFile && packageOf(sf.fileName) !== null)
        .sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
    const rel = (file: string) => relative(config.root, file.split("/").join(sep)).split(sep).join("/")
    return { program, checker, files, packageOf, rel }
}
