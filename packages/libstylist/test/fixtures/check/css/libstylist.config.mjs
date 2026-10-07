// CSS↔JSX: unused parts (S301; unbound sheets exempt), a root binding naming no component (S302),
// custom tags without display (S304; a root-part `display` rule counts), display on a marker root
// (S305), className props (S308) and a sheet with a broken directive (S300).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" }, unboundSheets: ["ui/swatch.css"] },
}
