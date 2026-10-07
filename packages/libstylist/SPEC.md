# libstylist SPEC — v1

The normative contract shared by every libstylist layer: the Babel transform, the
PostCSS plugin, the runtime, the registry, the lint rules and the conventions
checker. When code and this document disagree, the code is wrong. Changing
anything in §2–§4 changes emitted selectors, so it is a breaking change and
bumps `HASH_VERSION`.

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **prefix** | Project-wide identifier (`elo` for the design system, `app` for the webapp). Matches `^[a-z][a-z0-9]*$`. |
| **namespace** | Id used in hashes (`core`, `app`, `player`, `gram`, `inf`, `ai`), declared per package or per directory of a package (`namespaces`, §8: an app package's `src/render` → `render`). Several packages may share one (§7). |
| **segment** | The namespace's tag segment. Empty for `core`; otherwise usually equal to the namespace. |
| **scope** | A stylesheet's id: its basename without `.css` (`text-input`), unless pinned with `@stylist scope <id>;`. Scopes are unique within a prefix. |
| **part** | A local class name in a sheet (`icon`, `input-wrapper`, `root`). Grammar: `[a-z][a-z0-9]*(-[a-z0-9]+)*`. |
| **identity element** | The one element that names a component in the DOM: a custom tag, or a native element carrying a marker attribute. |
| **part attribute** | The hashed, value-less attribute that carries a part: `_cxclass_<prefix>-<hash>`. |
| **part map** | A sheet's `part → part attribute` object the css build exports (`alert.icon === "_cxclass_elo-or4d4l"`); source reads parts from it and spreads them with `cx()` (§5). |

## 2. Identity: tags and markers

### 2.1 Tag names

```
tag = prefix + ("-" + segment if segment) + "-" + name(path[0]) + ("-" + lower(member) for member in path[1:] unless member == "Root" and it is last)
name(x) = lower(stripNamespaceWord(x, segmentWord))
```

- `path` is the public export path, e.g. `["Modal", "Header"]` or `["ListCollection", "Item"]`.
- Every piece is fully lowercased, with no kebab splitting inside a word: `ControlsBar` → `controlsbar`.
- **Namespace-word stripping.** The component name loses its leading namespace word when that word is followed by an uppercase letter. The words per namespace are `player` → "Player" and `app` → "App"; `gram`, `inf` and `ai` also have words ("Gram", "Inf", "Ai"), and so does an app's `render` layer ("Render"). So `PlayerTopBar` → `topbar`, `AppHeader` → `header` and `RenderInvitationRow` (render) → `invitationrow`, but `Application` → `application` and `Renderer` → `renderer`.
- A trailing member named `Root` collapses into its parent: `ListCollection.Root` → `elo-gram-listcollection`.
- The result must match `^[a-z][a-z0-9]*(-[a-z0-9]+)+$`. The prefix guarantees the hyphen that custom-element names require.
- Duplicate tags are a build error. So is a `core` compound whose parent name equals another namespace's segment, e.g. `App.Dock` would collide with `elo-app-dock`.

Examples:
- `Alert` → `elo-alert`
- `ControlsBar` (player) → `elo-player-controlsbar`
- `PlayerTopBar.Url` → `elo-player-topbar-url`
- `Modal.Header` → `elo-modal-header`
- `FilterBar` (inf) → `elo-inf-filterbar`
- `ThinkingShader` (ai) → `elo-ai-thinkingshader`
- `RenderInvitationRow` (prefix `crm`, render) → `crm-render-invitationrow`

### 2.2 Root form

- A root that would be `div` or `span` (the **generic tags**) is rendered as the custom tag.
- Any other native element keeps its tag and carries the **marker attribute**, whose name equals the tag string. The marker has no value (`<button elo-button>`); in JSX authors write it without a value, and the transform normalizes it to `""`.
- A marker never goes on a generic tag, with one exception: hosts that must stay native elements (managed by a third party, or, during a migration, counted by a type-dependent selector such as `:last-of-type`), listed under the checker's `native` escape hatch.
- Tags and markers carry identity. **They are not styling hooks** inside a component's own sheet; see §4.

## 3. Part attributes

### 3.1 Hash

```
canonical = "v1" ␟ prefix ␟ namespace ␟ scope ␟ part          (␟ = U+001F, joined as UTF-8)
digest    = sha256(canonical)
n         = uint64 big-endian of digest[0..8)
hash      = base36(n mod 36^L), left-padded with "0" to L       (L = hashLength, default 6)
attr      = "_cxclass_" + prefix + "-" + hash
```

Test vector: prefix `elo`, namespace `core`, scope `alert`, part `icon` → `_cxclass_elo-or4d4l`.

Properties:
- **Pure and name-derived.** The registry (and with it the part maps) and PostCSS compute it independently, and it never depends on CSS content, so selectors stay stable across releases.
- **Collisions** are a build error that names both parts. The fix is to rename one of them. There are no salts.
- **Valid everywhere it is used**: as an HTML attribute name, as a CSS identifier, and under React's attribute-name check.

### 3.2 DOM form

A part is a value-less attribute: `<span _cxclass_elo-or4d4l>`. React needs a string value, so the value is `""`, which is exactly what the HTML parser produces for `<span attr>`. The design system never emits `class`.

## 4. Stylesheets (PostCSS plugin)

### 4.1 Authoring

Source sheets are plain nested CSS with local classes:
- **Every local class is a part**, including `.root`.
- **Directives** are removed from the output:
  - `@stylist root <ComponentPath> [as <local>] [display <keyword>];` binds a local (default `root`) to a component's identity element. It may be repeated for component families. `ComponentPath` is dotted: `Modal.Header`.
  - `@stylist scope <id>;` pins the scope id.
  - `@stylist override …;` and `@stylist reset …;` belong to override sheets (§9); in a package sheet
    they are errors.

### 4.2 Rewrites

These run after nesting is flattened, per selector:
1. `.local` → `[_cxclass_<prefix>-<hash(namespace, scope, local)>]`. Specificity (0,1,0) is the same as a class.
2. `:component(Path)` or `:component(ns/Path)` → `:is(<tag>,[<tag>])`. This is the sanctioned cross-component hook.
3. `:cx(scope:part)` → the other scope's part attribute. It is resolved through the registry.
4. `:global(x)` is spliced in verbatim; a list inside it is an error. **Legacy only**: the output audit reports it.
5. `@keyframes <local>` → `<prefix>-<scope>-<local>`, and `animation`/`animation-name` references to local keyframes are rewritten to match.
6. For each `@stylist root … display <kw>`, a zero-specificity default is emitted first in the sheet. A custom element has no UA styles (it computes like a `span`: `display: inline; unicode-bidi: normal`), so the keyword restores the element the tag replaces:
   - `block` (a `div`): `:where(<tag>:not([hidden])){display:block;unicode-bidi:isolate}` — both declarations the HTML rendering section gives `div`;
   - `inline` (a `span`): nothing — it is the custom-element default;
   - any other keyword: `:where(<tag>:not([hidden])){display:<kw>}`.

   Every custom-tag root declares one: `block` for a root that replaces a `div`, even when its root rule sets `display` itself (the `unicode-bidi` still applies), `inline` for one that replaces a `span`. The checker (S304) accepts either a display default or an unconditional `display` on the root part; the design system's css build requires the directive. Marker roots never declare one.
7. **Audit**: any remaining class selector in the output is an error.

## 5. JSX (the call API and the Babel transform)

### 5.1 Part maps

- The css build emits one **part map** per scope: an object of `part → part attribute` plus `$tags`
  (component path → tag), as ESM, CJS and a literal-typed `.d.ts` (`dist/classes.*` for the base
  group, `<group>-classes.*` for the others; §7). The export name is the camelCased scope
  (`text-input` → `textInput`); a reserved word gets `Classes` appended (`switch` → `switchClasses`).
- A workspace of app packages (§7, §8) generates one **part-map module** per package instead, committed
  as `index.ts` in its first sheet directory and imported by its `#css`: a side-effect import of each of
  its sheets (the base namespace's first, then each directory namespace's) and one `as const` map per
  sheet, all its groups in one module — so no two of its scopes may share an export name.
- A source file imports the maps it reads, the file's own sheet conventionally as `cn`:
  `import { alert as cn } from "@livesession/eloquentui-css"`, another sheet under its export
  name: `import { playerControls } from "@livesession/eloquentui-css/player"`.
- `partMaps` (a css group → the module specifier its map is imported from) tells the tooling which
  imports are part maps. Several groups may map to one specifier (an app package's `#css` serves its
  `core` and `render` groups): an import from it resolves against the scopes of all of them. Unset,
  any package import whose name is a sheet's export name is one.
- The tooling recognizes a part map **by its package specifier only**: an import by a relative or
  absolute path (`import { counter as cn } from "../styles-dist/parts"`) is never a part map — its
  members get no `_cxpart` and no part validation, and the root-part checks can't see them — and a
  path as a `partMaps` value is a configuration error. An app whose part maps are generated inside it
  exposes them under a specifier (an alias; CONFIG.md, "Part maps built inside an app"); the lint
  reports a member of a registry-known map imported by a path.
- A **member** of a map (`cn.icon`, `cn["group-label"]`) is the part attribute name. The literal
  types make an unknown part a type error; the lint rules and the transform check it against the
  registry too.
- The file's **own sheet** is the scope most of its part-map members read (with none read, the
  first part map it imports): the default root binding and bare `rootLocals` resolve against it.

