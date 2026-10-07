import * as React from "react"

import { roots as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { open?: boolean; children?: React.ReactNode }

const Ctx = React.createContext(0)
declare function computeNode(): React.ReactNode

export function Generic() {
    return <div />
}

export function Native() {
    return <button type="button" />
}

export function Wrong(props: Props) {
    return <elo-other {...cx(cn.wrong, props)} />
}

export function Passthrough(props: Props) {
    return <>{props.children}</>
}

export function Computed() {
    return <>{computeNode()}</>
}

export function Texty() {
    return <>hello</>
}

export function Framed(props: Props) {
    return <React.Suspense fallback={null}>{React.createElement("div")}</React.Suspense>
}

export function NoForward() {
    return <elo-noforward {...cx(cn.noforward)} />
}

export function NoPart(props: Props) {
    return <elo-nopart {...cx(props)} />
}

export function Wrapped(props: Props) {
    return (
        <React.Fragment>
            <Ctx.Provider value={1}>
                <React.Suspense fallback={null}>
                    <elo-wrapped {...cx(cn.wrapped, props)} />
                </React.Suspense>
            </Ctx.Provider>
        </React.Fragment>
    )
}

export function ViaConst(props: Props) {
    const forwarded = cx(props)
    return <elo-viaconst {...cx(cn.viaconst)} {...forwarded} />
}

function Shell(props: Props) {
    return (
        <elo-shell {...cx(cn.shell, props)}>
            {props.children}
        </elo-shell>
    )
}

export function Inlined(props: Props) {
    return <InnerShell {...props} />
}

function InnerShell(props: Props) {
    return <elo-inlined {...cx(cn.inlined, props)} />
}

export function Blocked() {
    return <InnerBlocked />
}

function InnerBlocked(props: Props) {
    return <elo-blocked {...cx(cn.blocked, props)} />
}

function Frame({ children }: Props) {
    return <Ctx.Provider value={2}>{children}</Ctx.Provider>
}

export function Framed2(props: Props) {
    return (
        <Frame>
            <elo-framed2 {...cx(cn.framed2, props)} />
        </Frame>
    )
}

export { Shell }
