// The removed `cx` attribute grammar and `@cxScope` pragma, kept for the codemod that converts them
// to cx() calls. Works on Babel nodes.
import { PART_RE } from "../conventions/index.js"

/** Minimal structural view of a Babel or ESTree node. */
export interface AnyNode {
    type: string
    [key: string]: any
}

export interface PartRef {
    /** Qualified scope (`player-controls` in `player-controls:button`), or null for the file's scope. */
    scope: string | null
    part: string
    /** The token as written, used for `_cxpart`. */
    label: string
}

export type CxIR =
    | { kind: "empty" }
    | { kind: "parts"; refs: PartRef[] }
    | { kind: "list"; items: CxIR[] }
    | { kind: "and"; test: AnyNode; then: CxIR }
    | { kind: "cond"; test: AnyNode; then: CxIR; else: CxIR }

export class CxGrammarError extends Error {
    constructor(message: string, readonly node: AnyNode) {
        super(message)
        this.name = "CxGrammarError"
    }
}

const HINT = "cx accepts literal part names only — use data-* for variants"

/** Splits a literal into part refs, validating every token (SPEC §5.2). */
export function parseTokens(value: string, node: AnyNode): PartRef[] {
    const refs: PartRef[] = []
    for (const token of value.split(/\s+/).filter(Boolean)) {
        const colon = token.indexOf(":")
        const scope = colon >= 0 ? token.slice(0, colon) : null
        const part = colon >= 0 ? token.slice(colon + 1) : token
        if (scope !== null && !PART_RE.test(scope)) throw new CxGrammarError(`invalid scope "${scope}" in cx token "${token}"`, node)
        if (!PART_RE.test(part)) throw new CxGrammarError(`invalid part "${part}" in cx token "${token}" (parts are kebab-case)`, node)
        refs.push({ scope, part, label: token })
    }
    return refs
}

const stringValue = (node: AnyNode): string | undefined => {
    if (node.type === "StringLiteral") return node.value
    if (node.type === "Literal" && typeof node.value === "string") return node.value
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis.map((q: AnyNode) => q.value.cooked ?? q.value.raw).join("")
    return undefined
}

const isNullish = (node: AnyNode): boolean =>
    node.type === "NullLiteral" ||
    (node.type === "Literal" && node.value === null && !node.regex) ||
    (node.type === "Identifier" && node.name === "undefined") ||
    ((node.type === "BooleanLiteral" || node.type === "Literal") && node.value === false)

const unwrap = (node: AnyNode): AnyNode => {
    let n = node
    while (n && (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression" || n.type === "ParenthesizedExpression" || n.type === "TSNonNullExpression")) n = n.expression
    return n
}

/** Parses a `cx` expression into IR. Throws `CxGrammarError` on anything non-static. */
export function parseCxExpression(input: AnyNode): CxIR {
    const node = unwrap(input)
    const str = stringValue(node)
    if (str !== undefined) {
        const refs = parseTokens(str, node)
        return refs.length ? { kind: "parts", refs } : { kind: "empty" }
    }
    if (isNullish(node)) return { kind: "empty" }
    switch (node.type) {
        case "ArrayExpression": {
            const items: CxIR[] = []
            for (const el of node.elements) {
                if (!el) throw new CxGrammarError("cx arrays must not contain holes", node)
                if (el.type === "SpreadElement") throw new CxGrammarError(`cx arrays must not contain spreads — ${HINT}`, el)
                items.push(parseCxExpression(el))
            }
            return { kind: "list", items }
        }
        case "ObjectExpression": {
            const items: CxIR[] = []
            for (const prop of node.properties) {
                if (prop.type === "SpreadElement" || prop.type === "RestElement") throw new CxGrammarError(`cx objects must not contain spreads — ${HINT}`, prop)
                if (prop.computed) throw new CxGrammarError(`cx object keys must be static — ${HINT}`, prop)
                const key = prop.key.type === "Identifier" ? prop.key.name : stringValue(prop.key)
                if (key === undefined) throw new CxGrammarError(`cx object keys must be identifiers or strings — ${HINT}`, prop)
                if (prop.kind && prop.kind !== "init") throw new CxGrammarError("cx objects must not contain getters/setters", prop)
                if (prop.method) throw new CxGrammarError("cx objects must not contain methods", prop)
                const refs = parseTokens(key, prop.key)
                if (refs.length) items.push({ kind: "and", test: prop.value, then: { kind: "parts", refs } })
            }
            return { kind: "list", items }
        }
        case "ConditionalExpression":
            return { kind: "cond", test: node.test, then: parseCxExpression(node.consequent), else: parseCxExpression(node.alternate) }
        case "LogicalExpression":
            if (node.operator !== "&&") throw new CxGrammarError(`cx supports "cond && parts" but not "${node.operator}" — ${HINT}`, node)
            return { kind: "and", test: node.left, then: parseCxExpression(node.right) }
        default:
            throw new CxGrammarError(`cx value must be static (got ${node.type}) — ${HINT}`, node)
    }
}

/** Parses a JSX attribute value (`"a b"` or `{expr}`). */
export function parseCxAttributeValue(value: AnyNode | null | undefined, attrNode: AnyNode): CxIR {
    if (!value) throw new CxGrammarError("cx needs a value", attrNode)
    if (value.type === "JSXExpressionContainer") {
        if (value.expression.type === "JSXEmptyExpression") throw new CxGrammarError("cx needs a value", attrNode)
        return parseCxExpression(value.expression)
    }
    return parseCxExpression(value)
}

/** Every part ref mentioned anywhere in the IR (for validation and lint). */
export function collectRefs(ir: CxIR, out: PartRef[] = []): PartRef[] {
    switch (ir.kind) {
        case "parts": out.push(...ir.refs); break
        case "list": for (const i of ir.items) collectRefs(i, out); break
        case "and": collectRefs(ir.then, out); break
        case "cond": collectRefs(ir.then, out); collectRefs(ir.else, out); break
    }
    return out
}

/** True when the IR has no conditions — it compiles to plain attributes. */
export function isStaticIR(ir: CxIR): boolean {
    if (ir.kind === "cond" || ir.kind === "and") return false
    if (ir.kind === "list") return ir.items.every(isStaticIR)
    return true
}

const PRAGMA = /@cxScope\s+([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/

/** The scope declared by a `@cxScope <id>` pragma among the file's comments, or null. Two different pragmas throw. */
export function findScopePragma(comments: ReadonlyArray<{ value: string }> | undefined | null): string | null {
    let found: string | null = null
    for (const c of comments ?? []) {
        const m = PRAGMA.exec(c.value)
        if (!m) continue
        if (found && found !== m[1]) throw new Error(`conflicting @cxScope pragmas: "${found}" and "${m[1]}"`)
        found = m[1]
    }
    return found
}
