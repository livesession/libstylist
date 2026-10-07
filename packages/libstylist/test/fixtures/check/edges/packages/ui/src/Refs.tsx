import * as React from "react"

import { refs as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

/** memo(forwardRef(arrow)) rendering a plain div — R101. */
export const MemoDiv = React.memo(React.forwardRef<HTMLDivElement, Props>((props, ref) => <div ref={ref} {...props} />))

/** forwardRef whose identity element's cx() never receives the props — R112. */
export const RefNoFwd = React.forwardRef<HTMLButtonElement, Props>(function RefNoFwd(props, ref) {
    return (
        <button elo-refnofwd ref={ref} {...cx(cn.refnofwd)}>
            {props.children}
        </button>
    )
})

function ProviderImpl(props: Props) {
    return <>{props.children}</>
}

/** @libstylistRoot none renders only the children it is given, no DOM of its own */
export const MemoProvider = React.memo(ProviderImpl)

/** @libstylistRoot none a `none` exemption never excuses a real generic root */
export function NotNone(props: Props) {
    return <div {...cx(props)}>{props.children}</div>
}
