// Export shapes: Object.assign members, expando members, plain-object namespaces with a Root
// member, memo / forwardRef / memo(forwardRef), and an aliased re-export — all conforming.
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
}
