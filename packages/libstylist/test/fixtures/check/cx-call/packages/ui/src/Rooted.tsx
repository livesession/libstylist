import * as React from "react"

import { rooted as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

/** T11: misses its root part — the message names the part as this file writes it (`cn.root`). */
export function Rooted({ children, ...rest }: Props) {
    return <elo-rooted {...cx(cn.icon, rest)}>{children}</elo-rooted>
}
