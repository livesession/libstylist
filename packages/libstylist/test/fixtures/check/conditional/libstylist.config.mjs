// Conditional returns: early null returns, ternaries, &&, helper calls, local consts, reassigned lets and fragments around a conditional — plus one wrong branch and a component that renders nothing.
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
}
