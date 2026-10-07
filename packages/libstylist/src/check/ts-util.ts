// TypeScript compiler-API helpers shared by the checker's passes.
import ts from "typescript"

import type { AnyNode } from "../core/index.js"

export type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration

export const isFunctionLike = (node: ts.Node | undefined): node is FunctionLike =>
    !!node && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))

/** Strips parentheses, type assertions, `satisfies` and `!`. */
export function unwrapExpr(node: ts.Expression): ts.Expression {
    let n = node
    for (;;) {
        if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression
        else return n
    }
}

/** True when the expression goes through an `as any` (or `<any>`) assertion. */
export function hasAnyAssertion(node: ts.Expression): boolean {
    let n: ts.Expression = node
    for (;;) {
        if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && n.type.kind === ts.SyntaxKind.AnyKeyword) return true
        if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)) n = n.expression
        else return false
    }
}

/** Follows import/export aliases to the symbol that declares the value. */
export function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    let s = symbol
    const seen = new Set<ts.Symbol>()
    while (s && s.flags & ts.SymbolFlags.Alias && !seen.has(s)) {
        seen.add(s)
        const next = checker.getAliasedSymbol(s)
        if (!next || next === s || next.flags & ts.SymbolFlags.None || next.escapedName === "unknown") return next && next.declarations?.length ? next : undefined
        s = next
    }
    return s
}

/** The value declaration of a symbol (first declaration as a fallback). */
export const valueDeclarationOf = (symbol: ts.Symbol | undefined): ts.Declaration | undefined => symbol?.valueDeclaration ?? symbol?.declarations?.[0]

/** The symbol an expression refers to, with aliases followed. */
export function symbolOf(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
    let target = node
    if (ts.isPropertyAccessExpression(node)) target = node.name
    return resolveAlias(checker, checker.getSymbolAtLocation(target))
}

