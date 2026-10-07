import * as React from "react"

import { Dialog } from "./Dialog"

type FooterProps = { onOk?: () => void }

/** No DOM of its own: the marker rides on the delegate's member. */
function ConfirmFooter({ onOk }: FooterProps) {
    return (
        <Dialog.Footer elo-confirm-footer>
            <button type="button" onClick={onOk}>
                OK
            </button>
        </Dialog.Footer>
    )
}

type ConfirmProps = { title: string; onOk?: () => void }

/** No DOM of its own: <elo-dialog elo-confirm>. It passes no props on (R112), so a caller's cx is lost. */
function ConfirmBase({ title, onOk }: ConfirmProps) {
    return (
        <Dialog elo-confirm title={title}>
            <ConfirmFooter onOk={onOk} />
        </Dialog>
    )
}

export const Confirm = Object.assign(ConfirmBase, { Footer: ConfirmFooter })
