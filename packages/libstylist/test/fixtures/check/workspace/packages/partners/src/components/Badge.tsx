import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

/** Planted: @fx/accounts exports a Badge too — both are <crm-badge> (T201). */
export function Badge(props: Props) {
    return <b crm-badge {...cx(props)}>{props.children}</b>
}
