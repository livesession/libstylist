import * as React from "react"

import { broken as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import { Tip } from "./Tip"

type Props = { on?: boolean }

/** The identity is inside the wrapper only when `on` — R109. */
export function Maybe({ on, ...rest }: Props) {
    return <label>{on && <input elo-maybe {...cx(cn.maybe, rest)} />}</label>
}

/** Two identity elements inside one wrapper — R104. */
export function Twice(props: Props) {
    return (
        <div>
            <elo-twice {...cx(cn.twice, props)} />
            <elo-twice {...cx(cn.twice, props)} />
        </div>
    )
}

/** A wrapper around another component only: its own root is a plain div — R101. */
export function Boxed() {
    return (
        <div>
            <Tip text="boxed" />
        </div>
    )
}

/** The wrapped identity element doesn't receive stylist props — R112. */
export function Bare() {
    return (
        <label>
            <input elo-bare {...cx(cn.bare)} />
        </label>
    )
}
