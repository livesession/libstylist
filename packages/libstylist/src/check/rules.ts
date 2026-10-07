// Rule table of `libstylist check` and the finding shape every check reports.

export type Severity = "error" | "warning"

/**
 * How a rule takes part in the migration ratchet:
 * - `hard`: holds for every component and sheet, migrated or not (duplicate tags, registry errors,
 *   malformed exemptions, flipped sheets);
 * - `component`: holds for migrated components; on a not-yet-migrated component the finding is
 *   pending (counted by `libstylist burndown`, not an error);
 * - `file`: like `component`, keyed on the source file the finding is in.
 */
export type RuleScope = "hard" | "component" | "file"

export interface RuleInfo {
    severity: Severity
    scope: RuleScope
    /** Short name used in summaries. */
    title: string
    /** What the rule enforces, in one sentence. */
    description: string
}

/**
 * Every rule the checker reports. Ids are stable: docs and tooling key on them.
 * `C0xx` export discovery, `R1xx` component roots, `T2xx` tag registry, `S3xx` CSS↔JSX,
 * `X12x` the `@libstylistRoot` escape hatch.
 */
export const RULES = {
    C001: { severity: "error", scope: "component", title: "unresolvable export", description: "Every exported component and compound member resolves to an analyzable function component and is not typed `any`." },
    C002: { severity: "error", scope: "hard", title: "invalid export path", description: "Every export path forms a valid custom-element tag that no other package's or directory namespace's segment claims." },
    C003: { severity: "error", scope: "component", title: "duplicate export", description: "One component implementation is exported under one tag only — a second export path would give the same element two identities." },
    R100: { severity: "error", scope: "component", title: "no root", description: "A component that renders nothing in every branch is marked `@libstylistRoot none <reason>`." },
    R101: { severity: "error", scope: "component", title: "generic root", description: "A component whose root would be a div or span renders its custom tag instead." },
    R102: { severity: "error", scope: "component", title: "missing marker", description: "A semantic (non-generic) native root carries the component's marker attribute." },
    R103: { severity: "error", scope: "component", title: "wrong identity", description: "The identity element names this component: its custom tag or marker equals the tag derived from the export path." },
    R104: { severity: "error", scope: "component", title: "multiple roots", description: "Every render branch has exactly one identity element and no sibling roots (`@libstylistRoot multi` allows unstyled siblings)." },
    R105: { severity: "error", scope: "component", title: "opaque root", description: "Every render branch's root is visible to the checker — not passed-through content, an unknown call or a third-party component." },
    R106: { severity: "error", scope: "component", title: "delegate without identity", description: "A component that renders another design-system component (a configured package's, or a libstylist library's such as the design system's dist) either forwards its marker onto it (and that component passes stylist props to its DOM — a library component marked `@libstylistRoot none` has none) or renders its own identity element in every branch of the delegate's children." },
    R107: { severity: "error", scope: "component", title: "unbounded polymorphic tag", description: "A polymorphic tag variable (`<As>`) has a finite string-literal union type." },
    R108: { severity: "error", scope: "component", title: "generic polymorphic member", description: "A polymorphic identity element never renders as div or span (a marker never goes on a generic tag)." },
    R109: { severity: "error", scope: "component", title: "conditional wrapper identity", description: "A wrapper branch (a native element around the identity element) has the identity element inside it on every render path." },
    R110: { severity: "error", scope: "component", title: "valued marker", description: "An identity marker is written value-less (`<button elo-button>`): cx() forwards only `\"\"` values, so a valued marker is dropped on its way to the DOM." },
    R112: { severity: "error", scope: "component", title: "props not forwarded", description: "The identity element's cx() call receives the component's props (`{...cx(cn.root, rest)}`) so wrappers, parents and apps can attach markers and parts (a forwarded marker rides on its delegate instead)." },
    R113: { severity: "error", scope: "component", title: "missing root part", description: "The identity element's cx() call carries the root part its sheet binds to it (`cn.root` or the family local)." },
    T201: { severity: "error", scope: "hard", title: "duplicate tag", description: "Every tag is owned by exactly one exported component (or registered member root) across all packages." },
    T202: { severity: "error", scope: "hard", title: "unregistered tag", description: "Every custom tag or marker of the prefix rendered in source belongs to an exported component or a member root bound in a stylesheet." },
    T203: { severity: "error", scope: "hard", title: "foreign tag", description: "A tag or marker is rendered only by the component that owns it (member roots: by the owning component's file)." },
    S300: { severity: "error", scope: "hard", title: "registry error", description: "The stylesheets build a registry without errors (duplicate scopes, collisions, bad directives, unresolved references)." },
    S301: { severity: "error", scope: "hard", title: "unused part", description: "Every part a flipped sheet (`@stylist root|scope`) declares is read from its part map (`cx(cn.part)`) somewhere in source." },
    S302: { severity: "error", scope: "hard", title: "unowned root binding", description: "Every `@stylist root` directive names a component exported by the sheet's package in the sheet's namespace, or a member root of one (`Popover.Content`)." },
    S303: { severity: "error", scope: "hard", title: "member root not rendered", description: "A member root bound in a sheet (`@stylist root Popover.Content as content`) is rendered by its owner's file as the marker or tag, carrying its bound local part." },
    S304: { severity: "error", scope: "component", title: "custom tag without display", description: "Every rendered custom tag has a display default (`@stylist root … display <kw>`) or its root part sets `display`." },
    S305: { severity: "error", scope: "component", title: "display on a marker root", description: "A `display` default is declared only for components that render their custom tag in some branch — it has no effect on a marker root." },
    S306: { severity: "error", scope: "hard", title: "stale host part", description: "Every `css.hostParts` entry names a part of a sheet that design-system source never reads from the part map — host code outside the sources puts it on its own elements." },
    S307: { severity: "error", scope: "file", title: "cx not forwarded", description: "A cx() call is spread only onto components that pass their props on to their DOM, and a named slot (`inputCx`) goes only to components that declare it and use it." },
    S308: { severity: "error", scope: "component", title: "className prop", description: "No exported props type declares `className` or `*ClassName`, except a `@deprecated` one kept for callers that have not migrated (counted by burndown until removed)." },
    S309: { severity: "warning", scope: "hard", title: "stale registry", description: "The built registry (`css.registry`) matches the stylesheets — rebuild the css package when it drifts." },
    S310: {
        severity: "error",
        scope: "hard",
        title: "override sheet",
        description: "Every override sheet (`css.overrides`) resolves against its design system's registry — its package, component, parts, resets and `within` exist —, compiles, and every reset drops something: what `libstylist build` stops on.",
    },
    X121: { severity: "error", scope: "hard", title: "malformed exemption", description: "`@libstylistRoot <none|multi|native> <reason>` names a known category, gives a reason and sits on an exported component, once." },
    X122: { severity: "error", scope: "component", title: "stale exemption", description: "A `@libstylistRoot` tag excuses at least one finding of its category; remove it once the component conforms." },
    X123: { severity: "error", scope: "hard", title: "exemption budget", description: "The number of exemptions per category stays within the configured budget." },
} as const satisfies Record<string, RuleInfo>

