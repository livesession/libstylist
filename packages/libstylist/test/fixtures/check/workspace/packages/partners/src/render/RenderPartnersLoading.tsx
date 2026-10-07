import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { Loader } from "../../../../vendor/ds"

type Props = Record<string, unknown>

/** Planted: its marker forwarded onto the design system's DOM-less <Loader> never reaches the DOM (R106). */
export function RenderPartnersLoading(props: Props) {
    return <Loader crm-render-partnersloading {...cx(props)} />
}