/** 1-based line of a node's first token. */
export function lineOf(node: ts.Node): number {
    const sf = node.getSourceFile()
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

/** The written name of a JSX tag (`div`, `elo-alert`, `Modal.Header`, `svg:circle`). */
export function jsxTagText(tag: ts.JsxTagNameExpression): string {
    if (ts.isIdentifier(tag)) return tag.text
    if (ts.isJsxNamespacedName(tag)) return `${tag.namespace.text}:${tag.name.text}`
    if (ts.isPropertyAccessExpression(tag)) return `${jsxTagText(tag.expression as ts.JsxTagNameExpression)}.${tag.name.text}`
    return (tag as ts.Node).getText()
}

/** True for lowercase or hyphenated intrinsic element names (the JSX host rule). */
export function isIntrinsicTag(tag: ts.JsxTagNameExpression): boolean {
    if (ts.isJsxNamespacedName(tag)) return true
    if (!ts.isIdentifier(tag)) return false
    return /^[a-z]/.test(tag.text) || tag.text.includes("-")
}

/** The written name of a JSX attribute. */
export function jsxAttrName(attr: ts.JsxAttribute): string {
    const n = attr.name
    return ts.isJsxNamespacedName(n) ? `${n.namespace.text}:${n.name.text}` : n.text
}

/** The named attributes of an element. */
export const jsxAttributes = (el: ts.JsxOpeningLikeElement): ts.JsxAttribute[] => el.attributes.properties.filter(ts.isJsxAttribute)

/** The spread attributes of an element. */
export const jsxSpreads = (el: ts.JsxOpeningLikeElement): ts.JsxSpreadAttribute[] => el.attributes.properties.filter(ts.isJsxSpreadAttribute)

/** The attribute named `name`, if written. */
export const jsxAttr = (el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined => jsxAttributes(el).find((a) => jsxAttrName(a) === name)

/** True when a boolean attribute is set (`asChild`, `asChild={true}`), false for `{false}`. */
export function isTruthyAttr(attr: ts.JsxAttribute | undefined): boolean {
    if (!attr) return false
    const init = attr.initializer
    if (!init) return true
    if (ts.isJsxExpression(init) && init.expression) {
        const e = unwrapExpr(init.expression)
        return e.kind !== ts.SyntaxKind.FalseKeyword && e.kind !== ts.SyntaxKind.NullKeyword && !(ts.isIdentifier(e) && e.text === "undefined")
    }
    return true
}

/** The opening element of a JSX element or self-closing element. */
export const openingOf = (node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxOpeningLikeElement => (ts.isJsxElement(node) ? node.openingElement : node)

// --- core cx grammar adapter ---------------------------------------------------------------------

/**
 * Mirrors a TypeScript expression into the Babel shape `core`'s cx() grammar reads, so the checker
 * classifies cx() arguments with exactly the grammar Babel and ESLint use. Only the node kinds the
 * grammar inspects are mirrored deeply; everything else becomes an opaque node of its syntax kind.
 * Every mirrored node keeps its TypeScript node as `tsNode`.
 */
export function toCoreNode(node: ts.Node): AnyNode {
    const base = { tsNode: node }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { ...base, type: "StringLiteral", value: node.text }
    if (ts.isNumericLiteral(node)) return { ...base, type: "NumericLiteral", value: Number(node.text) }
    if (ts.isPropertyAccessExpression(node)) {
        return { ...base, type: "MemberExpression", object: toCoreNode(node.expression), property: { type: "Identifier", name: node.name.text, tsNode: node.name }, computed: false }
    }
    if (ts.isElementAccessExpression(node)) return { ...base, type: "MemberExpression", object: toCoreNode(node.expression), property: toCoreNode(node.argumentExpression), computed: true }
    if (ts.isCallExpression(node)) {
        return {
            ...base,
            type: "CallExpression",
            callee: toCoreNode(node.expression),
            arguments: node.arguments.map((a) => (ts.isSpreadElement(a) ? { type: "SpreadElement", tsNode: a, argument: toCoreNode(a.expression) } : toCoreNode(a))),
        }
    }
    if (ts.isTemplateExpression(node)) return { ...base, type: "TemplateLiteral", expressions: node.templateSpans.map((s) => toCoreNode(s.expression)), quasis: [] }
    if (node.kind === ts.SyntaxKind.NullKeyword) return { ...base, type: "NullLiteral" }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { ...base, type: "BooleanLiteral", value: node.kind === ts.SyntaxKind.TrueKeyword }
    if (ts.isIdentifier(node)) return { ...base, type: "Identifier", name: node.text }
    if (ts.isParenthesizedExpression(node)) return { ...base, type: "ParenthesizedExpression", expression: toCoreNode(node.expression) }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return { ...base, type: "TSAsExpression", expression: toCoreNode(node.expression) }
    if (ts.isSatisfiesExpression(node)) return { ...base, type: "TSSatisfiesExpression", expression: toCoreNode(node.expression) }
    if (ts.isNonNullExpression(node)) return { ...base, type: "TSNonNullExpression", expression: toCoreNode(node.expression) }
    if (ts.isArrayLiteralExpression(node)) {
        return {
            ...base,
            type: "ArrayExpression",
            elements: node.elements.map((e) => (ts.isOmittedExpression(e) ? null : ts.isSpreadElement(e) ? { type: "SpreadElement", tsNode: e } : toCoreNode(e))),
        }
    }
    if (ts.isObjectLiteralExpression(node)) {
        return {
            ...base,
            type: "ObjectExpression",
            properties: node.properties.map((p): AnyNode => {
                if (ts.isSpreadAssignment(p)) return { type: "SpreadElement", tsNode: p, argument: toCoreNode(p.expression) }
                if (ts.isShorthandPropertyAssignment(p)) return { type: "ObjectProperty", tsNode: p, key: toCoreNode(p.name), value: toCoreNode(p.name), computed: false }
                if (ts.isPropertyAssignment(p)) {
                    const computed = ts.isComputedPropertyName(p.name)
                    return { type: "ObjectProperty", tsNode: p, key: computed ? { type: "Computed", tsNode: p.name } : toCoreNode(p.name), value: toCoreNode(p.initializer), computed }
                }
                if (ts.isMethodDeclaration(p)) return { type: "ObjectMethod", tsNode: p, key: toCoreNode(p.name), computed: false, method: true }
                return { type: "ObjectMethod", tsNode: p, key: toCoreNode(p.name), computed: false, kind: ts.isGetAccessor(p) ? "get" : "set" }
            }),
        }
    }
    if (ts.isConditionalExpression(node)) return { ...base, type: "ConditionalExpression", test: { type: "Opaque", tsNode: node.condition }, consequent: toCoreNode(node.whenTrue), alternate: toCoreNode(node.whenFalse) }
    if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind
        const operator = op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : op === ts.SyntaxKind.BarBarToken ? "||" : op === ts.SyntaxKind.QuestionQuestionToken ? "??" : null
        if (operator) return { ...base, type: "LogicalExpression", operator, left: toCoreNode(node.left), right: toCoreNode(node.right) }
    }
    return { ...base, type: ts.SyntaxKind[node.kind] }
}
