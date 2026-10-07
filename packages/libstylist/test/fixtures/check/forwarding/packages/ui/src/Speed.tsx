import * as React from "react"

import { speed as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import { Menu } from "./Menu"

type Props = { speed?: number }

/** SpeedMenu-like: the marker rides through the (unmigrated) Menu onto Pop's identity element. */
export function Speed({ speed, ...rest }: Props) {
    return (
        <Menu elo-speed {...cx(rest)} items={["1", "2"]}>
            <button type="button" {...cx(cn.option)}>
                x{speed}
            </button>
        </Menu>
    )
}
