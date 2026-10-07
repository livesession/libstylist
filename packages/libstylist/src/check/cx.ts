// `cx()` calls on TypeScript JSX, read with core's grammar (the one Babel and ESLint use): runtime
// callee and part-map binding resolution through the type checker's symbols.
import ts from "typescript"

import {
    CX_EXPORT,
    PART_MAP_TAGS_KEY,
    RUNTIME_MODULES,
    carriesProps,
    classifyCxCall,
    partArgs,
    flattenCxArgs,
    memberPartName,
    resolvePartMap,
    wrapsComponent,
    type AnyNode,
    type CxArg,
    type CxEnv,
    type PartMapModules,
    type PartMapRef,
    type PartMapRegistry,
    type PropsBinding,
    type PropsEnv,
} from "../core/index.js"
import { toCoreNode, unwrapExpr, valueDeclarationOf } from "./ts-util.js"

/** A part an element carries through its cx() spreads. */
export interface CarriedPart {
    scope: string
    part: string
    node: ts.Node
}

/** One `{...cx(…)}` spread on an element, classified. */
export interface CxSpread {
    spread: ts.JsxSpreadAttribute
    call: ts.CallExpression
    args: CxArg[]
}

const tsNodeOf = (n: AnyNode): ts.Node => n.tsNode as ts.Node

/** `a.b.c` for an identifier member chain, else null. */
function memberPathOf(node: ts.Expression): string | null {
    const n = unwrapExpr(node)
    if (ts.isIdentifier(n)) return n.text
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
        const object = memberPathOf(n.expression)
        return object ? `${object}.${n.name.text}` : null
    }
    return null
}

/**
 * True when `param` is the component's props: its function's first parameter, and the function no
 * callback — not an argument of a call, unless it is a component wrapper's first (`memo`,
 * `forwardRef`, `observer`, `Object.assign`), so a `.map((item) => …)` parameter is never the props
 * (the ESLint layer's `isPropsParam`).
 */
function isPropsParam(param: ts.ParameterDeclaration): boolean {
    const fn = param.parent
    if (fn.parameters[0] !== param) return false
    let child: ts.Node = fn
    let parent = fn.parent
    while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent))) {
        child = parent
        parent = parent.parent
    }
    if (parent && (ts.isCallExpression(parent) || ts.isNewExpression(parent))) {
        const args: readonly ts.Expression[] = parent.arguments ?? []
        const index = args.indexOf(child as ts.Expression)
        if (index >= 0) {
            const callee = unwrapExpr(parent.expression)
            const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null
            return wrapsComponent(name, memberPathOf(callee), index)
        }
    }
    return true
}

/** Reads cx() calls and part-map members of the program's sources. */
export class CxReader {
    readonly env: CxEnv
    readonly propsEnv: PropsEnv
    private readonly spreadCache = new Map<ts.JsxOpeningLikeElement, CxSpread[]>()
    private readonly primary = new Map<ts.SourceFile, string | null>()

    constructor(
        private readonly checker: ts.TypeChecker,
        private readonly registry: PartMapRegistry | null,
        private readonly partMaps: PartMapModules | null,
    ) {
        this.env = {
            isCx: (callee) => this.isCxCallee(tsNodeOf(callee)),
            partMap: (id) => this.partMapOf(tsNodeOf(id)),
        }
        this.propsEnv = {
            isCx: (callee) => this.isCxCallee(tsNodeOf(callee)),
            bindingOf: (id) => this.bindingOf(tsNodeOf(id)),
        }
    }

    /** The import specifier (or namespace import) an identifier is bound to, with its module specifier. */
    private importOf(id: ts.Node): { spec: ts.ImportSpecifier | ts.NamespaceImport; module: string } | null {
        if (!ts.isIdentifier(id)) return null
        const decl = this.checker.getSymbolAtLocation(id)?.declarations?.[0]
        if (!decl || !(ts.isImportSpecifier(decl) || ts.isNamespaceImport(decl))) return null
        const importDecl = ts.isImportSpecifier(decl) ? decl.parent.parent.parent : decl.parent.parent
        if (importDecl.importClause?.isTypeOnly || (ts.isImportSpecifier(decl) && decl.isTypeOnly)) return null
        const from = importDecl.moduleSpecifier
        return ts.isStringLiteral(from) ? { spec: decl, module: from.text } : null
    }

