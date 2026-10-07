// Polymorphic roots (<As>): a finite union of semantic tags, a generic-constrained type parameter, an unbounded string (R107), a union with div (R108), a missing marker (R102) and a component-typed variable (R105).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
}
