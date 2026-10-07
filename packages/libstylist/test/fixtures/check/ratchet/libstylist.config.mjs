// The migration ratchet: migrated components (a cx() call, an identity written, or an
// @libstylistRoot exemption) get every rule as an error; components not migrated yet only count as
// pending — except hard rules (duplicate tags). Also: the counted migration helpers (legacy(),
// legacyClassName(), @deprecated class props), flipped vs legacy sheets, and host parts (S306).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: {
        dir: "packages/css/src",
        partMaps: { ui: "@fx/css" },
        hostParts: {
            "done:engine": "the replay engine sets it on its iframe container",
            "done:inner": "stale: Done's own inner element carries it",
            "old:nope": "stale: the old sheet has no such part",
        },
    },
    exemptions: { budget: { none: 1, multi: 0, native: 0 } },
}
