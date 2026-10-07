// Edge cases the other fixtures skip: switch/try/nested-callback returns and null branches,
// memo/forwardRef that break the rules, expando members, re-export shapes (renamed, default import,
// `export * as`), portal boundaries, nested and internal wrappers, two-level forwarding chains and
// unbounded or mapped polymorphic tags.
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
}
