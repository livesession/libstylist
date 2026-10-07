// Export problems: an any-typed member and a factory-made member (C001), a third-party
// re-export (C001), a core compound that reads as another package's segment (C002), one
// implementation under two tags and one path with two implementations (C003).
export default {
    prefix: "elo",
    packages: [
        { name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts", "./extra": "src/extra.ts" }, cssGroup: "ui" },
        { name: "@fx/app", dir: "packages/app", namespace: "app", entries: { ".": "src/index.ts" }, cssGroup: "app" },
    ],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css", app: "@fx/css/app" } },
}
