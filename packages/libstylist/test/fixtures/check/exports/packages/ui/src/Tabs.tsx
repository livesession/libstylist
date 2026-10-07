import * as React from "react"

import { tabs as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

export type PanelProps = { children?: React.ReactNode }

export function Tabs(props: PanelProps) {
    return (
        <elo-tabs {...cx(cn.root, props)}>
            {props.children}
        </elo-tabs>
    )
}

function TabsItem(props: PanelProps) {
    return <li elo-tabs-item {...cx(cn.item, props)} />
}

Tabs.Item = TabsItem
Tabs.Panel = function Panel(props: PanelProps) {
    return <elo-tabs-panel {...cx(cn.panel, props)} />
}
