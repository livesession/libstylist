import * as React from "react"

import { field as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

export interface FieldProps extends React.HTMLAttributes<HTMLElement> {
    inputClassName?: string
}

export function Field({ inputClassName, ...props }: FieldProps) {
    return (
        <label elo-field {...cx(cn.root, props)}>
            <input {...cx(cn.input, { class: inputClassName })} />
        </label>
    )
}
