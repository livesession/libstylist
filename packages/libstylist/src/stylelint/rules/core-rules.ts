// The core selector rules the preset uses, wrapped so they read libstylist syntax correctly
// (see ../core-wrapper.ts). Each takes exactly the options of the core rule it wraps.
import { wrapCoreRule } from "../core-wrapper.js"
import { OPAQUE_PSEUDOS, STYLIST_PSEUDOS } from "../selectors.js"
import { toArray } from "../util.js"

/** Core `selector-class-pattern` options. */
export interface SelectorClassPatternOptions {
    resolveNestedSelectors?: boolean
}

/** Core `selector-pseudo-class-no-unknown` options. */
export interface SelectorPseudoClassNoUnknownOptions {
    ignorePseudoClasses?: string | RegExp | Array<string | RegExp>
}

/** Core `selector-max-type` options. */
export interface SelectorMaxTypeOptions {
    ignore?: Array<"descendant" | "child" | "compounded" | "next-sibling" | "custom-elements">
    ignoreTypes?: string | RegExp | Array<string | RegExp>
}

/**
 * `libstylist/selector-class-pattern`: checks local classes, which are parts. The arguments of
 * `:component(Modal.Header)` are not classes, and the classes inside a legacy `:global()` hook are
 * not parts (the build splices them verbatim; `:global` itself is policed by the disallowed list).
 */
export const selectorClassPattern = wrapCoreRule<SelectorClassPatternOptions, "selector-class-pattern">({
    core: "selector-class-pattern",
    mask: [...OPAQUE_PSEUDOS, "global"],
})

/**
 * `libstylist/selector-pseudo-class-no-unknown`: `:component`, `:cx` and `:global` are known, and
 * the `:part` of `:cx(scope:part)` is a part name, not a pseudo-class.
 */
export const selectorPseudoClassNoUnknown = wrapCoreRule<SelectorPseudoClassNoUnknownOptions, "selector-pseudo-class-no-unknown">({
    core: "selector-pseudo-class-no-unknown",
    secondary: (options) => ({ ...options, ignorePseudoClasses: [...toArray(options?.ignorePseudoClasses), ...STYLIST_PSEUDOS] }),
})

/** `libstylist/selector-pseudo-class-disallowed-list`: parses `:component(ns/Path)`. */
export const selectorPseudoClassDisallowedList = wrapCoreRule<Record<string, unknown>, "selector-pseudo-class-disallowed-list">({
    core: "selector-pseudo-class-disallowed-list",
    primaryOptionArray: true,
})

/** `libstylist/selector-max-type`: parses `:component(ns/Path)`; `Modal` in `:component(Modal)` is not a type. */
export const selectorMaxType = wrapCoreRule<SelectorMaxTypeOptions, "selector-max-type">({ core: "selector-max-type" })