### 5.2 `cx()` grammar

Every styled element spreads one runtime `cx()` call: its parts, the props it forwards and its data.

```
call   := cx( arg* )
arg    := Member                              a part: X.part | X["part"] (X a part-map import)
        | Identifier | MemberExpression      a props or slot object (rest, props.inputCx) — forwarded
        | { (key: value | key | ...spread)* } an inline data literal — the element's data-* attributes
        | cx( arg* )                          a nested call
        | undefined | null | false            nothing (an unset slot)
key    := Identifier | StringLiteral          data-<kebab(key)>: hasTitle → data-has-title, "row-id" → data-row-id
```

- **Parts name structure only.** Every state or variant the sheet reacts to (open, active, selected,
  disabled, size, kind, tone, has-title, forced hover …) travels as a `data-*` attribute through the
  data literal, and the sheet selects `.root[data-open]`. A part is never conditional: `c && X.p`,
  `c ? X.a : X.b`, `{ [X.p]: c }` and arrays of parts are errors, and so is a part held
  in a local (`const part = c ? X.a : X.b; cx(part)` — every write of the local counts) and a
  conditional spread of calls (`{...(c ? cx(X.a) : cx(X.b))}`, `{...(c && cx(X.p))}`). Two render
  branches that need different structural parts are two JSX branches with their own static call.
