import * as React from "react"

import { wraps as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { alt?: boolean; items?: string[]; children?: React.ReactNode }

/** Two levels of plain structure around the identity element. */
export function Deep({ alt, ...rest }: Props) {
    return (
        <label {...cx(cn.field)}>
            <div {...cx(cn.frame)}>
                {alt ? <elo-deep {...cx(cn.root, rest, { alt: "" })} /> : <elo-deep {...cx(cn.root, rest)} />}
            </div>
        </label>
    )
}

function Frame({ children }: Props) {
    return <div {...cx(cn.frame)}>{children}</div>
}

/** An internal (non-exported) component as the wrapper. */
export function Framed(props: Props) {
    return (
        <Frame>
            <elo-framed {...cx(cn.framed, props)} />
        </Frame>
    )
}

/** The identity inside a list is not one element — the root <ul> needs the marker (R102). */
export function Listed({ items = [], ...rest }: Props) {
    return (
        <ul {...cx(cn.list)}>
            {items.map((item) => (
                <li key={item} elo-listed {...cx(rest)}>
                    {item}
                </li>
            ))}
        </ul>
    )
}

const field = (inner: React.ReactNode) => <label {...cx(cn.field)}>{inner}</label>

/** One helper renders the wrapper in both branches; only one of them has the identity inside (R102 on the other). */
export function Helpered({ alt, ...rest }: Props) {
    return alt ? field(<input elo-helpered {...cx(cn.helpered, rest)} />) : field(<span>off</span>)
}

/** A helper taking an options object: the identity it wraps is found through the destructured parameter. */
export function Optioned({ alt, ...rest }: Props) {
    const wrap = ({ child, note }: { child: React.ReactNode; note: string }) => (
        <label {...cx(cn.field)}>
            {child}
            {note}
        </label>
    )
    return wrap({ child: <input elo-optioned {...cx(cn.optioned, rest)} disabled={alt} />, note: "n" })
}

/** The same, with a shorthand property naming a local const. */
export function Shorthanded({ alt, ...rest }: Props) {
    const wrap = ({ child }: { child: React.ReactNode }) => <label {...cx(cn.field)}>{child}</label>
    const child = <input elo-shorthanded {...cx(cn.shorthanded, rest)} disabled={alt} />
    return wrap({ child })
}
