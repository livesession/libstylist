// libstylist/data-in-cx — design-system source writes no raw `data-*` JSX attribute: every one goes
// through the element's cx() data literal (`{...cx(cn.root, { size, open })}`), one call per element
// with its parts, forwarded props and data (SPEC §5.2). aria-*, role and the rest stay plain JSX. On a
// libstylist component (`<Alert data-testid>`) a data-* attribute is a prop, never moved.
import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils"

import { camelRoundTrips, dataKeyOf, unwrapNode } from "../../core/index.js"
import { removeWithLeadingSpace, unwrap } from "../ast.js"
import { fileStylist, rootBinding } from "../context.js"
import { createRule } from "../create-rule.js"
import { asAny, cxFile, cxSpreads, partMapLocal, primaryScope, rendersLibstylistComponent } from "../cx.js"
import { appendArg, appendProperties, cxBinding, IDENT, memberText } from "../fix.js"
import { attrName, attributes, identityOf } from "../jsx.js"
import { forbiddenAttr } from "./no-dev-attrs.js"

type MessageIds = "move" | "moveSuggest"

/** A `data-*` attribute this rule moves (dev annotations and removed hooks are no-dev-attrs'). */
const isMovable = (attr: TSESTree.JSXAttribute): boolean => {
    const name = attrName(attr)
    return /^data-[a-z0-9]/.test(name) && !forbiddenAttr(name)
}

/** True when a value renders the same through the data literal: never `false` (which would now be omitted instead of printed "false"). */
function isSafeValue(node: TSESTree.Node): boolean {
    const n = unwrap(node)
    switch (n.type) {
        case AST_NODE_TYPES.Literal:
            return typeof n.value === "string" || typeof n.value === "number" || n.value === true || n.value === null
        case AST_NODE_TYPES.TemplateLiteral:
            return true
        case AST_NODE_TYPES.Identifier:
            return n.name === "undefined"
        case AST_NODE_TYPES.ConditionalExpression:
            return isSafeValue(n.consequent) && isSafeValue(n.alternate)
        case AST_NODE_TYPES.LogicalExpression:
            return n.operator === "||" && isSafeValue(n.right)
        default:
            return false
    }
}

const COMPARISONS = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "instanceof"])

/**
 * True when an expression is boolean by its shape (`!x`, `!!x`, a comparison, a boolean literal): then
 * `x || undefined` and `x` render the same through the data literal. Any other value may be `0` or
 * `""`, which `|| undefined` omits but the literal renders (`data-count="0"`).
 */
function isBooleanShaped(node: TSESTree.Node): boolean {
    const n = unwrap(node)
    if (n.type === AST_NODE_TYPES.UnaryExpression) return n.operator === "!"
    if (n.type === AST_NODE_TYPES.BinaryExpression) return COMPARISONS.has(n.operator)
    return n.type === AST_NODE_TYPES.Literal && typeof n.value === "boolean"
}

/** The key a `data-*` attribute takes in the data literal: camelCase when it round-trips, else quoted. */
const keyOf = (name: string): string => (camelRoundTrips(name) && IDENT.test(dataKeyOf(name)) ? dataKeyOf(name) : JSON.stringify(name.slice("data-".length)))

/** The data literal entry for one attribute, and whether it renders exactly as before. */
function entryOf(context: TSESLint.RuleContext<MessageIds, []>, attr: TSESTree.JSXAttribute): { text: string; safe: boolean } {
    const name = attrName(attr)
    const key = keyOf(name)
    const v = attr.value
    let value: string
    let safe = true
    if (!v) value = "true"
    // a JSX attribute string decodes entities and has no escapes: carry its decoded value into a JS string
    else if (v.type === AST_NODE_TYPES.Literal) value = JSON.stringify(v.value)
    else if (v.type === AST_NODE_TYPES.JSXExpressionContainer && v.expression.type !== AST_NODE_TYPES.JSXEmptyExpression) {
        const e = v.expression
        const u = unwrap(e)
        // `x || undefined` renders the same inside the literal (falsy → omitted); `x` alone only when x is boolean
        if (u.type === AST_NODE_TYPES.LogicalExpression && u.operator === "||" && unwrap(u.right).type === AST_NODE_TYPES.Identifier && (unwrap(u.right) as TSESTree.Identifier).name === "undefined") {
            value = context.sourceCode.getText(isBooleanShaped(u.left) ? u.left : e)
        } else {
            value = context.sourceCode.getText(e)
            safe = isSafeValue(e)
        }
    } else value = "undefined"
    return { text: key === value ? key : `${key}: ${value}`, safe }
}

