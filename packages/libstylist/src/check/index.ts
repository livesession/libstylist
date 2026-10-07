// `@livesession/libstylist/check`: the conventions checker (`libstylist check`) and the migration
// burndown (`libstylist burndown`). TS compiler API over every configured package plus the
// stylesheets: exports, component roots, the `@libstylistRoot` escape hatch, tag ownership and
// CSS↔JSX consistency, split by the migration ratchet into errors and pending work.
export {
    CONFIG_FILE,
    CheckConfigError,
    DEFAULT_MIN_REASON_LENGTH,
    EXEMPTION_CATEGORIES,
    findCheckConfig,
    loadCheckConfig,
    namingOf,
    validateCheckConfig,
    type CheckConfig,
    type CheckPackage,
    type ExemptionCategory,
    type RawCheckConfig,
    type RawCheckPackage,
    type RawCheckTypeScript,
} from "./config.js"
export {
    resolveCheckConfig,
    runCheck,
    type CheckResult,
    type CheckStats,
    type ComponentStatus,
    type LegacyUsage,
    type MigrationReason,
    type RunCheckOptions,
    type SheetStatus,
} from "./run.js"
export { burndownReport, formatBurndown, runBurndown, runBurndownCli, type BurndownOptions, type BurndownPackage, type BurndownReport } from "./burndown.js"
export { RULES, countByRule, dedupeFindings, sortFindings, type Finding, type RuleId, type RuleInfo, type RuleScope, type Severity } from "./rules.js"
export { CHECK_USAGE, formatFinding, formatReport, formatSummary, runCheckCli, type CliIO } from "./format.js"
export { EXEMPTION_TAG, parseExemption, type ParsedExemption } from "./exemptions.js"
export { RUNTIME_MODULES, isIdentityName, type FileFacts, type LegacyHelper } from "./migration.js"
export type { LegacyClassProp, MemberRoot } from "./crosscheck.js"
export type { ComponentEntry } from "./exports.js"
export type { IdentityHit, Problem, RootAnalysis } from "./roots.js"
