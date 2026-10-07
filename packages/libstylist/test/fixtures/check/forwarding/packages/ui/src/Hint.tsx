import * as React from "react"

import { hint as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import { Pop } from "./Pop"

type HintProps = { text?: string; children?: React.ReactNode }

/** Tooltip-like: forwards its marker and every other prop (stylist props included) to Pop. */
export function Hint({ text, ...rest }: HintProps) {
    return <Pop elo-hint content={<span {...cx(cn.bubble)}>{text}</span>} {...rest} />
}

/** A valued marker: cx() drops it, so it never reaches Pop's DOM — R110. */
export function Valued({ text, ...rest }: HintProps) {
    return <Pop elo-valued="yes" content={text} {...rest} />
}
