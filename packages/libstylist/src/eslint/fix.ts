// Fix helpers for the cx() rules: making the runtime `cx` available and editing a cx() call.
import { AST_NODE_TYPES, AST_TOKEN_TYPES, ASTUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils"

import { RUNTIME_MODULES } from "../core/index.js"
import type { AnyRuleContext } from "./ast.js"
import type { CxFile } from "./cx.js"

/** A valid JS identifier (usable as `key` and `map.key`). */
export const IDENT = /^[A-Za-z_$][\w$]*$/

/** `cn.icon` or `cn["group-label"]`. */
export const memberText = (local: string, part: string): string => (IDENT.test(part) ? `${local}.${part}` : `${local}[${JSON.stringify(part)}]`)

/**
 * The name the runtime `cx` is reachable under at `node`, plus the fixes that import it when the
 * file doesn't yet. Null when `cx` is taken by another binding (no safe fix).
 */
export function cxBinding(context: AnyRuleContext, cx: CxFile, node: TSESTree.Node, fixer: TSESLint.RuleFixer): { name: string; fixes: TSESLint.RuleFix[] } | null {
    const variable = ASTUtils.findVariable(context.sourceCode.getScope(node), "cx")
    if (variable) {
        const def = variable.defs[0]
        const id = def?.name
        return id && cx.isCxCall({ type: AST_NODE_TYPES.CallExpression, callee: id } as unknown as TSESTree.Node) ? { name: "cx", fixes: [] } : null
    }
    const body = context.sourceCode.ast.body
    const runtimeImport = body.find(
        (s): s is TSESTree.ImportDeclaration =>
            s.type === AST_NODE_TYPES.ImportDeclaration &&
            s.importKind !== "type" &&
            RUNTIME_MODULES.includes(s.source.value) &&
            s.specifiers.some((x) => x.type === AST_NODE_TYPES.ImportSpecifier) &&
            s.specifiers.every((x) => x.type === AST_NODE_TYPES.ImportSpecifier),
    )
    if (runtimeImport) {
        const last = runtimeImport.specifiers[runtimeImport.specifiers.length - 1]
        return { name: "cx", fixes: [fixer.insertTextAfter(last, ", cx")] }
    }
    // the import-grouping convention: packages first (plain, scoped, then @livesession/*), local modules last —
    // so the runtime import joins the @livesession/* group, or opens it after the last package import
    const imports = body.filter((s): s is TSESTree.ImportDeclaration => s.type === AST_NODE_TYPES.ImportDeclaration)
    const text = `import { cx } from "${RUNTIME_MODULES[0]}"`
    const isLocal = (d: TSESTree.ImportDeclaration) => d.source.value.startsWith(".") || d.source.value.startsWith("/")
    const livesession = imports.filter((d) => d.source.value.startsWith("@livesession/"))
    const packages = imports.filter((d) => !isLocal(d))
    const firstLocal = imports.find(isLocal)
    let fix: TSESLint.RuleFix
    if (livesession.length) fix = fixer.insertTextAfter(livesession[livesession.length - 1], `\n${text}`)
    else if (packages.length) fix = fixer.insertTextAfter(packages[packages.length - 1], `\n\n${text}`)
    else if (firstLocal) fix = fixer.insertTextBefore(firstLocal, `${text}\n\n`)
    else fix = fixer.insertTextBeforeRange([0, 0], `${text}\n`)
    return { name: "cx", fixes: [fix] }
}

/** Inserts `text` as the first argument of `call`. */
export function prependArg(context: AnyRuleContext, fixer: TSESLint.RuleFixer, call: TSESTree.CallExpression, text: string): TSESLint.RuleFix {
    if (call.arguments.length) return fixer.insertTextBefore(call.arguments[0], `${text}, `)
    const open = context.sourceCode.getTokenAfter(call.typeArguments ?? call.callee, (t) => t.type === AST_TOKEN_TYPES.Punctuator && t.value === "(")
    return fixer.insertTextAfterRange(open ? open.range : call.callee.range, text)
}

/** Inserts `text` as the last argument of `call`. */
export function appendArg(context: AnyRuleContext, fixer: TSESLint.RuleFixer, call: TSESTree.CallExpression, text: string): TSESLint.RuleFix {
    const args = call.arguments
    if (args.length) return fixer.insertTextAfter(args[args.length - 1], `, ${text}`)
    return prependArg(context, fixer, call, text)
}

/** Appends `entries` (source text of properties) to an object literal. */
export function appendProperties(context: AnyRuleContext, fixer: TSESLint.RuleFixer, obj: TSESTree.ObjectExpression, entries: string[]): TSESLint.RuleFix {
    const props = obj.properties
    if (!props.length) return fixer.replaceText(obj, `{ ${entries.join(", ")} }`)
    const last = props[props.length - 1]
    const after = context.sourceCode.getTokenAfter(last)
    const trailingComma = after && after.type === AST_TOKEN_TYPES.Punctuator && after.value === ","
    return trailingComma ? fixer.insertTextAfter(after, ` ${entries.join(", ")},`) : fixer.insertTextAfter(last, `, ${entries.join(", ")}`)
}
