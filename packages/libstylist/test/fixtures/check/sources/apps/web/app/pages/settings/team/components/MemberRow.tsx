import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { memberRow as cn } from "#css"

type Props = { name: string }

/** One member of the team page: its own identity element. */
export function MemberRow({ name, ...rest }: Props) {
    return (
        <crm-settings-memberrow {...cx(cn.root, rest)}>
            <span {...cx(cn.name)}>{name}</span>
        </crm-settings-memberrow>
    )
}
