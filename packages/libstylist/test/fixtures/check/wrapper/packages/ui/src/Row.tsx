import * as React from "react"

import { row as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import { Action } from "./Action"

type RowProps = { indent?: boolean; children?: React.ReactNode }

/** FilterEditor-like: the row is the identity in both branches; the indent node is plain structure around it. */
export function Row({ indent, children, ...rest }: RowProps) {
    const row = (
        <elo-row {...cx(cn.row, rest)}>
            {children}
            <Action {...cx(cn.action)} tooltip="more" />
        </elo-row>
    )

    if (!indent) return row

    return (
        <div {...cx(cn.node)}>
            <span {...cx(cn.connector)} aria-hidden="true" />
            <div {...cx(cn.content)}>{row}</div>
        </div>
    )
}
