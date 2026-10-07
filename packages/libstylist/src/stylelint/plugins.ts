// Every libstylist stylelint rule as a stylelint 16 plugin.
import type { Plugin } from "stylelint"

import { selectorClassPattern, selectorMaxType, selectorPseudoClassDisallowedList, selectorPseudoClassNoUnknown } from "./rules/core-rules.js"
import directiveSyntax from "./rules/directive-syntax.js"
import noIdentitySelectors from "./rules/no-identity-selectors.js"
import sheetRoot from "./rules/sheet-root.js"

/** The libstylist rules, ready for a stylelint config's `plugins`. */
export const plugins: readonly Plugin[] = [
    sheetRoot,
    directiveSyntax,
    noIdentitySelectors,
    selectorClassPattern.plugin,
    selectorPseudoClassNoUnknown.plugin,
    selectorPseudoClassDisallowedList.plugin,
    selectorMaxType.plugin,
]
