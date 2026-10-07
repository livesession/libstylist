import * as React from "react"

import { Pop } from "./Pop"

type MenuProps = { items?: string[]; children?: React.ReactNode }

/** Not migrated yet (no pragma, no identity): a Dropdown-like wrapper that spreads the rest onto Pop. */
export function Menu({ items, ...rest }: MenuProps) {
    return <Pop content={items?.join(", ")} {...rest} />
}
