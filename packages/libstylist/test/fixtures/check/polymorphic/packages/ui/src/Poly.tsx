import * as React from "react"

import { poly as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type ActionAs = "button" | "a"

export function Action({ as: As = "button", ...props }: { as?: ActionAs }) {
    return <As elo-action {...cx(cn.action, props)} />
}

export function Listing<T extends "ol" | "ul">({ as: As, ...props }: { as: T }) {
    return <As elo-listing {...cx(cn.listing, props)} />
}

export function Loose({ as: As = "section", ...props }: { as?: string }) {
    return <As elo-loose {...cx(cn.loose, props)} />
}

export function Boxy({ as: As = "section", ...props }: { as?: "div" | "section" }) {
    return <As elo-boxy {...cx(cn.boxy, props)} />
}

export function Bare({ as: As = "nav" }: { as?: "nav" | "header" }) {
    return <As />
}

export function Slot({ icon: Icon }: { icon: React.ComponentType }) {
    return <Icon />
}

export function Picked(props: { link?: boolean }) {
    const Tag = props.link ? "a" : "button"
    return <Tag elo-picked {...cx(cn.picked, props)} />
}
