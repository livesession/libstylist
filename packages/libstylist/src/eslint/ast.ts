// Small ESTree helpers shared by the rules: literal extraction, const resolution, callee names and
// runtime-import detection.
import { AST_NODE_TYPES, AST_TOKEN_TYPES, ASTUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils"

import { RUNTIME_MODULES } from "../core/index.js"

/** Any rule context — the helpers only read the source code, scopes and filename. */
export type AnyRuleContext = Readonly<TSESLint.RuleContext<string, readonly unknown[]>>
type Context = AnyRuleContext

/** Module ids the runtime helpers (`cx`, `legacy`, …) are imported from. */
export { RUNTIME_MODULES }

/** Strips TS-only wrappers (`as`, `satisfies`, `!`, `<T>x`) that do not change the runtime value. */
export function unwrap(node: TSESTree.Node): TSESTree.Node {
    let n = node
    while (
        n.type === AST_NODE_TYPES.TSAsExpression ||
        n.type === AST_NODE_TYPES.TSSatisfiesExpression ||
        n.type === AST_NODE_TYPES.TSNonNullExpression ||
        n.type === AST_NODE_TYPES.TSTypeAssertion
    )
        n = n.expression
    return n
}

/** The value of a string literal or an expression-less template, else `undefined`. */
export function staticString(node: TSESTree.Node | null | undefined): string | undefined {
    if (!node) return undefined
    const n = unwrap(node)
    if (n.type === AST_NODE_TYPES.Literal && typeof n.value === "string") return n.value
    if (n.type === AST_NODE_TYPES.TemplateLiteral && n.expressions.length === 0) return n.quasis.map((q) => q.value.cooked ?? q.value.raw).join("")
    return undefined
}

/** The static key name of an object property (`a`, `"a"`, `` `a` ``), else `undefined` (computed/dynamic). */
export function propertyKeyName(prop: TSESTree.Property): string | undefined {
    if (prop.computed) return staticString(prop.key)
    if (prop.key.type === AST_NODE_TYPES.Identifier) return prop.key.name
    if (prop.key.type === AST_NODE_TYPES.Literal) return String(prop.key.value)
    return undefined
}

/** The variable an identifier refers to, looked up from the identifier's own scope. */
export function findVariable(context: Context, id: TSESTree.Identifier): TSESLint.Scope.Variable | null {
    return ASTUtils.findVariable(context.sourceCode.getScope(id), id)
}

/**
 * The initializer of the `const` an identifier refers to (`const SEL = ".x"` → the literal), or
 * `null` when the binding is not a single `const` with a plain identifier pattern.
 */
export function constInit(context: Context, id: TSESTree.Identifier): TSESTree.Expression | null {
    const variable = findVariable(context, id)
    if (!variable || variable.defs.length !== 1) return null
    const def = variable.defs[0]
    if (def.node.type !== AST_NODE_TYPES.VariableDeclarator) return null
    const decl = def.node
    if (decl.parent.kind !== "const" || decl.id.type !== AST_NODE_TYPES.Identifier || !decl.init) return null
    return decl.init
}

/**
 * A selector-like static string: literals, expression-less templates, `const` references and `+`
 * concatenations of those. Template expressions are replaced by `placeholder` when given (so the
 * static shape can still be inspected), otherwise the value is `undefined`.
 */
export function resolveString(context: Context, node: TSESTree.Node, placeholder?: string, depth = 0): string | undefined {
    if (depth > 8) return undefined
    const n = unwrap(node)
    const s = staticString(n)
    if (s !== undefined) return s
    if (n.type === AST_NODE_TYPES.TemplateLiteral && placeholder !== undefined) {
        let out = ""
        n.quasis.forEach((q, i) => {
            out += q.value.cooked ?? q.value.raw
            if (i < n.expressions.length) out += placeholder
        })
        return out
    }
    if (n.type === AST_NODE_TYPES.Identifier) {
        const init = constInit(context, n)
        return init ? resolveString(context, init, placeholder, depth + 1) : undefined
    }
    if (n.type === AST_NODE_TYPES.BinaryExpression && n.operator === "+") {
        const left = resolveString(context, n.left, placeholder, depth + 1)
        const right = resolveString(context, n.right, placeholder, depth + 1)
        return left !== undefined && right !== undefined ? left + right : undefined
    }
    return undefined
}

/** The called name: `f` for `f()`, `m` for `a.b.m()` / `a["m"]()`; `null` for anything else. */
export function calleeName(callee: TSESTree.Node): string | null {
    const n = unwrap(callee)
    if (n.type === AST_NODE_TYPES.Identifier) return n.name
    if (n.type === AST_NODE_TYPES.MemberExpression) return memberName(n)
    return null
}

/** The property name of a member expression (`classList` in `el.classList` or `el["classList"]`). */
export function memberName(node: TSESTree.MemberExpression): string | null {
    if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) return node.property.name
    if (node.computed) {
        const s = staticString(node.property)
        if (s !== undefined) return s
    }
    return null
}

