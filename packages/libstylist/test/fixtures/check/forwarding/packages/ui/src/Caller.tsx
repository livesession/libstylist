import * as React from "react"

import { caller as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import { Confirm } from "./Confirm"
import { Hint } from "./Hint"

type Props = { children?: React.ReactNode }

export function Caller(props: Props) {
    return (
        <elo-caller {...cx(cn.root, props)}>
            <Hint {...cx(cn.hint)} text="reaches Pop's root" />
            <Confirm {...cx(cn.confirm)} title="lost: Confirm passes no props on" />
        </elo-caller>
    )
}
