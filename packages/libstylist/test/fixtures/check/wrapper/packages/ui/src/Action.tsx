import * as React from "react"

import { action as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import { Tip } from "./Tip"

type ActionProps = { label?: string; tooltip?: string; as?: "button" | "a"; children?: React.ReactNode }

/** Button-like: a polymorphic identity, optionally wrapped in a <label> and/or a Tip (slot identity). */
export function Action({ label, tooltip, as: As = "button", children, ...rest }: ActionProps) {
    const renderAction = () => (
        <As elo-action {...cx(cn.root, rest)}>
            {children}
        </As>
    )

    const content = label ? (
        <label>
            <span {...cx(cn.label)}>{label}</span>
            {renderAction()}
        </label>
    ) : (
        renderAction()
    )

    if (tooltip) {
        return <Tip text={tooltip}>{content}</Tip>
    }

    return content
}
