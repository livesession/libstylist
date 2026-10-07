import * as React from "react"

import { box as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { title?: string; items?: string[]; children?: React.ReactNode }

/** Body destructuring of the props parameter (through `as`): its rest is the component's props. */
export function Box(props: Props) {
    const { title: _title, ...rest } = props as Props
    return <elo-box {...cx(cn.root, rest)}>{props.children}</elo-box>
}

/** A const alias of a forwarding cx() call. */
export function Aliased(props: Props) {
    const forwarded = cx(props)
    return <elo-aliased {...cx(cn.aliased, forwarded)} />
}

/** forwardRef's second parameter is the ref, not the component's props: R112. */
export const Listed = React.forwardRef<HTMLElement, Props>((_props, ref) => <elo-listed {...cx(cn.listed, ref)} />)

/** A local helper closes over the rest of the component's parameter. */
export function Mapped({ items = [], ...rest }: Props) {
    const renderRoot = () => <elo-mapped {...cx(cn.mapped, rest)}>{items.join(", ")}</elo-mapped>
    return renderRoot()
}
