import * as React from "react"

import { card as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

export function Card(props: Props) {
    return <elo-card {...cx(cn.root, props)} />
}

function CardBody(props: Props) {
    // wrong identity: the member's tag is elo-card-body — R103 (and T203: elo-card is Card's)
    return <elo-card {...cx(cn.body, props)} />
}

Card.Body = CardBody
Card.displayName = "Card"
/** @libstylistRoot none the footer renders only what it is given here */
Card.Footer = function CardFooter(props: Props) {
    return <>{props.children}</>
}
