import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { DataGrid } from "../../../../vendor/grid"

type Props = { rows?: string[] }

/** Planted: a third-party component at the root, without an identity element around it (R105). */
export function RenderPartnersGrid({ rows, ...rest }: Props) {
    return <DataGrid rows={rows} {...cx(rest)} />
}
