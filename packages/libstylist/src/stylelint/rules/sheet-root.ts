// libstylist/sheet-root — a bound sheet styles its root at the top level, and `.root` is only
// ever the leading compound of a selector (SPEC §2.2, §4.1). In an override sheet (SPEC §9) `.root` is the
// overridden component's identity: nothing binds it, and document context may come before it
// (`:root[data-theme="dark"] .root`) — but never another part; a sheet-id override has no `.root` of
// its own to check.
import type { Root, Rule as PostcssRule } from "postcss"
import type parser from "postcss-selector-parser"
import stylelint from "stylelint"
import type { Rule, RuleBase } from "stylelint"

import { parseStylistDirective } from "../directives.js"
import {
    type AnyContainer,
    NestingResolver,
    inKeyframes,
    isForeignPseudo,
    parentRule,
    parseSelector,
    pseudoName,
    ruleSelector,
    splitCompounds,
    tryParseSelector,
    walkSkipping,
} from "../selectors.js"
import {
    PLUGIN_NAMESPACE,
    isBoolean,
    isRegExp,
    isString,
    isTopLevelDirective,
    matchesSheet,
    reportParseError,
    ruleUrl,
    sheetFile,
    sheetOverride,
    sheetScope,
    toArray,
} from "../util.js"

const {
    createPlugin,
    utils: { report, ruleMessages, validateOptions },
} = stylelint

export const ruleName = `${PLUGIN_NAMESPACE}/sheet-root` as const

/** The root local every sheet binds by default. */
export const ROOT_LOCAL = "root"

export interface SheetRootOptions {
    /** Also require every sheet that has parts to be bound, except the `unbound` ones. @default false */
    requireBinding?: boolean
    /** Sheets exempt from `requireBinding`: scope ids, basenames, path suffixes or regexes. */
    unbound?: string | RegExp | Array<string | RegExp>
}

export const messages = ruleMessages(ruleName, {
    missingTopLevel: () =>
        `Expected a top-level ".${ROOT_LOCAL}" rule or an "@stylist root" directive — this sheet uses ".${ROOT_LOCAL}" only inside nested rules`,
    unbound: () =>
        `Expected this sheet to be bound: add a top-level ".${ROOT_LOCAL}" rule or "@stylist root <Component>", or list it as unbound`,
    notLeading: (selector: string) =>
        `Expected ".${ROOT_LOCAL}" to lead "${selector}" — it is this sheet's own root, never a descendant of another compound (use ":component(X)" to reach another component)`,
    compounded: (selector: string, other: string) =>
        `Unexpected ".${ROOT_LOCAL}.${other}" in "${selector}" — qualify the root with data-* attributes or pseudo-classes, not another part`,
})

export const meta = { url: ruleUrl("sheet-root") }

interface Findings {
    notLeading: string | null
    compounded: { selector: string; other: string } | null
}

/** Pseudo-classes whose selector arguments sit at the position of the compound they qualify. */
const IN_PLACE_PSEUDOS = ["is", "where", "matches", "any", "-webkit-any", "-moz-any", "not"]

/** Pseudo-classes that also filter the compound's own element by a selector (`:nth-child(2 of .x)`). */
const SUBJECT_FILTER_PSEUDOS = ["nth-child", "nth-last-child"]

/** Cap on the class combinations tracked per compound (`:is()` lists multiply). */
const MAX_ALTERNATIVES = 64

const classesOf = (compound: parser.Node[]): string[] => compound.filter((n): n is parser.ClassName => n.type === "class").map((n) => n.value)

/**
 * The class sets one element matched by `compound` carries, one per alternative of the selector
 * lists in its in-place pseudo-classes: `.a:is(.b, .c)` → [a, b] and [a, c]. The subject compound
 * of each argument (`:is(.x .b)` → `.b`) is the one on this element.
 */
function compoundAlternatives(compound: parser.Node[]): string[][] {
    let alternatives: string[][] = [classesOf(compound)]
    for (const node of compound) {
        if (node.type !== "pseudo" || isForeignPseudo(node)) continue
        const name = pseudoName(node)
        if (!IN_PLACE_PSEUDOS.includes(name) && !SUBJECT_FILTER_PSEUDOS.includes(name)) continue
        const options = node.nodes.flatMap((arg) => {
            const { compounds } = splitCompounds(arg)
            return compoundAlternatives(compounds[compounds.length - 1])
        })
        if (options.length === 0) continue
        alternatives = alternatives.flatMap((base) => options.map((option) => [...base, ...option])).slice(0, MAX_ALTERNATIVES)
    }
    return alternatives
}

/** True when a compound (its in-place pseudo-classes' arguments included) names no class: document or ancestor context. */
function contextOnly(compound: parser.Node[]): boolean {
    let found = false
    for (const node of compound) {
        if (node.type === "class") return false
        if (node.type === "pseudo" && !isForeignPseudo(node)) {
            walkSkipping(
                node,
                (n) => {
                    if (n.type === "class") found = true
                },
                isForeignPseudo,
            )
        }
    }
    return !found
}

/** True when the node tree (outside foreign pseudo-classes) contains `.root`. */
function containsRoot(container: AnyContainer): boolean {
    let found = false
    walkSkipping(
        container,
        (node) => {
            if (node.type === "class" && node.value === ROOT_LOCAL) found = true
        },
        isForeignPseudo,
    )
    return found
}

/**
 * Records where `.root` appears in one complex selector. `leading` says whether the selector's
 * first compound is itself at the leading position of the full selector; `context` (an override
 * sheet) lets compounds that name no class come before it.
 */
