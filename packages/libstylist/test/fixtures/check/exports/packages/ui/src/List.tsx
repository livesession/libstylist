import * as React from "react"

import { list as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

type Props = { children?: React.ReactNode }

function ListRoot(props: Props) {
    return <elo-list {...cx(cn.root, props)} />
}

function ListItem(props: Props) {
    return <li elo-list-item {...cx(cn.item, props)} />
}

export const List = { Root: ListRoot, Item: ListItem }
