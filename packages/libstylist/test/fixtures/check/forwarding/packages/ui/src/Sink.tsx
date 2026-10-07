import * as React from "react"

import { sink as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

/** Its identity element never receives stylist props (R112) … */
export function Sink({ children }: Props) {
    return <elo-sink {...cx(cn.root)}>{children}</elo-sink>
}

/** … so a marker forwarded onto it never reaches the DOM (R106). */
export function Lost(props: Props) {
    return <Sink elo-lost {...cx(props)} />
}
