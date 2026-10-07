import * as React from "react"

import { tip as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type TipProps = { text?: string; children?: React.ReactNode }

/** Tooltip-like: its trigger is whatever the caller passes as children. */
export function Tip({ text, children, ...rest }: TipProps) {
    return (
        <elo-tip {...cx(cn.root, rest)}>
            {children}
            <span {...cx(cn.text)}>{text}</span>
        </elo-tip>
    )
}
