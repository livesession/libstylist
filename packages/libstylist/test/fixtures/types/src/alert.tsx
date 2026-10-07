// Package-style source: a custom-tag root with cx() parts, forwarded props, data, ARIA, events, refs,
// spreads and children. genTagTypes scans src/, so every custom tag opened here is listed in
// types/stylist-tags.gen.d.ts.
import * as React from "react"

import { cx, hostProps } from "@livesession/libstylist/runtime"

import { alert as cn } from "./parts"

export interface AlertProps {
    title?: string
    open?: boolean
    id?: string
    children?: React.ReactNode
}

export function Alert(props: AlertProps) {
    const { title, open, children, ...rest } = props
    const ref = React.useRef<HTMLElement>(null)
    return (
        <elo-alert
            ref={ref}
            {...cx(cn.root, props, { variant: "info", hasTitle: !!title, open })}
            role="status"
            aria-live="polite"
            onClick={(event) => event.currentTarget.focus()}
            {...hostProps(rest)}
        >
            <span {...cx(cn.icon)} />
            {/* <elo-commented-out> is a comment, not a tag */}
            <span {...cx(cn.content)} title="<elo-in-an-attribute>">
                {title}
            </span>
            {children}
        </elo-alert>
    )
}

// A root that used to be a <div>/<span> keeps its ref types: the element is an HTMLElement at
// runtime, and React's ref callbacks are bivariant, so div- and span-typed refs are accepted.
export const AlertTitle = React.forwardRef<HTMLDivElement, { children?: React.ReactNode }>(function AlertTitle(props, ref) {
    const spanRef = React.useRef<HTMLSpanElement>(null)
    return (
        <elo-alert-title ref={ref} {...cx(cn["group-label"], props)}>
            <elo-alert-badge ref={spanRef} />
            {/* JSX allows whitespace between "<" and the name; the scan still finds the tag */}
            <
                elo-alert-spaced
            />
            {props.children}
        </elo-alert-title>
    )
})
