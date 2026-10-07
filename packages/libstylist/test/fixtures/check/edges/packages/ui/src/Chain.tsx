import * as React from "react"

import { chain as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

export function Base({ children, ...rest }: Props) {
    return (
        <elo-base {...cx(cn.root, rest)}>
            {children}
        </elo-base>
    )
}

/** Two levels: Top → Mid (spreads the rest on) → Base: Top's marker reaches <elo-base>. */
export function Mid(props: Props) {
    return <Base elo-mid {...props} />
}
export function Top(props: Props) {
    return <Mid elo-top {...cx(props)} />
}

/** Mid2 passes nothing on — its delegate gets no props (R112), so Top2's marker is lost (R106). */
export function Mid2() {
    return <Base elo-mid2 />
}
export function Top2(props: Props) {
    return <Mid2 elo-top2 {...cx(props)} />
}

/** A caller's cx on Top reaches Base's DOM; on Mid2 it is lost — S307. */
export function Uses(props: Props) {
    return (
        <elo-uses {...cx(cn.uses, props)}>
            <Top {...cx(cn.top)} />
            <Mid2 {...cx(cn.mid2)} />
        </elo-uses>
    )
}
