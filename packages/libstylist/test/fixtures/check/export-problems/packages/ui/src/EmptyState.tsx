import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

export function Shade(props: object) {
    return <elo-emptystate-shade {...cx(props)} />
}

function EmptyStateBase(props: object) {
    return <elo-emptystate {...cx(props)} />
}

export const EmptyState = Object.assign(EmptyStateBase, { Shade })
