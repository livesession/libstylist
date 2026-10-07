// Marker forwarding: components with no DOM of their own pass their marker to a delegate —
// ModalConfirm-like (<Dialog elo-confirm>, no props passed on), its compound member onto the
// delegate's member (<Dialog.Footer elo-confirm-footer>), Tooltip-like (<Pop elo-hint {...rest}>), and
// SpeedMenu-like through a not-yet-migrated delegate that spreads {...rest} on (Menu, pending). Fails:
// forwarding onto a delegate whose identity element drops stylist props (R106, with the delegate's own
// R112), a valued marker cx() would drop (R110) and cx on a component whose props never
// reach the DOM (S307).
export default {
    prefix: "elo",
    packages: [{ name: "@fx/ui", dir: "packages/ui", namespace: "core", entries: { ".": "src/index.ts" }, cssGroup: "ui" }],
    css: { dir: "packages/css/src", partMaps: { ui: "@fx/css" } },
}
