#!/usr/bin/env node
// The `libstylist` bin. A committed file rather than dist/cli/index.js, so package managers link
// the bin even when the workspace is installed before it is built (CI: `pnpm install`, then
// `pnpm build`) — a bin whose target does not exist at install time is not linked.
let cli
try {
    cli = await import("../dist/cli/index.js")
} catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error
    console.error("libstylist: the CLI is not built yet — run `pnpm build` (or `pnpm --filter @livesession/libstylist build`) first.")
    process.exit(1)
}
process.exit(await cli.run(process.argv.slice(2)))
