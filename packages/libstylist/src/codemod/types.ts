// Type facts for the codemod's data values, from a TypeScript program: whether a value can be `false`
// (it renders "false" as a JSX data-* attribute today, and nothing in a cx() data literal), nullish,
// or `""`/`0` (which `x || undefined` omits and a bare `x` renders).
import ts from "typescript"

import type { DataTypes, ValueFacts } from "./index.js"

/** The facts of one type (union members and type-parameter constraints looked through). */
export function valueFacts(checker: ts.TypeChecker, type: ts.Type, depth = 0): ValueFacts {
    const out: ValueFacts = { unknown: false, canBeFalse: false, canBeUndefined: false, canBeNull: false, canBeEmpty: false }
    if (depth > 8) return { ...out, unknown: true }
    for (const t of type.isUnion() ? type.types : [type]) {
        const f = t.flags
        if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) out.unknown = true
        else if (f & ts.TypeFlags.Boolean) out.canBeFalse = true
        else if (f & ts.TypeFlags.BooleanLiteral) {
            if ((t as unknown as { intrinsicName?: string }).intrinsicName === "false") out.canBeFalse = true
        } else if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) out.canBeUndefined = true
        else if (f & ts.TypeFlags.Null) out.canBeNull = true
        else if (f & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.BigInt)) out.canBeEmpty = true
        else if (f & ts.TypeFlags.StringLiteral) {
            if ((t as ts.StringLiteralType).value === "") out.canBeEmpty = true
        } else if (f & ts.TypeFlags.NumberLiteral) {
            if ((t as ts.NumberLiteralType).value === 0) out.canBeEmpty = true
        } else if (f & ts.TypeFlags.BigIntLiteral) {
            if ((t as ts.BigIntLiteralType).value.base10Value === "0") out.canBeEmpty = true
        } else if (f & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Index | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution)) {
            const c = checker.getBaseConstraintOfType(t)
            if (!c || c === t) out.unknown = true
            else {
                const inner = valueFacts(checker, c, depth + 1)
                out.unknown ||= inner.unknown
                out.canBeFalse ||= inner.canBeFalse
                out.canBeUndefined ||= inner.canBeUndefined
                out.canBeNull ||= inner.canBeNull
                out.canBeEmpty ||= inner.canBeEmpty
            }
        } else if (f & ts.TypeFlags.Never) {
            // contributes nothing
        } else if (f & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.EnumLiteral | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) {
            if (f & (ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) out.canBeEmpty = true
        } else out.unknown = true
    }
    return out
}

/** The deepest expression of `sf` spanning exactly [start, end). */
function expressionAt(sf: ts.SourceFile, start: number, end: number): ts.Expression | null {
    let found: ts.Expression | null = null
    const visit = (node: ts.Node): void => {
        if (node.pos > start || node.end < end) return
        if (ts.isExpression(node) && node.getStart(sf) === start && node.end === end) found = node
        ts.forEachChild(node, visit)
    }
    visit(sf)
    return found
}

/** A `DataTypes` oracle for one file of `program`, or null when the program doesn't hold it. */
export function dataTypesFor(program: ts.Program, file: string): DataTypes | null {
    const sf = program.getSourceFile(file)
    if (!sf) return null
    const checker = program.getTypeChecker()
    return {
        facts(start, end) {
            const node = expressionAt(sf, start, end)
            return node ? valueFacts(checker, checker.getTypeAtLocation(node)) : null
        },
    }
}
