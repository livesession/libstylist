# The monorepo fixture

A miniature of the design-system monorepo's layout, for tests that need a realistic file location
whose libstylist package config resolves from disk the way it does in the design system — not the
design system's real sources (those tests take a checkout from `LIBSTYLIST_DESIGN_SYSTEM`, see
`test/design-system.ts`).

- `pnpm-workspace.yaml` makes this directory the repository root the tooling finds (`findRepoRoot`),
  so segment discovery reads these packages and never the surrounding checkout.
- `packages/<name>/package.json` declares the design system's six component packages and their
  namespaces: `components` → `core`, `app-ui` → `app`, `player` → `player`, `gram` → `gram`,
  `infinity` → `inf`, `ai` → `ai` (the discovered segments are `ai, app, gram, inf, player`). The
  `css` package declares the groups of its two sheet directories.
- `packages/components/src/components/index.ts`, `packages/player/src/components/index.ts` and
  `packages/player/src/headless/index.ts` are the entries the CONFIG.md checker example names, and
  `packages/css/src/{components,player}` its css groups (one sheet each, so git keeps the directories).

A test that needs a package *installed* under `node_modules` (a design-system component library an
app imports) copies this fixture into a scratch directory and writes the package there, as
`fixtures/overrides/install.ts` does — nothing under `node_modules` is committed.