/**
 * True when `callee` is the runtime export `exportName` — imported by name (possibly renamed)
 * or reached through a namespace import of one of the runtime modules.
 */
export function isRuntimeCallee(context: Context, callee: TSESTree.Node, exportName: string): boolean {
    const n = unwrap(callee)
    if (n.type === AST_NODE_TYPES.Identifier) {
        const def = findVariable(context, n)?.defs[0]
        if (!def || def.node.type !== AST_NODE_TYPES.ImportSpecifier) return false
        const imported = def.node.imported
        const importedName = imported.type === AST_NODE_TYPES.Identifier ? imported.name : imported.value
        return importedName === exportName && isRuntimeSource(def.node.parent)
    }
    if (n.type === AST_NODE_TYPES.MemberExpression && memberName(n) === exportName && n.object.type === AST_NODE_TYPES.Identifier) {
        const def = findVariable(context, n.object)?.defs[0]
        return !!def && def.node.type === AST_NODE_TYPES.ImportNamespaceSpecifier && isRuntimeSource(def.node.parent)
    }
    return false
}

const isRuntimeSource = (decl: TSESTree.Node | undefined): boolean =>
    decl?.type === AST_NODE_TYPES.ImportDeclaration && RUNTIME_MODULES.includes(decl.source.value)

/** An object literal that definitely ends up in spread props, and whether it is written inline (safe to fix). */
export interface SpreadObject {
    obj: TSESTree.ObjectExpression
    inline: boolean
}

/**
 * The object literals a spread argument definitely contributes: inline objects, nested object
 * spreads, both sides of `a ? {…} : {…}`, the right of `cond && {…}`, both sides of `||`/`??`, and
 * a single `const` binding (not inline). Anything dynamic is skipped.
 */
export function spreadObjectLiterals(context: Context, input: TSESTree.Node, inline = true, out: SpreadObject[] = [], depth = 0): SpreadObject[] {
    if (depth > 6) return out
    const n = unwrap(input)
    switch (n.type) {
        case AST_NODE_TYPES.ObjectExpression:
            out.push({ obj: n, inline })
            for (const p of n.properties) if (p.type === AST_NODE_TYPES.SpreadElement) spreadObjectLiterals(context, p.argument, inline, out, depth + 1)
            break
        case AST_NODE_TYPES.LogicalExpression:
            if (n.operator !== "&&") spreadObjectLiterals(context, n.left, inline, out, depth + 1)
            spreadObjectLiterals(context, n.right, inline, out, depth + 1)
            break
        case AST_NODE_TYPES.ConditionalExpression:
            spreadObjectLiterals(context, n.consequent, inline, out, depth + 1)
            spreadObjectLiterals(context, n.alternate, inline, out, depth + 1)
            break
        case AST_NODE_TYPES.Identifier: {
            const init = constInit(context, n)
            if (init) spreadObjectLiterals(context, init, false, out, depth + 1)
            break
        }
    }
    return out
}

/** True for `null`, `undefined`, `false` and other literals that spread/render nothing. */
export function isEmptyValue(node: TSESTree.Node): boolean {
    const n = unwrap(node)
    if (n.type === AST_NODE_TYPES.Literal) return n.value === null || n.value === false || n.value === "" || typeof n.value === "number"
    return n.type === AST_NODE_TYPES.Identifier && n.name === "undefined"
}

/**
 * Removes a node together with the whitespace that separates it from the previous token
 * (`<div a b>` → `<div a>` when removing `b`).
 */
export function removeWithLeadingSpace(context: Context, fixer: TSESLint.RuleFixer, node: TSESTree.Node | TSESTree.Token): TSESLint.RuleFix {
    const before = context.sourceCode.getTokenBefore(node, { includeComments: true })
    return fixer.removeRange([before ? before.range[1] : node.range[0], node.range[1]])
}

/** Removes an object property and exactly one adjacent comma, keeping the literal well formed. */
export function removeProperty(context: Context, fixer: TSESLint.RuleFixer, prop: TSESTree.Node): TSESLint.RuleFix {
    const sc = context.sourceCode
    const after = sc.getTokenAfter(prop)
    if (after && after.type === AST_TOKEN_TYPES.Punctuator && after.value === ",") {
        const next = sc.getTokenAfter(after, { includeComments: true })
        return fixer.removeRange([prop.range[0], next ? next.range[0] : after.range[1]])
    }
    const before = sc.getTokenBefore(prop)
    if (before && before.type === AST_TOKEN_TYPES.Punctuator && before.value === ",") return fixer.removeRange([before.range[0], prop.range[1]])
    return fixer.remove(prop)
}
