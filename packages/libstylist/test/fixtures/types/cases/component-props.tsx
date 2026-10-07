// Type-level uses of a tag name. `keyof` includes the template-literal key, so StylistTagMap alone
// is enough here on TS 4.9 and 5.x.
import type * as React from "react"

export type AlertHostProps = React.ComponentProps<"elo-alert">

export const hostProps: AlertHostProps = { role: "status", id: "a" }
