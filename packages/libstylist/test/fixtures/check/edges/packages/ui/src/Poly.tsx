import * as React from "react"

import { poly as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

/** A type parameter bounded only by string — R107. */
export function Unbounded<T extends string>({ as: As, ...rest }: { as: T }) {
    return <As elo-unbounded {...cx(cn.unbounded, rest)} />
}

/** React.ElementType admits components and every tag — R107. */
export function Elementy({ as: As = "button", ...rest }: { as?: React.ElementType }) {
    return <As elo-elementy {...cx(cn.elementy, rest)} />
}

/** Every intrinsic tag, div and span included — R108. */
export function Anything({ as: As = "section", ...rest }: { as?: keyof React.JSX.IntrinsicElements }) {
    return <As elo-anything {...cx(cn.anything, rest)} />
}

/** The documented mapping: generic branches render the custom tag, the rest carry the marker. */
export function Mapped({ as = "div", ...rest }: { as?: "div" | "p" }) {
    const Tag = as === "p" ? "p" : "elo-mapped"
    return <Tag elo-mapped {...cx(cn.mapped, rest)} />
}

/** Truncate-like: the custom tag in the generic branches, a marked <p> otherwise — its display default applies to the tag. */
export function Clamp({ as = "div", ...rest }: { as?: "div" | "p" }) {
    if (as === "p") return <p elo-clamp {...cx(cn.clamp, rest)} />
    return <elo-clamp {...cx(cn.clamp, rest)} />
}

/** Only ever a marked <p>: a display default has nothing to apply to — S305. */
export function Para(props: { children?: React.ReactNode }) {
    return <p elo-para {...cx(cn.para, props)} />
}