export type RuleId = keyof typeof RULES

export interface Finding {
    rule: RuleId
    severity: Severity
    message: string
    /** Path relative to the config root (forward slashes). */
    file: string
    /** 1-based line; 0 when the finding has no source position. */
    line: number
    /** Stable identity of the finding within its rule (no line numbers). */
    key: string
    /** The component the finding belongs to (`core/Modal.Header`), for `component`-scoped rules. */
    component?: string
}

/** Builds a finding with the rule's default severity. */
export function finding(rule: RuleId, key: string, message: string, file: string, line: number, component?: string): Finding {
    return { rule, severity: RULES[rule].severity, message, file, line, key, ...(component ? { component } : {}) }
}

/** Findings sorted by file, line, rule and key — the order every report uses. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
    return [...findings].sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.rule, b.rule) || cmp(a.key, b.key) || cmp(a.message, b.message))
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * One finding per rule and key: repeats of the same problem (several branches of one component, or
 * several uses in one file) keep the first and note how many more there were.
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
    const groups = new Map<string, Finding[]>()
    for (const f of sortFindings(findings)) {
        const id = `${f.rule}\u0000${f.key}`
        const group = groups.get(id)
        if (group) {
            if (!group.some((g) => g.message === f.message && g.file === f.file && g.line === f.line)) group.push(f)
        } else groups.set(id, [f])
    }
    const out: Finding[] = []
    for (const group of groups.values()) {
        const [first, ...rest] = group
        out.push(rest.length ? { ...first, message: `${first.message} (+${rest.length} more)` } : first)
    }
    return sortFindings(out)
}

/** Counts per rule id, sorted by id (only rules with findings). */
export function countByRule(findings: readonly Finding[]): Partial<Record<RuleId, number>> {
    const out: Partial<Record<RuleId, number>> = {}
    for (const id of Object.keys(RULES).sort() as RuleId[]) {
        const n = findings.filter((f) => f.rule === id).length
        if (n) out[id] = n
    }
    return out
}
