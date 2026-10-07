// Portals and Radix: a root rendered through createPortal, an in-place identity next to a portal, a Radix Root + asChild trigger carrying a marker on a span (allowed by native, R101 without it), and a Radix part without asChild at the root (R105).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
}
