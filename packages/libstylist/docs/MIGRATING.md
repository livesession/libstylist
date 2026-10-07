# Migrating components to libstylist

The step-by-step recipe for flipping a component family from class-name styling
(`className={cn.x}`, `ls-*` classes) to libstylist: identity tags/markers, part attributes spread
with `cx()` calls, `data-*` state and dev annotations. It was worked out on the design-system pilot (Alert,
Button, CopyButton, EventRow, Popover, Tooltip, the Modal family, ModalConfirm, Switch,
ThinkingShader) and every step below is enforced by lint, the build or the proof gates.

The goal of a flip is **zero visual change**: the markup changes, the pixels don't.

- [Vocabulary](#vocabulary)
- [The flip, step by step](#the-flip-step-by-step)
- [From the `cx` attribute to `cx()` calls](#from-the-cx-attribute-to-cx-calls)
- [Decisions per element](#decisions-per-element)
- [Hard cases](#hard-cases)
- [Coupled components and ordering](#coupled-components-and-ordering)
- [Proof gates](#proof-gates)
- [Decoupling: removing the migration hooks](#decoupling-removing-the-migration-hooks)
- [Migrating a consumer app](#migrating-a-consumer-app)

## Vocabulary

| Term | Meaning |
|---|---|
| **scope** | A stylesheet's id — its basename (`text-input`), or `@stylist scope <id>;`. Its part map is exported under the camelCased scope (`textInput`). |
| **part** | A local class of the sheet (`.icon`, `.input-wrapper`, `.root`). In JSX: a member of the part map spread with `cx()`, `{...cx(cn.icon)}`. In the DOM: a value-less hashed attribute `<span _cxclass_elo-or4d4l>`. |
| **part map** | The object the css package exports per sheet: `part → part attribute` (`import { alert as cn } from "@livesession/eloquentui-css"`). |
| **identity element** | The element that names the component: a custom tag (`<elo-alert>`) for a `div`/`span` root, or a value-less marker attribute on a semantic root (`<button elo-button>`). |
| **flipped sheet** | A sheet that declares `@stylist root …` (or `@stylist scope …`), which binds it to its components. The checker then requires every one of its parts to be carried (S301). |
| **legacy hook** | A literal class (`icon-wrapper`, `has-icon`) another, not-yet-decoupled sheet still targets with `:global(...)`. |

## The flip, step by step

A **family** is a stylesheet plus every component that renders its parts. Flip a family in
one change — sheet and components together.

1. **Run the codemod** on every component file of the family:

   ```sh
   pnpm exec libstylist codemod --write packages/components/src/components/Alert/Alert.tsx
   ```

   The part-map import (`import { alert as cn } from "@livesession/eloquentui-css"`) stays: the
   maps now hold part attributes. The codemod turns `className={cn.x}` and
   `className={cx(cn.a, cn.b)}` (the old class-joining helper, whose import it drops) into
   `{...cx(cn.a, cn.b)}` from the runtime, moves the element's `data-*` attributes into the call's
   data literal, and prints what it could not decide (the TODO list): a conditional class
   (`cx(cn.a, open && cn.open)`) is a state — give it a `data-*` attribute and select
   `.root[data-open]`; a literal hook another sheet still targets stays
   `className={legacy("icon-wrapper")}`.

2. **Mark the identity element** of every exported component (and compound member):
   - root is `div`/`span` → rename the element to the component's tag: `<elo-alert>`
     (`elo-` + optional package segment + lowercased export path; `Modal.Header` →
     `elo-modal-header`, player's `PlayerTopBar` → `elo-player-topbar`);
   - root is semantic (`button`, `a`, `li`, `ul`, `section`, `svg`, `i`, `h1`–`h6`, `p`,
     `label`, …) → keep it and add the value-less marker: `<button elo-button>`;
   - spread `{...cx(cn.root, rest)}` on it (or the family local, see below) — destructure
     `...rest` from the props, import `cx` from `@livesession/libstylist/runtime`, and put the
     element's state and variants in the same call's data literal:
     `{...cx(cn.root, rest, { variant, open })}`.

3. **Bind the sheet**: add `@stylist root <ExportPath>;` right before the first rule.
   - family members: `@stylist root Modal.Header as header;` — the member's identity
     element spreads `{...cx(cn.header, rest)}`;
   - every custom tag declares what it replaces: `display block` for a `div`
     (`@stylist root Modal.Body as body display block;`), `display inline` for a `span`.
     Custom elements have no UA styles — `block` restores the `div`'s `display: block` and
     `unicode-bidi: isolate` at zero specificity, so write it even when the root rule sets
     `display` itself. Semantic (marker) roots never take it;
   - rename hand-prefixed keyframes to locals: `@keyframes ls-popover-fade-in` →
     `@keyframes fade-in` (and the `animation-name`s); the build emits `elo-popover-fade-in`.

4. **Remove `className` / `*ClassName` from the component's props** (and from any
   `React.memo` comparator). If a not-yet-flipped caller still passes one, keep it for now as
   `className={legacyClassName(className)}` with `@deprecated` in its TSDoc — see
   [ordering](#coupled-components-and-ordering).

5. **Replace data hooks**: drop `data-component`; replace a sheet's own `[data-part="x"]`
   (or `[part="x"]`) selectors with a part (`.x` + `{...cx(cn.x)}`) — attribute → attribute keeps the
   specificity. Declare each one in `packages/css/migration/renames.json` under the sheet's scope,
   keyed by the old selector: `"dock": { "[data-part=\"header\"]": "header" }` — verify-migration
   renames that hook only inside the sheet's own rules (several sheets shared hook values). Keep
   every variant/state `data-*` exactly.

6. **Regenerate the JSX tag types** and build:

   ```sh
   pnpm exec libstylist gen-types packages/components
   pnpm --filter ./packages/css build && pnpm --filter ./packages/components build
   ```

7. **Run the gates** (below). Nothing is done until they are all green.

## From the `cx` attribute to `cx()` calls

Codebases migrated before the call API wrote parts as a compiled JSX attribute (`cx="icon"`, a
`/** @cxScope alert */` pragma, `{...forwardStylist(rest)}`, `inputCx="field"` slots). The transform
now fails on that syntax; `libstylist codemod` converts it, file by file, with no visual change:

```sh
pnpm exec libstylist codemod packages/*/src/**/*.tsx            # dry run: prints what it would do
pnpm exec libstylist codemod --write packages/*/src/**/*.tsx
```

| Before | After |
|---|---|
| `/** @cxScope alert */` | `import { alert as cn } from "@livesession/eloquentui-css"` (the module of the scope's css group, from `css.partMaps`; an existing import of the map is reused) |
| `cx="a b"`, `cx={["a", "b"]}` | `{...cx(cn.a, cn.b)}` |
| `cx="player-controls:button"` | `{...cx(playerControls.button)}` + `import { playerControls } from "…/player"` |
| `{...forwardStylist(rest)}` | merged into the element's call after the parts: `{...cx(cn.root, rest)}` (or `{...cx(rest)}`) |
| `{...(inputCx as Record<string, unknown>)}` | merged: `{...cx(cn.input, inputCx)}` |
| `inputCx="field"` | `inputCx={cx(cn.field)}` |
| `data-size={size} data-open={open \|\| undefined}` | the element's data literal: `{...cx(cn.root, { size, open })}` — `\|\| undefined` is dropped only when `open` can't be `""` or `0` (its type, or a boolean shape such as `!x` or a comparison), else kept: `{ count: count \|\| undefined }` |
| `data-label="Tom &amp; Jerry"` | `{ label: "Tom & Jerry" }` — the decoded string (JSX strings decode entities and have no backslash escapes) |
| `data-active={active}` where `active` can be `false` | `{ active: active === undefined ? undefined : String(active) }` — it rendered `data-active="false"` and keeps doing so; the codemod lists every such attribute |
| `<Button data-testid="x">` (a libstylist component) | unchanged — there a `data-*` attribute is one of the component's props, whose `cx()` would drop a data literal (as `data-in-cx` decides: imported from a relative module of a libstylist package, or from a package declaring a libstylist `prefix`, or a component function defined in the same file of a libstylist package) |
| imports | `cx` added to the runtime import, `forwardStylist` dropped |

What it never decides, and reports as a TODO instead: a conditional `cx` (`cx={open && "x"}`,
`cx={{ x: open }}` — move the state to a `data-*` attribute), a scope whose part-map module is
unknown (configure `css.partMaps`), a `forwardStylist(…)` call outside a JSX spread, a data value
whose type it can't read, and a data attribute that moves across another spread (check which one
should win for a key both set). It reads the project config (`libstylist.config.mjs`, or
`--config`) for the part-map modules and a TypeScript program for the data values' types
(`--no-types` skips it: `x || undefined` is then kept as written unless its shape is boolean — it
renders the same — and every other non-literal value is reported). It is idempotent: a converted
file, or one already on the call API, is left alone.

Then change the slot props' types to `CxAttrs` (from the runtime), run the lint (the new rules
report whatever the codemod left), the checker and the proof gates below. The converted production
DOM carries the same part attributes, markers and `data-*` attributes on the same elements.

## Decisions per element

| Element | Write |
|---|---|
| Styled element of the component | `{...cx(cn.part)}` — never `className` |
| A state or variant (was a conditional class) | a `data-*` attribute through the call's data literal: `{...cx(cn.item, { active })}`, selected as `.item[data-active]` — parts are never conditional |
| Another sheet's part | import its map: `import { playerControls } from "@livesession/eloquentui-css/player"`, `{...cx(playerControls.button)}` |
| Style a child DS component's **root** with your part | `<Button {...cx(cn.toggle)}>` — Button passes its props to its own `cx()` call |
| Style a child DS component's **inner** element | a named slot: `<Popover contentCx={cx(cn.popover)}>`, `<TextInput inputCx={cx(cn.field)}>` |
| SVG icon component (`<CloseIcon>`) | `{...cx(cn.glyph)}` — icons spread props onto their `<svg>` |
| Literal hook another sheet still targets | `className={legacy("icon-wrapper", hasIcon && "has-icon")}` — literal names only |
| Literal class nothing targets | delete it (the migration map records it) |
| A caller's `className` you must still accept | `className={legacyClassName(className)}` (+ `@deprecated`) |
| Both on one element (Icon's `icon-wrapper` + its callers' classes) | `className={legacy("icon-wrapper", legacyClassName(className))}` — each counted |
| Variant / state | a key of the call's data literal (`data-size={size}` → `{ size }`) |

Never hand-write `_cxclass_*`, `_cxpart`, `data-react-component` or `data-file-source` — the
transform owns them (the last three only exist in development builds).

## Hard cases

**Polymorphic root** (`as: "button" | "a"`): put the marker on the tag variable —
`<As elo-button {...cx(cn.root, rest)}>`. A polymorphic root that can be
`div`/`span` maps those branches to the custom tag and the rest to the marker, as two
returns: `if (As === "span") return <elo-text {...cx(cn.root, rest)} …>` and
`return <As elo-text {...cx(cn.root, rest)} …>`.
A literal `<elo-text>` is what gen-types declares and what the transform adapts as a host
(`hostProps`, `cxAttr`); a tag held in a variable gets neither, and `<Tag elo-text>` would
repeat the marker on the custom tag.

**SVG geometry hosts** (`<circle>`, `<ellipse>`, `<radialGradient>`): their `cx` attribute is
geometry and stays a plain attribute; parts spread like on any element —
`<circle {...cx(cn["circle-bar"])} cx={center} …>`.

**Wrapper branches** (Button's `label` / `tooltip`): the identity element stays on the
button in every branch; the wrapper is plain structure (`<label>`) or another component's
identity (Tooltip's trigger).

**Radix / third-party-managed hosts** (Popover's `Trigger asChild` span, `Content` div):
keep the native element and use a marker (`<span elo-popover>`, `<div elo-popover-content>`),
because Radix writes boolean ARIA onto the host and React 19 would print `aria-expanded=""` on a
custom tag. Document it on the component: `@libstylistRoot native <reason>`.

**Portaled panels**: bind the panel with a member path — `@stylist root Popover.Content as content;`
— and name its marker `<owner>-<suffix>` (`elo-popover-content`).

**Components with no DOM of their own** (ModalConfirm → Modal, Tooltip → Popover): forward
the marker onto the delegate with the component's props — `<Modal elo-modalconfirm {...cx(rest)}>`
renders `<elo-modal elo-modalconfirm>` and carries a caller's parts to it (without the props the
checker reports R112 and `forward-props` fails). When the component's sheet styles an element inside the
delegate (Tooltip's bubble), that element is a part, not a second identity (`{...cx(cn.bubble)}`;
record local renames such as `root` → `bubble` in `packages/css/migration/renames.json`).
A sheet whose components carry their identity elsewhere opts in with `@stylist scope <id>;`.

**Unstyled components** (Link: a plain `<a>`, no sheet): tags and markers come from `@stylist root`
bindings, so give the component an identity-only sheet — a header comment and `@stylist root Link;`,
no rules — registered in the layer manifest like any other, and render
`<a elo-link {...cx(cn.root, rest)}>`. Its dist file is new, so `verify-migration` accepts it only when it
emits no rule (reported as a "new identity-only sheet"). Providers and empty roots (State,
PlaybackProvider) render nothing to mark: `@libstylistRoot none <reason>`.

**Props that can be unset on a new custom tag** (`title={title}`, `id={id}`,
`tabIndex={cond ? 0 : undefined}`): React 19 would leave `title="undefined"` / `tabindex="0"` on the
custom tag once the value is unset — add `ref={unsetRef({ title })}` (lint enforces it).

**Multi-root** (Switch: button + hidden form checkbox): the button is the identity; document
the sibling with `@libstylistRoot multi <reason>`. Never add a wrapper element — it changes
layout and child combinators.

**Family members rendered internally** (the Modal dialog's titled header): render the member
component itself (`<ModalHeader>`), so one identity covers both uses.

**Selectors that reach into another component** (`.x :global(.icon-wrapper)`, `[data-component="TabsItem"]`,
bare `i`/`svg`/`li`): leave them in place during the flip — they are removed by the
decoupling phase with forwarded parts, slots, custom properties or `:component(X)`. Exception:
`[data-component="X"]` of a component flipped in the same change becomes `:component(X)`
(same specificity, same element). Declare each such rewrite in
`packages/css/migration/renames.json` under `_hooks` (`{ "code-block": { "[data-component=\"TabsItem\"]":
":component(Tabs.Item)" } }`): verify-migration compiles it and applies it to the BASE side, so the
sheet still compares identical and the specificity check still runs.

**Type-dependent selectors** (`:last-of-type`, `:first-of-type`, `:nth-of-type()`): they count
siblings of the same element type, so retagging a `div` as a custom tag changes what they match
when its siblings stay `div`s — Table's header row, followed by the rows' `div` wrapper, became
the last `elo-table-tr` and lost the border `.tr:last-of-type` removes. Before retagging, check the
family's sheets (and the sheets that reach into it) for them; when one would change, keep the
native element with its marker (`<div elo-table-tr>`) and document it with
`@libstylistRoot native <reason>` until the decoupling phase replaces the selector (Table did:
`.tr:last-child`, then `<elo-table-tr>`).
Like every exemption it counts against the project's budget (`exemptions.budget.native` in
`libstylist.config.mjs`, checked as X123); raising the budget takes a reviewed reason in that file.

## Coupled components and ordering

A migrated file may not pass `className` to anything. So:

- a **callee** (a component other DS components pass `className` to — Icon, Popover, Favicon)
  can flip first: it keeps `className={legacyClassName(className)}` for its unflipped callers;
- a **caller** flips when its callee has flipped: it spreads `cx()` on the callee (root) or passes a
  named slot (inner element);
- `legacyClassName` / `legacy` uses are counted by lint; the migration ends at zero.

List the couplings of a family before flipping it (`<Component className=…>` across all
packages). Flip callers and callees in the same change when both are small.

## Proof gates

Run all of them after every family; a red gate means the flip is wrong — fix the markup or
CSS, never a baseline.

```sh
# 1. CSS: rule-for-rule identical to the pre-migration build, through the rename map
node packages/css/scripts/verify-migration.mjs <BASE packages/css/dist>

# 2. lint: ESLint (the flipped files get every libstylist rule), stylelint, and the conventions
#    checker (`libstylist check`: every rule is an error once the component is migrated)
pnpm lint
pnpm exec libstylist burndown    # what is still pending, per package and rule

# 3. Storybook + VRT: zero pixel diff, no baseline updates
pnpm storybook:build && node apps/eloquentui/scripts/vrt/run.mjs --retries 2

# 4. interaction probe: no frozen fields, no React warnings, no dev attributes in production
node apps/eloquentui/scripts/probe/interaction.mjs

# 5. React 18/19 host parity + hydration, per component
node apps/eloquentui/scripts/parity/run.mjs --package components --component Alert
```

A component counts as migrated once its identity element is in place; from then on every
checker finding for it is an error (see [RULES.md](RULES.md)). Parts that only consumer code
carries (a banner a host composes from the part map) are declared in `css.hostParts` of
`libstylist.config.mjs` with a reason.

`verify-migration` also accepts the declared `display` defaults and the renames in
`packages/css/migration/renames.json` (renamed locals and attribute hooks turned into parts);
anything else that differs is a failure.

## Decoupling: removing the migration hooks

Once every component is flipped, the sheets still reach into each other the old way:
`:global(.icon-wrapper)`, type selectors (`> li`, `a`, `svg`), `*-of-type`, forced-state classes
(`:global(.hover)`), and the components keep the matching `legacy()` literals and
`legacyClassName` props. Decoupling removes them, sheet by sheet, still with **zero visual change**.
The strict stylelint preset (`preset({ prefix })` without `legacy`) lists what is left.

**Rewrite each reach-in, in this order of preference:**

1. **The element is rendered by this component** (its own `li`, `a`, `svg`, `div`): give it a part
   and select the part — `.root > li` → `.root > .item` with `{...cx(cn.item)}` on the `li`.
2. **The element is another DS component's root**: pass your own part to it —
   `<Icon {...cx(cn.chevron)}>` + `.chevron` instead of `:global(.icon-wrapper)`; a child's inner
   element goes through its named slot (`inputCx`, `contentCx`).
3. **A value the child must take** (size, color): a documented custom property (`--icon-size`).
4. **Another DS component inside slot content you don't render**: `:component(X)`.
5. **Consumer-supplied content** (HTML a host passes as children or through a prop — an
   illustration `<img>`, a description `<p>`, a list): no part can reach it. Keep the type
   selector with a described disable, naming the content:
   `/* stylelint-disable-next-line libstylist/selector-max-type -- content: the host's description paragraphs */`
   (a `stylelint-disable` / `stylelint-enable` pair around several rules).
   Never use this for an element the DS renders itself.

Once a sheet has no reach-in left, lint it with the strict preset: list it in the project's
stylelint config as a strict override (`overrides: [{ files: decoupled, rules: preset({ prefix }).rules }]`
next to the migration preset). The reach-ins can't come back, and its content disables count as
used — under the migration preset (`legacy: true`), where the rule is off, they would be reported
as needless.

**Forced states and variants become props:** a class a story adds to fake a state
(`inputClassName="hover"` + `:global(.hover)`) becomes a documented prop that sets a `data-*`
attribute (`state="hover"` → `data-force="hover"`); a literal variant class (`settings`,
`with-border`, `success`) becomes a `data-*` variant (`data-variant`, `data-bordered`,
`data-tone`). Update every story that used the class, then delete the class hook, the `legacy()`
call and the `*ClassName` prop.

**`*-of-type` counts element types:** replace it with a part or a `data-*` state the component
sets (`data-last`), then the element can take its custom tag (drop the `native` exemption).

**Declare every selector change in the ledger** — `packages/css/migration/ledger/<scope>.json`:

```json
{
  "rewrites": [{ "old": ".ls-tabs a", "new": ".root .item", "why": "the tab link is the item part" }],
  "removed":  [{ "old": ".ls-text-input__wrapper .hover", "why": "forced hover is data-force now" }],
  "added":    [{ "rule": ".root[data-force=\"hover\"] .field { … }", "why": "state=\"hover\" prop" }]
}
```

`old` is one complex selector exactly as the BASE dist prints it; `new`/`rule` is written in the
sheet's own terms and compiled by the plugin. `verify-migration` applies the ledger to BASE, so
the rest of the sheet is still proven rule for rule; it reports every specificity change (a type
selector (0,0,1) becomes a part (0,1,0) — unavoidable, so it must be proven harmless below) and
fails on entries that match nothing.

**Proof for a decoupled sheet**, on top of the flip gates:

```sh
# the ledger's pairs: old selector (BASE DOM) vs compiled new selector (new DOM)
node packages/css/scripts/verify-migration.mjs <BASE dist> --ledger --ledger-pairs /tmp/pairs.json
# every rewritten selector matches exactly the same elements in every story
node apps/eloquentui/scripts/vrt/snapshot.mjs --out /tmp/sel-base --static <BASE storybook-static> --no-forced --selectors /tmp/pairs.json
node apps/eloquentui/scripts/vrt/snapshot.mjs --out /tmp/sel-new --no-forced --selectors /tmp/pairs.json
node apps/eloquentui/scripts/vrt/snapshot.mjs --compare-selectors /tmp/sel-base /tmp/sel-new --pairs /tmp/pairs.json
# and computed styles stay identical in the default and forced states (0 [style] differences)
node apps/eloquentui/scripts/vrt/snapshot.mjs --compare <base capture> <new capture> --rename <map> --ignore-dev-attrs
```

A pair that matches nothing in any story (`UNEXERCISED`) needs its own proof (an SSR or
Playwright harness of the uncovered branch); a new story needs a new VRT baseline, which a
decoupling change may not add.

## Migrating a consumer app

An app that consumed `@livesession/eloquentui-*` before libstylist:

1. **Run `libstylist migrate-selectors`** over the app's stylesheets, components and tests — a dry
   run first, then `--write`, then `--check` in CI:

   ```sh
   pnpm exec libstylist migrate-selectors --map node_modules/@livesession/eloquentui-css/dist/migration-map.json \
     "src/**/*.{css,scss,less,ts,tsx}" "e2e/**/*.ts"          # dry run: report only, exit 0
   pnpm exec libstylist migrate-selectors --write "src/**/*.{css,scss,less,ts,tsx}" "e2e/**/*.ts"
   pnpm exec libstylist migrate-selectors --check "src/**/*.{css,scss,less,ts,tsx}"   # exit 1 while anything would change
   ```

   Pass the stylesheets and the components in **one** run: the first pass collects the legacy
   classes the app puts on its own elements, so a stylesheet run alone can't know that
   `.ls-dropdown` also styles the app's `<Wrap className="ls-dropdown">`.

   It reads the old→new map the css package ships (`--map` defaults to the installed
   `@livesession/eloquentui-css/migration/ls-to-elo.json`; `MIGRATION-SELECTORS.md` in the css
   package is the same data as tables) and rewrites, in place and formatting-preserving:

   | Where | Rewritten |
   |---|---|
   | CSS, CSS Modules, SCSS, LESS | `.ls-alert__icon` → `[_cxclass_elo-or4d4l]`; a root `.ls-alert` → its part attribute `[_cxclass_elo-qkqllh]` (same specificity; `--roots identity` writes `elo-alert` / `[elo-button]` and notes the specificity change); `div.ls-alert` → `elo-alert[_cxclass_…]` (the `div` is the custom tag now); `:global(.ls-x)` → `[_cxclass_…]` (the wrapper stays while it still globalizes a class, and in a sheet that only its `:global` use marks as scoped); `[data-component="Tabs"]` → `:is(elo-tabs,[elo-tabs])`; `[data-part="header"]` inside its component; `[class~="ls-x"]`; `animation` / `@keyframes` names; `@supports selector()` / `@scope` preludes; a selector the design system rewrote itself (`selectorRewrites`, matched exactly) |
   | TS / JS | selector strings in `querySelector(All)` / `closest` / `matches`, jQuery `$()`, Playwright and Cypress locators (`page.locator`, `$`, `$$`, `waitForSelector`, `click`, `cy.get`, …; `css=` engines and `>>` chains), styled-components / emotion / linaria templates and object-style selector keys, `animation` values; a class selector built from a part map value in those contexts (`` `.${fe.row} input` `` → `` `[${fe.row}] input` ``) |

   Code outside strings, templates and CSS is never touched, and a second run changes nothing.
   What can't be rewritten mechanically is a **TODO** in the report — `file:line`, the old token,
   the suggested successor and the map's instruction:

   - a legacy class **used as a class** (`className="ls-alert"`, `classList.add("ls-alert")`,
     `clsx("ls-alert")`, `toHaveClass("ls-alert")`): a part attribute can't be a class — render the
     component (with `cx` for your own styles, step 2) or select the part attribute;
   - a selector naming a legacy class or `data-component` value **the app puts on its own element**
     (`className="ls-dropdown"` in any file, JSX `data-component="Sidebar"`): the rule styles that
     element too, and the successor would stop matching it — rename the app's hook, or select the
     successor if the rule was only for the design system's element;
   - a **part map value** used as a class (`import { filterEditor as fe } from
     "@livesession/eloquentui-css/infinity"`, `className={fe.row}`, `classList.contains(fe.row)`):
     the part maps keep their names but hold part attribute names now (`_cxclass_…`), so the class
     matches nothing — set it as an attribute (`{...cx(fe.row)}` in a libstylist app, else
     `{...{ [fe.row]: "" }}`), test it with
     `hasAttribute(fe.row)`, or render the component; a key whose part was renamed (`dropdown.root` →
     `dropdown.menu`) is named in the TODO;
   - reads of attributes the design system no longer renders (`getAttribute("data-component")`,
     `toHaveAttribute("data-part", "list")`, `el.dataset.component`);
   - literal hooks whose successor is a prop or a `data-*` variant (`.ls-icon.small` →
     `data-size="small"`), literal hooks that are removed or still `pending` in the map, and
     removed classes;
   - removed props and exports of the components you import (`<Popover className>`,
     `styled(Button)`, `EmptyStateShade`);
   - names built at runtime (`.ls-toast__${kind}`, SCSS `&__icon`), and selector-looking strings
     outside a known selector API (`const SEL = ".ls-alert"`).

   - in a CSS Modules file, a legacy class outside `:global()`: the module build hashed it, so it
     only ever styled the app's own `styles["ls-x"]` elements — rewriting it would start styling the
     design system's. A stylesheet that uses `:global` is read the same way whatever its name
     (webapp-next's sheet pipeline, Svelte / Vue scoped styles), and keeps its `:global(…)` wrappers.

   `ls-*` tokens the map doesn't know are listed separately (a block name the design system never
   rendered, `.ls-filter-editor`, names the component its classes belong to). Literal hooks
   (`icon-wrapper`, `small`, `content`) and `[data-part]` values are generic words, so they are
   handled only on or inside the element of a design-system hook of their own component
   (`.ls-table .table-td`, `.ls-button > .content`, a rule nested in `.ls-button { … }`); named
   elsewhere in the selector (`.content .ls-button`, `.ls-button + .content`), or held only by a hook
   the design system removed (`.ls-color .label`), they are a TODO. `--literals all` treats every
   occurrence as the design system's. A file that names nothing the map knows is skipped unparsed.
   `--json` prints the same report for tools. Options and limits: [CONFIG.md](CONFIG.md#cli).
   Part attributes are stable across releases (derived from names), but prefer tags, markers and
   `data-*` where they suffice.
2. The `className` / `*ClassName` props are gone. With libstylist in the app (prefix `app`),
   spread `cx()` on the DS component with a part of your own sheet
   (`<Alert {...cx(page.banner)}>`, `page` imported from your css package's part map) — it lands on the root as
   `_cxclass_app-…`; inner elements go through the component's `*Cx` slots. Without libstylist,
   target the component's tag/marker and parts from CSS.
3. Tests: select by role and text first, then tags/markers (`elo-alert` for a tag, `[elo-button]`
   for a marker); never by `_cxpart` or other dev attributes.
4. Session replay: saved selectors, masking rules and segments keyed on `.ls-*` or
   `data-component` must be re-authored before deploying (masking rules *before* the deploy).
