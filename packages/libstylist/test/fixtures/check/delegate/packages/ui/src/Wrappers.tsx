import * as React from "react"

import { confirm as cn, panel } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import { Legacy, Panel } from "./Panel"

type Props = { open?: boolean; children?: React.ReactNode }

export function Confirm(props: Props) {
    return (
        <Panel elo-confirm {...cx(cn.root, props)}>
            {props.children}
        </Panel>
    )
}

export function Relay(props: Props) {
    return <Legacy elo-relay {...cx(props)} />
}

export function Plain() {
    return <Panel>just text</Panel>
}

export function Slot(props: Props) {
    return (
        <Panel>
            <section elo-slot {...cx(props)} />
        </Panel>
    )
}

export function Sometimes(props: Props) {
    return <Panel>{props.open && <section elo-sometimes {...cx(props)} />}</Panel>
}

export function Dropped() {
    return <Panel elo-dropped />
}

export function Styler(props: Props) {
    return (
        <elo-styler {...cx(props)}>
            <Legacy {...cx(panel.body)} />
        </elo-styler>
    )
}
