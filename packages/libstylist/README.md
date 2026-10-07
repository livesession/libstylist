# @livesession/libstylist

Tooling for building UIs the LiveSession way: namespaced custom-element roots, hashed part
attributes spread with `cx()`, dev-only source annotations — and the lint rules, conventions
checker and build backstops that enforce them.

```tsx
import { alert as cn } from "@livesession/eloquentui-css" // the sheet's part map: cn.icon === "_cxclass_elo-or4d4l"
import { cx } from "@livesession/libstylist/runtime"

export function Alert({ variant = "info", title, children, ...rest }: AlertProps) {
    const hasTitle = title != null
    return (
        <elo-alert {...cx(cn.root, rest, { variant, hasTitle })} role="status">
            <span {...cx(cn.icon)}>…</span>
            <span {...cx(cn.content)}>{hasTitle && <span {...cx(cn.title)}>{title}</span>}{children}</span>
        </elo-alert>
    )
}
```

```css
/* alert.css */
@stylist root Alert display block;

.root { display: flex; }
.root[data-has-title] .icon { align-self: flex-start; }
```

renders (production):

```html
<elo-alert _cxclass_elo-qkqllh data-variant="info" data-has-title="true" role="status">
  <span _cxclass_elo-or4d4l>…</span>
  <span _cxclass_elo-fgknzp><span _cxclass_elo-4dp27z>Title</span>…</span>
</elo-alert>
```

and in development additionally `_cxpart="icon"`, `data-react-component="Alert"` and
`data-file-source="packages/components/src/components/Alert/Alert.tsx:73"`.

One `cx()` call per element: its parts (members of part maps), the props object it forwards
(markers and parts a wrapper or an app put on the component) and an inline data literal (its
`data-*` attributes). Parts name structure only; every state and variant is data.

## What's inside

| Subpath | What |
|---|---|
| `.` | the isomorphic entry: part hashing, identity naming and the shared conventions (`PART_ATTR_PREFIX`, `TAG_RE`, `SLOT_PROP`, …, `normalizePackageConfig`, `normalizeNamespaces`) |
| `/hash` | `partHash`, `partAttr`, `partSelector`, `isPartAttr` (SPEC §3.1) |
| `/naming` | custom-tag and marker names derived from export paths (SPEC §2) |
| `/conventions` | the shared policy constants and per-file config resolution — a package's namespace or its `namespaces` directory's (`resolvePackageConfig`, `findLibstylistPackage`, `packageConfigOf`; SPEC §1, §8) |
| `/core` | the `cx()` call grammar (SPEC §5.2) and part-map resolution (`partMapGroups`, `resolvePartMap`), shared by the Babel transform, the ESLint rules, the checker and the codemod |
| `/runtime` | `cx`; `cxData` and `cxCompiled` (emitted by the transform, never written by hand); `cxAttr`, `hostProps`, `unsetRef`, `legacy`, `legacyClassName`; the types `CxAttrs`, `CxArg`, `CxDataRecord`, `CxData` (SPEC §6) |
| `/vite` | `stylist()` Vite plugin — brands `cx()` data literals, normalizes markers, adapts custom-tag hosts and adds dev annotations before JSX compilation; bundles the runtime. `stylistWorkspace()` — the same over a workspace of app packages, plus their sheets compiled at import time into cascade layers and, in dev, their part maps kept in step; with override sheets (`css.overrides`) each compiled into the overrides layer and the design system's stylesheets stripped of the resets as the app imports them |
| `/babel` | the same transform as a Babel plugin |
| `/postcss` | `stylist()` PostCSS plugin — parts → hashed attributes, roots, display defaults, keyframes; `stylistOverride()` — an app's override sheet of a design-system component (SPEC §9); `stylistReset()`/`resetCss()` — the build-time reset of the design system's stylesheets, with its report |
| `/registry` | stylesheet registry, part maps, lock file, rename maps; `resolveOverrides` — override sheets against a design system's registry |
| `/jsx` | TypeScript JSX types (the custom tags' props) |
| `/eslint`, `/stylelint` | the rule sets |
| `/check` | the conventions checker behind `libstylist check` (override sheets included: S310) |
| `/workspace` | a workspace of app packages that keep their sheets next to their sources: the config's packages discovered from the workspace (`workspacePackages`, `partMapsFor`), a package's css groups — one per namespace — and their sheets (`packageSheetGroups`, `sheetGroupName`), and the build — the registry, each package's generated part-map module, the lock, one sheet compiled into its layer (`buildWorkspace`, `renderPartMapModule`, `compileSheet`, `runWorkspaceBuild`; [docs/CONFIG.md](docs/CONFIG.md#a-workspace-of-app-packages)); an app's override sheets of a design system (`css.overrides`) — the design systems and component packages installed where they are (`loadDesignSystems`, `overridePackageResolver`), pass 1 and the resolution (`collectOverrides`), one sheet compiled into the overrides layer (`compileOverrideSheet`, `compileOverride`, `overridesLayerProblem`), the reset report (`overrideReports`), the generated module (`renderOverridesModule`) and which stylesheet a reset strips (`designSystemOf`, `resetsOf`; [docs/CONFIG.md](docs/CONFIG.md#overriding-the-design-system)) |
| `libstylist` CLI | `gen-types`, `build`, `codemod`, `migrate-selectors`, `check`, `burndown`, `hash` — see [docs/CONFIG.md](docs/CONFIG.md#cli) |

Documentation: [CLAUDE.md](CLAUDE.md) (entry point), [docs/AUTHORING.md](docs/AUTHORING.md),
[docs/MIGRATING.md](docs/MIGRATING.md), [docs/RULES.md](docs/RULES.md),
[docs/CONFIG.md](docs/CONFIG.md), [SPEC.md](SPEC.md).
