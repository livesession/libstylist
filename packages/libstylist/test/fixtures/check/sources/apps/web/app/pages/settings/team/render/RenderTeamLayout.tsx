import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { SettingsPage } from "~/pages/settings/components"

type Props = { children?: React.ReactNode }

/** The layout's frame, an internal component: the owner's marker and the caller's parts go onto the page frame. */
function TeamFrame({ children, ...rest }: Props) {
    return (
        <SettingsPage crm-settings-renderteamlayout {...cx(rest)} title="Team">
            {children}
        </SettingsPage>
    )
}

/** The team area's layout, rendered through its internal frame (no part of its own). */
export function RenderTeamLayout(props: Props) {
    return <TeamFrame {...props} />
}
