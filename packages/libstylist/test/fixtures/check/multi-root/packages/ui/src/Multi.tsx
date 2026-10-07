import * as React from "react"

import { multi as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { open?: boolean }

export function Pair(props: Props) {
    return (
        <>
            <elo-pair {...cx(cn.pair, props)} />
            <span>caption</span>
        </>
    )
}

/**
 * A switch: the visible control plus a hidden native input for forms.
 * @libstylistRoot multi the hidden checkbox must stay a sibling for form submission
 */
export function Toggle(props: Props) {
    return (
        <>
            <button elo-toggle {...cx(cn.toggle, props)} />
            {props.open && <input type="checkbox" hidden />}
        </>
    )
}

export function Twins() {
    return (
        <>
            <div />
            <div />
        </>
    )
}

/** @libstylistRoot multi two identity elements are never allowed, even here */
export function Double(props: Props) {
    return (
        <>
            <elo-double {...cx(cn.double, props)} />
            <elo-double {...cx(cn.double, props)} />
        </>
    )
}
