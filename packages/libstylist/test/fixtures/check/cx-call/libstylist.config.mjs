// The cx() call API against the checker: forwarding requires the component's own props binding — the
// props parameter, its rest, a named slot, body destructuring and const aliases of those (Box, Aliased,
// Mapped) — never another prop (Space's `style`: R112, and a caller's parts on it are lost: S307) nor a
// later parameter or a callback's (Listed forwards forwardRef's `ref`: R112); a data
// literal spread on a design-system component renders nothing (S307 :data), while one on a polymorphic
// host renders; messages name the file's own part-map local (Rooted: R113) and a DOM-less delegate's
// form (Confirmish: R112, S307).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
}
