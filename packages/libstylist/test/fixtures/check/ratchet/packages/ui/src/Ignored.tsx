import * as React from "react"

interface IgnoredProps {
    /**
     * Accepted for source compatibility only.
     * @deprecated Never applied; removed in the next major.
     */
    inputClassName?: string
    /** Not deprecated: an error on a migrated component (S308). */
    labelClassName?: string
}

/** Migrated by its identity alone (no cx() call). */
export function Ignored({ inputClassName, labelClassName, ...rest }: IgnoredProps) {
    return <section elo-ignored {...rest} data-label={labelClassName} />
}
