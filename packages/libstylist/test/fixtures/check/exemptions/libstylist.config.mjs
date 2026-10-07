// The escape hatch: valid none/native exemptions, a stale one (X122), malformed ones (X121: unknown
// category, short reason, two tags, a tag on a non-component) and a blown budget (X123).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
    exemptions: { budget: { none: 2, multi: 0, native: 1 }, minReasonLength: 12 },
}
