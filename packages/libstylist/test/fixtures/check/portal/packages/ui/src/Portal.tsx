import * as React from "react"
import { createPortal } from "react-dom"

import { layer as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import * as Pop from "../../../vendor/@radix-ui/react-popover"

type Props = { open?: boolean; children?: React.ReactNode }

export function Overlay(props: Props) {
    return createPortal(<elo-overlay {...cx(cn.overlay, props)} />, document.body)
}

export function Floating(props: Props) {
    return (
        <>
            <elo-floating {...cx(cn.floating, props)} />
            {props.open && createPortal(<div>floating layer</div>, document.body)}
        </>
    )
}

/** @libstylistRoot native the Radix asChild trigger merges its props onto the host span */
export function Hint(props: Props) {
    return (
        <Pop.Root>
            <Pop.Trigger asChild>
                <span elo-hint {...cx(cn.hint, props)}>
                    {props.children}
                </span>
            </Pop.Trigger>
            {props.open && (
                <Pop.Portal>
                    <Pop.Content>tip</Pop.Content>
                </Pop.Portal>
            )}
        </Pop.Root>
    )
}

export function Tip(props: Props) {
    return (
        <Pop.Root>
            <Pop.Trigger asChild>
                <span elo-tip {...cx(cn.tip, props)} />
            </Pop.Trigger>
        </Pop.Root>
    )
}

export function Opener() {
    return (
        <Pop.Root>
            <Pop.Trigger>open</Pop.Trigger>
        </Pop.Root>
    )
}
