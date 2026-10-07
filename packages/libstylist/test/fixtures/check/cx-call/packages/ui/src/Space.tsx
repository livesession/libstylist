import * as React from "react"

import { space as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { gap?: number; style?: React.CSSProperties; children?: React.ReactNode }

/** T7: `style` is one of its props, not its props — a caller's parts never reach the DOM (R112). */
export function Space({ gap, style, children, ...rest }: Props) {
    void rest
    return <elo-space {...cx(cn.root, style, { gap })}>{children}</elo-space>
}
