import * as React from "react"

import { nulls as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { kind?: "a" | "b" | "c"; open?: boolean; children?: React.ReactNode }

/** Every case returns the identity or nothing. */
export function Switcher({ kind, ...rest }: Props) {
    switch (kind) {
        case "a":
            return <elo-switcher {...cx(cn.switcher, rest, { kind: "a" })} />
        case "b":
            return null
        default:
            return <elo-switcher {...cx(cn.switcher, rest)} />
    }
}

/** Returns inside nested callbacks are not render paths. */
export function Nested(props: Props) {
    const renderOther = React.useCallback(() => <div>not a root</div>, [])
    function helperNotCalled() {
        return <span />
    }
    void renderOther
    void helperNotCalled
    return <elo-nested {...cx(cn.nested, props)} />
}

/** try/catch branches. */
export function Guarded(props: Props) {
    try {
        return <elo-guarded {...cx(cn.guarded, props)} />
    } catch {
        return null
    }
}

/** The null branch is fine; the other one renders a plain div — R101. */
export function HalfDiv({ open, ...rest }: Props) {
    return open ? <elo-halfdiv {...cx(cn.halfdiv, rest)} /> : <div {...cx(rest)} />
}

/** undefined, false and an empty fragment render nothing — R100. */
export function Empty({ open, kind }: Props) {
    if (open) return undefined
    if (kind === "a") return false
    return <></>
}

/** What useMemo's factory returns is the root. */
export function Memoized({ open, ...rest }: Props) {
    const content = React.useMemo(() => (open ? <elo-memoized {...cx(cn.memoized, rest)} /> : null), [open, rest])
    return content
}

/** A Suspense fallback is a render path of its own: here a plain div — R101. */
export function Suspended(props: Props) {
    return (
        <React.Suspense fallback={<div>loading</div>}>
            <elo-suspended {...cx(cn.suspended, props)} />
        </React.Suspense>
    )
}
