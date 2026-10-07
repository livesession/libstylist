// The libstylist stylelint preset: the plugin rules plus the built-in rules that keep source
// sheets inside the part/tag model (docs/RULES.md). Core rules that parse selectors run
// through their libstylist/* wrappers (see core-wrapper.ts).
import type { Config } from "stylelint"

import { PART_ATTR_PREFIX, PART_RE, PREFIX_RE } from "../conventions/index.js"
import { plugins } from "./plugins.js"
import { DEFAULT_PREFIX } from "./util.js"

export interface PresetOptions {
    /** Project prefix of identity tags and markers (`elo`, `app`). @default "elo" */
    prefix?: string
    /**
     * Migration mode: tolerates the pre-existing hooks the decoupling phase removes — `:global()`,
     * `*-of-type` pseudo-classes, type selectors and `[data-component]`/`[data-part]` selectors.
     * @default false
     */
    legacy?: boolean
    /** Require every sheet that has parts to be bound (see `libstylist/sheet-root`). @default false */
    requireBinding?: boolean
    /** Sheets exempt from `requireBinding`: scope ids, basenames, path suffixes or regexes. */
    unbound?: Array<string | RegExp>
}

/** Pseudo-classes no source sheet may use; all but `:local` are tolerated in legacy (migration) mode. */
export const DISALLOWED_PSEUDO_CLASSES: readonly string[] = ["global", "local", "first-of-type", "last-of-type", "nth-of-type", "nth-last-of-type", "only-of-type"]
const LEGACY_TOLERATED_PSEUDO_CLASSES: readonly string[] = ["global", "first-of-type", "last-of-type", "nth-of-type", "nth-last-of-type", "only-of-type"]

/** Local class (part) pattern: kebab-case, never hand-prefixed with `ls-`, `_cxclass_` or `<prefix>-`. */
export function localClassPattern(prefix: string): string {
    return `^(?!ls-|${PART_ATTR_PREFIX}|${prefix}-)${PART_RE.source.slice(1)}`
}

/**
 * Builds the stylelint config for libstylist source sheets. Use it directly as a stylelint config
 * or spread it into one (`export default preset({ legacy: true })`).
 */
export function preset(options: PresetOptions = {}): Config {
    const prefix = options.prefix ?? DEFAULT_PREFIX
    if (!PREFIX_RE.test(prefix)) throw new Error(`libstylist stylelint preset: "prefix" must match ${PREFIX_RE}`)
    const legacy = options.legacy ?? false
    const disallowed = DISALLOWED_PSEUDO_CLASSES.filter((name) => !(legacy && LEGACY_TOLERATED_PSEUDO_CLASSES.includes(name)))
    const bannedPseudos = disallowed.map((name) => `:${name}`).join(", ")

    return {
        plugins: [...plugins],
        reportDescriptionlessDisables: true,
        reportNeedlessDisables: true,
        rules: {
            "libstylist/sheet-root": [true, { requireBinding: options.requireBinding ?? false, unbound: options.unbound ?? [] }],
            "libstylist/directive-syntax": true,
            "libstylist/no-identity-selectors": [true, { prefix, allowRemovedHooks: legacy }],
            "libstylist/selector-class-pattern": [
                localClassPattern(prefix),
                {
                    resolveNestedSelectors: true,
                    message: `Expected "%s" to be a part name: kebab-case, never hand-prefixed with ls-, ${PART_ATTR_PREFIX} or ${prefix}- (the build derives part attributes and tags)`,
                },
            ],
            "libstylist/selector-pseudo-class-no-unknown": true,
            "libstylist/selector-pseudo-class-disallowed-list": [
                disallowed,
                { message: `Unexpected pseudo-class "%s" — ${bannedPseudos} are banned: give the element a part, or use :component(X) / data-* attributes` },
            ],
            "libstylist/selector-max-type": legacy
                ? null
                : [0, { message: "Unexpected type selector in \"%s\" — give the element a part (cx) or reach another component with :component(X)" }],
            "at-rule-no-unknown": [true, { ignoreAtRules: ["stylist"] }],
            // The core selector rules misread libstylist syntax (`:component(ns/Path)` doesn't
            // parse, `:component(Modal.Header)` has a ".Header" class, `:cx(scope:part)` a ":part"
            // pseudo); the libstylist/* versions above run them on a masked copy instead.
            "selector-class-pattern": null,
            "selector-pseudo-class-no-unknown": null,
            "selector-pseudo-class-disallowed-list": null,
            "selector-max-type": null,
            "color-no-hex": [true, { message: "Raw hex is banned — use a --ls-* token var(); documented one-offs need a stylelint-disable comment." }],
            "custom-property-pattern": ["^[a-z][a-z0-9]*(-[a-z0-9]+)*$", { message: "Custom properties are kebab-case." }],
        },
    }
}
