import * as React from "react"

function OlderBase() {
    return <div />
}

function OlderRoot() {
    return <div />
}

/** Not migrated, but `Older` and `Older.Root` claim one tag — a hard error for everyone (T201). */
export const Older = Object.assign(OlderBase, { Root: OlderRoot })
