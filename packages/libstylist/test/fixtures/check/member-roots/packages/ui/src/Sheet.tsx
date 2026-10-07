import * as React from "react"
import { createPortal } from "react-dom"

import { sheet as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

/** Its portaled panel is a member root rendered as a custom tag, with no display default — S304. */
export function Sheet({ children, ...rest }: Props) {
    return (
        <elo-sheet {...cx(cn.root, rest)}>
            {createPortal(<elo-sheet-panel {...cx(cn.panel)}>{children}</elo-sheet-panel>, document.body)}
        </elo-sheet>
    )
}
