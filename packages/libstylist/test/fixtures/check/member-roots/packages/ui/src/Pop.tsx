import * as React from "react"

import { pop as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

import * as P from "../../../vendor/@radix-ui/react-popover"

type Props = { content?: React.ReactNode; children?: React.ReactNode }

/**
 * Popover-like: the trigger span is the identity; the portaled panel is the member root Pop.Content.
 * @libstylistRoot native the Radix asChild trigger writes boolean ARIA onto its host span
 */
export function Pop({ content, children, ...rest }: Props) {
    return (
        <P.Root>
            <P.Trigger asChild>
                <span elo-pop {...cx(rest)}>
                    {children}
                </span>
            </P.Trigger>
            {content != null && (
                <P.Portal>
                    <P.Content elo-pop-content {...cx(cn.content)}>
                        {content}
                    </P.Content>
                </P.Portal>
            )}
        </P.Root>
    )
}
