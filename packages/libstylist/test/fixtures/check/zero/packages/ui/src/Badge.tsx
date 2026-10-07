import * as React from "react"

import { badge as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type BadgeProps = { children?: React.ReactNode }

export function Badge({ children, ...rest }: BadgeProps) {
    return (
        <elo-badge {...cx(cn.root, rest)}>
            <span {...cx(cn.label)}>{children}</span>
        </elo-badge>
    )
}
