import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { renderAccountsTable as cn } from "#css"

import { Table } from "../../../../vendor/ds"

type Props = { rows?: string[] }

/** Roots on the design system's <Table> with its marker — a libstylist delegate, no wrapper element. */
export function RenderAccountsTable({ rows, ...rest }: Props) {
    return <Table crm-render-accountstable {...cx(cn.root, rest)} rows={rows} />
}
