import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

function MenuBase(props: Props) {
    return <elo-menu {...cx(props)} />
}

function MenuRoot(props: Props) {
    return <elo-menu {...cx(props, { root: true })} />
}

export const Menu = Object.assign(MenuBase, { Root: MenuRoot })

export function Badge(props: Props) {
    return <elo-badge {...cx(props)} />
}

export function Card(props: Props) {
    return (
        <elo-card {...cx(props)}>
            <elo-badge />
            <elo-ghost />
            <span elo-phantom />
        </elo-card>
    )
}

const renderCardLike = (props: Props) => <elo-card {...cx(props)} />

export function Other(props: Props) {
    return renderCardLike(props)
}
