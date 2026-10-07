// Delegates: marker forwarding onto a forwarding component, onto one that drops stylist props (R106), without any identity (R106), slot identity (always and only sometimes), a DOM-less marker forward that passes no props on (Dropped: conforms, like ModalConfirm), a delegate whose identity element never receives stylist props (Legacy: R112), and cx on a component that drops it (S307).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
}
