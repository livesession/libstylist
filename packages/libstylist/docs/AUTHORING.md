# Authoring components with libstylist

How to write a component and its stylesheet. The normative details are in
[SPEC.md](../SPEC.md); the rules that enforce this page are in [RULES.md](RULES.md).

- [Identity: tags and markers](#identity-tags-and-markers)
- [Parts, data and forwarding: `cx()`](#parts-data-and-forwarding-cx)
- [Stylesheets](#stylesheets)
- [Styling other components](#styling-other-components)
- [Overriding and resetting a design-system component](#overriding-and-resetting-a-design-system-component)
- [Dev annotations](#dev-annotations)
- [Escape hatches](#escape-hatches)

## Identity: tags and markers

Every component exported from a package entry has exactly one **identity element**, the root of
what it renders:

| Root would be | Write | DOM |
|---|---|---|
| `div` or `span` | the component's custom tag | `<elo-alert>` |
| anything semantic (`button`, `a`, `li`, `ul`, `section`, `svg`, `i`, `h1`–`h6`, `p`, `label`, …) | the native tag + a value-less marker | `<button elo-button>` |

**Tag names**: `<prefix>` + package segment (none in the base package; `app`, `player`, `gram`,
`inf`, `ai` in the others; or the segment of the package's `namespaces` directory the file sits in —
an app's `src/render`: `RenderInvitationRow` → `crm-render-invitationrow`) + the lowercased export
name, + lowercased compound members:
`Alert` → `elo-alert`, `Modal.Header` → `elo-modal-header`, `ControlsBar` (player) →
`elo-player-controlsbar`. A leading namespace word is dropped (`PlayerTopBar` →
`elo-player-topbar`, `AppHeader` → `elo-app-header`); a trailing `Root` member collapses
(`ListCollection.Root` → `elo-gram-listcollection`).

On the identity element spread one `cx()` call with the root part, the component's props and its
data:

```tsx
import { alert as cn } from "@livesession/eloquentui-css"
import { cx } from "@livesession/libstylist/runtime"

export function Alert({ variant, title, children, ...rest }: AlertProps) {
    const hasTitle = title != null
    return (
        <elo-alert {...cx(cn.root, rest, { variant, hasTitle })} role="status">
```

- `cn.root` — the sheet's root rules (`.root`) select it;
- `rest` — passes through the markers and part attributes a parent or an app puts on your component
  (`<Alert {...cx(page.banner)}>`, `<Modal elo-modalconfirm {...cx(rest)}>`);
- `{ variant, hasTitle }` — the element's `data-*` attributes (`data-variant`, `data-has-title`).

Internal (non-exported) components are free-form, but they still style with `cx()`.

**DOM-property props on a custom tag.** React 19 writes a custom element's props through its DOM
property when the element has one, so unsetting `title`, `id`, `tabIndex`, `lang`, `dir`, … leaves
`title="undefined"` / `tabindex="0"` where a `div` had the attribute removed. When such a prop's
value can be unset, pair it with `unsetRef` (lint: `libstylist/reflected-props`):

```tsx
import { unsetRef } from "@livesession/libstylist/runtime"

<elo-player-time tabIndex={tabIndex} ref={unsetRef({ tabIndex })}>
```

## Parts, data and forwarding: `cx()`

A file imports its sheet's **part map** — the css package exports one per sheet, typed with its part
names, so an unknown part is a TypeScript error and your editor completes them:

```tsx
import { textInput as cn } from "@livesession/eloquentui-css"            // components
import { playerControls } from "@livesession/eloquentui-css/player"       // another sheet
import { cx } from "@livesession/libstylist/runtime"
```

and every styled element spreads **one** `cx()` call:

```tsx
<div {...cx(cn.wrapper)}>                                   // a part
<span {...cx(cn.label, { required })}>                      // a part and its state as data-required
<span {...cx(cn.icon, { active: isActive, size })}>         // data-active, data-size
<div {...cx({ open })}>                                     // data only
<Button {...cx(playerControls.button)}>                     // a part of another sheet on a child's root
<input {...cx(cn.field, inputCx, { size })}>                // a slot the component received
```

- A **part** is a member of a part map: `cn.icon`, `cn.wrapper` (a kebab-case part takes brackets,
  as in the table map's `table["sort-icon"]`). It renders the value-less part attribute
  (`cn.wrapper` → `<div _cxclass_elo-izocz9>`).
- **Parts name structure only.** Every state or variant — open, active, selected, disabled, size,
  kind, tone, has-title, forced hover — goes into the call's **data literal**, and the sheet selects
  `.root[data-open]`. A part is never conditional (`open && cn.open` is an error — so is a part
  routed through a local, `const part = open ? cn.a : cn.b`, or a conditional spread,
  `{...(open && cx(cn.a))}`); two branches that need different parts are two JSX branches.
- The **data literal** is the inline object in the call, in any position: each key becomes
  `data-<kebab(key)>` exactly like `element.dataset` (`hasTitle` → `data-has-title`; quoted kebab keys
  work too, `"row-id"`), and a value renders as a string (`true` → `"true"`, a number → its string),
  or not at all when it is `false`, `null` or `undefined` — so `data-open={open || undefined}` is
  `{ open }`. Values may be any expression (`{ size: numeric ? undefined : size }`); spreads work
  (`{ ...state, size }`). Keep the data in the literal: a variable holding the object would be
  forwarded as props, not rendered.
- The data literal goes on **your own elements**: in a named slot value (`inputCx={cx(cn.field, { wide })}`)
  or in a `cx()` spread on a libstylist component (`<Button {...cx(cn.close, { open })}>`) it renders
  nothing — the child's `cx()` forwards only parts and markers — and the lint reports it. Pass the
  state as one of the child's props instead.
- **Design-system source writes no raw `data-*` JSX attribute** — the data literal is the only place
  for them. `aria-*`, `role` and every other attribute stay plain JSX.
- An **object** that is not a literal — the component's props or rest, a slot, another `cx()`
  result — contributes its markers and part attributes (never its `data-*`/`aria-*`).
- `undefined`, `null` and `false` add nothing (an unset slot).
- The data literal is branded by the libstylist Babel/Vite plugin (`cxData({…})`); the plugin must run
  wherever components are compiled — see [CONFIG.md](CONFIG.md). Without it a data literal renders
  nothing (the development build warns).
- `cx` on SVG `circle`, `ellipse` and `radialGradient` is geometry and stays a plain attribute.

There is no `className` in a libstylist codebase, and components don't expose
`className`/`*ClassName` props.

## Stylesheets

Plain nested CSS; every local class is a part:

```css
@stylist root TextInput display block;

.root { … }
.label { … }
.wrapper { … }
.root[data-size="small"] .wrapper { … }
```

Directives (removed from the output):

| Directive | Meaning |
|---|---|
| `@stylist root <Export> [as <local>] [display <kw>];` | Binds `.root` (or `<local>`) to that component's identity element. Repeat it for families: `@stylist root Modal.Header as header display block;` — the member's identity element then spreads `cx(cn.header, rest)` |
| `display <kw>` | Declare it on every custom-tag root (convention; S304 also accepts an unconditional `display` on the root part): `block` when the tag stands for a `div` (emits a zero-specificity `:where(<tag>:not([hidden])) { display: block; unicode-bidi: isolate }` — the UA `div` pair a custom element lacks), `inline` when it stands for a `span` (emits nothing; custom elements are inline). Other keywords emit `display` only. Marker roots never take it. |
| `@stylist scope <id>;` | Pins the scope id (keeps hashes and the part map's name stable across a file rename); also opts in a sheet whose components carry their identity elsewhere. |

Selectors compile to part attributes with the same specificity as the classes they replace.
Keyframes use local names (`@keyframes fade-in` → `elo-popover-fade-in`). Don't write type
selectors, `:global()`, tag or marker selectors, or `[data-component]` — see below for how to reach
other components.

## Styling other components

| You want | Write |
|---|---|
| Style a child DS component's root | `<Button {...cx(cn.toggle)}>` — the child passes its props to its own `cx()` call (parts and markers only: state goes to the child as a prop, never as a data literal here) |
| Style a child's inner element | its named slot: `<TextInput inputCx={cx(cn.field)}>`, `<Popover contentCx={cx(cn.menu)}>` |
| Pass layout values into a child | a documented custom property (`--icon-size`) |
| Match another component inside yours (content you can't give a part to) | `:component(Tabs)` or `:component(core/Modal.Header)` in CSS → `:is(elo-tabs, [elo-tabs])` |
| Restyle every instance of a design-system component in an app | an override sheet (below) |

A component that exposes an inner element declares a slot prop typed `CxAttrs` and merges it into
that element's call:

```tsx
import { cx, type CxAttrs } from "@livesession/libstylist/runtime"

interface PopoverProps {
    /** Parts for the floating panel: contentCx={cx(cn.menu)}. */
    contentCx?: CxAttrs
}

export function Popover({ contentCx, ...rest }: PopoverProps) {
    return <RadixPopover.Content elo-popover-content {...cx(cn.content, contentCx, { side })}>
```

A slot carries parts and markers only; the caller's data stays on the caller's own elements (a
data literal in a slot value is a lint error).

The receiving binding must be the component's own props — its props parameter, its rest, a slot it
destructures, or a destructuring/`const` alias of those (`const { a, ...rest } = props`). Another prop
(`cx(cn.root, style)`) forwards nothing, and a caller's parts on the component would be lost.

A component whose root takes the caller's parts while its other props go to an **inner element** (a
text field's native `<input>`) strips them there with `withoutStylist`, so they land on the root only:

```tsx
import { cx, withoutStylist } from "@livesession/libstylist/runtime"

<elo-textinput {...cx(cn.root, rest)}>
    <input {...withoutStylist(rest)} />
```

A component with **no DOM of its own** forwards its marker to the component it renders, together
with its caller's parts:

```tsx
export function ModalConfirm(props: ModalConfirmProps) {
    return <Modal elo-modalconfirm {...cx(props)} …>   // renders <elo-modal elo-modalconfirm>
```

## Overriding and resetting a design-system component

An app restyles a design-system component everywhere it renders with an **override sheet**: plain
nested CSS that names the component and then styles `.root` and the component's parts by name, the
way the design system's own sheet does. The normative details are SPEC §9.

Override sheets live in the app's overrides directory (`css.overrides.dir` in `libstylist.config.mjs`,
[CONFIG.md](CONFIG.md#overriding-the-design-system)): every `.css` file there is one, one sheet per
design-system sheet, with a kebab-case file name (`button.css`, `table-in-cart.css`) — its basename is
the sheet id, which namespaces the sheet's own keyframes (`Button.css` is an `[invalid-override]`).
`libstylist build` and the dev server keep the directory's generated `index.ts` importing them all; the
app's entry imports it once (`import "./styles/overrides"`), so an override applies from the first page
on.

```css
/* app/styles/overrides/button.css */
@stylist override Button from "@livesession/eloquentui-react";

.root {
    border-radius: var(--ls-radius-lg);
    &:focus-visible { outline: 2px solid var(--ls-color-primary-border); }
}
:root[data-theme="dark"] .root[data-kind="secondary"] { --btn-border: var(--ls-color-divider); }
.root[data-loading] .loader { opacity: 0.6; }
```

compiles into the overrides layer:

```css
@layer reset, tokens, components, utilities, app.overrides, app.core, app.render;
@layer app.overrides {
:is(elo-button,[elo-button]) { border-radius: var(--ls-radius-lg); }
:is(elo-button,[elo-button]):focus-visible { outline: 2px solid var(--ls-color-primary-border); }
:root[data-theme="dark"] :is(elo-button,[elo-button])[data-kind="secondary"] { --btn-border: var(--ls-color-divider); }
:is(elo-button,[elo-button])[data-loading] [_cxclass_elo-wj11dj] { opacity: 0.6; }
}
```

- **`from`** is the package you import the component from; it picks the design system and the
  namespace (`Button` from `@livesession/eloquentui-react`, `ListCollection` from
  `@livesession/eloquentui-gram`).
- **`.root`** is the component's identity — its custom tag or its marker, whichever it renders.
  Every other class is a part of the component's sheet: the keys of its part map
  (`import { button } from "@livesession/eloquentui-css"`), or the `_cxpart` attribute devtools shows
  in development. An unknown part fails the build (and the dev overlay, and `libstylist check`) with
  the nearest name and the full list, so a design-system rename can't silently turn an override into a
  no-op:

  ```
  [unknown-part] apps/crm/app/styles/overrides/button.css:15: Button (core, from "@livesession/eloquentui-react") has no part "loadr" — did you mean "loader"? Its parts: chevron, children, content, icon, label, loader, root
  ```
- **Members** are targets of their own (`@stylist override Table.Tr …`: `.root` is `<elo-table-tr>`),
  but one sheet serves a component family: in the `Table` override, a row is `.tr`. A sheet with no
  component of its own, or shared by several, is named by its id: `@stylist override tooltip from
  "@livesession/eloquentui-react";` (`.root` is then that sheet's `root` part). A component that renders
  another one's identity — Tooltip renders a Popover — styles what it adds with such a sheet, named after
  it: `@stylist override Tooltip …` is an `[unknown-target]` whose message names `tooltip` and its parts.
- **State** is the component's `data-*` (`.root[data-kind="secondary"]`), pseudo-classes and elements,
  combinators and nesting all work as in any sheet; so does document context
  (`:root[data-theme="dark"] .root`). Specificity is the DS sheet's: `.root` and a part are (0,1,0),
  but you never need to out-specify the design system — the overrides layer comes after it. The one
  exception is a design-system `!important`: for important declarations the cascade reverses the layer
  order, so it beats the override whatever you write (`!important` included). The build warns
  (`[important] … can't take effect`) and names the fix: `@stylist reset <part>;` removes it.
- **The element a rule styles is the target's own**: `.root`, a part, or an element inside one
  (`.root svg`, `.content > *`, `.icon + .children`). Context goes before it — document context, and
  **another design-system component** as `:component()`: Buttons inside table cells are the Button
  override's `:component(Table.Td) .root { height: 24px; }` (`:component(ns/Path)` names another
  namespace of the same design system; the identities it reads are locked). `:has()` on it works
  (`.root:has(.loader)`); `:has()`, `+` and `~` that lead *out* of the component
  (`:root:has(.root) [data-open]`, `.root ~ p`) are errors — they would restyle the rest of the app.
- **One sheet per design-system sheet** (and per `within` component): two would be ordered by file
  name.
- **Not allowed**: another component as the element styled (`.td :component(Button)` — restyle it in
  its own sheet, with this one as context), `:cx()`, a selector that names no part (`[data-open] { … }`
  would restyle the whole app), ids, `:global()`, class or part-attribute selectors, tags and markers
  (write `.root`, or `:component(X)` for context), `@layer`, `@import`.
- **Keyframes** of your own are namespaced (`@keyframes pulse` → `crm-override-button-pulse`); the
  component's own are available by their local name (`animation: loading`).
- **The app's components win over the override**: the overrides layer sits before the app's
  namespace layers, so `<Button {...cx(cn.toggle)}>` styled by a component's own sheet still beats a
  global Button override.

**`within`** scopes an override to one app component and its subtree:
`@stylist override Table from "@livesession/eloquentui-react" within RenderAccountsTable;`
(`ns/Path` when the name exists in two namespaces). Portaled content — a Modal, a Popover or a
Dropdown panel — is not inside the component in the DOM, so `within` does not reach it.

### Resetting

`@stylist reset <part> …;` removes the design system's own declarations for those parts from its
stylesheets at build time — the Vite plugin strips them from `styles.css` (and every other stylesheet of
the design system's css package) as the app imports it, the design system itself is never edited — so
the override starts from scratch; `@stylist reset;` resets every part of the target's sheet:

```css
@stylist override Modal from "@livesession/eloquentui-react";
@stylist reset header;

.header { position: relative; padding: 12px 16px; }   /* the close button still positions against it */
```

- A reset is per element: every design-system rule whose subject is the part goes, including its
  states, pseudo-elements, `!important` and media-query variants. A rule listing the part next to
  other elements keeps them (`[icon], [chevron] {…}` keeps the chevron; `:is([icon], [chevron])`
  gets a zero-specificity `:where(:not([icon]))`). A part styled only through such shared rules — the
  Button's chevron has no rule of its own — is reset by those guards, and the report counts them.
- Kept: the component's **custom properties** (build on them: `height: var(--btn-h)`), the display
  default of a custom tag (a reset `<elo-table>` is still a block), the design system's reset and
  tokens layers, rules for the element's descendants, and **other components' rules** for it (a
  Button's icon slot still sizes an Icon placed in it).
- A reset can't be conditional: no `@stylist reset` in a `within` sheet.
- Parts can share an element (a table cell carries `cell` and `td`): reset both to start from
  scratch.
- The reset report (`libstylist build`, and the dev server when it starts and whenever the resets
  change) lists what each reset drops, and a `note` for every layout declaration the element's parent
  or children may rely on (`display: flex`, `position: relative`, `flex: 1`, `min-width: 0`,
  `width: 100%`, `margin-left: auto`…) that your sheet does not re-declare for the same part under the
  same conditions — `.root[data-loading] .loader { display: flex }` does not take over the loader's
  unconditional `display: none`, every other state lost it:

  ```
  reset   elo:core/modal:header — 1 declaration in 1 rule (styles.css, components/modal.css)
  reset   elo:core/modal:frame — 24 declarations in 9 rules (styles.css, components/modal.css)
  note    elo:core/modal:frame drops overflow: hidden (styles.css:3021) — its children's layout may rely on it; declare it in apps/crm/app/styles/overrides/modal.css to keep it
  ```

  A part reset that drops nothing is an error (`[empty-reset]`): the design system moved its styling
  elsewhere.
- A reset needs the design system's CSS to go through Vite: `vite build` fails when a reset strips
  nothing the build bundles (`[unbundled-reset]` — the CSS comes from a CDN link, or the part's
  aggregate is not imported).
- A reset `display` on an element that may be `[hidden]`: write `.root:not([hidden]) { display: flex }`.

## Dev annotations

In development builds the transform adds:

| Attribute | On | Value |
|---|---|---|
| `_cxpart` | every element with a `cx()` spread that reads parts | the part names (`icon`; a part of another sheet as `player-controls:button`) |
| `data-react-component` | identity elements | the component name |
| `data-file-source` | identity elements and every element with a `cx()` spread | `<repo-relative path>:<line>` (outside a git/pnpm checkout: relative to the nearest `package.json`; the `sourceRoot` option sets the root) |

They are guarded by `process.env.NODE_ENV !== "production"` in the published build, so the
consumer's bundler strips them. Never select them in CSS or tests.

On a **component element** (`<Button {...cx(cn.close)}>`) the annotations are props passed to the
component, and reach the DOM only when the component passes its props to a DOM element — a
third-party one such as `<RadixPopover.Arrow {...cx(cn["hidden-arrow"])}>` does. A libstylist
component's `cx()` forwards only parts and markers: its root shows the component's own `_cxpart`
and `data-file-source`, and a part you put on it appears in the DOM only as its `_cxclass_`
attribute.

## Escape hatches

Documented on the component with a TSDoc tag the checker validates and counts:

| Tag | When |
|---|---|
| `@libstylistRoot none <reason>` | renders no DOM of its own (providers, `null`, empty fragments) |
| `@libstylistRoot multi <reason>` | one identity element plus unstyled siblings (Switch's hidden form input) |
| `@libstylistRoot native <reason>` | a host that must stay a native element: third-party-managed (Radix `asChild`), or, during a migration, a `div` whose element type a type-dependent selector (`:last-of-type`) still counts |

During a migration two counted runtime helpers exist; a finished codebase has none:
`legacy("icon-wrapper")` (a literal hook another sheet still targets) and
`legacyClassName(className)` (a caller's class, while that caller hasn't migrated).
