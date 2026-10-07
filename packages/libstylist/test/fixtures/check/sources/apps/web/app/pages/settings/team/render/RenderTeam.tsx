import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { renderTeam as cn } from "#css"
import { SettingsPage } from "~/pages/settings/components"
import { MemberRow } from "~/pages/settings/team/components"

type Props = { members?: string[] }

/** The team page: roots on the area's page frame, imported through the `~/` alias, with its marker. */
export function RenderTeam({ members = [], ...rest }: Props) {
    return (
        <SettingsPage crm-settings-renderteam {...cx(cn.root, rest)} title="Team">
            <ul {...cx(cn.list)}>
                {members.map((m) => (
                    <MemberRow key={m} name={m} />
                ))}
            </ul>
        </SettingsPage>
    )
}
