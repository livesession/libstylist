// @livesession/libstylist/jsx: hand-written JSX typings for sources that use libstylist.
//
// This file must compile on TypeScript 4.9 and 5.x against @types/react 19, including both of
// its typesVersions variants (TS <= 5.0 loads `ts5.0/index.d.ts`). Keep the syntax 4.9-safe:
// no `satisfies`, no `const` type parameters, no `NoInfer`. test/types-compile.test.ts compiles
// it with both compilers.
//
// What it declares:
// - The props type of custom tags, `StylistHostProps`. Custom tags are explicit
//   `React.JSX.IntrinsicElements` keys in each package's generated `types/stylist-tags.gen.d.ts`
//   (`libstylist gen-types`). The one-key alternative, `StylistTagMap<"elo">`, is opt-in and not
//   used by default, for three reasons:
//   - TS 4.9 ignores template-literal keys when it checks JSX tags.
//   - Neither 4.9 nor 5.x applies them to a tag held in a variable (`const Tag = "elo-alert"; <Tag />`).
//   - The key enters `keyof JSX.IntrinsicElements`, so `React.ElementType` gains `elo-${string}`,
//     and every JSX tag typed `React.ElementType` (`<As>`) fails with TS2604 on 4.9 and 5.x.
// - Nothing for parts. Elements spread a `cx()` call (`<span {...cx(cn.icon)}>`), whose result type
//   `CxAttrs` (from `@livesession/libstylist/runtime`) has only hyphenated keys; there is no `cx`
//   JSX attribute (on SVG `circle`, `ellipse` and `radialGradient`, `cx` is the geometry attribute
//   React already types).
//
// Hyphenated attribute names such as identity markers (`<button elo-button>`,
// `<Modal elo-modalconfirm>`), `data-*` and `_cxclass_*` need no declaration. TypeScript never
// checks undeclared hyphenated JSX attributes, on intrinsic or component elements, in 4.9 or 5.x.
//
// With @types/react 19, `jsx: "react"` resolves the JSX namespace through the factory
// (`React.JSX`), and `jsx: "react-jsx"` resolves it through `react/jsx-runtime`, which re-exports
// `React.JSX`. The global `JSX` namespace is never consulted: @types/react 19 does not declare
// one, and augmenting it has no effect. The generated keys therefore target `React.JSX`, which
// requires @types/react >= 18.2.7.

import type * as React from "react"

/** Props of a custom-tag host (`<elo-alert>`): the attributes of a plain `<div>`/`<span>`. */
export type StylistHostProps = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>

/**
 * Every `<P>-*` custom tag as a JSX intrinsic element, through one template-literal key. It is
 * opt-in (`stylistTypesStub(prefix, { tagMap: true })`); the default is the explicit keys in
 * `types/stylist-tags.gen.d.ts`.
 *
 * TypeScript 5.x (verified on 5.9) honors the key for literal JSX tags (`<elo-alert>`). TS 4.9
 * does not, and neither honors it for literal-typed tag variables. `React.ComponentProps<"elo-alert">`
 * works with this map alone on both versions. The cost: `React.ElementType` then includes
 * `` `${P}-${string}` ``, and rendering a value of that type (`<As>`) fails with TS2604 on 4.9 and 5.x.
 */
export type StylistTagMap<P extends string> = { [K in `${P}-${string}`]: StylistHostProps }
