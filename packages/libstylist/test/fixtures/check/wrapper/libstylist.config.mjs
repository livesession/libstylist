// Wrapper branches and slot identity: a <label> or indent <div> authored by the component around its
// identity element (Button's label, FilterEditor's indent node), the identity inside an exported
// component's children (Button's <Tooltip>{button}</Tooltip>), and the failures — identity inside
// the wrapper only on some paths (R109), two identities inside one wrapper (R104), a wrapper around
// another component only (R101), a wrapped identity whose cx() gets no props (R112). Plus the implied
// `<scope>:root` binding shared by two identity elements of one file (no R113, like ESLint's root-part).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
}
