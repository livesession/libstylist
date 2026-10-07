import * as React from "react"

import { pop as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type PopProps = { content?: React.ReactNode; children?: React.ReactNode }

export function Pop({ content, children, ...rest }: PopProps) {
    return (
        <elo-pop {...cx(cn.root, rest)}>
            {children}
            {content}
        </elo-pop>
    )
}
