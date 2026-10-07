import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { Cart } from "#components"
import { renderCart as cn } from "#css"

type Props = { items?: string[] }

/** The smart layer: its own identity element around the dummy cart (namespace render, <app-render-cart>). */
export function RenderCart({ items = [], ...rest }: Props) {
    return (
        <app-render-cart {...cx(cn.root, rest)}>
            <Cart>{items.join(", ")}</Cart>
        </app-render-cart>
    )
}
