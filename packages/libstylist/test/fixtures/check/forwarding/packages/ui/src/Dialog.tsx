import * as React from "react"

import { dialog as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { title?: string; children?: React.ReactNode }

function DialogBase({ title, children, ...rest }: Props) {
    return (
        <elo-dialog {...cx(cn.root, rest)}>
            {title}
            {children}
        </elo-dialog>
    )
}

function DialogFooter({ children, ...rest }: Props) {
    return (
        <elo-dialog-footer {...cx(cn.footer, rest)}>
            {children}
        </elo-dialog-footer>
    )
}

export const Dialog = Object.assign(DialogBase, { Footer: DialogFooter })
