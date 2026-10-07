import * as React from "react"

import { card as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { src?: string }

/** The member root Card.Media is rendered without its bound part `media` — S303. */
export function Card({ src, ...rest }: Props) {
    return (
        <elo-card {...cx(cn.root, rest)}>
            <img elo-card-media src={src} alt="" />
        </elo-card>
    )
}
