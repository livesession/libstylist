// Tag registry: two components owning one tag (T201: `Menu` and `Menu.Root`), unregistered tags and
// markers (T202), a tag rendered by a component that doesn't own it (T203) and a wrong identity (R103).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" }, unboundSheets: [] },
}
