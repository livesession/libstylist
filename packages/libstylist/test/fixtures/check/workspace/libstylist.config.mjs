// A workspace of app packages (prefix crm): accounts and partners share the `core` namespace (their
// dummy layer, src/components) and the `render` namespace (their smart layer, src/render — `Render*`
// components, tags <crm-render-…>); each keeps its sheets next to its sources (src/css, render sheets
// in src/css/render) and imports its part maps from its own `#css`. The entries are the layer barrels.
// A render component roots on the design system's <Table> (vendor/ds declares a libstylist prefix) with
// its marker and no wrapper element. Planted: a render component's sheet left in the core directory
// (S302), one tag exported by both packages (T201), a third-party root (R105), a design-system root
// without the marker (R106) and a DOM-less one with it (R106), and no built registry at the default
// css.registry (S309).
const namespaces = { "src/render": "render", "src/css/render": "render" }
const entries = { "./components": "src/components/index.ts", "./render": "src/render/index.ts" }

export default {
    prefix: "crm",
    packages: [
        { name: "@fx/accounts", dir: "packages/accounts", namespace: "core", namespaces, entries, sheets: "src/css" },
        { name: "@fx/partners", dir: "packages/partners", namespace: "core", namespaces, entries, sheets: ["src/css"] },
    ],
    css: { partMaps: { accounts: "#css", "accounts.render": "#css", partners: "#css", "partners.render": "#css" } },
}