    /** True when `callee` is the runtime `cx` (an import of it, or `ns.cx` of a namespace import of the runtime). */
    isCxCallee(node: ts.Node): boolean {
        const callee = ts.isExpression(node) ? unwrapExpr(node) : node
        if (ts.isIdentifier(callee)) {
            const hit = this.importOf(callee)
            return !!hit && ts.isImportSpecifier(hit.spec) && (hit.spec.propertyName ?? hit.spec.name).text === CX_EXPORT && RUNTIME_MODULES.includes(hit.module)
        }
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === CX_EXPORT) {
            const hit = this.importOf(callee.expression)
            return !!hit && ts.isNamespaceImport(hit.spec) && RUNTIME_MODULES.includes(hit.module)
        }
        return false
    }

    /** True when `node` is a call of the runtime `cx`. */
    isCxCall(node: ts.Node): node is ts.CallExpression {
        return ts.isCallExpression(node) && this.isCxCallee(node.expression)
    }

    /** The part map an identifier is bound to, or null. */
    partMapOf(id: ts.Node): PartMapRef | null {
        const hit = this.importOf(id)
        if (!hit || !ts.isImportSpecifier(hit.spec)) return null
        return resolvePartMap((id as ts.Identifier).text, (hit.spec.propertyName ?? hit.spec.name).text, hit.module, this.registry, this.partMaps)
    }

    /** Classifies a cx() call. */
    classify(call: ts.CallExpression): CxArg[] {
        return classifyCxCall(toCoreNode(call), this.env)
    }

    /** The element's `{...cx(…)}` spreads. */
    spreadsOf(el: ts.JsxOpeningLikeElement): CxSpread[] {
        let hit = this.spreadCache.get(el)
        if (!hit) {
            hit = []
            for (const p of el.attributes.properties) {
                if (!ts.isJsxSpreadAttribute(p)) continue
                const call = unwrapExpr(p.expression)
                if (this.isCxCall(call)) hit.push({ spread: p, call, args: this.classify(call) })
            }
            this.spreadCache.set(el, hit)
        }
        return hit
    }

    /** Every part the element's cx() spreads carry (nested calls included); parts of an unknown scope are skipped. */
    partsOf(el: ts.JsxOpeningLikeElement): CarriedPart[] {
        const out: CarriedPart[] = []
        for (const s of this.spreadsOf(el)) for (const p of partArgs(s.args)) if (p.map.scope) out.push({ scope: p.map.scope, part: p.part, node: tsNodeOf(p.node) })
        return out
    }

    /** The props/slot arguments of a cx() call (nested calls included). */
    propsArgs(call: ts.CallExpression): ts.Expression[] {
        return flattenCxArgs(this.classify(call))
            .filter((a) => a.kind === "props")
            .map((a) => tsNodeOf(a.node) as ts.Expression)
    }

    /** `scope:part` of every part-map member read anywhere in `node` (for S301). */
    memberReads(node: ts.Node, visit: (scope: string, part: string, at: ts.Node) => void): void {
        const walk = (n: ts.Node): void => {
            if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && ts.isIdentifier(n.expression)) {
                const scope = this.partMapOf(n.expression)?.scope
                if (scope) {
                    const part = memberPartName(toCoreNode(n))
                    if (part !== null && part !== PART_MAP_TAGS_KEY) visit(scope, part, n)
                }
            }
            ts.forEachChild(n, walk)
        }
        walk(node)
    }

    /** Runtime cx() calls in `node` (for stats and the ratchet). */
    countCalls(node: ts.Node): number {
        let n = 0
        const walk = (x: ts.Node): void => {
            if (this.isCxCall(x)) n++
            ts.forEachChild(x, walk)
        }
        walk(node)
        return n
    }

    /** The local name a file imports `scope`'s part map under (`cn`), or null. */
    localOf(sf: ts.SourceFile, scope: string): string | null {
        for (const stmt of sf.statements) {
            const bindings = ts.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : undefined
            if (!bindings || !ts.isNamedImports(bindings)) continue
            for (const e of bindings.elements) if (this.partMapOf(e.name)?.scope === scope) return e.name.text
        }
        return null
    }

    /** How an identifier is bound, for the shared forwarding predicate (`carriesProps`), through the checker's symbols. */
    bindingOf(id: ts.Node): PropsBinding {
        if (!ts.isIdentifier(id)) return { kind: "other" }
        const symbol = this.checker.getSymbolAtLocation(id)
        if (!symbol) return { kind: "unresolved" }
        const decl = valueDeclarationOf(symbol)
        if (!decl) return { kind: "other" }
        const isConst = (d: ts.VariableDeclaration) => ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0
        if (ts.isParameter(decl)) return ts.isIdentifier(decl.name) && !decl.dotDotDotToken && isPropsParam(decl) ? { kind: "param" } : { kind: "other" }
        if (ts.isBindingElement(decl)) {
            const pattern = decl.parent
            if (!ts.isObjectBindingPattern(pattern)) return { kind: "other" }
            const rest = !!decl.dotDotDotToken
            const prop = decl.propertyName ?? decl.name
            const key = ts.isIdentifier(prop) || ts.isStringLiteral(prop) ? prop.text : null
            const owner = pattern.parent
            if (ts.isParameter(owner)) return isPropsParam(owner) ? { kind: "pattern", rest, key, from: "param" } : { kind: "other" }
            if (ts.isVariableDeclaration(owner) && isConst(owner) && owner.initializer) return { kind: "pattern", rest, key, from: toCoreNode(owner.initializer) }
            return { kind: "other" }
        }
        if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && isConst(decl) && decl.initializer) return { kind: "const", init: toCoreNode(decl.initializer) }
        return { kind: "other" }
    }

    /** True when an expression may carry the component's stylist props (the predicate ESLint's forward-props shares). */
    carriesProps(node: ts.Expression): boolean {
        return carriesProps(toCoreNode(node), this.propsEnv)
    }

    /** The scope most part-map members of a file read — its own sheet (the default root binding resolves against it). */
    primaryScopeOf(sf: ts.SourceFile): string | null {
        if (this.primary.has(sf)) return this.primary.get(sf) ?? null
        const counts = new Map<string, number>()
        this.memberReads(sf, (scope) => counts.set(scope, (counts.get(scope) ?? 0) + 1))
        let best: string | null = null
        for (const [scope, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = scope
        // no member read yet: the first part map the file imports names its sheet
        for (const stmt of best ? [] : sf.statements) {
            const bindings = ts.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : undefined
            if (!bindings || !ts.isNamedImports(bindings)) continue
            best = bindings.elements.map((e) => this.partMapOf(e.name)?.scope).find((s): s is string => !!s) ?? null
            if (best) break
        }
        this.primary.set(sf, best)
        return best
    }
}
