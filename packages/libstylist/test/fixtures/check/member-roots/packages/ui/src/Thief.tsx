import * as React from "react"

import { thief as cn, pop } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

/** Renders Pop's member root in its own file — T203. */
export function Thief(props: Props) {
    return (
        <elo-thief {...cx(cn.root, props)}>
            <div elo-pop-content {...cx(pop.content)} />
        </elo-thief>
    )
}
