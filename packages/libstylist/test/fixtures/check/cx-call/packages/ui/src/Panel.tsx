import * as React from "react"

import { panel as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { title?: string; children?: React.ReactNode }

export function Panel({ title, children, ...rest }: Props) {
    return (
        <elo-panel {...cx(cn.root, rest)}>
            {title}
            {children}
        </elo-panel>
    )
}

/** T9/T11: DOM-less, forwards its marker but not its props — R112 names the delegate form, S307 on a caller too. */
export function Confirmish({ title }: Props) {
    return <Panel elo-confirmish title={title} />
}
