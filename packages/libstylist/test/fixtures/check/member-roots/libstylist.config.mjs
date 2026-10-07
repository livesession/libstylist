// Member roots bound in a sheet to a member no export resolves to: Popover's portaled panel
// (`@stylist root Pop.Content as content` → the marker elo-pop-content on the Radix Content) is owned
// by Pop's file. Fails: a member root rendered as a custom tag without display (S304), bound but never
// rendered (S303), rendered without its bound part (S303), rendered by another file (T203), and a
// binding whose parent is not exported either (S302).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
    exemptions: { budget: { none: 0, multi: 0, native: 1 } },
}
