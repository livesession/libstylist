import * as React from "react"

import { drawer as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

/** drawer.css binds Drawer.Body, but nothing renders elo-drawer-body — S303. */
export function Drawer({ children, ...rest }: Props) {
    return (
        <elo-drawer {...cx(cn.root, rest)}>
            <div {...cx(cn.body)}>{children}</div>
        </elo-drawer>
    )
}