- **One call per element**, spread unconditionally: a second `cx()` spread on the element is an
  error (merge its arguments into the first). The spread is the call itself: a `cx()` result held
  in a local and spread on its own (`const a = cx(X.p); <span {...a}>`, or a conditional of calls,
  `const a = c ? cx(X.a) : cx(X.b)`) is an error too (the one-call and conditional checks and the
  dev annotations read the call on the element) — move the call onto the element. A held result
  passed on as an argument (`{...cx(X.q, a)}`) or a slot value forwards only its parts and markers,
  so one holding a data literal is an error like a nested call's.
- **Data only in the literal.** Design-system source writes no raw `data-*` JSX attribute: every one
  goes through the element's data literal (`cx(cn.root, rest, { size, open })`). A data literal held
  in a variable is an error (it would be forwarded as props, never rendered: spread it into the
  literal, `{ ...state }`) — a `const`, `let` or `var`, initialized or assigned; so is the abandoned
  `{ data: { … } }` wrapper, a computed key, a data value that reads a part (`{ icon: c && X.icon }`
  renders the part attribute's name), and a data literal where it renders nothing: inside a nested
  call or a named slot value (a `cx()` result passed on forwards only its parts and markers), or in
  a `cx()` spread on a libstylist component, whose `cx()` forwards only the parts and markers it
  receives (`<Button {...cx(cn.close, { open })}>` renders no `data-open` — pass the state as a prop).
  A component function defined in the same file of a libstylist package is a libstylist component
  like an imported one; a polymorphic host (`<As>`, or a local holding a tag) or a third-party
  component that passes `data-*` to its DOM is not.
- Anything else is an error: string literals, computed non-literal members, other calls, spread
  arguments, conditional arguments.
- `aria-*`, `role` and every other attribute stay plain JSX.
- The removed syntax — the `cx` JSX attribute (SVG `circle`/`ellipse`/`radialGradient` geometry
  excepted), the `@cxScope` pragma, qualified `"scope:part"` strings and part-list strings in named
  slots — fails the build and the lint.

### 5.3 The transform

The Babel plugin (and the Vite plugin that runs it) compiles no parts: a member is a runtime value.
It is still **required wherever components are compiled** (library builds, Storybook, consumer
apps, test runners), because at runtime a data literal and a props object are both plain objects:

- **Branding.** Every inline object-literal argument of a runtime `cx()` call — `cx` imported from
  the runtime (under any name, or through a namespace import) — is wrapped in `cxData({…})`, which
  brands it as data. Literals of other functions, and identifiers or members, are left alone.
  Branding runs in every file, configured package or not.
- **Markers:** a value-less `elo-x` is normalized to `elo-x=""`. A marker on `div`/`span` is an
  error unless the file documents a native root (`@libstylistRoot native`).
- **Custom-tag hosts:** an author spread becomes `{...hostProps(spread)}` — except a `cx()` spread,
  which is string-only already — and every `data-*`/`aria-*` value that could be boolean is wrapped
  in `cxAttr(v)`; literal `true` values become `"true"`.
- **Key placement:** a `key` after the element's `cx()` spreads moves ahead of them (when no other
  spread precedes it), so the automatic runtime keeps `jsx()`.
- **Compiled mark:** a module with a runtime `cx()` call gets one top-level `cxCompiled()` after its
  imports (behind the `NODE_ENV` guard in `dev: "runtime"`), so the runtime's development heuristic
  for unbranded data literals (§6) knows its calls are compiled before the first render.
