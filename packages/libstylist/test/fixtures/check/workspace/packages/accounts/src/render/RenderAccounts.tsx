import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { AccountsList } from "#components"
import { renderAccounts as cn } from "#css"

type Props = { accounts?: string[] }

/**
 * The smart layer over AccountsList (namespace render: RenderAccounts → crm-render-accounts): it owns no
 * DOM and forwards its marker onto the list, a component of its own package imported through #components.
 */
export function RenderAccounts(props: Props) {
    return <AccountsList crm-render-accounts {...cx(cn.root, props)} accounts={props.accounts} />
}
