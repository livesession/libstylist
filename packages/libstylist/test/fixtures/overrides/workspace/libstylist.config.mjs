// A workspace of app packages (prefix app) whose app restyles a design system (prefix ds) with override
// sheets: packages/shop is the one app package (a dummy Cart in core, a smart RenderCart in render, sheets
// next to the sources); apps/web is the app — no libstylist package — whose src/css/overrides holds the
// override sheets: button.css (additive), modal.css (resets two parts, re-declares one layout contract)
// and table-in-cart.css (a Table override scoped `within RenderCart`). The design system (@ds/css, the
// registry and the aggregates; @ds/react and @ds/gram, the component packages) is built from
// ../design-system by the tests and installed into a scratch copy's apps/web/node_modules. The cascade
// layers are the defaults: the design system's, app.overrides, then app.core and app.render.
const namespaces = { "src/render": "render", "src/css/render": "render" }
const entries = { "./components": "src/components/index.ts", "./render": "src/render/index.ts" }

export default {
    prefix: "app",
    packages: [{ name: "@shop/ui", dir: "packages/shop", namespace: "core", namespaces, entries, sheets: "src/css" }],
    css: {
        partMaps: { shop: "#css", "shop.render": "#css" },
        // inside the workspace: a scratch copy's node_modules is a link to libstylist's own
        registry: ".libstylist/stylist-registry.json",
        overrides: { dir: "apps/web/src/css/overrides", registries: ["@ds/css"] },
    },
}
