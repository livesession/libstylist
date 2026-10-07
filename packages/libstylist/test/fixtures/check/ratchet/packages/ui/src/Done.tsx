import * as React from "react"

import { done as cn } from "@fx/css"
import { cx, legacy, legacyClassName } from "@livesession/libstylist/runtime"

interface DoneProps {
    children?: React.ReactNode
    /**
     * Legacy class name, applied until every caller styles Done with `cx`.
     * @deprecated Use `cx`; removed in the next major.
     */
    className?: string
}

/** Migrated; still carries the counted migration helpers. */
export function Done({ children, className, ...rest }: DoneProps) {
    return (
        <elo-done {...cx(cn.root, rest)} className={legacyClassName(className)}>
            <span {...cx(cn.inner)} className={legacy("icon-wrapper")}>
                {children}
            </span>
        </elo-done>
    )
}
