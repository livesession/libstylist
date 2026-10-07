import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

export function Thing(props: object) {
    return <elo-thing {...cx(props, { other: true })} />
}
