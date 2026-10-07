import * as React from "react"

import { exempt as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import { Widget } from "../../../vendor/widget"

const Ctx = React.createContext(0)

type Props = { children?: React.ReactNode }

/** @libstylistRoot none context provider that renders only its children */
export function Provider(props: Props) {
    return <Ctx.Provider value={1}>{props.children}</Ctx.Provider>
}

/** @libstylistRoot none renders nothing at all, it only subscribes */
export function Listener() {
    return null
}

/** @libstylistRoot none this component already has a proper root */
export function Fine(props: Props) {
    return <elo-fine {...cx(cn.fine, props)} />
}

/** @libstylistRoot bogus some reason that is long enough */
export function Bogus() {
    return <div />
}

/** @libstylistRoot none too short */
export function Short() {
    return null
}

/**
 * @libstylistRoot none renders nothing at all in production
 * @libstylistRoot multi a second tag on the same component
 */
export function Twice() {
    return null
}

/** @libstylistRoot native a third-party widget host managed by the vendor */
export const Vendor = (props: Props) => <Widget elo-vendor {...cx(cn.vendor, props)} />

/** @libstylistRoot none helpers are never exported components */
export function renderHelper() {
    return null
}
