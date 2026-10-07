// What every workspace module shares: the error a workspace can't be built with, and postcss-nesting
// loaded on first compile (an optional peer, so discovering packages never needs it).
import type { AcceptedPlugin } from "postcss"

/** A workspace problem the build can't start with (its config, a package's `imports`, the layers). */
export class WorkspaceError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "WorkspaceError"
    }
}

type NestingPlugin = () => AcceptedPlugin
let nesting: Promise<NestingPlugin> | null = null

/** postcss-nesting, loaded once on first compile — an optional peer, so the discovery helpers never need it. */
export function loadNesting(): Promise<NestingPlugin> {
    nesting ??= import("postcss-nesting").then(
        (m) => ((m as { default?: NestingPlugin }).default ?? (m as unknown as NestingPlugin)),
        (err: Error) => {
            nesting = null
            throw new WorkspaceError(`compiling the workspace sheets needs postcss-nesting next to @livesession/libstylist (${err.message})`)
        },
    )
    return nesting
}
