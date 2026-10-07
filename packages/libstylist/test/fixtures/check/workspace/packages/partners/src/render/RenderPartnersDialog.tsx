import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { Modal } from "../../../../vendor/ds"

type Props = { children?: React.ReactNode }

/** Planted: a design-system component at the root without this component's marker (R106). */
export function RenderPartnersDialog({ children, ...rest }: Props) {
    return (
        <Modal title="Partners" {...cx(rest)}>
            {children}
        </Modal>
    )
}
