# libstylist rules

Every convention in [AUTHORING.md](AUTHORING.md) is enforced by one of three layers:

| Layer | Runs on | Command |
|---|---|---|
| [ESLint rules](#eslint-rules) (`libstylist/*`) | one source file at a time | `pnpm lint:js` |
| [stylelint rules](#stylelint-rules) (`libstylist/*`) | one source sheet at a time | `pnpm lint:css` |
| [The conventions checker](#the-conventions-checker) (`C/R/T/S/X` ids) | every package, its exports and all sheets together | `libstylist check` (`pnpm lint:conventions`) |

Only definite violations are reported. Inline `eslint-disable` of `libstylist/*` rules is not a fix:
change the code, or use one of the [sanctioned escape hatches](#escape-hatches).

## Migration ratchet

A codebase migrates component by component. The strict rules apply to **migrated** code only:

- ESLint: there is no legacy subset. Apply `configs.recommended` only to the files you have migrated
  (its `files` globs), and widen the globs as components migrate.
- `libstylist check`: a component is migrated when its file calls the runtime `cx()` or writes an
  identity tag/marker of the prefix, or when it carries a `@libstylistRoot` exemption. Findings on
  migrated components are errors; findings on the others are **pending** — counted by
  `libstylist burndown`, never errors. Hard rules (duplicate tags, registry errors, flipped sheets,
  malformed exemptions) hold for everyone.
- A sheet is **flipped** when it declares `@stylist root` or `@stylist scope` (it is bound to its
  components). The PostCSS plugin and the css build compile every sheet into part attributes, flipped
  or not. The flip only decides what the checker holds the sheet to: unused parts (S301) are checked
  on flipped sheets only, and burndown counts the sheets that are not flipped.

`libstylist burndown` reports what is left: components not migrated, sheets not flipped, pending
findings per rule, and the migration helpers still in use (`legacy()`, `legacyClassName()`,
`@deprecated` class props). `libstylist burndown --expect-zero` fails while any of that remains or
`check` has errors — the switch for the final flip.

---

# ESLint rules

Rule ids of the `cx()` call API (the `cx` attribute's rules were renamed with it): `cx-static` →
**`cx-args`**, `forward-stylist` → **`forward-props`**; new: **`no-cx-attribute`**, **`data-in-cx`**.
`cx-part-exists` and `root-part` keep their ids and check part-map members now.

## cx-args

Every argument of a runtime `cx()` call is a part-map member (`cn.icon`, `cn["group-label"]`), a
props or slot object (an identifier or member expression: `rest`, `props.inputCx`), the element's
inline data literal (keys are identifiers, string literals or spreads), a nested `cx()` call, or
nothing (`undefined`/`null`/`false`). Parts are never conditional — `open && cn.open`,
`open ? cn.a : cn.b` and arrays are reported: state and variants go through `data-*` attributes;
parts name structure only (`cx(cn.root, { open })` and `.root[data-open]`). Also reported: string
literals (read the part from its map), computed members, other calls, spread arguments, a data
literal held in a variable (it would be forwarded as props, not rendered — spread it into the
literal), the abandoned `{ data: … }` wrapper, a data literal inside a nested call (a `cx()` result
passed on forwards only parts and markers) and a `cx()` spread on a Fragment.

A part or a data literal routed through a local is reported like the inline form: every write of a
`const`/`let`/`var` counts — its initializer and each `=` assignment — so `const part = open ? cn.a :
cn.b`, `let p = cn.icon; if (open) p = cn.title` and `let d = { open }` are errors (`cx(part)`,
`cx(cn.root, rest, d)`), and so is a local whose conditional or logical value can be a data literal
(`const d = open ? { open } : { closed: true }`, `const d = open && { open }`). A data value that reads a part (`{ icon: open && cn.icon }`, which renders
the attribute name as `data-icon`) and the object form of a conditional part (`{ [cn.icon]: open }`)
are too.

One `cx()` call per element, spread unconditionally and as the call itself: a `cx()` result held in
a local and spread (`const attrs = cx(cn.icon, { open }); <span {...attrs}>`, a local holding a
conditional of calls, `const attrs = open ? cx(cn.a) : cx(cn.b)`, and a held result as a branch of a
conditional spread) is reported — it would escape these checks and get no dev annotations; move the
call onto the element. Passing the held result on instead (`{...cx(cn.title, attrs)}`, or as a slot
value) keeps only its parts and markers: when it holds a data literal, that is reported like a
nested call's or a slot value's data. A second `cx()` spread on the element is
reported (merge its parts, props and data into the first), and so is a conditional spread of `cx()`
calls (`{...(open ? cx(cn.a) : cx(cn.b))}`, `{...(open && cx(cn.x))}`, or one spread inside an object
spread) — a conditional part in disguise. A conditional slot value (`inputCx={open ? cx(cn.a) :
undefined}`) is the same conditional part on the child's element and is reported too. A type wrapper
(`cx(…) as T`, `cx(…)!`) is not an outer call: the data literal of a wrapped call renders.

A data literal only where it renders. A named slot (`inputCx={cx(cn.field, { wide })}`, also through a
cast or as a branch of a conditional value) carries parts and markers into the child, never data; and a libstylist component's `cx()` forwards only the parts
and markers it receives, so `<Button {...cx(cn.close, { open })}>` renders no `data-open`. Both are
reported — pass the state as one of the child's props, or put it on your own element. A libstylist
component is one imported from a relative module of a libstylist package or from a package whose
`package.json` declares a libstylist `prefix`, or a component function defined in the same file of a
libstylist package (`function Item(props)`, `const Row = memo((props) => …)`); a polymorphic host
(`<As>`, a parameter or a local holding a tag) and a third-party component (`<RadixPopover.Content>`,
which passes `data-*` to its DOM) are not.

A member of a part map imported by a path (`import { counter as cn } from "../styles-dist/parts"`) is
reported when the registry knows the export: the tooling recognizes part maps by their package
specifier only, so it would read `cn.root` as a props object (no part check, no `_cxpart`, and
`root-part` couldn't see the root). Import the maps through a package specifier or an alias
([CONFIG.md](CONFIG.md#part-maps-built-inside-an-app)).

## cx-part-exists

Every member read from a part map names a part of its sheet (checked against
`stylist-registry.json`), with a "did you mean" suggestion; with `partMaps` configured, every named
import from a part-map module names a sheet of that css group. TypeScript reports an unknown member
too (the maps are literal-typed); the rule covers untyped code and names the sheet.

## data-in-cx

Design-system source writes no raw `data-*` JSX attribute: each one goes through the element's
`cx()` data literal — `data-size={size} data-open={!!open || undefined}` becomes
`{...cx(cn.root, { size, open: !!open })}` (offered as a suggestion: see below). The fix moves every `data-*` attribute of the element
into its call (creating `{...cx({ … })}`, and the `cx` import — in the `@livesession/*` group, after
the package imports and ahead of the local ones — when there is none), rendering exactly what the
attribute rendered:

- a string attribute keeps its decoded value (`data-label="Tom &amp; Jerry"` → `label: "Tom & Jerry"`;
  JSX strings decode entities and have no backslash escapes, JavaScript strings the opposite);
- a trailing `|| undefined` is stripped only when the value is boolean by its shape (`!x`, `!!x`, a
  comparison); any other `x || undefined` stays as written, because `x` may be `0` or `""`, which
  `|| undefined` omits and the literal renders (`data-count="0"`);
- the rule has no type information, so `--fix` applies only when every `data-*` value on the element
  is provably never `false` by its shape: string, number, `true` and `null` literals, a value-less
  attribute, template literals, `undefined`, `x || <one of those>` (including `x || undefined`) and
  ternaries whose branches are all of those. Any other expression (an identifier, a member, a call
  or a cast, e.g. `data-size={size}`) may be `false`, which renders `"false"` as a JSX attribute and
  nothing in the literal. When an element has such a value, all its `data-*` attributes move together
  as a suggestion to review, literal ones like `data-label="x"` on the same element included.
  `libstylist codemod`, which reads types, decides this per value ([MIGRATING.md](MIGRATING.md)).

On a libstylist component (`<Alert data-testid="x">`) a `data-*` attribute is one of its props, not
the element's data — the rule leaves it (and `cx-args` reports a data literal spread there). Dev
annotations and removed hooks are `no-dev-attrs`'.

## forward-props

Every identity element (a custom tag of the prefix, or an element carrying a marker) passes the
component's props (or rest) object to its `cx()` call — `{...cx(cn.root, rest)}` — which is how
wrappers pass their marker down and how parents and apps attach their parts. A component that hands
its whole props object on (`<Popover elo-tooltip {...rest}>`) satisfies it too; object literals and
other calls don't.

"The component's props" is resolved by scope analysis — the same predicate as the checker's R112: a
function parameter bound as a whole (`props`), the rest element of a parameter's object pattern
(`...rest`) or a named slot it destructures (`contentCx`), the same destructured in the body from one
of those (`const { a, ...rest } = props as T`), a `const` alias of one or of a `cx()` call forwarding
one, and a named slot read off one (`props.inputCx`). The parameter is the function's first, and the
function no callback: a function passed to a call is a callback unless it is the first argument of
a component wrapper (`memo`, `forwardRef`, `observer`, `Object.assign`), so a `.map((item) => …)`
parameter is not the props, nor is `memo`'s comparator's, and neither is `forwardRef`'s `ref`. Any other prop (`cx(cn.root, style)`),
an import, a `let` or another member forwards nothing. The message names the call to write: `{...cx(cn.root,
rest)}` on an own root, `<Modal elo-modalconfirm {...cx(rest)}>` on a delegate, and the bound part
with its slot on a member root (`{...cx(cn.content, contentCx)}`).

## marker-attr

Markers are value-less (`<button elo-button>`) and never sit on their own custom tag or on
`div`/`span` (render the custom tag instead). The one exception is the `div`/`span` placement: it is
allowed when an enclosing declaration is documented `@libstylistRoot native <reason>`, the same host
exception as R101. A valued or redundant marker is reported whatever the tag says.

## no-anonymous-container

No `document.createElement("div" | "span")`: create a named custom tag so the DOM shows who owns the
node (portal roots, measuring nodes).

## no-class-query

No DOM queries by class (`.x` selectors, `getElementsByClassName`): select a tag, marker, `data-*`
attribute or a part attribute from the part map.

## no-classname

No `className`/`class`/`*ClassName` in design-system source. During a migration the two counted
helpers are allowed: `legacy("literal")` for a hook another sheet still targets and
`legacyClassName(className)` for a not-yet-migrated caller's class.

## no-cx-attribute

The removed source API: a `cx` JSX attribute (SVG `circle`/`ellipse`/`radialGradient` geometry
excepted), the `@cxScope` pragma, a part-list string, array or object in a named slot
(`inputCx="field"` → `inputCx={cx(cn.field)}`) and a named slot on a host element. The message names
the replacement; `libstylist codemod` converts a whole file.

## no-dev-attrs

No hand-written `_cxpart`, `data-react-component`, `data-file-source`, `_cxclass_*`, `data-component`
or `data-part` (attributes, spread object keys, `cx()` data-literal keys such as `{ fileSource }`, or
selectors): the transform owns them.

## no-hash-literal

No hard-coded part-attribute hashes or retired `ls-*` class names in strings: use the part map, a tag,
a marker or `data-*`. A part-map module `libstylist build` generated (its first line is the generated
header) is where the hashes live, and is skipped.

## no-imperative-class

No `classList`, `className =` or class-attribute writes through the DOM API: toggle a `data-*`
attribute the sheet styles.

## no-literal-class

No literal class names in `className` values or class-joining helpers (the old `utils/cx`, clsx,
classnames — never the runtime `cx()`, which `cx-args` checks): a part-map member in `cx()`, a
`data-*` variant, or `legacy("…")` mid-migration.

## reflected-props

React 19 writes a custom element's props through its DOM property, so an unset `title`, `id`,
`tabIndex`, … on a custom tag becomes `title="undefined"` or `tabindex="0"` where a native element
had the attribute removed. On a custom-tag host, such a prop with a value that can be unset needs
`ref={unsetRef({ title })}` from the runtime, which removes the attribute whenever it is unset.

## root-part

The identity element's `cx()` call carries the root part its sheet binds (`cn.root`, or the family
local from `@stylist root Modal.Header as header`: `cn.header`), and a reserved root local appears in
no other element's `cx()` call (slot values included). The fix adds the member as the call's first
argument (or spreads `{...cx(cn.root)}`) when the file imports that sheet's part map.

## tag-name

Custom tags and markers follow the tag grammar (`<prefix>[-segment]-name[-member]`, SPEC §2.1) and the
file's package segment.

---

# stylelint rules

## libstylist/sheet-root

A bound sheet styles its root at the top level, and `.root` is only ever the leading compound of a
selector. In an [override sheet](#override-sheets) of a component, `.root` is that component's identity:
nothing binds it, and document context may come before it (`:root[data-theme="dark"] .root`) — never
another part (`.loader .root`). In an override sheet of a sheet id (`@stylist override tooltip …`)
`.root` is a plain part and the rule stands aside.

## libstylist/directive-syntax

`@stylist root|scope` directives and the arguments of `:component()`, `:cx()` and `:global()` are
well-formed and lowercase. In an override sheet, `@stylist override` and `@stylist reset` follow the
grammar and the placement the build reads (SPEC §9.2): one `@stylist override` first, then the resets,
before any rule; no `@stylist root|scope`; no part reset twice; a reset names its parts at the top of
the sheet, never nested in a rule (`.loader { @stylist reset; }` is reported).

## libstylist/no-identity-selectors

No hand-written tag, marker, part-attribute, dev-attribute, `data-component`/`data-part` or `class`
selectors — reach other components with `:component(X)`.

## libstylist/selector-class-pattern

Local classes (parts) are kebab-case and never start with `ls-`, `_cxclass_` or the prefix.

## libstylist/selector-pseudo-class-no-unknown

`:component`, `:cx` and `:global` are known pseudo-classes; everything else follows stylelint's core rule.

## libstylist/selector-pseudo-class-disallowed-list

No `:global`, `:local` or `*-of-type` selectors. `:global` and `*-of-type` are tolerated in legacy
mode; `:local` never is.

## libstylist/selector-max-type

No type selectors — never reach into another component by tag (tolerated in legacy mode only).

---

# The conventions checker

`libstylist check [--config libstylist.config.mjs] [--json] [--pending]` analyzes every package entry
of the config with the TypeScript compiler API plus every sheet, and prints one line per finding:
`file:line  RULE  message  [key]`. It exits 1 on errors (pending work and warnings never fail), 2 on a
config problem. `--pending` also lists the findings of components that are not migrated yet. The
config is described in [CONFIG.md](CONFIG.md#conventions-checker).

Exported components are found from each package entry, re-exports followed: functions and arrow
functions (also through `memo`/`forwardRef`), and their compound members — `Object.assign(X, { Y })`,
expando `X.Y = …`, plain-object namespaces (`{ Root, Item }`) and module namespaces
(`export * as Icons from "./icons"`). Every PascalCase export and member is a component path. A
component belongs to the package holding its implementation and is named in that file's namespace —
the package's `namespaces` directory it sits in (an app's `src/render`: `render`), else the package's
own ([SPEC.md](../SPEC.md) §8). Its id is `<namespace>/<Path>` (`render/RenderAccounts`); when two
packages sharing a namespace export one path, the second one's id adds its directory
(`core/Badge@packages/partners`).

Each render path is followed through conditionals, `&&`/`??`, `switch`/`try`, local consts and
lets, local helpers (their arguments bound, destructured ones included), `useMemo` factories,
fragments, `Suspense` (children and fallback), providers, DOM-less Radix roots, `asChild` and
portals; internal components are inlined, exported ones are delegates.

What the checker accepts as an identity (SPEC §2, AUTHORING):

- the component's custom tag (`<elo-alert>`) or, on a semantic native root, its value-less marker
  (`<button elo-button>`, `<As elo-button>` with a finite union of tags);
- a **wrapper branch**: a plain element authored by the component (Button's `<label>`, FilterEditor's
  indent `<div>`) or another design-system component's children (Button's `<Tooltip>{button}</Tooltip>`)
  around exactly one element carrying the identity, on every render path;
- a **forwarded marker**: a component with no DOM of its own puts its marker on a delegate, passing
  its props on with it (`<Modal elo-modalconfirm {...cx(rest)}>`, `<Popover elo-tooltip {...rest}>`),
  and the delegate's identity element receives stylist props;
- a **member root** bound in a sheet (`@stylist root Popover.Content as content`): the marker
  `elo-popover-content` belongs to Popover's file even though no export resolves to it.

## C001

**unresolvable export** — every exported component and compound member resolves to an analyzable
function component and is not typed `any` (`Table.Button: any`), made by a factory
(`styled("div")`), a class, or a re-exported third-party component. Type the member, export a plain
function component, or wrap the third-party one.

## C002

**invalid export path** (hard) — every export path forms a valid tag, and a compound of a namespace
without a segment must not read as another segment's tag: `App.Dock` → `elo-app-dock` (the app
package's), a core `Render.Row` → `crm-render-row` in a workspace whose packages have a `render`
directory namespace. Rename the compound's parent.

## C003

**duplicate export** — one implementation is exported under one tag only (`EmptyStateShade` and
`EmptyState.Shade` would give one element two identities), and one path has one implementation in a
package. Drop the duplicate export. The same path exported by two packages sharing a namespace is
one tag with two owners: T201.

## R100

**no root** — the component renders nothing in any branch. Mark it
`@libstylistRoot none <reason>` (providers, `null`). Waived by `none`.

## R101

**generic root** — a root that would be `div`/`span` renders the custom tag instead
(`<elo-alert>`). A marker on a `div`/`span` is allowed only for hosts that must stay native
elements (`@libstylistRoot native`): third-party-managed hosts (Radix `asChild`), or, during a
migration, a `div` a type-dependent selector (`:last-of-type`) still counts; a plain
generic root is never waived.

## R102

**missing marker** — a semantic native root (`button`, `a`, `li`, `svg`, …) carries the component's
marker: `<button elo-button>`.

## R103

**wrong identity** — the identity element names this component: its tag or marker equals
`tagName(export path)` (`Modal.Header` → `elo-modal-header`).

## R104

**multiple roots** — every render branch has exactly one identity element. Sibling roots next to
it need `@libstylistRoot multi <reason>` (Switch's hidden form input); two identity elements, or none
among several roots, are always errors, whatever the exemption. Never add a wrapper element to fix
it — it changes layout.

## R105

**opaque root** — every branch's root is visible to the checker: not passed-through `children`, the
result of an unknown call, bare text or a third-party component. Render the identity element around
it; a component with no DOM of its own is marked `@libstylistRoot none <reason>`, and a marker on a
third-party host needs `@libstylistRoot native <reason>`. A branch with more than 128 render paths
is never waived — simplify it. A component of a libstylist library is not third-party: one declared
in a package whose `package.json` has a libstylist `prefix` (the design system's dist, linked or
installed) is a delegate (R106).

## R106

**delegate without identity** — a component that renders another design-system component either
forwards its marker onto it (`<Modal elo-modalconfirm {...cx(rest)}>`) — and that component must pass
stylist props on to its DOM, or the marker is lost — or renders its own identity element inside the
delegate's children on every path (slot identity). The delegate may be a component of a configured
package or of a libstylist library outside them — an app rooting on the design system's `<Table>`:
`<Table crm-render-accountstable {...cx(cn.root, rest)}>` needs no wrapper element. That library's own
checker holds its components to R112, so their forwarding is assumed; without the marker the root is
still R106. One its library marks `@libstylistRoot none` in its declaration (the design system's
`Loader`, its providers — the `.d.ts` keeps the tag) renders no DOM: a marker forwarded onto it never
reaches the DOM, so that is R106 too — render the identity element around it or inside it.

## R107

**unbounded polymorphic tag** — a tag variable (`<As>`) has a finite union of string literals
(`"button" | "a"`), not `string` or `ElementType`.

## R108

**generic polymorphic member** — a polymorphic identity element never renders as `div`/`span`
(a marker never goes on a generic tag): render those branches as the custom tag
(`const Tag = as === "p" ? "p" : "elo-text"` or separate returns).

## R109

**conditional wrapper identity** — a wrapper branch has the identity element inside it on every
render path; return the wrapper only when it contains the identity.

## R110

**valued marker** — an identity marker is written value-less (`<button elo-button>`); the transform
normalizes it to `""`, and `cx()` forwards only `""` values, so a valued marker
(`elo-button="x"`) never reaches the DOM through a delegate.

## R112

**props not forwarded** — the identity element's `cx()` call receives the component's props object
(`{...cx(cn.root, rest)}`, or the whole props spread on as `{...rest}`), and every internal component
it is rendered through passes the props on. A `cx()` call with only parts and data forwards nothing,
and neither does another prop (`cx(cn.root, style)`): the argument is the props parameter, its rest,
a named slot, or a destructuring or `const` alias of those — the predicate `forward-props` shares. A
forwarded marker's delegate element passes the props too, with the marker:
`<Modal elo-modalconfirm {...cx(rest)}>` (without them a caller's parts on the component are lost).

## R113

**missing root part** — the identity element's `cx()` call carries the part its sheet binds
(`cn.root`, or the family local such as `cn.header`).

## T201

**duplicate tag** (hard) — every tag is owned by exactly one exported component across all packages
(`Menu` and `Menu.Root` both collapse to `elo-menu`), packages sharing a namespace included: a `Badge`
exported by two app packages is `<crm-badge>` twice. Rename one component.

## T202

**unregistered tag** (hard) — every tag or marker of the prefix in source belongs to an exported
component or a member root bound in a sheet.

## T203

**foreign tag** (hard) — a tag or marker is rendered only by its owner (member roots: by the owner's
file). Render the owning component instead.

## S300

**registry error** (hard) — the sheets build a registry: no duplicate scopes, hash collisions, bad
directives or unresolved `:cx()`/`:component()` references (the css build fails on the same).

## S301

**unused part** (hard) — every part of a flipped sheet is read from its part map somewhere in the
design-system sources (in a `cx()` call, a slot value, or any other read). Spread it with `cx()` on
the element it styles, delete the dead rules, or — when code outside the sources carries it through
the part map — list it in `css.hostParts`.

## S302

**unowned root binding** (hard) — every `@stylist root` names an exported component of the sheet's
package in the sheet's namespace, or a member of one. A sheet's namespace is its directory's: a render
component's sheet belongs in the render sheet directory (`src/css/render`) — left in `src/css` it
hashes and names tags in `core`, where no `RenderAccounts` is exported.

## S303

**member root not rendered** (hard) — a member root bound in a sheet is rendered by its owner's file
(`<RadixPopover.Content elo-popover-content {...cx(cn.content, contentCx)}>`), carrying its bound local
part next to the slot that brings the caller's parts (a declared slot that reaches no `cx()` call is
S307's).

## S304

**custom tag without display** — every rendered custom tag has a display default
(`@stylist root X display block;`) or its root part sets `display` unconditionally; custom elements are
`inline`.

## S305

**display on a marker root** — a `display` default is declared only for components rendered as a
custom tag; on a component that only ever renders a marker root it has no effect. A component that
renders its tag in some branches and a marker in others (Truncate's `div`/`span` vs `<p>`) keeps it
for the tag branches.

## S306

**stale host part** (hard) — every `css.hostParts` entry names an existing part that the
design-system sources never read from its part map. Remove the entry once a component carries the part.

## S307

**cx not forwarded** — a `cx()` spread carrying parts goes only onto components that pass their props
on to their DOM (`<ModalConfirm {...cx(cn.x)}>` is lost when ModalConfirm passes no props to Modal —
its delegate must receive them with the marker, `<Modal elo-modalconfirm {...cx(rest)}>`), and a
named slot (`<TextInput inputCx={cx(cn.field)}>`) only to components that declare it and use it —
pass it to an element's `cx()` call (`{...cx(cn.input, inputCx)}`) or on to a component that does
(Tooltip's `contentCx` through its props to Popover). A data literal in a `cx()` spread on a
design-system component is lost too (`<Button {...cx(cn.close, { open })}>`, key `…>core/Button:data`):
a component's `cx()` forwards parts and markers only — pass the state as one of its props, or put it
on your own element.

## S308

**className prop** — no exported props type declares `className` or `*ClassName`; consumers style
through a `cx()` spread on the component, named slots (`inputCx`), tags/markers and the part map. While callers still
pass one, keep it `@deprecated` (applied with `legacyClassName(…)` or accepted and ignored) — burndown
counts it until it is removed.

## S309

**stale registry** (warning) — the built `stylist-registry.json` (`css.registry`) matches the sheets;
rebuild the css package (a workspace of app packages: `libstylist build`) when it drifts, so lint and
consumers see the current parts.

## S310

**override sheet** (hard) — every override sheet (`css.overrides`, [below](#override-sheets)) resolves
against its design system's registry — its package, component, parts, resets and `within` exist —,
compiles, and every reset drops something. The finding carries the build's `[code]` and message, at the
sheet's line; `libstylist build` and `vite build` stop on the same. A design system that is not
installed or not built is one too: build it (the check reads its `dist/stylist-registry.json` and
stylesheets, as the build does).

## X121

**malformed exemption** (hard) — `@libstylistRoot <none|multi|native> <reason>` names a known
category, gives a reason of at least `minReasonLength` characters, sits on an exported component, once.

## X122

**stale exemption** — a `@libstylistRoot` tag excuses at least one finding; remove it once the
component conforms. A tag whose category doesn't cover the component's findings (`none` on a
component that renders a `<div>`) excuses nothing: fix the findings instead.

## X123

**exemption budget** (hard) — exemptions per category stay within `exemptions.budget` in the config.

---

# The workspace build

`libstylist build` and `stylistWorkspace()` (a workspace of app packages,
[CONFIG.md](CONFIG.md#a-workspace-of-app-packages)) stop on these; nothing is written while one stands.

| Error | Fix |
|---|---|
| a registry error — `[duplicate-scope]`, `[hash-collision]`, `[duplicate-tag]`, `[invalid-directive]`, `[unresolved-ref]` (what S300 reports) | rename one of the two sheets, parts or components (scopes and tags are unique across the whole workspace), or fix the reference |
| `[duplicate-export] … both export as "x" from <package>'s part-map module` (or `from the "#css" part maps`) | two scopes of one module share an export name (`switch`, `switch-classes`): rename one sheet or pin a scope with `@stylist scope` |
| `@layer — the build wraps every sheet in its namespace's layer` | remove the block: the layer comes from `css.layers` |
| `@import — a sheet is compiled alone` | import the other sheet's part map in the component, or reach its parts with `:cx(scope:part)` |
| `imports["#css"] is "…", but the build writes …` | point the package's `#css` at the generated module (`./src/css/index.ts`) |
| `css.layers.statement does not declare "…"` | add the namespace's layer to the statement, or map the namespace to a declared layer |
| ``stale part maps — run `libstylist build` `` (`vite build`), `stale` lines (`libstylist build --check`) | run `libstylist build` and commit the part maps and the lock |

---

# Override sheets

An app's override sheets (SPEC §9, [AUTHORING.md](AUTHORING.md#overriding-and-resetting-a-design-system-component),
[CONFIG.md](CONFIG.md#overriding-the-design-system)) stop `libstylist build`, the dev server's overlay
and `vite build` on these — and `libstylist check` reports them as [S310](#s310); nothing is compiled,
stripped or written while one stands.

| Error | When | Fix |
|---|---|---|
| `[invalid-override]` | the directives: no `@stylist override` first, a reset before it, a part reset twice, a whole reset next to part resets, `@stylist root`/`scope` in an override sheet, a directive after a rule; two override sheets with one file name; a file name that is not kebab-case (`Button.css`: the basename is the sheet id) | as the message says; rename the sheet `button.css` |
| `@stylist override belongs in an override sheet` | `@stylist override`/`reset` in a package sheet | move the rules to the app's overrides directory |
| `[unresolved-package]` | `from` is not installed, is not a component package (a css package publishes the registry; name the package the component is imported from), is the app's own, or belongs to a design system whose registry is not configured | fix `from`, or configure the registry |
| `[unknown-target]` | the component is not in the package's namespace (did you mean …; the namespace that has it; the members of a family with no identity of its own, or its sheet id; the sheet named after a component that renders another one's identity — `Tooltip` → `tooltip`) | fix the name, `from`, or override a member or the sheet |
| `[unknown-part]` | a class or a reset part is not a part of the target's sheet (did you mean …, and every part) | fix the name — a design-system rename lands here |
| `[unresolved-ref]` | a `:component()` of the context is not a component of the design system (did you mean …), or is an identity of the target sheet itself | fix the name, `ns/Path`; write the target's own identities with their class (`.root`, `.tr`) |
| `[unknown-within]` | the `within` component is not in the app, or is in two namespaces | fix the name, or write `ns/Path` |
| `[duplicate-override]` | two sheets override one design-system sheet (globally, or within one component) | merge them |
| `[shared-reset]` | `@stylist reset;` of a component whose sheet also styles other components | reset its parts by name, or override the sheet by id |
| `[reset-within]` | `@stylist reset` in a `within` sheet | reset in the global override sheet |
| `[keyframes-clash]` | own `@keyframes` named like one of the target's | rename yours |
| `[override-selector]` | an element styled that is not `.root`, a part or inside one (a part named only in `:has()`, or before `+`/`~`: `:root:has(.root) [x]`, `.root ~ p`), another design-system component as the element styled (`.td :component(Button)`), `:cx()`, `:global()`, an id, a class or part-attribute selector, a dev or removed attribute, a tag or marker, a selector that names no part outside `:not()` | as the message says: `.root`, a part, `:component(X)` as context before them (in that component's own sheet for the reverse), `within` |
| `[empty-reset]` | a part reset drops nothing (or a whole reset drops nothing for any part) | remove it |
| `[reset-import]` | a design-system stylesheet with a local `@import` while resets are active | bundle the flat aggregate (`styles.css`) |
| `[design-system]` | a `css.overrides.registries` entry: not installed where the override sheets (or the config) are, not a css package (no `libstylist.groups` — a component package was listed), its registry missing (the design system is not built), unreadable or of another version, its prefix the app's or another design system's | install / build the css package, list the css package |
| `[overrides-index]` | a hand-written `index.ts` in the overrides directory (the build never overwrites it) | move its code elsewhere and delete it — the build generates the module the app imports |
| `the overrides module is stale` | `vite build` with a committed overrides module that no longer imports every override sheet (`libstylist build --check` reports it `stale` too) | run `libstylist build` and commit |
| `[unbundled-reset]` | `vite build`: a reset target stripped from no design-system stylesheet the build bundles — the design system's CSS comes from elsewhere (a CDN link, a copy), or not the aggregate that styles the part | import the design system's CSS through Vite in the app's entry, or remove the reset |
| `[overrides-not-imported]` | `vite build`: the build bundles the design system's CSS but not every override sheet | import the overrides module once in the app's entry; a build that must not apply them (a Storybook of the app's packages) passes `stylistWorkspace({ overrides: false })` |
| `[layer-order]` | `vite build`: a CSS asset declares the overrides layer before `components` or after a namespace layer — a hand-written `@layer` order statement imported before the override sheets lists the app's layers without it | list the overrides layer in every order statement the app writes, where `css.layers.statement` puts it |

`libstylist build --check` fails on a stale lock like on any drift, and prints the entries that moved:
`~ override elo:core/modal:header _cxclass_elo-… → _cxclass_elo-…` when the design system moved a part
an override reads, `+ reset …` when a part joined a wholly reset sheet.

`note` lines of the reset report are information: a layout declaration a reset drops that the
override sheet does not re-declare for the same part under the same conditions.

`[important]` is a warning of `libstylist build` and Vite: an override declaration a design-system
`!important` of the same element beats (important declarations reverse the layer order) — it never
takes effect. `@stylist reset <part>;` removes the design system's `!important`; one of another
component's rules for the identity only the design system can drop.

---

# Escape hatches

| Hatch | For | Waives | Counted by |
|---|---|---|---|
| `@libstylistRoot none <reason>` | no DOM of its own (providers, `null`) | R100; R105 for passed-through children, unknown calls, text and DOM-less third-party wrappers | check stats, budget |
| `@libstylistRoot multi <reason>` | one identity element plus unstyled siblings | R104 for sibling roots next to one identity element | check stats, budget |
| `@libstylistRoot native <reason>` | a host that must stay native: third-party-managed (Radix `asChild`), or a `div` a type-dependent selector still counts during a migration | R101 and the matching `libstylist/marker-attr` finding for a marker on `div`/`span`, R105 for a marker on a third-party component, R108 | check stats, budget |
| `css.hostParts` | parts host code outside the sources carries (engine-owned nodes) | S301 | burndown |
| `css.unboundSheets` | sheets bound to no component (a documentation-only swatch sheet, say) | S301 | — |
| `legacy("…")`, `legacyClassName(x)`, `@deprecated` class props | mid-migration hooks | S308 (`@deprecated` props) | burndown; zero at the end |

Nothing else is waivable: two identity elements, a wrong or missing identity, a lost marker, a
missing props forwarding or root part and a valued marker are errors whatever the tag says.
