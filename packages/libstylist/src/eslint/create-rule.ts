// Rule factory shared by every `libstylist/*` rule: typescript-eslint's RuleCreator with docs
// links into docs/RULES.md.
import { ESLintUtils } from "@typescript-eslint/utils"

/** Where the rule reference lives; each rule links to its own anchor. */
export const RULES_DOC_URL = "https://github.com/livesession/libstylist/blob/master/packages/libstylist/docs/RULES.md"

/** The docs URL for a rule: `docs/RULES.md#<rule-name>` (RULES.md has one `## <rule-name>` heading per rule). */
export const ruleDocsUrl = (name: string): string => `${RULES_DOC_URL}#${name}`

/** Creates a `libstylist/*` rule with its docs URL filled in. */
export const createRule = ESLintUtils.RuleCreator(ruleDocsUrl)
