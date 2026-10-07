// Root basics: generic root (R101), missing marker (R102), wrong tag (R103), opaque roots (R105:
// passed-through children, unknown call, bare text, third-party component), props missing from the identity's cx()
// (R112, also through an inlined internal component), missing root part (R113), and transparent
// wrappers / internal components / cx(props) through a const that all conform.
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
}
