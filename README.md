# libstylist

The purist styling system for UI artisans — LiveSession's tooling for building UIs with a
self-describing DOM.

Every exported component renders a namespaced **custom tag** (`<elo-alert>`) or, on a semantic
root, a value-less **marker attribute** (`<button elo-button>`). Styling goes through typed **part
maps** and one `cx()` call per element, never `className`: the call renders hashed, value-less
**part attributes** (`<span _cxclass_elo-or4d4l>`) that the sheet selects, state and variants are
`data-*` attributes from the same call, and development builds annotate every element with its
readable part name, component and source line. Lint rules, a conventions checker and the build
enforce all of it.

```tsx
import { alert as cn } from "@livesession/eloquentui-css" // the sheet's typed part map
import { cx } from "@livesession/libstylist/runtime"

export function Alert({ variant = "info", title, children, ...rest }: AlertProps) {
    return (
        <elo-alert {...cx(cn.root, rest, { variant, hasTitle: title != null })} role="status">
            <span {...cx(cn.icon)}>…</span>
            <span {...cx(cn.content)}>{title && <span {...cx(cn.title)}>{title}</span>}{children}</span>
        </elo-alert>
    )
}
```

The package is [`@livesession/libstylist`](packages/libstylist) — its [README](packages/libstylist/README.md)
lists every entry point (`/runtime`, `/vite`, `/babel`, `/postcss`, `/registry`, `/eslint`,
`/stylelint`, `/check`, `/workspace`, `/jsx` and the `libstylist` CLI), and its docs cover
[authoring](packages/libstylist/docs/AUTHORING.md), [migrating](packages/libstylist/docs/MIGRATING.md),
the [rules](packages/libstylist/docs/RULES.md), the [configuration](packages/libstylist/docs/CONFIG.md)
and the [specification](packages/libstylist/SPEC.md).

## Installing

The package is published to GitHub Packages under the `@livesession` scope. Point the scope at the
registry and authenticate once with a token that can read packages:

```ini
# .npmrc
@livesession:registry=https://npm.pkg.github.com
```

```sh
pnpm config set //npm.pkg.github.com/:_authToken <a GitHub token with read:packages>
pnpm add -D @livesession/libstylist
```

Every push to `master` also publishes a canary build, `0.0.0-canary.<sha>`, under the `canary`
dist-tag.

## Repository

```
packages/libstylist   the package: src/, test/, bin/, jsx/, docs/
.change/              pending beachball change files (one per change, consumed by a release)
.github/workflows     CI and the release workflows
```

```sh
pnpm install
pnpm build        # tsc → packages/libstylist/dist (the CLI loads it)
pnpm typecheck
pnpm test         # node:test over packages/libstylist/test
```

The design-system smoke tests (`*-real.test.ts` and the other tests that read a checkout of
LiveSession's design system — libstylist's first consumer) run only with
`LIBSTYLIST_DESIGN_SYSTEM=<path to that checkout>` (absolute, or relative to this directory) and skip
otherwise.

## Releasing

Releases run on the [`livesession/public-release-actions`](https://github.com/livesession/public-release-actions)
reusable workflows:

- `package.json` keeps the permanent placeholder version `0.0.0-dev`; nobody hand-bumps. Real
  versions live in `@livesession/libstylist@x.y.z` git tags, on the registry and in the generated
  `CHANGELOG.md`.
- Every PR that changes the package carries a **change file**: `pnpm change` asks for the bump type
  (major / minor / patch / none) and a changelog sentence and writes it to `.change/`; CI fails
  without one (only the package's tests are exempt — `ignorePatterns` in `beachball.config.cjs`).
- A push to `master` publishes a **canary** and keeps the bot-owned **Release PR** up to date:
  the generated changelog, the consumed change files and `.release/latest.json`, the manifest of
  what merging it releases. Merging that PR is the release approval.
- The merge **tags** `@livesession/libstylist@x.y.z`, and the tag **publishes** exactly that
  version. A release whose tag started no publish is finished by hand from the Actions tab with
  *Publish Latest* (dry run by default).

## License

[ISC](LICENSE)
