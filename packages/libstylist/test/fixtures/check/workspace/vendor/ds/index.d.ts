// Stand-in for a linked design-system dist (its package.json declares a libstylist prefix): components
// whose own checker holds them to forwarding, so a marker and parts put on them reach their DOM.
import type * as React from "react"

type Props = { children?: React.ReactNode; [key: string]: unknown }

export declare function Table(props: Props & { rows?: string[] }): React.JSX.Element
export declare function Modal(props: Props & { title?: string }): React.JSX.Element

// the design system's DOM-less Loader, in its dist's shape: the tag sits on the function behind the
// exported compound's type
/**
 * @libstylistRoot none renders nothing (no DOM of its own); the splash screen is `Loader.Splash`
 */
declare function LoaderComponent(): null
declare function SplashLoader(props: Props): React.JSX.Element
export declare const Loader: typeof LoaderComponent & { Splash: typeof SplashLoader }
