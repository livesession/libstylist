import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { cart as cn } from "#css"

type Props = { children?: React.ReactNode }

/** The dummy layer: the cart panel (namespace core, a marker root: <section app-cart>). */
export function Cart({ children, ...rest }: Props) {
    return <section app-cart {...cx(cn.root, rest)}>{children}</section>
}