function analyze(selector: parser.Selector, leading: boolean, display: string, out: Findings, context = false): void {
    const { compounds, combinators } = splitCompounds(selector)
    compounds.forEach((compound, i) => {
        const classes = classesOf(compound)
        // `.root + .root` / `.root ~ .root`: stacked instances, still roots, never nested.
        const siblingsOfRoots =
            i > 0 && combinators.slice(0, i).every((c) => c === "+" || c === "~") && compounds.slice(0, i).every((c) => classesOf(c).includes(ROOT_LOCAL))
        const afterContext = context && i > 0 && compounds.slice(0, i).every(contextOnly)
        const atLead = leading && (i === 0 || siblingsOfRoots || afterContext)
        if (classes.includes(ROOT_LOCAL) && !atLead && !out.notLeading) out.notLeading = display
        // `.root.open`, and the same through in-place pseudo-classes: `.root:is(.open)`, `.open:not(.root)`.
        for (const alternative of compoundAlternatives(compound)) {
            const other = alternative.find((c) => c !== ROOT_LOCAL)
            if (other && alternative.includes(ROOT_LOCAL) && !out.compounded) out.compounded = { selector: display, other }
        }
        for (const node of compound) {
            if (node.type !== "pseudo" || isForeignPseudo(node) || node.nodes.length === 0) continue
            const name = pseudoName(node)
            for (const arg of node.nodes) {
                if (name === "has") {
                    if (containsRoot(arg) && !out.notLeading) out.notLeading = display
                } else if (IN_PLACE_PSEUDOS.includes(name)) {
                    analyze(arg, atLead, display, out, context)
                } else if (containsRoot(arg) && !out.notLeading) {
                    // :nth-child(… of .root) and friends: the root is a sibling filter, not the subject.
                    if (!atLead) out.notLeading = display
                }
            }
        }
    })
}

const ruleFunction: RuleBase<boolean, SheetRootOptions | undefined> = (primary, secondary) => (root: Root, result) => {
    const valid = validateOptions(
        result,
        ruleName,
        { actual: primary, possible: [true] },
        { actual: secondary, possible: { requireBinding: [isBoolean], unbound: [isString, isRegExp] }, optional: true },
    )
    if (!valid) return

    // An override sheet: a sheet-id target's `.root` is a plain part of that sheet; a component's is its
    // identity, bound by the design system, with document context allowed before it.
    const override = sheetOverride(root)
    if (override && override.target.kind === "sheet") return
    const overrideComponent = override !== null

    // Only what the build honours binds a sheet: top-level, exactly-spelled, well-formed directives
    // (libstylist/directive-syntax reports the rest).
    let directives = 0
    root.each((node) => {
        if (!isTopLevelDirective(node)) return
        const parsed = parseStylistDirective(node.params)
        if (parsed.ok && parsed.directive.kind === "root") directives++
    })

    const resolver = new NestingResolver()
    const findings = new Map<PostcssRule, Findings>()
    let firstRootUse: PostcssRule | undefined
    let firstLocal: PostcssRule | undefined
    let topLevelRoot = false

    root.walkRules((rule) => {
        if (inKeyframes(rule)) return
        const raw = ruleSelector(rule)
        const own = tryParseSelector(raw)
        if (typeof own === "string") {
            reportParseError(result, rule, own)
            return
        }
        let usesRoot = false
        let hasLocal = false
        walkSkipping(
            own,
            (node) => {
                if (node.type !== "class") return
                hasLocal = true
                if (node.value === ROOT_LOCAL) usesRoot = true
            },
            isForeignPseudo,
        )
        if (hasLocal && !firstLocal) firstLocal = rule
        if (usesRoot && !firstRootUse) firstRootUse = rule
        const parent = parentRule(rule)
        // Where `.root` sits inside the selector is the positional check's job below.
        if (!parent && usesRoot) topLevelRoot = true

        const found: Findings = { notLeading: null, compounded: null }
        for (const resolved of resolver.resolve(rule)) {
            const ast = parseSelector(resolved)
            if (!ast) continue
            for (const selector of ast.nodes) analyze(selector, true, resolved, found, overrideComponent)
        }
        findings.set(rule, found)
        // Report where a violation first appears; nested rules inherit their parent's.
        const inherited = parent ? findings.get(parent) : undefined
        if (found.notLeading && !inherited?.notLeading) {
            report({ ruleName, result, node: rule, message: messages.notLeading, messageArgs: [found.notLeading], index: 0, endIndex: raw.length })
        }
        if (found.compounded && !inherited?.compounded) {
            const { selector, other } = found.compounded
            report({ ruleName, result, node: rule, message: messages.compounded, messageArgs: [selector, other], index: 0, endIndex: raw.length })
        }
    })

    if (overrideComponent) return
    if (directives === 0 && firstRootUse && !topLevelRoot) {
        report({ ruleName, result, node: firstRootUse, message: messages.missingTopLevel, index: 0, endIndex: ruleSelector(firstRootUse).length })
    }
    const bound = directives > 0 || firstRootUse !== undefined
    if (!bound && secondary?.requireBinding && firstLocal && !matchesSheet(sheetFile(root), toArray(secondary.unbound), sheetScope(root))) {
        report({ ruleName, result, node: firstLocal, message: messages.unbound, index: 0, endIndex: ruleSelector(firstLocal).length })
    }
}

export const rule: Rule = Object.assign(ruleFunction, { ruleName, messages, meta })

export default createPlugin(ruleName, rule)
