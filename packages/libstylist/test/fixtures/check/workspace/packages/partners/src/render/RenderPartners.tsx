import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { PartnersCard } from "#components"
import { renderPartners as cn } from "#css"

type Props = { partners?: string[] }

/** The smart layer: its own identity element around the dummy cards. */
export function RenderPartners({ partners = [], ...rest }: Props) {
    return (
        <crm-render-partners {...cx(cn.root, rest)}>
            {partners.map((p) => (
                <PartnersCard key={p} name={p} />
            ))}
        </crm-render-partners>
    )
}
