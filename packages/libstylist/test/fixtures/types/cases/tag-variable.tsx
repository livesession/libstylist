// A custom tag held in a literal-typed variable. TypeScript resolves it through an explicit
// IntrinsicElements key only. The template-literal key in StylistTagMap doesn't apply, even on 5.x.
import * as React from "react"

const Tag = "elo-alert" as const

export const dynamic = <Tag data-open="true" />
