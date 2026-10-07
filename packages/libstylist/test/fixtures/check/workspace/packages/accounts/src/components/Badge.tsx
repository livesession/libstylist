import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

/** A badge — @fx/partners exports a Badge too: one tag, two owners (T201). */
export function Badge(props: Props) {
    return <b crm-badge {...cx(props)}>{props.children}</b>
}
