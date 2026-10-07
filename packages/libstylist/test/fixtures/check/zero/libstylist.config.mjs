// A finished migration: every component migrated, every sheet flipped, no migration helpers left —
// `libstylist burndown --expect-zero` passes.
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" }, unboundSheets: ["ui/swatch.css"] },
    exemptions: { budget: { none: 0, multi: 0, native: 0 } },
}