export default createRule<[], MessageIds>({
    name: "data-in-cx",
    meta: {
        type: "problem",
        docs: { description: "Require data-* attributes of design-system elements to go through the element's cx() data literal" },
        fixable: "code",
        hasSuggestions: true,
        messages: {
            move: "`{{name}}` is written as a JSX attribute — design-system elements pass their data-* attributes through the cx() data literal: {{hint}}.",
            moveSuggest: "Move the data-* attributes into the element's cx() data literal (a value that can be `false` renders nothing there instead of \"false\")",
        },
        schema: [],
    },
    defaultOptions: [],
    create(context) {
        const file = fileStylist(context)
        const cx = cxFile(context, file)

        /** Moves every movable data-* attribute of `opening` into its cx() data literal. */
        const moveAll = (opening: TSESTree.JSXOpeningElement, attrs: TSESTree.JSXAttribute[], fixer: TSESLint.RuleFixer): TSESLint.RuleFix[] | null => {
            const entries = attrs.map((a) => entryOf(context, a).text)
            const spreads = cxSpreads(cx, opening)
            const fixes: TSESLint.RuleFix[] = []
            if (spreads.length) {
                const call = spreads[0].call
                const literal = [...call.arguments].reverse().find((a) => unwrapNode(asAny(a)).type === "ObjectExpression")
                const obj = literal ? (unwrap(literal) as TSESTree.ObjectExpression) : null
                fixes.push(obj ? appendProperties(context, fixer, obj, entries) : appendArg(context, fixer, call, `{ ${entries.join(", ")} }`))
                for (const a of attrs) fixes.push(removeWithLeadingSpace(context, fixer, a))
                return fixes
            }
            const binding = cxBinding(context, cx, opening, fixer)
            if (!binding) return null
            fixes.push(...binding.fixes)
            fixes.push(fixer.replaceText(attrs[0], `{...${binding.name}({ ${entries.join(", ")} })}`))
            for (const a of attrs.slice(1)) fixes.push(removeWithLeadingSpace(context, fixer, a))
            return fixes
        }

        /** The call the message shows: the element's existing cx() arguments (or its root part on an identity element) plus the moved entry, exactly as the fix writes it. */
        const hintFor = (opening: TSESTree.JSXOpeningElement, entry: string): string => {
            const call = cxSpreads(cx, opening)[0]?.call
            const args = call ? call.arguments.filter((a) => unwrapNode(asAny(a)).type !== "ObjectExpression").map((a) => context.sourceCode.getText(a)) : []
            if (!call && file.prefix && identityOf(opening, file.prefix)) {
                const identity = identityOf(opening, file.prefix)!
                const binding = rootBinding(file, cx.registry, identity.name, primaryScope(context, cx))
                if (binding) args.push(memberText(partMapLocal(context, cx, binding.scope) ?? "cn", binding.local))
            }
            return `{...cx(${[...args, `{ ${entry} }`].join(", ")})}`
        }

        return {
            JSXOpeningElement(opening) {
                // on a libstylist component a `data-*` attribute is a prop (the component decides where it goes), not the element's data
                if (rendersLibstylistComponent(context, file, opening)) return
                const attrs = attributes(opening).filter(isMovable)
                if (!attrs.length) return
                const safe = attrs.every((a) => entryOf(context, a).safe)
                for (const attr of attrs) {
                    const fix = (fixer: TSESLint.RuleFixer) => moveAll(opening, attrs, fixer)
                    const name = attrName(attr)
                    context.report({
                        node: attr,
                        messageId: "move",
                        data: { name, key: keyOf(name), hint: hintFor(opening, entryOf(context, attr).text) },
                        fix: safe ? fix : null,
                        suggest: safe ? [] : [{ messageId: "moveSuggest", fix }],
                    })
                }
            },
        }
    },
})
