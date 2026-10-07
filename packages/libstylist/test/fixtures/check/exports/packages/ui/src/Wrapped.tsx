import * as React from "react"

import { wrapped as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

export const Memoed = React.memo(function Memoed(props: Props) {
    return <elo-memoed {...cx(cn.memoed, props)} />
})

export const Reffed = React.forwardRef<HTMLButtonElement, Props>(function Reffed(props, ref) {
    return <button elo-reffed ref={ref} {...cx(cn.reffed, props)} />
})

export const Both = React.memo(React.forwardRef<HTMLElement, Props>((props, _ref) => <elo-both {...cx(cn.both, props)} />))
