import * as React from "react"

import { pairs as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

/** Carries the sheet's implied root part. */
export function PairA(props: Props) {
    return <elo-paira {...cx(cn.root, props)} />
}

/** A second identity element of the same file: the implied `pairs:root` binding is PairA's. */
export function PairB(props: Props) {
    return <elo-pairb {...cx(cn.b, props)} />
}
