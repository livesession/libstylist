# @livesession/libstylist — guide for agents

libstylist is LiveSession's tooling for building UIs with a self-describing DOM:

- every exported component's root is a namespaced **custom tag** (`<elo-alert>`,
  `<elo-app-dock>`) or, for a semantic root, a value-less **marker attribute**
  (`<button elo-button>`);
- styling goes through **part maps and `cx()`**, never `className`: a component imports its sheet's
  typed part map (`import { alert as cn } from "@livesession/eloquentui-css"`) and spreads one call
  per element, `<span {...cx(cn.icon)}>`, which renders the hashed, value-less **part attribute**
  (`<span _cxclass_elo-or4d4l>`), selected in CSS as `[_cxclass_elo-or4d4l]`. The DOM carries no
  `class` attributes;
- state and variants are `data-*` attributes from the same call's data literal:
  `<elo-alert {...cx(cn.root, rest, { variant, open })}>`;
- development builds add `_cxpart` (the readable part name), `data-react-component` and
  `data-file-source` (file:line); production builds carry none of them;
- lint rules, a conventions checker and the build enforce all of it.

The prefix (`elo` in the design system) is configurable per project (`app` in the webapp).

## Read the doc for your task

| Task | Read |
|---|---|
| Writing or changing a component (tags, markers, `cx()`, part maps, data, slots, forwarding, `@stylist` directives) | [docs/AUTHORING.md](docs/AUTHORING.md) |
| Overriding or resetting a design-system component from an app (`@stylist override`, `@stylist reset`) | [docs/AUTHORING.md](docs/AUTHORING.md#overriding-and-resetting-a-design-system-component), [docs/CONFIG.md](docs/CONFIG.md#overriding-the-design-system) (the app's setup: `css.overrides`, the overrides module, what the build and Vite do), SPEC §9 |
| Migrating a component, a component family, or a whole app to libstylist — or code from the old `cx` attribute to `cx()` calls; rewriting a consumer app's legacy `ls-*` selectors (`libstylist migrate-selectors`) | [docs/MIGRATING.md](docs/MIGRATING.md) |
| A lint, stylelint, build or `libstylist check` error | [docs/RULES.md](docs/RULES.md) |
| Setting up libstylist in a project (Vite, Babel, PostCSS, ESLint, stylelint, TypeScript) | [docs/CONFIG.md](docs/CONFIG.md) |
| How tags and part hashes are derived, the registry, the part maps, the `cx()` grammar | [SPEC.md](SPEC.md) |

## Rules of thumb

- Never write `className` in a libstylist codebase. Style an element with `{...cx(cn.part)}`, a child
  component's root by spreading `cx()` on the child (`<Button {...cx(cn.toggle)}>`), a child's inner
  element through its `*Cx` slot prop (`inputCx={cx(cn.field)}`).
- One `cx()` call per element: its parts (part-map members), the props object it forwards (the
  identity element always passes its `rest`) and one inline data literal.
- Parts name structure only and are never conditional: every state or variant goes into the data
  literal (`cx(cn.root, { open })`) and the sheet selects `.root[data-open]`. Write no raw `data-*`
  JSX attribute on design-system elements.
- Never hand-write `_cxclass_*`, `_cxpart`, `data-react-component` or `data-file-source` —
  the part maps and the transform own them.
- The libstylist Babel/Vite plugin must compile every module that calls `cx()` (it brands the data
  literals); without it the data renders nothing.
- Visual output must not change when you restructure markup: prove it with the project's
  visual regression suite; never update a baseline to make a refactor pass.
- Run `libstylist gen-types` after adding a custom tag, and the project's lint before
  committing.
