# libstylist — guide for agents

One published package, `@livesession/libstylist`, in `packages/libstylist`; its own
[CLAUDE.md](packages/libstylist/CLAUDE.md) is the entry point to what the package does and routes
you to the doc for your task (authoring, migrating, rules, config, SPEC). This file covers the
repository around it.

## Layout and commands

- `packages/libstylist/src` — the sources, one directory per entry point (`runtime`, `babel`,
  `vite`, `postcss`, `registry`, `eslint`, `stylelint`, `check`, `codemod`, `migrate`, `workspace`,
  `typesgen`, `cli`); `jsx/index.d.ts` the hand-written JSX typings; `bin/libstylist.mjs` the
  committed CLI launcher (it loads `dist/cli/index.js`, so `pnpm build` first).
- `packages/libstylist/test` — `node:test` suites run by `pnpm test` (`node --import tsx --test`).
  Fixtures live in `test/fixtures` (`fixtures/monorepo` is a design-system-shaped workspace for the
  tests that need a realistic package layout). The tests that read the design-system repository's
  real sources (`*-real.test.ts`, the real-sheet and real-source smokes) take the checkout's path
  from `LIBSTYLIST_DESIGN_SYSTEM` (absolute, or relative to the repository root) and skip without
  it; a path that is set but is no checkout fails the run — see `test/design-system.ts`.
- `pnpm build` (tsc, `tsconfig.build.json`), `pnpm typecheck`, `pnpm test` from the root run the
  package's scripts; CI (`.github/workflows/pr.yml`) runs exactly these plus `beachball check`.

## Changing the package

- Every PR that touches `packages/libstylist` outside its tests needs a **change file**:
  `pnpm change` (bump type + one changelog sentence) writes `.change/<name>.json`. Use `none` for a
  change nothing published can tell (a comment, a devDependency), `patch` for a fix, `minor` for a
  new capability, `major` for a breaking change of the runtime, the transform output, the CLI or
  the rule set. Docs ship in the tarball (`files` in package.json), so a docs change takes a change
  file too; only `test/**` is exempt.
- Never edit `version` in `packages/libstylist/package.json`: `0.0.0-dev` is a permanent
  placeholder. Versions are computed by the Release PR from change files, from the seed
  `0.0.0` on the first release.
- The published surface is the `exports` map; a new entry point needs its `exports` and
  `typesVersions` entries and a `minor` change file.
- `docs/RULES.md` is linked from every ESLint and stylelint message (`RULES_DOC_URL`,
  `src/eslint/create-rule.ts`); keep its anchors stable when renaming a rule.

## Releasing (what the workflows do)

`.github/workflows` are thin callers of the `livesession/public-release-actions` reusable
workflows:

| Workflow | Fires on | Does |
|---|---|---|
| `pr.yml` | PRs, pushes to master | `beachball check`, install, build, typecheck, test, clean tree |
| `canary.yml` | push to master | publishes `0.0.0-canary.<sha>` under the `canary` dist-tag |
| `release-pr.yml` | push to master (pending change files) | updates the bot-owned Release PR: CHANGELOG, consumed change files, `.release/latest.json` |
| `tag-release.yml` | `.release/latest.json` changes on master (the Release PR merge) | creates and pushes the `@livesession/libstylist@x.y.z` tag |
| `publish-tag.yml` | a pushed `@livesession/**` tag | publishes that exact version |
| `publish-latest.yml` | by hand | publishes the manifest's release when no tag event ran it (dry run by default) |

Merging the Release PR is the only human release action. Secrets: `TAG_RELEASE_TOKEN` (a PAT with
`contents: write`) lets the pushed tag start Publish Tag; without it, run Publish Latest after the
tags appear. The workflow `GITHUB_TOKEN` publishes to GitHub Packages (`packages: write`).

## Conventions

- Commit messages: `feat(libstylist): …`, `fix(cli): …`, `test: …`, `docs: …`; no AI attribution.
- The package is public: no internal hostnames, tokens or private links in sources, docs, tests
  or change files.
