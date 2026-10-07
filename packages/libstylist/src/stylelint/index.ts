// `@livesession/libstylist/stylelint`: the libstylist stylelint plugin rules and preset.
//
//   // stylelint.config.mjs
//   import { preset } from "@livesession/libstylist/stylelint"
//   export default preset({ prefix: "elo", legacy: true })
//
// The module's default export is the plugin list, so `plugins: ["@livesession/libstylist/stylelint"]`
// also works in a hand-written config.
import { plugins } from "./plugins.js"
import { selectorClassPattern, selectorMaxType, selectorPseudoClassDisallowedList, selectorPseudoClassNoUnknown } from "./rules/core-rules.js"
import { ruleName as directiveSyntax } from "./rules/directive-syntax.js"
import { ruleName as noIdentitySelectors } from "./rules/no-identity-selectors.js"
import { ruleName as sheetRoot } from "./rules/sheet-root.js"

export { plugins } from "./plugins.js"
export { DISALLOWED_PSEUDO_CLASSES, localClassPattern, preset, type PresetOptions } from "./preset.js"
export { wrapCoreRule, type CoreWrapperSpec, type WrappedRule } from "./core-wrapper.js"
export {
    COMPONENT_PATH_RE,
    DISPLAY_KEYWORDS,
    checkComponentArg,
    checkCxArg,
    checkGlobalArg,
    parseStylistDirective,
    type DirectiveParse,
    type StylistDirective,
} from "./directives.js"
export type { SelectorClassPatternOptions, SelectorMaxTypeOptions, SelectorPseudoClassNoUnknownOptions } from "./rules/core-rules.js"
export { attributeReason, tagReason, type NoIdentitySelectorsOptions } from "./rules/no-identity-selectors.js"
export { ROOT_LOCAL, type SheetRootOptions } from "./rules/sheet-root.js"
export { DEFAULT_PREFIX, PLUGIN_NAMESPACE } from "./util.js"

/** Every libstylist stylelint rule name. */
export const ruleNames = {
    sheetRoot,
    directiveSyntax,
    noIdentitySelectors,
    selectorClassPattern: selectorClassPattern.ruleName,
    selectorPseudoClassNoUnknown: selectorPseudoClassNoUnknown.ruleName,
    selectorPseudoClassDisallowedList: selectorPseudoClassDisallowedList.ruleName,
    selectorMaxType: selectorMaxType.ruleName,
} as const

export default plugins
