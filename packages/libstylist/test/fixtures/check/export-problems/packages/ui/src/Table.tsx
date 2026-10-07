import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

const AnyButton = ((props: any) => <button elo-table-button {...cx(props)} />) as any

const makeRow = () => (props: object) => <elo-table-row {...cx(props)} />

function TableBase(props: { children?: React.ReactNode }) {
    return <elo-table {...cx(props)}>{props.children}</elo-table>
}

export const Table = Object.assign(TableBase, { Button: AnyButton, Row: makeRow() })
