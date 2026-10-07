// The design-system checkout the real-repository tests read (never write): `*-real.test.ts`, the
// real-sheet and real-source smokes, and the tests that run the tooling over the design system's own
// libstylist.config.mjs. Those tests used to run inside the design-system monorepo, where this package
// lived (packages/libstylist) and the repository root was three directories up; the design system's CI
// ran them on every change. Since the package moved into its own repository they run on demand: point
// LIBSTYLIST_DESIGN_SYSTEM at a design-system checkout (absolute, or relative to this repository's root
// — the directory with pnpm-workspace.yaml, whatever the working directory `pnpm -r` runs the suite in)
// and run the suite —
//
//     LIBSTYLIST_DESIGN_SYSTEM=../design-system pnpm test
//
// Without the variable every such test skips with `skipWithoutDesignSystem` as its reason, and no test
// file reads the design system at import time: a test file imports cleanly on any machine and loads the
// real sheets, sources or config lazily, inside the gated test. A checkout counts as present only when
// it holds libstylist.config.mjs and packages/css/src (the source sheets); a variable that is set but
// names no such checkout (a typo, a stale path) fails the run at import, so it can never skip the suite
// quietly. Tests that need the built css package (packages/css/dist) check for it themselves and skip
// with their own reason.
//
// This file is not a test: it is named so that the `test/**/*.test.ts` glob leaves it out.
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const DESIGN_SYSTEM_ENV = "LIBSTYLIST_DESIGN_SYSTEM"

/** This repository's root: the nearest directory above this file holding pnpm-workspace.yaml. */
function repositoryRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (;;) {
        if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
        const parent = dirname(dir)
        if (parent === dir) return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
        dir = parent
    }
}

const isCheckout = (root: string): boolean => existsSync(join(root, "libstylist.config.mjs")) && existsSync(join(root, "packages", "css", "src"))

let resolved: string | null | undefined

/**
 * The design-system checkout `LIBSTYLIST_DESIGN_SYSTEM` names — an absolute path, or one relative to
 * this repository's root — or null when the variable is unset or empty. A variable that is set but names
 * no design-system checkout (no libstylist.config.mjs, or no packages/css/src) throws: the suite must
 * fail, not skip, on a mistyped path.
 */
export function designSystemRoot(): string | null {
    if (resolved !== undefined) return resolved
    const value = process.env[DESIGN_SYSTEM_ENV]?.trim()
    if (!value) return (resolved = null)
    const root = resolve(repositoryRoot(), value)
    if (!isCheckout(root)) {
        throw new Error(
            `${DESIGN_SYSTEM_ENV}=${value} (${root}) is not a design-system checkout: no libstylist.config.mjs or no packages/css/src — point it at one (absolute, or relative to the repository root), or unset it to skip the real-repository tests`,
        )
    }
    return (resolved = root)
}

/**
 * The `skip` option of a test that reads the real design system: `false` when a checkout is present,
 * else the reason the test skips with.
 */
export const skipWithoutDesignSystem: string | false = designSystemRoot()
    ? false
    : `${DESIGN_SYSTEM_ENV} is unset — point it at a design-system checkout to run the real-repository tests`

/**
 * A path inside the design-system checkout (`designSystemPath("packages", "css", "src")`; the root with
 * no segments) for code a test gated with {@link skipWithoutDesignSystem} runs. Throws when the checkout
 * is absent, so a read outside a gated test is an error rather than a read of some other directory.
 */
export function designSystemPath(...segments: string[]): string {
    const root = designSystemRoot()
    if (!root) throw new Error(`${DESIGN_SYSTEM_ENV} is unset or not a design-system checkout — gate the test with skipWithoutDesignSystem`)
    return join(root, ...segments)
}
