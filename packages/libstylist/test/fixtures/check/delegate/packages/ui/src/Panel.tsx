import * as React from "react"

import { panel as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

export function Panel(props: Props) {
    return (
        <elo-panel {...cx(cn.root, props)}>
            {props.children}
        </elo-panel>
    )
}

/** Renders its identity element but never forwards stylist props. */
export function Legacy(props: Props) {
    return <elo-legacy {...cx(cn.legacy)}>{props.children}</elo-legacy>
}
