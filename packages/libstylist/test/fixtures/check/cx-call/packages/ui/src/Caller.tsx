import * as React from "react"

import { caller as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import { Aliased, Box } from "./Box"
import { Button } from "./Button"
import { Confirmish } from "./Panel"
import { Space } from "./Space"

type Props = { open?: boolean; children?: React.ReactNode }

export function Caller({ open, ...rest }: Props) {
    return (
        <elo-caller {...cx(cn.root, rest)}>
            <Space {...cx(cn.action)}>lost: Space forwards `style`, not its props</Space>
            <Box {...cx(cn.box)}>reaches Box's root</Box>
            <Aliased {...cx(cn.aliased)} />
            <Button {...cx(cn.close, { open })}>lost data: a component forwards parts and markers only</Button>
            <Confirmish {...cx(cn.confirm)} title="lost: Confirmish passes no props on" />
        </elo-caller>
    )
}
