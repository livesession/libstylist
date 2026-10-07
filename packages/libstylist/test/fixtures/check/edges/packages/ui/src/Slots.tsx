import * as React from "react"

import { slots as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type CxSlot = Record<string, string>

export interface FieldProps {
    /** Parts for the inner input. */
    inputCx?: CxSlot
    children?: React.ReactNode
}

/** TextInput-like: the inputCx slot lands on the inner input. */
export function Field({ inputCx, children, ...rest }: FieldProps) {
    return (
        <elo-field {...cx(cn.root, rest)}>
            {children}
            <input {...cx(cn.input, inputCx)} />
        </elo-field>
    )
}

/** Tooltip-like: declares Field's slots and passes them on with the rest of its props. */
export function Relay(props: FieldProps) {
    return <Field elo-relay {...props} />
}

/** Declares the slot but never spreads it. */
export function Dropper({ inputCx: _inputCx, ...rest }: FieldProps) {
    return <elo-dropper {...cx(cn.dropper, rest)} />
}

export function SlotUser(props: { children?: React.ReactNode }) {
    return (
        <elo-slotuser {...cx(cn.slotuser, props)}>
            <Field inputCx={cx(cn["field-input"])} />
            <Relay inputCx={cx(cn["field-input"])} />
            <Dropper inputCx={cx(cn["field-input"])} />
            <Field labelCx={cx(cn["field-input"])} />
        </elo-slotuser>
    )
}
