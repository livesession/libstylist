// The migration ratchet's facts per source file: whether it is migrated (it calls the runtime `cx()`,
// or it writes an identity tag/marker of the prefix), and its uses of the sanctioned migration helpers
// `legacy(...)` and `legacyClassName(...)` from the runtime — counted by `libstylist burndown`, never
// errors, and zero when the migration is done.
import ts from "typescript"

import { TAG_RE } from "../conventions/index.js"
import { RUNTIME_MODULES } from "../core/index.js"
import type { CxReader } from "./cx.js"
import { jsxAttrName, jsxAttributes, openingOf } from "./ts-util.js"

export { RUNTIME_MODULES }

export type LegacyHelper = "legacy" | "legacyClassName"
export const LEGACY_HELPERS: readonly LegacyHelper[] = ["legacy", "legacyClassName"]

export interface FileFacts {
    /** Runtime cx() calls in the file. */
    cxCalls: number
    /** Identity tags and markers of the prefix written in the file's JSX. */
    identities: Set<string>
    /** A cx() call or an identity written — the file is migrated. */
    migrated: boolean
    /** Calls of each migration helper. */
    calls: Record<LegacyHelper, number>
    /** Names passed to `legacyClassName(x)` / `legacyClassName(props.x)` (the class props still accepted). */
    legacyClassNameArgs: Set<string>
}

const DATA_ARIA = /^(data|aria)-/

/** True for an identity name of `prefix` (`elo-alert`), never `data-*`/`aria-*`. */
export const isIdentityName = (name: string, prefix: string): boolean => name.startsWith(`${prefix}-`) && TAG_RE.test(name) && !DATA_ARIA.test(name)

/** The runtime helper an identifier callee imports, or null (`import { legacy as l } from "@livesession/libstylist/runtime"` → `legacy`). */
function importedHelper(checker: ts.TypeChecker, callee: ts.Expression): LegacyHelper | null {
    if (!ts.isIdentifier(callee)) return null
    const sym = checker.getSymbolAtLocation(callee)
    const decl = sym?.declarations?.[0]
    if (!decl || !ts.isImportSpecifier(decl)) return null
    const from = decl.parent.parent.parent.moduleSpecifier
    if (!ts.isStringLiteral(from) || !RUNTIME_MODULES.includes(from.text)) return null
    const name = (decl.propertyName ?? decl.name).text
    return (LEGACY_HELPERS as readonly string[]).includes(name) ? (name as LegacyHelper) : null
}

/** Collects the ratchet facts of a source file. */
export function collectFileFacts(sf: ts.SourceFile, checker: ts.TypeChecker, prefix: string, cx: CxReader): FileFacts {
    const cxCalls = cx.countCalls(sf)
    const identities = new Set<string>()
    const calls: Record<LegacyHelper, number> = { legacy: 0, legacyClassName: 0 }
    const legacyClassNameArgs = new Set<string>()
    const visit = (node: ts.Node): void => {
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
            const el = openingOf(node)
            if (ts.isIdentifier(el.tagName) && isIdentityName(el.tagName.text, prefix)) identities.add(el.tagName.text)
            for (const attr of jsxAttributes(el)) {
                const name = jsxAttrName(attr)
                if (isIdentityName(name, prefix)) identities.add(name)
            }
        } else if (ts.isCallExpression(node)) {
            const helper = importedHelper(checker, node.expression)
            if (helper) {
                calls[helper]++
                const arg = node.arguments[0]
                if (helper === "legacyClassName" && arg) {
                    if (ts.isIdentifier(arg)) legacyClassNameArgs.add(arg.text)
                    else if (ts.isPropertyAccessExpression(arg)) legacyClassNameArgs.add(arg.name.text)
                }
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(sf)
    return { cxCalls, identities, migrated: cxCalls > 0 || identities.size > 0, calls, legacyClassNameArgs }
}
