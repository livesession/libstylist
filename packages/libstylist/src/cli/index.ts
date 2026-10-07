#!/usr/bin/env node
// `libstylist` CLI. Commands:
//   gen-types [--check] [--config <file>] [<packageDir...>]
//                                          per-package JSX tag types (types/stylist-tags.gen.d.ts); --config:
//                                          every package of a libstylist.config.mjs, scanning its `sources`
//   build [--config <file>] [--check] [--watch]
//                                          a workspace of app packages' part maps, lock and registry (../workspace)
//   codemod [--write] [--config <file>] [--no-types] <file.tsx...>
//                                          cx attributes, @cxScope and forwardStylist → cx() calls
//   migrate-selectors [options] <inputs>   a consumer's legacy selectors → libstylist hooks (../migrate)
//   hash <prefix> <namespace> <scope> <part> [--length n]   print one part attribute
// The conventions checker and the burndown report are registered by ./commands.ts.
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { realpathSync } from "node:fs"

import { partAttr } from "../hash/index.js"
import { checkTagTypes, writeTagTypes, writeTypesStub } from "../typesgen/index.js"

export interface CliIo {
    out: (line: string) => void
    err: (line: string) => void
}

export type Command = (args: string[], io: CliIo) => Promise<number> | number

const flag = (args: string[], name: string): boolean => {
    const i = args.indexOf(name)
    if (i < 0) return false
    args.splice(i, 1)
    return true
}

const option = (args: string[], name: string): string | undefined => {
    const i = args.indexOf(name)
    if (i < 0) return undefined
    const value = args[i + 1]
    args.splice(i, 2)
    return value
}

const genTypes: Command = async (args, io) => {
    const check = flag(args, "--check")
    const wantsConfig = args.includes("--config")
    const configFile = option(args, "--config")
    if (wantsConfig && !configFile) {
        io.err("usage: libstylist gen-types [--check] [--config <file>] [<packageDir...>]")
        return 2
    }
    // a directory argument scans what its package.json declares (`libstylist.sources`, else src)
    const targets: Array<{ dir: string; sources?: readonly string[] }> = args.map((dir) => ({ dir }))
    if (configFile !== undefined) {
        // the packages of a libstylist.config.mjs (a workspace of app packages lists them all there), each
        // scanned in its source directories
        const { loadCheckConfig } = await import("../check/config.js")
        const config = await loadCheckConfig(resolve(configFile))
        for (const pkg of config.packages) targets.push({ dir: relative(process.cwd(), pkg.dir) || ".", sources: pkg.sources })
    }
    if (targets.length === 0) {
        io.err("libstylist gen-types: pass one or more package directories, or --config <file>")
        return 2
    }
    let failed = 0
    for (const { dir, sources } of targets) {
        const packageDir = resolve(dir)
        if (check) {
            const result = checkTagTypes({ packageDir, sources })
            if (result.ok) io.out(`ok      ${result.file}`)
            else {
                failed++
                io.err(`stale   ${result.file} — run \`libstylist gen-types ${dir}\``)
            }
            continue
        }
        const stub = writeTypesStub({ packageDir })
        if (stub.written) io.out(`created ${stub.file}`)
        const { file, changed } = writeTagTypes({ packageDir, sources })
        io.out(`${changed ? "wrote  " : "ok     "} ${file}`)
    }
    return failed > 0 ? 1 : 0
}

const hash: Command = (args, io) => {
    const length = option(args, "--length")
    const [prefix, namespace, scope, part] = args
    if (!part) {
        io.err("usage: libstylist hash <prefix> <namespace> <scope> <part> [--length n]")
        return 2
    }
    io.out(partAttr({ prefix, namespace, scope, part }, length ? Number(length) : undefined))
    return 0
}

// imported on use: postcss + the selector parser stay out of the gen-types / hash paths
const migrateSelectorsCommand: Command = async (args, io) => (await import("../migrate/index.js")).runMigrateSelectorsCli(args, io)
const buildCommand: Command = async (args, io) => (await import("../workspace/cli.js")).runBuildCli(args, io)

export const commands: Record<string, Command> = {
    "gen-types": genTypes,
    build: buildCommand,
    "migrate-selectors": migrateSelectorsCommand,
    hash,
}

const USAGE = `usage: libstylist <command> [...]
commands:
  gen-types [--check] [--config <file>] [<packageDir...>]
                                        write/check types/stylist-tags.gen.d.ts per package from the JSX of its
                                        sources (--config: every package of a libstylist.config.mjs)
  build [--config <file>] [--check] [--watch]
                                        a workspace of app packages: each package's part-map module, the lock
                                        and the registry (--check: fail on drift; --watch: rebuild on change)
  codemod [--write] [--config <file>] [--no-types] <file.tsx...>
                                        cx attributes, @cxScope and forwardStylist → cx() calls (reports what stays manual);
                                        --config: the libstylist.config.mjs to resolve part maps with, --no-types: skip the
                                        TypeScript type facts that keep data values rendering as before
  migrate-selectors [--map <file>] [--write | --check [--strict]] [--json]
                    [--roots part|identity] [--literals anchored|all|off] [--ignore <glob>]... <file|dir|glob...>
                                        a consumer's ls-* selectors → libstylist hooks, per the migration map
  check [options]                       conventions checker over the configured repo
  burndown [options]                    remaining migration findings per rule
  hash <prefix> <ns> <scope> <part> [--length n]
                                        print one part attribute`

/** Runs the CLI with `argv` (without node/script) and returns the exit code. */
export async function run(argv: string[], io: CliIo = { out: (l) => console.log(l), err: (l) => console.error(l) }): Promise<number> {
    const [name, ...args] = argv
    // late registration keeps the checker (TypeScript compiler API) out of the gen-types/hash paths
    const extra: Record<string, Command> = await import("./commands.js").then(
        (m) => m.commands as Record<string, Command>,
        () => ({}),
    )
    const command = commands[name ?? ""] ?? extra[name ?? ""]
    if (!command) {
        io.err(USAGE)
        return name ? 2 : 0
    }
    try {
        return await command(args, io)
    } catch (err) {
        io.err(`libstylist ${name}: ${err instanceof Error ? err.message : String(err)}`)
        return 1
    }
}

const realpath = (file: string): string | undefined => {
    try {
        return realpathSync(file)
    } catch {
        return undefined
    }
}

// Entry check. Node resolves a symlinked main module to its real path for `import.meta.url`,
// while argv[1] keeps the path as invoked — and pnpm's bin shims invoke the CLI through the
// workspace symlink (node_modules/@livesession/libstylist → packages/libstylist). Comparing
// against argv[1] alone made `pnpm exec libstylist …` a silent no-op that exited 0.
const entry = process.argv[1]
if (entry && [entry, realpath(entry)].some((file) => file !== undefined && import.meta.url === pathToFileURL(file).href)) {
    run(process.argv.slice(2)).then((code) => process.exit(code))
}
