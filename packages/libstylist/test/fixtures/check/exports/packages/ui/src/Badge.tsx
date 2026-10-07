import * as React from "react"

import { badge as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

export function Badge(props: { children?: React.ReactNode }) {
    return <elo-tag {...cx(cn.root, props)} />
}
