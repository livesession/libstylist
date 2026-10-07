import * as React from "react"

import { def as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

export default function Def(props: { children?: React.ReactNode }) {
    return <section elo-def {...cx(cn.root, props)} />
}
