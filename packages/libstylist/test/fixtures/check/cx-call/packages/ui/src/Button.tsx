import * as React from "react"

import { button as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { as?: "button" | "a"; children?: React.ReactNode }

/** Polymorphic: the data literal on its own host `As` (a parameter binding, not a component) renders. */
export function Button({ as: As = "button", children, ...rest }: Props) {
    return (
        <As elo-button {...cx(cn.root, rest, { kind: "primary" })}>
            {children}
        </As>
    )
}
