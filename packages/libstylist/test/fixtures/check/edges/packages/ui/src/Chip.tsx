import * as React from "react"

import { chip as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

/** Exported only under the renamed path Pill. */
export function Chip(props: { children?: React.ReactNode }) {
    return <elo-pill {...cx(cn.root, props)} />
}
