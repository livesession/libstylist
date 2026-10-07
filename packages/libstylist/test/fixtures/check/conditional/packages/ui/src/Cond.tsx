import * as React from "react"

import { cond as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { open?: boolean; kind?: "a" | "b"; children?: React.ReactNode }

export function Early(props: Props) {
    if (!props.open) return null
    return <elo-early {...cx(cn.early, props)} />
}

export function Ternary(props: Props) {
    return props.open ? <elo-ternary {...cx(cn.ternary, props)} /> : null
}

export function AndAnd(props: Props) {
    return props.open && <elo-andand {...cx(cn.andand, props)} />
}

export function Helper(props: Props) {
    const renderInner = () => <elo-helper {...cx(cn.helper, props)} />
    const content = props.open ? renderInner() : null
    return content
}

export function LetVar(props: Props) {
    let node: React.ReactNode = null
    if (props.open) node = <elo-letvar {...cx(cn.letvar, props)} />
    return <>{node}</>
}

export function Wrapped(props: Props) {
    return (
        <>
            {props.open ? (
                <elo-wrapped {...cx(cn.wrapped, props)}>
                    {props.children}
                </elo-wrapped>
            ) : null}
        </>
    )
}

export function Branchy(props: Props) {
    if (props.kind === "a") return <elo-branchy {...cx(cn.branchy, props)} />
    return <div {...cx(props)} />
}

export function Nothing() {
    return null
}
