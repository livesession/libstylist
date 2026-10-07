// A workspace whose package keeps its components outside src: an app's settings area
// (apps/web/app/pages/settings — nested sub-areas, each with its own barrels; one sheet directory), whose
// files import each other through the app's tsconfig alias `~/*` → `apps/web/app/*`. `sources` points
// gen-types and the workspace transform at the area (src does not exist; app/root.tsx is the app's, not
// the package's), `typescript.paths` resolves the alias in the checker's program: without it every
// component rooting on an aliased one roots on `any` (R105, and T203 for a marker forwarded onto it).
// The package.json declares no `sources`: the config sets them, as a config post-processing
// workspacePackages() does. No built registry at the default css.registry (S309).
export default {
    prefix: "crm",
    packages: [
        {
            name: "@fx/web",
            dir: "apps/web",
            namespace: "settings",
            entries: {
                "./pages/settings/components": "app/pages/settings/components/index.ts",
                "./pages/settings/team/components": "app/pages/settings/team/components/index.ts",
                "./pages/settings/team/render": "app/pages/settings/team/render/index.ts",
            },
            sources: ["app/pages/settings"],
            sheets: "app/pages/settings/css",
        },
    ],
    typescript: { paths: { "~/*": ["apps/web/app/*"] } },
    css: { partMaps: { web: "#css" } },
}
