import * as React from "react"
import { createPortal } from "react-dom"

import { portals as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { open?: boolean; children?: React.ReactNode }

/** Only rendered through a portal, or not at all. */
export function Layer({ open, ...rest }: Props) {
    return open ? createPortal(<elo-layer {...cx(cn.layer, rest)} />, document.body) : null
}

/** The in-place root is a plain div; the identity lives in a portal below it — R101. */
export function Hosted(props: Props) {
    return <div>{createPortal(<elo-hosted {...cx(cn.hosted, props)} />, document.body)}</div>
}

/** Two portals, each with the identity element — R104. */
export function Doubled(props: Props) {
    return (
        <>
            {createPortal(<elo-doubled {...cx(cn.doubled, props)} />, document.body)}
            {createPortal(<elo-doubled {...cx(cn.doubled, props)} />, document.body)}
        </>
    )
}
