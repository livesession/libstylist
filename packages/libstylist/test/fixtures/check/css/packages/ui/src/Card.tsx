import * as React from "react"

import { card as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { title?: string; children?: React.ReactNode }

/** A part read from the map outside a cx() call still counts as carried (the host sets it imperatively). */
export function markTitle(el: Element) {
    el.setAttribute(cn["has-title"], "")
}

export function Card(props: Props) {
    return (
        <elo-card {...cx(cn.root, props)}>
            <span {...cx(cn.title, { hasTitle: !!props.title })}>{props.title}</span>
        </elo-card>
    )
}

export function Chip(props: Props) {
    return <elo-chip {...cx(cn.chip, props)} />
}

export function Pill(props: Props) {
    return <elo-pill {...cx(cn.pill, props)} />
}

/** The stat part sits on an inner element, so it never gives the root its display. */
export function Stat(props: Props) {
    return (
        <elo-stat {...cx(props)}>
            <span {...cx(cn.stat)}>{props.title}</span>
        </elo-stat>
    )
}
