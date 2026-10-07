// Stand-in for @radix-ui/react-popover's public types (the fixture can't carry node_modules).
import type * as React from "react"

type Props = { children?: React.ReactNode; asChild?: boolean; [key: string]: unknown }

export declare const Root: React.FC<Props>
export declare const Trigger: React.ForwardRefExoticComponent<Props>
export declare const Portal: React.FC<Props>
export declare const Content: React.ForwardRefExoticComponent<Props>
