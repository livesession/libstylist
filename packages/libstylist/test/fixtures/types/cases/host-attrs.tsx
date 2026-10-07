// Constructs that need no generated tag keys and no stub: cx() spread onto HTML hosts, SVG and every
// kind of component element (strict props included), identity markers, slot props typed CxAttrs,
// forwarded attributes and data literals. This file must compile cleanly in every configuration, on
// TS 4.9 and 5.x.
import * as React from "react"

import { cx, type CxAttrs } from "@livesession/libstylist/runtime"

import { alert as cn } from "../src/parts"

declare const open: boolean
declare const size: "small" | "large" | undefined
declare const count: number

// cx() on HTML hosts: parts, a data literal (any position), spreads inside it, nothing
export const hosts = (
    <div {...cx(cn.root, { size, open, count, "row-id": "r1" })}>
        <span {...cx(cn.icon, cn.content)} />
        <span {...cx(cn["group-label"], undefined, null, false)} />
        <span {...cx({ ...{ open }, size })} />
        <input {...cx(cn.content)} type="text" />
    </div>
)

// SVG keeps its geometry `cx` (number | string); parts spread like anywhere else
export const geometry = (
    <svg {...cx(cn.icon)} viewBox="0 0 10 10">
        <circle cx={5} cy={5} r={2} {...cx(cn.content)} />
        <ellipse cx="5" cy={5} rx={2} ry={1} />
        <radialGradient id="g" cx="50%" cy="50%" r="50%" />
    </svg>
)

// Components: none of them declares the part attributes; CxAttrs has only hyphenated keys
type BadgeProps = { tone?: "info" | "warn"; children?: React.ReactNode }
function Badge(props: BadgeProps) {
    return <span {...cx(props)}>{props.children}</span>
}

interface StrictProps {
    onClick: (event: React.MouseEvent) => void
    size: number
    title: string
}
function Strict(props: StrictProps) {
    return <button {...cx(props)} type="button" onClick={props.onClick} title={props.title} data-size={props.size} />
}

interface PanelProps {
    title: string
}
class Panel extends React.Component<PanelProps> {
    render() {
        return <section>{this.props.title}</section>
    }
}

// A named slot: callers pass a cx() value; the component merges it into the inner element's cx()
type FieldProps = { label: string; inputCx?: CxAttrs }
const Field = React.forwardRef<HTMLInputElement, FieldProps>(function Field({ label, inputCx }, ref) {
    return (
        <label>
            {label}
            <input ref={ref} {...cx(cn.content, inputCx)} />
        </label>
    )
})

const MemoBadge = React.memo(Badge)

export const components = (
    <>
        <Badge {...cx(cn.icon)} tone="info">
            x
        </Badge>
        <MemoBadge {...cx(cn.icon, { open })} />
        <Strict {...cx(cn.icon)} onClick={() => {}} size={1} title="t" />
        <Panel title="t" {...cx(cn.icon)} />
        <Field label="Name" {...cx(cn.content)} inputCx={cx(cn.icon, { wide: open })} ref={null} />
        <Field label="Name" inputCx={undefined} />
        {["a", "b"].map((key) => (
            <Badge key={key} {...cx(cn.icon)} />
        ))}
    </>
)

// Identity markers: hyphenated attribute names need no declaration, on native and component elements
export const markers = (
    <>
        <button elo-button type="button" {...cx(cn.root)} />
        <a elo-button href="#" />
        <Badge elo-modalconfirm {...cx(cn.root)} />
        <MemoBadge elo-tooltip />
        <Panel title="t" elo-panel />
        <Field label="x" elo-textinput />
    </>
)

// A CxAttrs value is an object of hyphenated keys; the transform's output shape type-checks too
export const slot: CxAttrs = { "_cxclass_elo-or4d4l": "", "elo-modalconfirm": "" }
export const compiled = <span _cxclass_elo-or4d4l="" elo-alert="" data-open="true" aria-hidden="true" />
