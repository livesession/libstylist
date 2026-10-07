// Type errors the typings must report. Each `// ts-error: <code> <message fragment>` marks one
// expected diagnostic on that line. This file is compiled only with the generated keys present.
import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

import { alert as cn } from "../src/parts"

type BadgeProps = { tone?: string }
declare function Badge(props: BadgeProps): React.ReactElement

export const unknownPart = <span {...cx(cn.icn)} /> // ts-error: 2551 Property 'icn' does not exist
export const numberArg = <span {...cx(cn.icon, 5)} /> // ts-error: 2345 is not assignable to parameter of type 'CxArg'
export const trueArg = <span {...cx(true)} /> // ts-error: 2345 is not assignable to parameter of type 'CxArg'
export const removedAttribute = <div cx="icon" /> // ts-error: 2322 Property 'cx' does not exist
export const removedOnComponent = <Badge cx="icon" /> // ts-error: 2322 Property 'cx' does not exist
export const arrayOnCircle = <circle cx={["icon"]} /> // ts-error: 2322 is not assignable to type 'string | number | undefined'
export const undeclaredSlot = <Badge inputCx={cx(cn.icon)} /> // ts-error: 2322 Property 'inputCx' does not exist
