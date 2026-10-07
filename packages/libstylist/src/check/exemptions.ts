// The only escape hatch: a TSDoc tag on the component, `@libstylistRoot <none|multi|native> <reason>`.
// - none: the component renders no DOM of its own (providers, null/empty).
// - multi: one identity element plus sibling parts.
// - native: third-party-managed hosts that must stay native (a marker on a Radix asChild host).
import ts from "typescript"

import { EXEMPTION_CATEGORIES, type ExemptionCategory } from "./config.js"

export const EXEMPTION_TAG = "libstylistRoot"

export interface ExemptionTag {
    tag: ts.JSDocTag
    /** The node owning the JSDoc block (function, variable statement, expression statement, property). */
    owner: ts.Node
    /** Text after the tag name. */
    text: string
}

export type ParsedExemption = { ok: true; category: ExemptionCategory; reason: string } | { ok: false; problem: string }

const HOST_KINDS = new Set([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.VariableStatement,
    ts.SyntaxKind.ExpressionStatement,
    ts.SyntaxKind.PropertyAssignment,
    ts.SyntaxKind.ShorthandPropertyAssignment,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.ExportAssignment,
    ts.SyntaxKind.ExportDeclaration,
])

/** Every `@libstylistRoot` tag in the files, with the node that owns its JSDoc block. */
export function collectExemptionTags(files: readonly ts.SourceFile[]): ExemptionTag[] {
    const out: ExemptionTag[] = []
    const seen = new Set<ts.JSDocTag>()
    for (const sf of files) {
        if (!sf.text.includes(`@${EXEMPTION_TAG}`)) continue
        const visit = (node: ts.Node): void => {
            if (HOST_KINDS.has(node.kind)) {
                for (const tag of ts.getJSDocTags(node)) {
                    if (tag.tagName.text !== EXEMPTION_TAG || seen.has(tag)) continue
                    seen.add(tag)
                    out.push({ tag, owner: tag.parent.parent ?? node, text: (ts.getTextOfJSDocComment(tag.comment) ?? "").trim() })
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(sf)
    }
    return out
}

/** Parses `<category> <reason>`; the reason must have at least `minReasonLength` characters. */
export function parseExemption(text: string, minReasonLength: number): ParsedExemption {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(text.trim())
    if (!m) return { ok: false, problem: `is empty — write \`@${EXEMPTION_TAG} <${EXEMPTION_CATEGORIES.join("|")}> <reason>\`` }
    const [, category, rest] = m
    if (!EXEMPTION_CATEGORIES.includes(category as ExemptionCategory)) return { ok: false, problem: `has unknown category "${category}" — use one of ${EXEMPTION_CATEGORIES.join(", ")}` }
    const reason = rest.replace(/\s+/g, " ").trim()
    if (reason.length < minReasonLength) return { ok: false, problem: `needs a reason of at least ${minReasonLength} characters (got ${reason.length}) — say why this component can't have one identity element` }
    return { ok: true, category: category as ExemptionCategory, reason }
}

/**
 * True when the JSDoc of a declaration (its statement's included) carries `@libstylistRoot <category>`
 * — a component library's `.d.ts` keeps the tag (`@libstylistRoot none` on the design system's
 * `Loader`).
 */
export function declaresExemption(decl: ts.Node, category: ExemptionCategory): boolean {
    return jsDocOwners(decl).some((node) =>
        ts.getJSDocTags(node).some((tag) => tag.tagName.text === EXEMPTION_TAG && (ts.getTextOfJSDocComment(tag.comment) ?? "").trim().split(/\s+/)[0] === category),
    )
}

/** The nodes whose JSDoc block documents a component host node (a declaration and its statement). */
export function jsDocOwners(host: ts.Node): ts.Node[] {
    const out = [host]
    if (ts.isVariableDeclaration(host) && ts.isVariableDeclarationList(host.parent)) out.push(host.parent.parent)
    if ((ts.isArrowFunction(host) || ts.isFunctionExpression(host)) && host.parent) {
        const p = host.parent
        if (ts.isVariableDeclaration(p) && ts.isVariableDeclarationList(p.parent)) out.push(p.parent.parent)
        if (ts.isBinaryExpression(p) && ts.isExpressionStatement(p.parent)) out.push(p.parent)
        if (ts.isPropertyAssignment(p)) out.push(p)
        if (ts.isCallExpression(p)) out.push(...jsDocOwners(p))
    }
    if (ts.isCallExpression(host) && host.parent) {
        const p = host.parent
        if (ts.isVariableDeclaration(p) && ts.isVariableDeclarationList(p.parent)) out.push(p.parent.parent)
        if (ts.isCallExpression(p)) out.push(...jsDocOwners(p))
    }
    return out
}
