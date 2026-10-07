import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { settingsPage as cn } from "#css"

type Props = { title: string; children?: React.ReactNode }

/** The frame of every settings page (namespace settings, the word Settings stripped: <crm-settings-page>). */
export function SettingsPage({ title, children, ...rest }: Props) {
    return (
        <crm-settings-page {...cx(cn.root, rest)}>
            <h1 {...cx(cn.title)}>{title}</h1>
            {children}
        </crm-settings-page>
    )
}