- **Validation:** with a registry, a member naming no part of its sheet is an error (`onUnknownPart`).
  A `partMaps` value that is a relative or absolute path is an error (§5.1).

### 5.4 Forwarding and slots

- Every exported component's identity element passes its props to its `cx()` call:
  `<elo-alert {...cx(cn.root, rest, { variant })}>`. That call forwards the markers and part
  attributes a wrapper or a caller puts on the component (`<Alert {...cx(page.banner)}>`,
  `<Modal elo-modalconfirm {...cx(rest)}>`); a component that hands its whole props object on
  (`<Popover elo-tooltip {...rest}>`) forwards them too.
- "The component's props" is a binding, resolved by scope analysis (ESLint `forward-props` and the
  checker's R112/R106/S307 share the predicate): the props parameter, its rest element, a named slot
  it destructures, the same destructured in the body from one of those (`const { a, ...rest } =
  props`), a `const` alias of one or of a `cx()` call forwarding one, and a named slot read off one
  (`props.inputCx`). "The props parameter" is a function's first parameter, and only when the
  function is no callback: a function passed to a call is a callback unless it is the first
  argument of a component wrapper (`memo`, `forwardRef`, `observer`, `Object.assign`), so a
  `.map((item) => …)` parameter is not the props, nor is `memo`'s comparator's, and neither is a later
  parameter (`forwardRef`'s `ref`). Another prop
  (`cx(cn.root, style)`), an import or a `let` forwards nothing.
- A component with no DOM of its own passes its props to its delegate with the marker
  (`<Modal elo-modalconfirm {...cx(rest)}>`); a member root carries its bound part and the slot that
  brings the caller's parts (`<RadixPopover.Content elo-popover-content {...cx(cn.content, contentCx)}>`).
- A **named slot** (`inputCx`, `contentCx`, `textareaCx`) is a prop typed `CxAttrs` whose value is a
  `cx()` call: `<TextInput inputCx={cx(cn.field)}>`. The child merges it into the inner element's
  call: `<input {...cx(cn.input, inputCx)} />`. A slot carries parts and markers only; a data literal
  in a slot value renders nothing (an error) — the caller's data stays on its own elements.

### 5.5 Dev annotations

Appended as the last attribute:

```
{...(process.env.NODE_ENV !== "production" && { _cxpart, "data-react-component", "data-file-source" })}
```

- `_cxpart` is the space-joined part names the element's `cx()` spreads read, from their member
  arguments (nested calls included): `cn.icon` → `icon`, `cn["group-label"]` → `group-label`. A part
  of a sheet other than the file's own is labelled `scope:part` (`player-controls:button`); the
  scope is resolved through the registry from the imported map. It is omitted when no part is read.
- `data-react-component` is the innermost PascalCase enclosing function's name (looking through
  `memo`, `forwardRef`, `Object.assign` and `X.Y =`) and goes on identity elements.
- `data-file-source` is `<repo-relative path>:<line>` and goes on identity elements and on every
  element with a `cx()` spread. The root is the nearest directory above the file holding
  `pnpm-workspace.yaml` or `.git`; outside any checkout, the nearest one with a `package.json` (the
  `sourceRoot` option sets it explicitly).
- On a **component element** (`<Button {...cx(cn.close)}>`) the annotations are props passed to the
  component: they reach the DOM only when the component passes its props to a DOM element (a
  third-party one such as `<RadixPopover.Arrow {...cx(cn["hidden-arrow"])}>` does). A libstylist
  component's `cx()` forwards parts and markers only, so its root shows the component's own
  `_cxpart` and `data-file-source`; a part put on it appears in the DOM only as its `_cxclass_`
  attribute.
- The `dev` option can be `"runtime"` (default; the guard stays in dist), `true` or `false`.

## 6. Runtime (`@livesession/libstylist/runtime`)

| Export | Contract |
|---|---|
| `cx(...args)` | Returns a fresh `CxAttrs`: a string argument is a part attribute → `{ [attr]: "" }`; a branded data literal renders `data-<kebab(key)>` for each key (string as is, number → `String(n)`, `true` → `"true"`, `false`/`null`/`undefined` → omitted); any other object contributes exactly its keys matching `^_cxclass_` or a marker `^[a-z][a-z0-9]*-[a-z0-9-]+$` (never `data-*`/`aria-*`) whose value is `""`; `undefined`, `null` and `false` add nothing. Argument order doesn't change the attribute set. In development (any `NODE_ENV` but `"production"`, browsers without a `process` included) it warns once about an unbranded plain object with only primitive values and no forwardable key (a part attribute, or a non-`data-*`/`aria-*` marker, valued `""`) — the signature of a data literal compiled without the plugin — unless a module compiled by the plugin was loaded by that copy of the runtime (`cxCompiled()`). |
| `cxCompiled()` | Marks the copy of the runtime as serving plugin-compiled code, which turns the unbranded-literal heuristic off. The transform emits one top-level call (behind the `NODE_ENV` guard in `dev: "runtime"`) in every module with a runtime `cx()` call; never written by hand. |
| `cxData(record)` | Brands a data literal (`Symbol.for("libstylist.cxData")`, shared by every copy of the runtime). Emitted by the transform; never written by hand. |
| `CxAttrs` | The type of a `cx()` result and of a named slot prop: `{ readonly [attr: \`${string}-${string}\`]: "" }` — only hyphenated keys, so it spreads onto intrinsic elements, custom tags and components with strict props (TS 4.9 and 5.x). |
| `CxArg`, `CxDataRecord`, `CxData` | The argument types (`string \| false \| null \| undefined \| object`; a data literal is `Record<string, string \| number \| boolean \| null \| undefined>` — TypeScript can't tell a literal from a props object, the lint rules can). |
| `cxAttr(v)` | Returns `"true"` for `true`; otherwise returns `v` unchanged. Emitted by the transform. |
| `hostProps(props)` | Returns a copy with boolean `data-*`/`aria-*` values normalized as `cxAttr` does. Emitted by the transform. |
| `withoutStylist(props)` | Returns a copy of `props` without the keys `cx(props)` would forward (its part attributes and identity markers): for a component whose root takes them while the rest spreads onto an inner element. |
| `unsetRef(props)` | A ref for a custom tag whose DOM-property props (`title`, `tabIndex`, …) may become unset; removes the attributes React 19 would leave behind. |
| `legacyClassName(value)` | Passes a not-yet-migrated caller's class prop through (a single identifier or member); counted by lint; zero uses at the end. |
| `legacy(...names)` | Joins truthy literal class names — the only sanctioned `className` value while a family is mid-migration; counted; zero uses at the end. |

## 7. Registry (`stylist-registry.json`)

```
{ version: 1, prefix, hash: { version: 1, length },
  scopes: { [scope]: { namespace, group, file,
                       roots: [{ component, local, tag, display? }],
                       parts: { [part]: attr }, globals: [...], keyframes: { [local]: name } } } }
```

The **part maps** are the projection `{ [part]: attr, $tags: { [component]: tag } }` of each scope, one export per scope (§5.1).

Every sheet belongs to one css group, and every group to one namespace. Several groups may share a
namespace — each package of a workspace of app packages has a group per namespace of its own
(`crm-accounts` and `crm-accounts.render`, `crm-partners` and `crm-partners.render`) — when they name
its tags one way (the same segment and word). Uniqueness holds per prefix, across groups and packages:
a scope, a part attribute or a tag declared twice is a build error whichever groups the two come from.

A workspace of app packages is built by `libstylist build` (CONFIG.md): the same registry, every
sheet compiled alone and wrapped as `@layer <order statement>; @layer <its namespace's layer> { … }`
(`css.layers`; a sheet declaring `@layer` or `@import` is an error), each package's part-map module
(§5.1), the lock and the registry JSON. Two scopes whose export names meet in one part-map module or
under one `partMaps` specifier are a build error.

The **lock file** (`stylist.lock.json`) is the flat projection `{ parts: { "ns/scope:part": attr }, tags: { "ns/Component.Path": tag } }`, plus, for an app with override sheets, the optional sections `overrides` and `resets` (§9.6). It is committed, so a changed identity shows up in review: the css build rewrites it on every build, and CI's clean-tree check fails when the regenerated lock differs from the committed one (the update is committing it). There is no `lock` CLI command; `diffLock(prev, next)` from `@livesession/libstylist/registry` classifies a difference (an entry that changed or disappeared is `breaking`, an addition never is) and `formatLockDiff` prints it, for a project that wants a stricter gate.

## 8. Configuration

**Per package**, in its `package.json`:

```
"libstylist": { "prefix": "elo", "namespace": "player", "segment": "player", "word": "Player" }
```

- `segment` defaults to `namespace`, except for `core`, where it is empty.
- `word` defaults to the capitalized segment.

**Per directory**, in the same field — directories of the package whose files (sources and sheets) use
a namespace of their own:

```
"libstylist": { "prefix": "crm", "namespace": "core", "namespaces": { "src/render": "render", "src/css/render": "render" } }
```

- A key is a package-relative posix directory: no leading `/`, no `.` or `..` segment, no backslash,
  no glob. A value is a namespace (naming defaulted as above) or `{ "namespace", "segment"?, "word"? }`.
- A file takes the namespace of the longest key containing it, matched on whole path segments
  (`src/renderer/Row.tsx` is not in `src/render`); a file under no key takes the package's `namespace`.
- A namespace names tags one way: its directories agree on segment and word, and a directory repeating
  the package's own namespace repeats its naming.

**Per project**, in `libstylist.config.mjs`, used by lint, the checker and the workspace build
(`libstylist build`, `stylistWorkspace()`): see `docs/CONFIG.md` — including an app's override sheets of
a design system (`css.overrides`, §9.7).

## 9. Override sheets

An **override sheet** is an app's plain CSS file that restyles a design-system (DS) component with
the part names the DS publishes. It declares what it overrides and then styles `.root` and the parts
like the DS sheet itself; libstylist rewrites them to the DS's identity and part attributes, places
the result in a cascade layer after the DS's, and can **reset** DS parts so the app starts from
scratch.

### 9.1 Vocabulary

| Term | Meaning |
|---|---|
| **target** | What an override sheet names: a DS component path (the **component form**, `Button`, `Table.Tr`, `ListCollection.Root`) or a DS sheet id (the **scope form**, `tooltip`). |
| **target sheet** | The DS registry scope holding the target: the scope whose `@stylist root` binds the path (`Path` ≡ `Path.Root`), or the named scope. |
| **reset target** | A part of a target sheet whose DS declarations a reset strips; labelled `<prefix>:<namespace>/<scope>:<part>` (`elo:core/button:loader`). |

### 9.2 Grammar

```
override-sheet     := preamble override-directive reset-directive* rule-or-at-rule*
preamble           := (comment | "@charset" …)*
override-directive := "@stylist" "override" target "from" package [ "within" app-component ] ";"
target             := ComponentPath | sheet-id           ; dotted PascalCase | kebab-case
package            := a quoted bare package name         ; "@livesession/eloquentui-react", no subpath
app-component      := [ namespace "/" ] ComponentPath    ; the :component() argument grammar
reset-directive    := "@stylist" "reset" part* ";"       ; no part: every part of the target sheet
```

- Directives are top-level statements before the first rule. Exactly one `@stylist override`, first;
  `@stylist reset` may repeat (parts accumulate; a part twice, or a whole reset next to part resets,
  is an error). `@stylist root|scope` in an override sheet are errors: it declares no component.
- `from` names the component package the app imports the component from. Its `package.json`
  `libstylist.prefix` selects the design system (its registry), `libstylist.namespace` the namespace
  the target is looked up in. A package of the app's own prefix is an error.

### 9.3 Resolution

- Component form: the scope of the namespace whose roots bind the path. The **identity** is that root's
  tag; the target's **root part** is its local (`Table.Tr` → `tr`).
- Scope form: that scope of the namespace; its root part is `root` when the sheet has one.
- Every class of the sheet (outside `:global()`) must be `root` (component form) or a part of the
  target sheet; every reset part must be a part of it, `root` meaning the target's root part.
- Every `:component([ns/]Path)` of the sheet names a component of the same design system — of the
  target's namespace, or of `ns` — other than an identity of the target sheet itself (written with its
  class: `.root`, `.tr`); it resolves to that root's tag (`unresolved-ref`, with the nearest name).
- The sheet id (the file's basename) is kebab-case (`invalid-override`).
- `within` resolves against the app's registry: a root of the named namespace, or of exactly one.
- Across an app: sheet ids (basenames) are unique; a target sheet has at most one global override
  sheet and one per `within` component (`Table` and `Table.Tr` are one target sheet); own keyframes
  never share a name with the target sheet's.
- A whole reset in the component form is allowed only when every root the target sheet binds is the
  target or one of its members; otherwise the scope form resets the whole sheet.
- Errors carry a code (`invalid-override`, `unresolved-package`, `unknown-target`, `unknown-part`,
  `unresolved-ref`, `unknown-within`, `duplicate-override`, `shared-reset`, `reset-within`,
  `keyframes-clash`) and name the nearest valid name and, for parts, the target's full part list. An
  unknown component path whose kebab-case name (or its family's) is a sheet of the namespace names that
  sheet as the target (`Tooltip` → `@stylist override tooltip …`).

### 9.4 Compiling

After nesting is flattened, per selector:

| Source | Component form | Scope form | Specificity |
|---|---|---|---|
| `.root` | `:is(<tag>,[<tag>])` — the custom tag and the marker alike | `[<root part attr>]` | (0,1,0) |
| `.<part>` | `[<part attr>]` | same | (0,1,0) |
| `:component([ns/]Path)` (context only) | `:is(<tag>,[<tag>])` of that component | same | (0,1,0) |
| `@keyframes <local>` | `<appPrefix>-override-<sheet id>-<local>`, own `animation` references renamed | same | — |
| `animation: <target keyframes local>` | the target sheet's emitted name | same | — |

- **The subject is the target's own element.** In a rule selector, a compound **names a part** when
  it has a class of its own, or an in-place pseudo-class (`:is`, `:where`) or a sibling filter
  (`:nth-child(… of S)`) whose every argument's subject does; a class inside `:not()` or `:has()`
  names another element. Some compound naming a part must be the subject, or be followed by a
  descendant or child combinator (after one, any combinator stays inside that element): `.root svg`,
  `.content > *` and `.icon + .children` style elements of the component; `:root:has(.root) [x]`,
  `:has(.loader)` and `.root ~ p` would style the rest of the app.
- `:component()` of the same design system is context only: before the compound naming a part, in a
  sibling compound, inside `:has()`/`:not()`, or in an at-rule prelude. In the subject compound it is
  rejected — that component is restyled in its own override sheet, with this one as its context.
- Rejected (`[override-selector]`): the above, `:cx()`, `:global()`, ids, `[class…]`, part
  attributes (`[_cxclass_…]`), the dev attributes, `[data-component]`/`[data-part]`, tags and markers
  of the DS or the app prefix, and a rule selector with no class outside `:not()` (it would restyle
  the whole app). At-rule preludes (`@scope`, `@supports selector()`) only have their classes and
  `:component()` references rewritten. An authored `@layer` or `@import` is an error.
- `within <App>`: in every rule selector, the first compound naming a part gets
  `:is(<T>,[<T>],<T> *,[<T>] *)` (`T` the app component's tag) appended before its pseudo-element —
  the app component's identity element or anything inside it, +(0,1,0).
- A design-system `!important` beats every declaration of the overrides layer for the same property
  and element (the cascade reverses the layer order for important declarations): a workspace build
  warns (`[important]`) for each such declaration of an override sheet — the design-system rule's
  subject names the part (or, for `.root`, the root part or the identity), the properties overlap
  (equal, or a shorthand and its longhand) — unless the part is reset, which removes its own
  `!important`s; another component's `!important` for the identity only the design system can drop.
- Output: `@layer <order statement>;\n@layer <overrides layer> {\n<compiled>\n}\n`. The overrides layer
  (`app.overrides` by default) comes after the DS `components` layer — after `utilities` in effect,
  since the DS aggregate declares its layers first — and before every namespace layer of the app, so
  an app component's contextual styling of a DS element beats the global override.

### 9.5 Reset

A reset is applied at build time to the DS stylesheets the app bundles; nothing happens at runtime.
(`revert-layer` in the override layer rolls back only to the DS layer itself, and `all: revert`
rolls back to the user agent — custom tags lose their display, native controls get their UA
styles back, the DS reset layer is gone.)

For each rule outside `@keyframes`, each complex selector's **subject** (its last compound, with its
pseudo-classes and pseudo-element) is classified against the reset attributes `R`:
- **all**: a top-level attribute selector of the subject is in `R`, or an in-place pseudo-class
  (`:is`, `:where`, `:matches`, `:-webkit-any`, `:-moz-any`) has only arguments whose subjects are
  **all**;
- **some**: an in-place pseudo-class, or a subject filter (`:nth-child(… of S)`,
  `:nth-last-child(… of S)`), has an argument whose subject is **all** or **some**; a subject filter is
  never **all**;
- **none** otherwise. `:not()`, `:has()` and ancestor compounds never count. Inside `@scope`,
  `:scope` and `&` stand for the start selector. A subject carrying the guard
  `:where(:not([a],…))` has those attributes excluded already.

Only rules with a declaration other than a custom property are touched. Then: **none** keeps the
selector; **some** keeps it with `:where(:not(<[attr] per attribute of R it names>))` appended to the
subject (before a pseudo-element) — no specificity change; **all** drops it. A rule left with no
selector loses every declaration except custom properties (`--*`) and is removed when none is left; a
rule with kept selectors keeps them, and a clone right before it carries the custom properties of its
dropped selectors and of its guarded ones as written. At-rules left empty are removed; an emptied
`@layer <name> {}` that first declares its layer becomes `@layer <name>;`, and a block-less at-rule
left last in its container is ended with `;` (a bundler concatenates the next stylesheet right after
it). The result is idempotent, keeps rule order and every kept selector's specificity, and is preceded
by `/* libstylist: reset <labels> (<override sheets>) */`. A local `@import` in a DS stylesheet while
resets are active is an error (`[reset-import]`).

Kept by construction: custom properties, the display defaults and every rule whose subject is a
component's identity (another component's `:component()` contract for it), rules whose subject is a
descendant of the reset element, `@keyframes`, and the DS `reset`/`tokens` layers.

The **report** of a reset target counts the unique declarations and rules it drops across the DS
stylesheets (conditions + selector + property + value) — a guarded selector drops its rule's
declarations for the target like a dropped one —, the selectors it guarded, the other components'
rules on its identity (when the part is a root's local), and the **layout-contract** declarations it
drops that the override sheet does not re-declare for the same element under the same conditions:
`item` — `flex*`, `order`, `align-self`, `justify-self`, `place-self`, `grid-area`, `grid-row*`,
`grid-column*`, `inset*`, `top`/`right`/`bottom`/`left`, `z-index`, a zero `min-width`/`min-height`/
`min-inline-size`/`min-block-size`, a relative (`%`, `stretch`) `width`/`height`/`inline-size`/
`block-size`/`max-*`, an `auto` margin; `container` — `display` establishing a layout (`flex`, `grid`,
`contents`, `none`, `table*`), `flex-direction`, `flex-flow`, `flex-wrap`, `grid-template*`,
`grid-auto*`, `gap`, `row-gap`, `column-gap`, `align-items`, `justify-items`, `place-items`,
`align-content`, `justify-content`, `overflow*`; `position` other than `static` is both. Declarations
of a pseudo-element's rule are no contract. An override declaration re-declares a dropped one when its
rule's subject names the target (its part attribute, or its identity for a root), it declares the
property or a shorthand of it, its conditional at-rules are among the dropped rule's, and its
selector's **conditions** are among the dropped selector's — a condition is every simple selector that
is not structure (state, pseudo-classes and elements, document context; structure is combinators, type
selectors, part attributes, identity markers and an `:is()`/`:where()` of structure only). A part reset
that drops nothing is an error (`[empty-reset]`); a whole reset is one only when no part drops
anything.

### 9.6 Lock

With override sheets, the lock gains `overrides` — `"<prefix>:<ns>/<Component.Path>"` → tag for each
component-form target and each `:component()` of a sheet's context, `"<prefix>:<ns>/<scope>:<part>"` →
attribute for each part a sheet reads or resets — and `resets` — the reset parts. Each section is written only when it has an entry, so a lock
without overrides is unchanged; `diffLock` classifies them like the others (kinds `override`,
`reset`).

### 9.7 In a workspace

A workspace of app packages (`libstylist build`, `stylistWorkspace()`, `libstylist check`) takes its
override sheets from `css.overrides` (CONFIG.md, "Overriding the design system"):

- **`dir`**: every `.css` file under it (dot, `node_modules` and build-output directories skipped) is an
  override sheet, identified by its path relative to the config's directory. It is neither a sheet
  directory nor above one; inside one, its files are no package's sheets (no scope, no part map, no
  identity, no finding of the checker's sheet rules). Sheet ids (basenames) are unique across it.
- **`registries`**: the design systems. A css package specifier is found installed (`node_modules`,
  symlinks followed) from `dir`, then from the config's directory; its `package.json` declares
  `libstylist.groups` and names its registry in `libstylist.registry` (package-relative), default
  `dist/stylist-registry.json`. A `.json` path is a registry whose package is the nearest directory above
  it with a `package.json`. A registry is readable, of version 1, carries its package's
  `libstylist.prefix`, and its prefix is neither the app's nor another design system's
  (`[design-system]`).
- **`from "<package>"`** resolves to the package installed where the sheet is; its `package.json`
  declares `libstylist.prefix` and `libstylist.namespace` (a component package; a css package is an
  error).
- **`layer`** (default `app.overrides`) is declared by the order statement after `components` and before
  every namespace's layer; the default statement is the design system's layers, the overrides layer,
  then the namespace layers.
- **The overrides module**: `<dir>/index.ts`, generated (the part-map header, a side-effect import of
  every override sheet sorted by path, `export {}`), committed, imported once by the app's entry. A file
  there without the header is an error (`[overrides-index]`) and never overwritten.
- **The lock** carries the `overrides` and `resets` sections (§9.6).
- **Resets** are applied by the bundler plugin to every stylesheet inside a configured design system's
  package directory as the app imports it, with the resets of the last error-free resolution (in watch
  mode, override sheets and design-system stylesheets are transformed on every rebuild, so a new reset
  strips a cached stylesheet and the guards below count every module). A build fails when a reset
  target is stripped (dropped or guarded) from no bundled stylesheet (`[unbundled-reset]`; a whole
  reset when none of its parts is), when it bundles a design-system stylesheet or an override sheet but
  not every override sheet (`[overrides-not-imported]`), and when a bundled CSS asset declares the
  overrides layer out of place — before `components`, or after a namespace layer (`[layer-order]`: the
  first `@layer` declaring a layer fixes its order, so every order statement the app writes lists the
  overrides layer where `css.layers.statement` does).
- **`!important` warnings** (§9.4) are compile warnings of the override sheet, over every stylesheet the
  design system publishes.
- **The reset report** is computed over every stylesheet under the directory of each design system's
  registry file, aggregates first, each named by its path under that directory; `[empty-reset]` is an
  error of the build, the dev overlay and the checker (S310).
