import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { partnersCard as cn } from "#css"

type Props = { name?: string }

/** The dummy layer: one partner (namespace core, tag crm-partnerscard). */
export function PartnersCard({ name, ...rest }: Props) {
    return <crm-partnerscard {...cx(cn.root, rest)}>{name}</crm-partnerscard>
}
