# Configuring libstylist

## Per package: `package.json`

Every package whose sources use libstylist declares its prefix and namespace:

```json
{
  "libstylist": { "prefix": "elo", "namespace": "player" }
}
```

| Field | Meaning | Default |
|---|---|---|
| `prefix` | Project prefix — tags (`elo-…`), markers and part attributes (`_cxclass_elo-…`) | required |
| `namespace` | Hash namespace (`core`, `app`, `player`, …) — must match the stylesheet group | required |
| `segment` | Tag segment (`elo-<segment>-…`) | the namespace; empty for `core` |
| `word` | Leading word stripped from component names (`PlayerTopBar` → `topbar`) | capitalized segment |
| `hashLength` | Characters of the part hash | 6 |
| `namespaces` | Directories with a namespace of their own: package-relative posix directory → namespace, or `{ namespace, segment?, word? }` ([SPEC.md](../SPEC.md) §8). A file takes the longest directory containing it | none |
| `sources` | The package's source directories (package-relative posix directories, none nested in another): where `gen-types` finds the custom tags and what the workspace transform compiles — for a package whose components don't live under `src` ([Sources outside `src`](#sources-outside-src)) | `["src"]` |

A package with layers keeps each one in its own namespace — an app package's dummy components in
`src/components` (the package's `core`: `<crm-invitationrow>`) and its smart `Render*` components in
`src/render` (`render`: `RenderInvitationRow` → `<crm-render-invitationrow>`), with the render sheets
in `src/css/render`:

```json
{
  "libstylist": { "prefix": "crm", "namespace": "core", "namespaces": { "src/render": "render", "src/css/render": "render" } }
}
```

The transform, the lint rules (`tag-name`, `rootLocals`), `gen-types` and the checker resolve each
file's namespace this way; `src/renderer/x.tsx` is not in `src/render`. Many packages may share these
namespaces ([A workspace of app packages](#a-workspace-of-app-packages)).

The stylesheet package declares the group table instead:

```json
{
  "libstylist": {
    "prefix": "elo",
    "hashLength": 6,
    "groups": { "components": { "namespace": "core" }, "app-ui": { "namespace": "app" } }
  }
}
```

## Build: the plugin is required

The libstylist Babel plugin (or the Vite plugin that runs it) must compile **every** module that
calls the runtime `cx()`: the design-system library builds, Storybook, consumer apps and test
runners (Vitest through the Vite plugin; Jest or other Babel pipelines through
`@livesession/libstylist/babel`). At runtime an inline data literal and a props object are both
plain objects; the plugin brands each inline object-literal argument of a `cx()` call
(`cxData({…})`) so the runtime renders it as `data-*` attributes. Compiled without the plugin, a
data literal is forwarded as props and renders nothing — the development runtime warns once when
it meets one (in Node and in browsers alike; only a `NODE_ENV` of `"production"` silences it). A
module the plugin compiled marks its copy of the runtime when it loads (`cxCompiled()`), which turns
that heuristic off, so a props object of primitives in compiled code never trips it. The plugin also
normalizes markers, adapts custom-tag hosts and adds the dev annotations.

## Build: Vite

```ts
// vite.config.mts (ESM — libstylist is ESM-only)
import { stylist } from "@livesession/libstylist/vite"

export default defineConfig({
    plugins: [
        stylist({
            registry: resolve(__dirname, "../css/dist/stylist-registry.json"),
            partMaps: { components: "@livesession/eloquentui-css", player: "@livesession/eloquentui-css/player" },
        }), // first
        react(),
    ],
})
```

`stylist()` runs with `enforce: "pre"` on `.tsx/.jsx/.ts/.js` sources outside `node_modules` that
import the runtime (or write tags/markers of the prefix), resolves prefix/namespace per file from
the nearest `package.json` (its `namespaces` directory's when the file sits in one), brands data literals, validates part-map members against the registry
when one is given, and bundles the runtime (`@livesession/libstylist/runtime` imports resolve to a
virtual module, so consumers never install libstylist). Works with and without
`@vitejs/plugin-react` (Vite 5–8).

Options: `prefix`, `namespace` (override per-file resolution), `registry` (path, object or thunk),
`partMaps` (css group → the package specifier its part map is imported from; unset, any package
import named like a sheet's part map counts — used for `_cxpart` labels and validation; a relative or
absolute path is an error, see [Part maps built inside an app](#part-maps-built-inside-an-app)),
`onUnknownPart` (`"error"` default, or `"warn"`), `dev: "runtime" | true | false` (dev annotations
behind a `NODE_ENV` guard — default — always, or never), `sourceRoot` (the directory
`data-file-source` paths are relative to; default: the nearest directory holding
`pnpm-workspace.yaml` or `.git`, else — a Docker build context, a fresh scaffold — the nearest one
with a `package.json`), `include`/`exclude` (module id patterns).

Storybook (`.storybook/main.ts` → `viteFinal`): put `stylist()` first in `config.plugins`.

A workspace of app packages uses `stylistWorkspace()` instead: `stylist()` over its packages plus their
sheets compiled at import time ([Vite: `stylistWorkspace()`](#vite-stylistworkspace)).

## Build: Babel

```js
// babel.config.js — any pipeline that compiles JSX/TSX (Jest, a custom Webpack setup)
plugins: [["@livesession/libstylist/babel", { registry, partMaps }]] // before the JSX transform
```

Same options as the Vite plugin (the registry as an object or a thunk); `runtimeModule` names the
module the injected helpers (`cxData`, `hostProps`, `cxAttr`, `cxCompiled`) are imported from.

## Build: stylesheets

```ts
import postcssNesting from "postcss-nesting"
import { stylist } from "@livesession/libstylist/postcss"
import { buildRegistry, stylistOptions } from "@livesession/libstylist/registry"

const { registry, errors } = buildRegistry({ prefix, hashLength, groups, sheets })
// per sheet: postcss([postcssNesting(), stylist(stylistOptions(registry, scope, groups))])
```

Write `stylist-registry.json` (consumed by the Vite plugin, lint and the checker) and the part
maps (`toPartMapModules`: one literal-typed export per sheet, which components import) from the
registry, and commit the lock (`toLock`) so changed part attributes show up in review.

### Override sheets and resets

An app's override sheets (SPEC §9, [AUTHORING.md](AUTHORING.md#overriding-and-resetting-a-design-system-component))
go through three steps, each a pure function. A workspace of app packages gets all of them from
`libstylist build` and `stylistWorkspace()` ([Overriding the design system](#overriding-the-design-system));
another pipeline wires them like this:

```ts
import { acknowledgedDeclarations, collectOverrideSheet, formatResetReports, resetCss, resetReports } from "@livesession/libstylist/postcss"
import { resolveOverrides, toLock } from "@livesession/libstylist/registry"
import { compileOverride, overridesLayerProblem, renderOverridesModule } from "@livesession/libstylist/workspace"

// 1. pass 1 + resolution: every override sheet against the design system's registry
const infos = files.map((file) => collectOverrideSheet(readFileSync(file, "utf8"), { file }))
const { sheets, resets, lock, errors } = resolveOverrides({
    sheets: infos,
    designSystems: [dsRegistry], // @livesession/eloquentui-css/dist/stylist-registry.json
    resolvePackage: (specifier, file) => libstylistFieldOf(specifier, file), // the package's { prefix, namespace }, or { error }
    app: { prefix: "crm", registry: appRegistry }, // `within` resolves against the app's registry
})
// errors: [code] + message with did-you-mean; stop on any

// 2. each override sheet compiled into the overrides layer (nesting + stylistOverride() + the wrap)
overridesLayerProblem(statement, "app.overrides", ["app.core", "app.render"]) // null, or why the order is wrong
const compiled = await compileOverride(css, { from: sheet.file, plugin: sheet.plugin, statement })

// 3. the design system's stylesheets stripped of the reset parts, where the app bundles them
const { css: stripped, outcome } = resetCss(dsCss, resets, { from: "styles.css" }) // null: unchanged
const lines = formatResetReports(resetReports(resets, [{ file: "styles.css", outcome }], {
    acknowledged: (target) => acknowledgedDeclarations(compiledCssOf(target.sheet), target),
}))

toLock(appRegistry, lock) // the lock's `overrides` and `resets` sections
renderOverridesModule(overridesDir, files) // the module the app entry imports once

// 4. the bundle: its CSS declares the overrides layer after components, before the app's layers
bundleLayerProblem(declaredLayerOrder(bundledCss), "app.overrides", ["app.core", "app.render"]) // null, or why
```

`compileOverrideSheet` (a workspace's sheets) also warns about declarations a design-system
`!important` of the same element beats (`importantWarnings`, over `designSystemImportants(ds)`).

`stylistOverride()` and `stylistReset({ resets })` are the same steps as PostCSS plugins, for a
pipeline that already runs PostCSS over the sheets and the design system's CSS. The overrides layer
must come after the design system's `components` layer and before the app's namespace layers
(`overridesLayerProblem`). The reset needs the design system's CSS to go through the pipeline —
a stylesheet linked from a CDN keeps every declaration.

### Part maps built inside an app

The tooling recognizes a part map **by its package specifier only** — the transform, the lint rules,
the checker and the codemod compare import specifiers, never resolved paths. A part map imported by
a relative or absolute path (`import { counter as cn } from "../styles-dist/parts"`) renders
correctly, but its members get no `_cxpart` label and no part validation, and `root-part`/R113 can't
see the root part through it; `cx-args` reports such an import when the registry knows the export,
and a path as a `partMaps` value is a configuration error.

A published css package already has a specifier. An app that generates its part maps itself exposes
them under one — an alias every tool resolves:

```ts
// build-css: write the group's part maps next to the registry
const { mjs, dts } = toPartMapModules(registry, "app")
writeFileSync("styles-dist/parts.mjs", mjs)
writeFileSync("styles-dist/parts.d.ts", dts)
```

```ts
// vite.config.mts (and the test runner's config)
resolve: { alias: { "@app/styles": resolve(__dirname, "styles-dist/parts.mjs") } },
plugins: [stylist({ registry: "styles-dist/stylist-registry.json", partMaps: { app: "@app/styles" } }), react()],
```

```jsonc
// tsconfig.json
{ "compilerOptions": { "paths": { "@app/styles": ["./styles-dist/parts.d.ts"] } } }
```

and `partMaps: { app: "@app/styles" }` in the ESLint `settings.libstylist` (and in `css.partMaps`
of `libstylist.config.mjs` when the checker runs). Components then import
`import { counter as cn } from "@app/styles"`.

## TypeScript

Each package keeps `types/stylist.d.ts` (loads `@livesession/libstylist/jsx`, the custom tags' props
type) and a generated `types/stylist-tags.gen.d.ts` (one `JSX.IntrinsicElements` key per custom tag
— TS 4.9 ignores template-literal keys). Include `types/` in the tsconfig used for type-checking but
not in the published declarations. Parts need no JSX typings: `cx()` returns `CxAttrs` (hyphenated
keys only, so it spreads onto any element or component on TS 4.9 and 5.x), the part maps are
literal-typed (an unknown part is a type error), and named slot props are typed `CxAttrs`:

```sh
libstylist gen-types packages/components          # write
libstylist gen-types --check packages/components  # CI
libstylist gen-types --config libstylist.config.mjs  # every package of the config
```

`gen-types` scans a package's `src` — or the directories its `package.json` declares in
`libstylist.sources`; with `--config`, each package's `sources` as the config resolves them.

## Lint

```js
// eslint.config.mjs
import tseslint from "typescript-eslint"

import libstylist from "@livesession/libstylist/eslint"

export default [
    {
        files: ["packages/*/src/**/*.{ts,tsx}"],
        ...libstylist.configs.recommended,
        languageOptions: { parser: tseslint.parser },
        settings: {
            libstylist: {
                registry: "packages/css/dist/stylist-registry.json",
                // css group → part-map module (the same map as css.partMaps in libstylist.config.mjs)
                partMaps: { components: "@livesession/eloquentui-css", player: "@livesession/eloquentui-css/player" },
            },
        },
    },
    { files: ["**/*.stories.tsx"], ...libstylist.configs.stories, languageOptions: { parser: tseslint.parser } },
]
```

The configs set no parser: TypeScript and TSX sources need typescript-eslint's
(`typescript-eslint`, or `@typescript-eslint/parser` on its own) — without it ESLint's default parser
stops at the first type annotation or JSX tag and no rule runs. JSX in `.tsx` needs no
`ecmaFeatures` option (the parser reads it from the extension).

```js
// stylelint.config.mjs
import { preset } from "@livesession/libstylist/stylelint"
export default preset({ prefix: "elo" })             // { legacy: true } while migrating
```

Settings: `registry` (path or object), `partMaps` (package specifiers only — see
[Part maps built inside an app](#part-maps-built-inside-an-app)), `prefix`/`namespace`/`segment`/`word` (override
the file's config from the nearest `package.json`, its `namespaces` directory's included), `segments`
(the tag segments of sibling packages and of their directory namespaces, discovered from the workspace
by default) and `rootLocals` (family-bound root locals by tag or component path). The
design-system root `eslint.config.mjs` imports `partMaps` from `libstylist.config.mjs`. Allow
imports of the part-map modules — components read their parts from them.

## Conventions checker

`libstylist check` (TypeScript compiler API over all packages plus the stylesheets) finds every
exported component from the package entries and verifies identity elements, forwarding (the
identity's `cx()` receives the props), root parts, tag uniqueness, display defaults and CSS↔JSX
agreement (every part read from its map); `libstylist burndown` reports what
the migration still has to do. Both read `libstylist.config.mjs`, found upward from the working
directory (or `--config <file>`); paths in it are relative to the file. The loader is strict:
unknown keys and wrong types are errors. A component is named in the namespace of its
implementation file (its package's `namespaces` directory, else the package's own); packages may
share a namespace, while tags and scopes stay unique per prefix.

```js
// libstylist.config.mjs
export default {
    prefix: "elo",
    // hashLength: 6,                                     // optional; must equal the css build's
    packages: [
        // name: npm name; entries: keyed like package.json "exports" → source file; cssGroup: the
        // subdirectory of css.dir with the package's sheets. segment/word default as in package.json.
        // An app package lists its own sheet directories (sheets) and namespaces instead of a
        // cssGroup — see "A workspace of app packages".
        { name: "@livesession/eloquentui-react", dir: "packages/components", namespace: "core",
          entries: { ".": "src/components/index.ts" }, cssGroup: "components" },
        { name: "@livesession/eloquentui-player", dir: "packages/player", namespace: "player",
          entries: { ".": "src/components/index.ts", "./headless": "src/headless/index.ts" }, cssGroup: "player" },
    ],
    css: {
        dir: "packages/css/src",
        registry: "packages/css/dist/stylist-registry.json", // optional: drift warning (S309)
        partMaps: { components: "@livesession/eloquentui-css", player: "@livesession/eloquentui-css/player" }, // css group → module
        unboundSheets: [],                                    // sheets bound to no component, relative to css.dir
        hostParts: {                                          // "scope:part": reason
            "player-root:scaled": "the host sets it on the engine's scaled wrapper through the part map",
        },
    },
    exemptions: { budget: { none: 1, multi: 1, native: 1 }, minReasonLength: 12 },
}
```

| Key | Meaning |
|---|---|
| `packages[].entries` | The public entry points; every PascalCase export (and compound member) is a component. An app package's entries are its layer barrels (`./components`, `./render`), never a `.` barrel re-exporting them as `as const` namespace objects (their members would be read as compounds of the object's name) |
| `packages[].segment`, `packages[].word` | The base namespace's tag naming; default as in `package.json`, and must agree with it |
| `packages[].namespaces` | Directory namespaces, exactly as the package's `package.json` `libstylist.namespaces` declares them (the loader compares the two). Needs `sheets` |
| `packages[].sources` | The package's source directories, relative to `dir` (`["app/pages/settings"]`): existing, package-relative, none nested in another. `gen-types --config` scans them and the workspace transform compiles them. Default: the `package.json`'s `libstylist.sources` (which a value set here must equal), else `["src"]` — [Sources outside `src`](#sources-outside-src) |
| `packages[].cssGroup` | The subdirectory of `css.dir` holding the package's sheets, all in the package's namespace. Exactly one of `cssGroup` and `sheets` |
| `packages[].sheets` | The package's own sheet directories (package-relative, searched recursively; no two directories of the config nest or repeat): one css group per namespace, named after the package directory — `crm-accounts`, `crm-accounts.render` — each sheet in the namespace of its directory. `[]` is a package without sheets yet (its groups exist all the same) |
| `css.dir` | One subdirectory per css group; required only when a package has a `cssGroup` |
| `css.registry` | The css build's output; `check` warns when it no longer matches the sheets (S309). `libstylist build` writes it. Unset in a config with no `cssGroup` package (a workspace of app packages), the loader defaults it to where the build writes it, `node_modules/.cache/libstylist/stylist-registry.json` (gitignored), so `check` and the codemod read it too; an ESLint config that imports the raw config object sees only what is written there — [Lint, types and the checker](#lint-types-and-the-checker) |
| `css.lock` | The lock `libstylist build` writes and `--check` compares (committed); default `stylist.lock.json` next to the config |
| `css.layers` | The cascade layers `libstylist build` and `stylistWorkspace()` wrap each sheet in: `statement` (the `@layer` order statement every compiled sheet starts with; default the design system's `reset, tokens, components, utilities`, then the overrides layer when there are override sheets, then each namespace's layer) and `namespaces` (namespace → layer; default `app.<namespace>`). Every namespace's layer must be in the statement — [A workspace of app packages](#a-workspace-of-app-packages) |
| `css.overrides` | The app's override sheets of a design system ([SPEC.md](../SPEC.md) §9): `dir` — the directory holding them, searched recursively (neither a sheet directory nor above one; inside one it is fine — its `.css` files are then override sheets, never the package's); `registries` — each design system, as its css package (`@livesession/eloquentui-css`: the build reads its `dist/stylist-registry.json`, or the package's `libstylist.registry`) or a registry `.json` path; `layer` — the cascade layer they compile into, default `app.overrides`, which the statement declares after `components` and before every namespace's layer — [Overriding the design system](#overriding-the-design-system) |
| `css.partMaps` | css group → the package specifier its part map is imported from; the checker, the codemod and (imported by the ESLint config) the lint rules resolve part-map imports with it. Every key is a css group of a package; several groups may share one specifier (a package's `#css` serves its `core` and `render` groups). Unset: any package import named like a sheet's part map counts. A relative or absolute path is an error (imports are matched by specifier — [Part maps built inside an app](#part-maps-built-inside-an-app)) |
| `css.unboundSheets` | Sheets that style no component (never pending, never checked for unused parts); relative to `css.dir`, or to the config's directory without one |
| `css.hostParts` | Parts that code outside the analyzed sources carries (engine-owned nodes, consumer markup) |
| `exemptions.budget` | The most `@libstylistRoot` tags per category (`none`, `multi`, `native`); omit for unbudgeted |
| `hashLength` | Characters of the part hash, default 6. Must equal the css build's `hashLength` (the stylesheet package's `libstylist.hashLength`). `check` rebuilds the registry from the sheets with this value, so a mismatch makes the parts differ and S309 reports the built registry as stale. The loader does not cross-check it against `package.json` |
| `exemptions.minReasonLength` | The minimum number of characters for an `@libstylistRoot` reason (X121) and for each `css.hostParts` reason. Default 12 |
| `typescript` | `{ paths }`: aliases the TypeScript program of `check` and the codemod resolves, next to the package names (which always resolve to their entries): tsconfig `compilerOptions.paths` semantics — pattern → non-empty array of targets, at most one `*` in each — with the targets relative to the config file (`{ "~/*": ["apps/webapp/app/*"] }`). A pattern equal to a package's name or entry subpath is an error. Without it an aliased import is unresolved, the component it names is `any` and its users report R105 — [Sources outside `src`](#sources-outside-src) |

```sh
libstylist check [--config <file>] [--json] [--pending]
libstylist burndown [--config <file>] [--format text|markdown] [--json] [--expect-zero]
```

- `check` exits 1 on errors — hard rules everywhere, every rule on migrated components — and 0
  otherwise; findings on components not migrated yet are pending (`--pending` lists them).
- `burndown` reports migrated components and flipped sheets per package (never per namespace:
  packages may share one), pending findings per rule and the migration helpers still in use;
  `--format markdown` suits a CI job summary.
  `--expect-zero` exits 1 until nothing is pending, no helper is left and `check` is clean.

Both are also exported from `@livesession/libstylist/check` (`runCheck`, `runBurndown`). See
[RULES.md](RULES.md) for the rule catalogue and the migration ratchet.

## CLI

The `libstylist` bin (`pnpm exec libstylist <command>`):

| Command | What it does |
|---|---|
| `gen-types [--check] [--config <file>] [<packageDir...>]` | writes (or checks) `types/stylist-tags.gen.d.ts` per package from the JSX of its source directories (`src`, or `libstylist.sources`); `--config` adds every package of a `libstylist.config.mjs`, each with its `sources` — [TypeScript](#typescript) |
| `build [--config <file>] [--check] [--watch]` | a workspace of app packages: writes each package's part-map module, the overrides module, the lock and the registry, and prints what each reset of the override sheets drops; `--check` exits 1 when a committed one is out of date (still writing the gitignored registry; a stale lock lists the entries that moved); `--watch` rebuilds on every change of a sheet, an override sheet or a design system's registry — [A workspace of app packages](#a-workspace-of-app-packages), [Overriding the design system](#overriding-the-design-system) |
| `codemod [--write] [--config <file>] [--no-types] <file.tsx...>` | converts a component file to `cx()` calls — from class maps (`className={cn.x}`) or from the old `cx` attribute, `@cxScope` pragma and `forwardStylist` — and prints what stays manual; `--config` names the `libstylist.config.mjs` its part-map modules come from, `--no-types` skips the TypeScript type facts — [MIGRATING.md](MIGRATING.md) |
| `migrate-selectors [options] <file\|dir\|glob...>` | rewrites a consumer codebase's legacy selectors (`.ls-*`, literal hooks, `data-component`, keyframes) to libstylist hooks from a migration map — [MIGRATING.md](MIGRATING.md#migrating-a-consumer-app) |
| `check [--config <file>] [--json] [--pending]` | the conventions checker over every package of the config, shared namespaces included — [Conventions checker](#conventions-checker) |
| `burndown [--config <file>] [--format text\|markdown] [--json] [--expect-zero]` | what the migration still has to do, per package |
| `hash <prefix> <namespace> <scope> <part> [--length n]` | prints one part attribute ([SPEC.md](../SPEC.md) §3.1) |

### `migrate-selectors`

```sh
libstylist migrate-selectors [--map <migration-map.json>] [--write | --check [--strict]] [--json]
                             [--roots part|identity] [--literals anchored|all|off] [--ignore <glob>]... <file|dir|glob...>
```

| Option | Meaning |
|---|---|
| `--map <file>` | The migration map. Default: `@livesession/eloquentui-css/migration/ls-to-elo.json`, resolved from the working directory. Everything the command knows comes from the map. |
| *(no mode)* | Dry run: prints the rewrites and the TODO list, writes nothing, exits 0. |
| `--write` | Applies the rewrites (edits are spliced into the original text; formatting is kept). |
| `--check` | Exits 1 when any file would change or could not be read — for CI once the migration is done. |
| `--strict` | `--check`, and TODOs and unknown `ls-*` tokens fail too. |
| `--json` | The report as JSON (`files[].entries[]`: `kind` rewrite / todo / unknown / error, `line`, `column`, `reason`, `old`, `new`, `message`, `notes`; `summary`). |
| `--roots part\|identity` | A root class becomes its part attribute (default — same specificity, (0,1,0)) or its identity: the custom tag (`elo-alert`, (0,0,1)) or the marker (`[elo-button]`); a changed specificity is noted on the rewrite. |
| `--literals anchored\|all\|off` | Literal hooks (`icon-wrapper`, `small`, `content`) and `[data-part]` values: only on or inside the element of a hook of their own component — the same compound, a later one reached through a descendant / child combinator, or a nesting parent every branch of which names it (default); everywhere; or never. |
| `--ignore <glob>` | Skips matching paths (repeatable). |

Inputs are files, directories (walked for `.css .pcss .scss .less .js .jsx .mjs .cjs .ts .tsx
.mts .cts`) and globs (`**`, `*`, `?`, `{a,b}`, `[…]` — quote them). Walks skip `node_modules`,
`.git`, `dist`, `build`, `coverage`, `storybook-static`, `.next`, `.turbo` and `.cache` unless a
pattern names them. A file that names nothing the map knows (no legacy class prefix, keyframes
name, `data-component`, attribute hook, part attribute / identity, design-system package) is
skipped without being parsed. Exit codes: 0 done (always for a dry run); 1 when `--check` /
`--strict` fail, or when `--write` met a file it could not read or parse; 2 on a usage or map
error.

The run is two passes: the first collects the legacy classes and `data-component` values the
project puts on its own elements (literal `className` / `class` / `*ClassName` values, `clsx`-style
calls, `classList.add`, `setAttribute("class")`, JSX `data-component="…"`); a selector naming one of
them anywhere in the run is a TODO, never a rewrite.

Limits:

- **SCSS / LESS** are parsed with `postcss-scss` / `postcss-less` when the project has them
  installed. Without them the plain CSS parser reads the file with `//` comments masked (the report
  says so per file) and a file with interpolation (`#{…}`, `@{…}`) is an error — install the syntax
  package. The indented Sass syntax (`.sass`), Vue / Svelte single-file components and HTML are not
  read.
- TS/JS strings are rewritten only in the contexts listed in
  [MIGRATING.md](MIGRATING.md#migrating-a-consumer-app); a selector kept in a variable is reported,
  not rewritten, and props passed through a local wrapper component can't be traced to the design
  system.
- A class *used as a class* (`className`, `classList`) is never rewritten: a part attribute is an
  attribute.
- In CSS Modules (`*.module.css`, or any stylesheet that uses `:global`) only globalized classes
  (`:global(…)`, a `:global` mode switch) are rewritten; a local `.ls-x` was hashed by the module
  build and is the app's own — a TODO. A sheet recognized by its `:global` use (not its name) keeps
  the `:global(…)` wrappers, so a second run still reads it as scoped.
- Part maps (`@livesession/eloquentui-css[/<subpath>]` imports, from the map's `partMap` / `legacy`
  fields) are followed through named and namespace imports only; a part map value copied into a
  variable, or re-exported by a local module, can't be traced.
- JS / TS files are parsed with Babel's error recovery, so a recoverable error (a duplicate import
  binding) doesn't stop the strings being read.
- `--roots identity` writes a polymorphic component's identity (Card, Text, … render the tag for a
  div / span and a marker on other elements) as `:is(elo-x,[elo-x])` unless a `div` / `span` type
  pins the tag.

## Adopting in another project

A project takes one of two shapes.

**A component library with a css package** (the design system's shape): the sheets live in the css
package, one directory per css group, and the component packages import their part maps by the css
package's specifier.

1. Add `"libstylist": { "prefix": "app", "namespace": "…" }` to each component package and the group
   table to the css package ([Per package](#per-package-packagejson)).
2. Compile the sheets with the PostCSS plugin in the css package's build
   ([Build: stylesheets](#build-stylesheets)) and publish the part maps, or expose part maps built
   inside the app under an alias ([Part maps built inside an app](#part-maps-built-inside-an-app)) —
   never import them by a relative path.
3. Put `stylist()` first in Vite, and the Babel plugin in any other pipeline that compiles components
   (test runners included).

**An app split into packages that keep their sheets next to their sources** (the CRM's and the
webapp's shape): nothing to hand-build — see [A workspace of app packages](#a-workspace-of-app-packages).

1. Declare the prefix and the layer namespaces in each package's `package.json`, with `#css` in its
   `imports`.
2. Discover the packages in `libstylist.config.mjs` (`workspacePackages`, `partMapsFor`).
3. Put `stylistWorkspace()` in Vite and `stylistWorkspace({ css: false })` in the test runner; run
   `libstylist build` for the committed part maps and lock (`--check` in CI). An app that restyles the
   design system's components adds its override sheets to the same build
   ([Overriding the design system](#overriding-the-design-system)).

Then, in both shapes:

4. Add the ESLint/stylelint configs (with typescript-eslint's parser), `partMaps` and
   `libstylist gen-types`. Set `sourceRoot` when the app builds outside a git/pnpm checkout and its
   `package.json` is not the root you want `data-file-source` paths relative to.
5. Run `libstylist check` (and `libstylist burndown`) over the project's `libstylist.config.mjs`.
6. Migrate component by component with [MIGRATING.md](MIGRATING.md).

## A workspace of app packages

An app split into many packages (`packages/crm-accounts`, `packages/crm-partners`, …) under one
prefix, each with the same two layers:

- the dummy layer, `src/components/**`, is the package's own namespace `core` (`<crm-x>`); the smart
  layer, `src/render/**` — components named `Render<X>` — is the `render` namespace
  (`RenderInvitationRow` → `<crm-render-invitationrow>`). Every package declares the same
  `namespaces`, so a namespace names its tags one way everywhere; tags and scopes stay unique across
  the packages (a `Badge` exported by two of them is `<crm-badge>` twice: T201);
- each package keeps its sheets next to its sources (`src/css`, the render sheets in
  `src/css/render`) and imports its part maps and its own components through `package.json`
  `imports` subpaths (`#css`, `#components`). A `#` import is the package's own module to the lint
  rules and the codemod, like a relative one;
- a component may root on a design-system component with its marker and no wrapper element:
  `<Table crm-render-accountstable {...cx(cn.root, rest)}>`. The checker treats a component declared
  in a package whose `package.json` has a libstylist `prefix` (the design system's dist) as a delegate
  that passes stylist props on — its own checker holds it to R112 — and one rendered without the
  marker as R106. A DOM-less one (`@libstylistRoot none` in its declaration: `Loader`, the providers)
  passes nothing on: a marker forwarded onto it is R106 as well.

```json
{
  "name": "@crm/accounts",
  "imports": { "#css": "./src/css/index.ts", "#components": "./src/components/index.ts", "#render": "./src/render/index.ts" },
  "libstylist": { "prefix": "crm", "namespace": "core", "namespaces": { "src/render": "render", "src/css/render": "render" } }
}
```

### The config

The checker lists every package with its layer barrels as entries and its sheet directories; no
`css.dir` is needed:

```js
// libstylist.config.mjs at the app workspace's root, packages listed by hand
const namespaces = { "src/render": "render", "src/css/render": "render" }
const layers = { "./components": "src/components/index.ts", "./render": "src/render/index.ts" }

export default {
    prefix: "crm",
    packages: [
        { name: "@crm/accounts", dir: "packages/crm-accounts", namespace: "core", namespaces, entries: layers, sheets: "src/css" },
        { name: "@crm/partners", dir: "packages/crm-partners", namespace: "core", namespaces, entries: layers, sheets: "src/css" },
    ],
    css: {
        // one group per (package, namespace), named after the package directory; each package's
        // #css serves both of its groups
        partMaps: { "crm-accounts": "#css", "crm-accounts.render": "#css", "crm-partners": "#css", "crm-partners.render": "#css" },
    },
}
```

`@livesession/libstylist/workspace` discovers the same list, so a new package needs no config edit:

```js
// libstylist.config.mjs at the app workspace's root
import { partMapsFor, workspacePackages } from "@livesession/libstylist/workspace"

const packages = workspacePackages({ root: import.meta.dirname, prefix: "crm" })

export default {
    prefix: "crm",
    packages,
    css: {
        partMaps: partMapsFor(packages, "#css"),
        registry: "node_modules/.cache/libstylist/stylist-registry.json", // libstylist build writes it; gitignored
        lock: "stylist.lock.json", // libstylist build writes it; committed
        layers: {
            statement: ["reset", "tokens", "components", "utilities", "app.core", "app.render"],
            namespaces: { core: "app.core", render: "app.render" },
        },
    },
}
```

- `workspacePackages({ root, prefix, include?, entries?, sheets? })` reads the `packages` globs of
  `pnpm-workspace.yaml` at `root` (a directory or a `file:` URL; or the `include` globs, `!` excluding)
  and returns every matched package whose `package.json` declares a libstylist namespace, sorted by
  directory, as `{ name, dir, namespace, segment?, word?, namespaces?, sources?, entries, sheets }`: the
  naming, the namespaces and the source directories exactly as the `package.json` declares them; the entries that exist of the layer
  barrels `./components` (`src/components/index.ts`) and `./render` (`src/render/index.ts`), or of
  `entries` (a map, or a function of the package); `sheets` (default `src/css`) when that directory
  exists, else `[]` — a package without sheets yet. A package of another prefix and a package with
  none of its entry files are errors.
- `partMapsFor(packages, "#css")` maps every css group of every package — raw or validated config
  packages — to the specifier (or to what a function answers per package).

### Sources outside `src`

A package whose components don't live under `src` — an app's own area, `apps/webapp/app/pages/settings/**`,
nested sub-areas each with its `components/` and `render/` barrels, imported everywhere through a tsconfig
alias (`~/pages/settings/team/components`) — needs two more settings:

- **`sources`**: its source directories. `gen-types` scans them for the package's custom tags (with
  `--config`, or from the `package.json` field) and `stylistWorkspace()` compiles them with the JSX
  transform; without it both look in `src` only, so the tag file comes out empty and the package's
  typecheck fails on its tags. Declare it in the package's `package.json` — `workspacePackages()` passes
  it on, and the loader holds the config to it — or set it on the config package:

  ```json
  { "name": "webapp", "libstylist": { "prefix": "app", "namespace": "settings", "sources": ["app/pages/settings"] } }
  ```

- **`typescript.paths`**: the aliases its sources import each other by. The checker builds one TypeScript
  program over every package from the config alone — it reads no tsconfig, so each package's own
  `paths` (which may disagree: two packages can each map `~/*` to their own `app/`) never reach it.
  Unresolved, an aliased component is `any`: every component rooting on it reports R105, and one that
  forwards its marker onto it T203. The codemod's program takes the same options.

```js
// libstylist.config.mjs — the app package joins the discovered packages with its own entries and sheets
const packages = workspacePackages({
    root: import.meta.dirname,
    prefix: "app",
    include: ["packages/webapp-*", "apps/webapp"],
    entries: (pkg) => (pkg.dir === "apps/webapp" ? settingsBarrels() : LAYERS),
}).map((pkg) => (pkg.dir === "apps/webapp" ? { ...pkg, sheets: "app/pages/settings/css", sources: ["app/pages/settings"] } : pkg))

export default {
    prefix: "app",
    packages,
    // tsconfig "paths" semantics; targets relative to this file
    typescript: { paths: { "~/*": ["apps/webapp/app/*"] } },
    css: { partMaps: partMapsFor(packages, "#css") /* … */ },
}
```

The `sources` set in the `.map()` is only needed when the `package.json` doesn't declare it (a value in
both must be the same list).

### Building the sheets: `libstylist build`

```sh
libstylist build           # write the outputs that changed
libstylist build --check   # CI: exit 1 when a committed output is out of date
libstylist build --watch   # rebuild on every change under the sheet directories
```

The build is the css build's two passes over the workspace. Pass 1: every package's sheets, grouped
exactly as the checker groups them, make one registry. It fails on the registry's errors (a scope, a
part attribute or a tag declared twice anywhere in the workspace, an unresolved `:cx()` or
`:component()`, a bad directive) and when two scopes would export one name from one part-map module —
a package's `#css` serves all its groups, so `switch` and `switch-classes` (both `switchClasses`)
can't live in one package, nor under one `css.partMaps` specifier. Pass 2 compiles every sheet (see
[Cascade layers](#cascade-layers)), so a sheet Vite would reject fails the build too. Nothing is
written while there is an error. The outputs:

| Output | Where | Git |
|---|---|---|
| each package's part-map module | `index.ts` in the package's first sheet directory (`src/css/index.ts`); the package's `imports["#css"]` must point at it (a `#` specifier that doesn't is a config error) | committed |
| the overrides module (with `css.overrides`) | `index.ts` in the overrides directory: it imports every override sheet; the app's entry imports it once — [Overriding the design system](#overriding-the-design-system) | committed |
| the lock (`toLock`, [SPEC.md](../SPEC.md) §7) | `css.lock`, default `stylist.lock.json` next to the config; with override sheets also what they read and reset | committed |
| the registry | `css.registry`, default `node_modules/.cache/libstylist/stylist-registry.json` | ignored |

Each is written only when it differs. `--check` writes nothing committed and exits 1 when the part maps,
the overrides module or the lock are out of date; it still writes the registry, which lint and
`libstylist check` read. A generated module whose package has no sheet left is removed; a file without
the generated header is never touched.

The part-map module imports the package's sheets — the base namespace's first, then each directory
namespace's, sorted within each — so importing a map brings its CSS along and a component never
imports a `.css` file, and exports one `as const` map per sheet:

```ts
// generated by libstylist (`libstylist build`) — do not edit; `libstylist build --check` fails on drift
import "./invitation-row.css"
import "./render/render-invitations.css"

/** invitation-row.css */
export const invitationRow = {
    name: "_cxclass_crm-…",
    root: "_cxclass_crm-…",
    $tags: {
        InvitationRow: "crm-invitationrow",
    },
} as const

/** render/render-invitations.css */
export const renderInvitations = {
    root: "_cxclass_crm-…",
    $tags: {
        RenderInvitations: "crm-render-invitations",
    },
} as const
```

Components import it by the package's specifier: `import { invitationRow as cn } from "#css"`.

### Cascade layers

Each sheet compiles alone — postcss-nesting, then the libstylist PostCSS plugin against the registry
— and is wrapped in its namespace's layer behind the whole order statement:

```css
@layer reset, tokens, components, utilities, app.core, app.render;
@layer app.render {
    /* the compiled sheet */
}
```

Every sheet carries the statement, so the order holds whichever sheet the browser parses first: the
design system's layers, then the app's — `render` after `core`, so a render component's sheet wins
over the dummy component it styles. `css.layers.statement` and `css.layers.namespaces` override the
defaults (the design system's layers, then `app.<namespace>` per namespace); a namespace whose layer
the statement doesn't declare is a config error. A sheet that declares `@layer` itself or `@import`s
another is an error. A production build minified by lightningcss folds the statement into the layer
blocks; the order is unchanged.

Compiling needs `postcss-nesting` next to `@livesession/libstylist` (an optional peer dependency, like
`vite`); discovering packages does not.

### Vite: `stylistWorkspace()`

```ts
// the app's vite.config.ts
import { stylistWorkspace } from "@livesession/libstylist/vite"

export default defineConfig({ plugins: [stylistWorkspace(), react()] })
```

```ts
// the test runner's config: the JSX transform only (Vitest loads no CSS)
plugins: [stylistWorkspace({ css: false })]
```

`stylistWorkspace(options)` resolves to two plugins configured from the `libstylist.config.mjs` found
upward from Vite's root (or `config`, relative to it):

- the transform — `stylist()` over the source directories of the workspace's packages (`sources`,
  default `src`; plus `include`),
  with the config's `css.partMaps` and the registry held in memory, so part-map members are validated
  and labelled. A linked design-system dist and anything under the workspace root's `3rd-party/` are never
  transformed;
- the sheets (`enforce: "pre"`, ahead of `vite:css`) — every sheet of a package's sheet directories
  compiled at import time into its layer. When a sheet's text differs from the copy the registry was
  built from, the registry is rebuilt inside the transform, so a sheet never compiles against its
  previous version.

In dev the sheet directories are watched: a sheet added, removed or edited rewrites the owning
package's part-map module when it differs (and the lock and the registry), reloads the sheets whose
`:cx()` or `:component()` read a changed sheet, and sends a registry error to the overlay. Nothing is
written while the registry has an error; the rebuild that fixes it catches up on every sheet changed in
the meantime, in any package. The server brings every output up to date when it starts (or, when it
starts with a registry error, once that is fixed). With `write: false` it leaves the files alone and warns.
`vite build` fails on a registry error and on a stale part-map module — run `libstylist build` and
commit.

Options: `config`, `css` (default `true`), `overrides` (default `true`: compile the override sheets and
strip the design system's stylesheets of their resets — `false` for a build that bundles the design
system without them), `write` (default `true`), `include` and `exclude` (module ids), and the
transform's `dev`, `sourceRoot`, `onUnknownPart` and `runtimeModule`. Register it once:
two copies of the transform (a Vitest config merged over the Vite config concatenates their plugins,
or a `stylist()` next to it) are an error.

### Overriding the design system

An app restyles design-system components everywhere they render with **override sheets** — plain CSS
that names the component and styles `.root` and its part names ([AUTHORING.md](AUTHORING.md#overriding-and-resetting-a-design-system-component),
[SPEC.md](../SPEC.md) §9) — and can **reset** parts so the design system's own look no longer applies.
The workspace build and `stylistWorkspace()` do all of it; the design system's files are never edited.

```js
// libstylist.config.mjs
css: {
    partMaps: partMapsFor(packages, "#css"),
    lock: "stylist.lock.json",
    overrides: {
        dir: "apps/crm/app/styles/overrides",         // every .css under it is an override sheet
        registries: ["@livesession/eloquentui-css"],   // the design system's css package (its dist/stylist-registry.json)
        // layer: "app.overrides",                     // the default
    },
    layers: {
        // the app's whole order, a theme layer included: every compiled sheet starts with this statement
        statement: ["reset", "tokens", "components", "utilities", "crm-theme", "app.overrides", "app.core", "app.render"],
        namespaces: { core: "app.core", render: "app.render" },
    },
},
```

```ts
// the app's entry (apps/crm/app/root.tsx)
import "@livesession/eloquentui-css/styles.css"
import "./styles/theme.css" // @layer reset, tokens, components, utilities, crm-theme, app.overrides, app.core, app.render;
import "./styles/overrides" // generated: imports every override sheet
```

- **One directory, loaded once.** An override applies to every instance in the app, so the sheets live
  in one directory whose generated `index.ts` (the overrides module, committed, rewritten by
  `libstylist build` and the dev server) the app's entry imports — never with a lazily loaded package.
  The directory may sit inside a package's sheet directory (`src/css/overrides`); its sheets are still
  no package's sheets: no scope, no part map, no checker finding of their own.
- **`from "<package>"`** is resolved where the sheet is: the component package installed there
  (`node_modules/@livesession/eloquentui-react`, symlinks followed) names the design system by its
  `libstylist.prefix` and the namespace by its `libstylist.namespace`. The css packages of
  `registries` are found from the overrides directory, then from the config.
- **The layer.** Override sheets compile into `css.overrides.layer`, which comes after the design
  system's `components` — after `utilities` in effect: the design system's aggregate declares its layers
  first, and a later statement can't move a layer before them — and before every namespace's layer, so
  an app component's own styling of a design-system element (`<Button {...cx(cn.toggle)}>`) beats the
  global override. The loader enforces both in `css.layers.statement`; without it the default statement
  puts it there. An app theme layer is best placed before it.
- **The order the bundle declares is the one that counts.** A layer's place is fixed by the first
  `@layer` that names it, and `app.overrides` is a sublayer of `app`: a hand-written order statement
  (a theme or globals sheet: `@layer …, crm-theme, app.core, app.render;`) imported before the override
  sheets makes `app.overrides` a sublayer declared after `app.render` — every global override would beat
  the app's components. So every `@layer` order statement the app writes lists the overrides layer
  where `css.layers.statement` puts it, and `css.layers.statement` is the app's whole order (a theme
  layer included — every compiled sheet starts with it; one without `crm-theme` imported before the
  theme sheet would declare `app` first and push the theme after the app's layers). `vite build` checks
  every CSS asset it emits and fails with `[layer-order]` when the overrides layer lands before
  `components` or after a namespace layer.
- **Resets happen at build time.** `stylistWorkspace()` strips the reset parts' declarations from every
  stylesheet of the design system's css package as the app imports it (`styles.css`, the add-on
  aggregates, `components/*.css`, `?inline` too) — a runtime `revert-layer` could only roll back to the
  design system itself, `all: revert` to the browser's defaults. So the design system's CSS must go
  through Vite: `vite build` fails when a reset strips nothing it bundles (`[unbundled-reset]`), when the
  build bundles the design system but not the override sheets (`[overrides-not-imported]`; a build that
  must not apply them passes `stylistWorkspace({ overrides: false })`), on a reset that drops nothing
  (`[empty-reset]`) and on a stale overrides module. Another bundler runs `stylistReset()` over the
  design system's CSS ([Override sheets and resets](#override-sheets-and-resets)). `vite build --watch`
  re-reads a changed override sheet before the rebuild and transforms the override sheets and the design
  system's stylesheets on every rebuild (Rollup would keep their cached output), so a new reset strips
  them and the guards see every module.
- **What a reset drops** is printed by `libstylist build` (and by the dev server when it starts and
  whenever the resets change), over every stylesheet the design system publishes:

  ```
  reset   elo:core/modal:header — 1 declaration in 1 rule (styles.css, components/modal.css)
  note    elo:core/modal:frame drops overflow: hidden (styles.css:3021) — its children's layout may rely on it; declare it in apps/crm/app/styles/overrides/modal.css to keep it
  ```

  A `note` is a layout declaration the element's parent or children may rely on that the override
  sheet does not re-declare for the same part under the same conditions (a re-declaration under a state
  or a media query the design system's rule lacks leaves the other states without it).
- **A design-system `!important` can't be overridden**, only reset: the cascade reverses the layer
  order for important declarations. `libstylist build` and Vite warn for each override declaration one
  beats (`warning apps/crm/app/styles/overrides/dock.css: [important] line 3: text-decoration can't take
  effect — … @stylist reset link; removes it`).
- **When the design system changes.** Override sheets resolve by name, and the lock records what they
  read and reset (its `overrides` and `resets` sections): a part renamed or removed fails the build,
  the dev overlay and `libstylist check` with the nearest name and the full part list; an attribute that
  moved (a sheet renamed) is lock drift that `libstylist build --check` lists
  (`~ override elo:core/button:loader _cxclass_elo-… → _cxclass_elo-…`).
- **In dev** the overrides directory and the design systems' registries are watched: an edited override
  sheet recompiles (Vite reloads it), a sheet added or removed rewrites the overrides module, a changed
  set of resets reloads every design-system stylesheet served so far, a rebuilt design system reloads
  the override sheets that read it. While an override sheet has an error (on the overlay), the design
  system keeps the last good resets.
- **Lint.** `libstylist check` validates the override sheets as the build does ([S310](RULES.md#s310));
  the stylelint preset reads their directives and their `.root` ([RULES.md](RULES.md#override-sheets)).
  The Vitest config (`stylistWorkspace({ css: false })`) needs no design system.

### Lint, types and the checker

- ESLint: `settings.libstylist.registry` is `css.registry` and `partMaps` is `css.partMaps`. Load the
  config with `loadCheckConfig` (`@livesession/libstylist/check`) so the defaults apply — the raw
  object has no `css.registry` when the config leaves it to its default, and without a registry
  `cx-part-exists` checks nothing. The `segments` `tag-name` checks against (`render` included) are
  discovered from the workspace's `package.json` files. `no-hash-literal` skips the generated
  part-map modules (their first line is the generated header); another formatter or linter over the
  workspace should skip them and the lock too (the build writes both, and `--check` compares them).

  ```js
  // eslint.config.mjs
  import tseslint from "typescript-eslint"

  import { loadCheckConfig } from "@livesession/libstylist/check"
  import libstylist from "@livesession/libstylist/eslint"

  const { css } = await loadCheckConfig("libstylist.config.mjs")

  export default [
      {
          files: ["packages/*/src/**/*.{ts,tsx}"],
          ...libstylist.configs.recommended,
          languageOptions: { parser: tseslint.parser },
          settings: { libstylist: { registry: css.registry, partMaps: css.partMaps } },
      },
  ]
  ```
- `libstylist gen-types --config libstylist.config.mjs` writes every package's tag types.
- `libstylist check` reads the same config and warns (S309, "run `libstylist build`") while the
  registry at `css.registry` is missing or stale.

`@livesession/libstylist/workspace` exports the pieces: `workspacePackages` and `partMapsFor`;
`loadWorkspace` and `workspaceOf`, `buildWorkspace`, `compileSheet`, `renderPartMapModule`,
`planWorkspaceOutputs` and `writeWorkspaceOutputs`, and `runWorkspaceBuild` (what `libstylist build`
runs); the grouping every tool shares — `packageSheetGroups` (a package's css groups and the
sheets of each), `packageGroups`, `sheetGroupName` and `sheetNaming`; and the override sheets' —
`loadDesignSystems` and `overridePackageResolver` (the design systems and component packages installed
where the sheets are), `collectOverrides` (pass 1 and the resolution), `compileOverrideSheet`,
`overrideReports` (the reset report), `renderOverridesModule`, `designSystemOf` and `resetsOf` (which
stylesheet a reset strips, with which targets).
