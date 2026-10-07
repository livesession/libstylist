import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { accountsList as cn } from "#css"

type Props = { accounts?: string[] }

/** The dummy layer: a list of account names (namespace core, tag crm-accountslist). */
export function AccountsList({ accounts = [], ...rest }: Props) {
    return (
        <ul crm-accountslist {...cx(cn.root, rest)}>
            {accounts.map((a) => (
                <li key={a} {...cx(cn.row)}>
                    {a}
                </li>
            ))}
        </ul>
    )
}
