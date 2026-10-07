// Commands backed by the TypeScript compiler API. ./index.ts registers them for every run, so each one
// imports the checker (and with it `typescript`) only when it is invoked: gen-types and hash never
// load it, and a missing `typescript` peer surfaces as that command's error.
//   check [--config <file>] [--json] [--pending]
//   burndown [--config <file>] [--format text|markdown] [--json] [--expect-zero]
//   codemod [--write] [--config <file>] [--no-types] <file.tsx...>
import type { Command } from "./index.js"

export const commands: Record<string, Command> = {
    check: async (args, io) => (await import("../check/format.js")).runCheckCli(args, { stdout: io.out, stderr: io.err }),
    burndown: async (args, io) => (await import("../check/burndown.js")).runBurndownCli(args, { stdout: io.out, stderr: io.err }),
    codemod: async (args, io) => (await import("../codemod/cli.js")).runCodemodCli(args, io),
}
