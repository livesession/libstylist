import * as React from "react"

import { icons as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

/** A member of the `Icons` module namespace: <svg elo-icons-close>. */
export function Close(props: { size?: number }) {
    return <svg elo-icons-close {...cx(cn.close, props)} />
}

/** Wrong: the namespace member's marker is elo-icons-open — R103. */
export function Open(props: { size?: number }) {
    return <svg elo-open {...cx(cn.open, props)} />
}
