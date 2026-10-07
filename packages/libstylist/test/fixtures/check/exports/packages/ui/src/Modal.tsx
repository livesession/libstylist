import * as React from "react"

import { modal as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

function ModalBase(props: Props) {
    return (
        <elo-modal {...cx(cn.root, props)}>
            {props.children}
        </elo-modal>
    )
}

function ModalHeader(props: Props) {
    return (
        <header elo-modal-header {...cx(cn.header, props)}>
            {props.children}
        </header>
    )
}

export function useModal(): number {
    return 1
}

export const Modal = Object.assign(ModalBase, { Header: ModalHeader, displayName: "Modal" })
