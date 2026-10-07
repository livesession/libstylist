// Render evaluation: what a component can render at its root, per branch. Every return path is
// followed through conditionals, `&&`, fragments, local consts, local helper calls and transparent
// wrappers (Fragment, Suspense, `*.Provider`, DOM-less Radix roots, `asChild`); internal
// (non-exported) design-system components are inlined; exported ones become delegates, and so do
// components of a libstylist library outside the analyzed sources (a linked design-system dist);
// portals are boundaries. The result is a list of alternatives, each the list of root items of one
// branch.
import ts from "typescript"

import { declaresLibstylist } from "../conventions/index.js"

import { declaresExemption } from "./exemptions.js"
import type { ComponentEntry, ExportIndex } from "./exports.js"
import { calleeName, resolveExpression, resolveSymbolValue } from "./exports.js"
import type { CheckProgram } from "./program.js"
import {
    isFunctionLike,
    isIntrinsicTag,
    isTruthyAttr,
    jsxAttr,
    jsxTagText,
    openingOf,
    resolveAlias,
    unwrapExpr,
    valueDeclarationOf,
    type FunctionLike,
} from "./ts-util.js"

/** Where an element sits: the asChild wrappers merged onto it and the internal components it was inlined through. */
export interface ElementContext {
    el: ts.JsxOpeningLikeElement
    /**
     * The binding scope the element was evaluated in. One node evaluated through two calls of a helper
     * (`wrap(<a/>)`, `wrap(<b/>)`) is two different elements: their children differ.
     */
    scope: number
    /** `asChild` elements whose props merge onto this one (outermost first). */
    via: ts.JsxOpeningLikeElement[]
    /** Call sites of the internal components this element was inlined from (outermost first). */
    inline: ts.JsxOpeningLikeElement[]
    /** The element's children, evaluated in its own scope (for wrapper branches and slot identity). */
    children: () => Alts
}

export interface HostItem extends ElementContext {
    kind: "host"
    tag: string
}
export interface TagVarItem extends ElementContext {
    kind: "tagvar"
    /** The variable as written (`As`). */
    name: string
    /** The finite string-literal members of its type, or null when unbounded. */
    members: string[] | null
    typeText: string
}
export interface DelegateItem extends ElementContext {
    kind: "delegate"
    target: ComponentEntry
}
/**
 * A component of a libstylist component library outside the analyzed sources — its declaration's
 * nearest `package.json` declares a libstylist `prefix` (a linked design-system dist, `<Table>`,
 * `<Modal>`). It is a delegate whose forwarding is assumed: that library's own checker holds its
 * exports to R112, so a marker and parts put on it reach its identity element — unless the library
 * marks it `@libstylistRoot none` (`<Loader>`, a provider): it has no DOM for them to reach.
 */
export interface LibstylistDelegateItem extends ElementContext {
    kind: "libstylist-delegate"
    /** The element name as written (`Table`, `Modal.Body`). */
    name: string
    /** True when its library marks it `@libstylistRoot none`: it renders no DOM of its own. */
    domless: boolean
}
/** A third-party component (neither a design-system component nor one of a libstylist library). */
export interface ForeignItem extends ElementContext {
    kind: "foreign"
    name: string
}
export interface PortalItem {
    kind: "portal"
    node: ts.Node
    /** The binding scope it was evaluated in (see {@link ElementContext.scope}). */
    scope: number
    content: Alts
}
export interface TextItem {
    kind: "text"
    node: ts.Node
}
export interface OpaqueItem {
    kind: "opaque"
    node: ts.Node
    reason: string
}

export type ElementItem = HostItem | TagVarItem | DelegateItem | LibstylistDelegateItem | ForeignItem
export type Item = ElementItem | PortalItem | TextItem | OpaqueItem
/** The root items of one branch. */
export type Alt = Item[]
/** Every branch. `[[]]` renders nothing. */
export type Alts = Alt[]

export const isElementItem = (i: Item): i is ElementItem => i.kind === "host" || i.kind === "tagvar" || i.kind === "delegate" || i.kind === "libstylist-delegate" || i.kind === "foreign"

type Binding =
    | { kind: "alts"; alts: () => Alts }
    | { kind: "expr"; expr: ts.Expression; env: Env }
    | { kind: "props"; el: ts.JsxOpeningLikeElement; children: () => Alts; env: Env }

interface Env {
    bindings: Map<ts.Symbol, Binding>
    /** Id of `bindings`: a new one per helper call or inlined component (see {@link ElementContext.scope}). */
    scope: number
    /** Functions being evaluated (recursion guard). */
    stack: ts.Node[]
    via: ts.JsxOpeningLikeElement[]
    inline: ts.JsxOpeningLikeElement[]
}

/** Max branches per evaluation; beyond it the branch becomes opaque. */
export const MAX_ALTS = 128
const MAX_DEPTH = 24

/** Radix packages whose `Root`/`Provider` render no DOM of their own. */
const DOMLESS_RADIX = new Set([
    "react-popover",
    "react-tooltip",
    "react-dialog",
    "react-alert-dialog",
    "react-dropdown-menu",
    "react-context-menu",
    "react-hover-card",
    "react-select",
    "react-toast",
    "react-direction",
    "react-portal",
])
const REACT_TRANSPARENT = new Set(["Fragment", "Suspense", "StrictMode", "Profiler", "Activity", "ViewTransition"])
const LIST_METHODS = new Set(["map", "flatMap", "filter", "reduce", "concat", "slice", "sort", "reverse"])

const EMPTY: Alts = [[]]
const inNodeModules = (file: string) => file.split(/[\\/]/).includes("node_modules")

const nodeKey = (n: ts.Node) => `${n.getSourceFile().fileName}:${n.pos}:${n.end}`
/** A stable identity for a root item (its node plus the asChild/inline context it was reached through). */
export function itemKey(i: Item): string {
    if (i.kind === "text" || i.kind === "opaque") return `${i.kind}@${nodeKey(i.node)}`
    if (i.kind === "portal") return `portal@${nodeKey(i.node)}#${i.scope}`
    return `${i.kind}@${nodeKey(i.el)}#${i.scope}|${i.via.map(nodeKey).join(",")}|${i.inline.map(nodeKey).join(",")}`
}
const altKey = (a: Alt) => a.map(itemKey).join(";")

/** Concatenates branch lists, dropping duplicates. */
export function union(node: ts.Node, ...lists: Alts[]): Alts {
    const out: Alts = []
    const seen = new Set<string>()
    for (const list of lists) {
        for (const alt of list) {
            const key = altKey(alt)
            if (seen.has(key)) continue
            seen.add(key)
            out.push(alt)
        }
    }
    return out.length > MAX_ALTS ? [[{ kind: "opaque", node, reason: `more than ${MAX_ALTS} render paths` }]] : out
}

/** Every combination of sibling branch lists (a fragment's children). */
export function product(node: ts.Node, parts: Alts[]): Alts {
    let acc: Alts = [[]]
    for (const part of parts) {
        if (part.length === 1 && part[0].length === 0) continue
        const next: Alts = []
        for (const a of acc) for (const b of part) next.push([...a, ...b])
        if (next.length > MAX_ALTS) return [[{ kind: "opaque", node, reason: `more than ${MAX_ALTS} render paths` }]]
        acc = next
    }
    return union(node, acc)
}

/** The render evaluator of one program. */
export class RenderEvaluator {
    private readonly checker: ts.TypeChecker
    private scopes = 0

    constructor(
        private readonly cp: CheckProgram,
        private readonly index: ExportIndex,
    ) {
        this.checker = cp.program.getTypeChecker()
    }

    /** The branches a component renders at its root. */
    component(fn: FunctionLike): Alts {
        return this.functionAlts(fn, { bindings: new Map(), scope: ++this.scopes, stack: [fn], via: [], inline: [] })
    }

    /** The exported design-system component a JSX element renders, or null (hosts, internals, third-party). */
    delegateOf(el: ts.JsxOpeningLikeElement): ComponentEntry | null {
        if (isIntrinsicTag(el.tagName)) return null
        const k = this.classify(el)
        return k.kind === "delegate" ? k.target : null
    }

    // --- functions -------------------------------------------------------------------------------

    private functionAlts(fn: FunctionLike, env: Env): Alts {
        const body = fn.body
        if (!body) return [[{ kind: "opaque", node: fn, reason: "renders a function without a body" }]]
        if (!ts.isBlock(body)) return this.expr(body, env)
        const results: Alts[] = []
        const visit = (node: ts.Node): void => {
            if (isFunctionLike(node) || ts.isClassLike(node)) return
            if (ts.isReturnStatement(node)) {
                results.push(node.expression ? this.expr(node.expression, env) : EMPTY)
                return
            }
            ts.forEachChild(node, visit)
        }
        visit(body)
        const last = body.statements[body.statements.length - 1]
        if (!last || !(ts.isReturnStatement(last) || ts.isThrowStatement(last))) results.push(EMPTY)
        return union(fn, ...results)
    }

    // --- expressions -----------------------------------------------------------------------------

    private expr(input: ts.Expression, env: Env): Alts {
        if (env.stack.length > MAX_DEPTH) return [[{ kind: "opaque", node: input, reason: "render nesting is too deep to follow" }]]
        const e = unwrapExpr(input)
        if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) return this.element(e, env)
        if (ts.isJsxFragment(e)) return this.childList(e, e.children, env)
        switch (e.kind) {
            case ts.SyntaxKind.NullKeyword:
            case ts.SyntaxKind.TrueKeyword:
            case ts.SyntaxKind.FalseKeyword:
                return EMPTY
        }
        if (ts.isIdentifier(e)) return e.text === "undefined" ? EMPTY : this.identifier(e, env)
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text === "" ? EMPTY : [[{ kind: "text", node: e }]]
        if (ts.isTemplateExpression(e) || ts.isNumericLiteral(e) || ts.isBigIntLiteral(e)) return [[{ kind: "text", node: e }]]
        if (ts.isVoidExpression(e)) return EMPTY
        if (ts.isConditionalExpression(e)) return union(e, this.expr(e.whenTrue, env), this.expr(e.whenFalse, env))
        if (ts.isBinaryExpression(e)) {
            switch (e.operatorToken.kind) {
                case ts.SyntaxKind.AmpersandAmpersandToken:
                    return union(e, this.expr(e.right, env), EMPTY)
                case ts.SyntaxKind.BarBarToken:
                case ts.SyntaxKind.QuestionQuestionToken:
                    return union(e, this.expr(e.left, env), this.expr(e.right, env))
                case ts.SyntaxKind.CommaToken:
                    return this.expr(e.right, env)
            }
            return [[{ kind: "opaque", node: e, reason: `renders the result of \`${short(e)}\`` }]]
        }
        if (ts.isArrayLiteralExpression(e)) {
            if (e.elements.some(ts.isSpreadElement)) return [[{ kind: "opaque", node: e, reason: "renders a spread array" }]]
            return product(e, e.elements.map((el) => (ts.isOmittedExpression(el) ? EMPTY : this.expr(el, env))))
        }
        if (ts.isPropertyAccessExpression(e)) return this.propertyAccess(e, env)
        if (ts.isCallExpression(e)) return this.call(e, env)
        return [[{ kind: "opaque", node: e, reason: `renders \`${short(e)}\`` }]]
    }

    private propertyAccess(e: ts.PropertyAccessExpression, env: Env): Alts {
        if (ts.isIdentifier(e.expression)) {
            const sym = this.checker.getSymbolAtLocation(e.expression)
            const binding = sym && env.bindings.get(sym)
            if (binding?.kind === "props") return this.propOf(binding, e.name.text, e)
            if (!binding && sym && isParameterSymbol(sym)) return [[{ kind: "opaque", node: e, reason: e.name.text === "children" ? "renders the `children` prop (passed-through content)" : `renders the \`${e.name.text}\` prop` }]]
        }
        return [[{ kind: "opaque", node: e, reason: `renders \`${short(e)}\`` }]]
    }

    private propOf(binding: Extract<Binding, { kind: "props" }>, name: string, node: ts.Node): Alts {
        if (name === "children") return binding.children()
        const attr = jsxAttr(binding.el, name)
        const init = attr?.initializer
        if (init && ts.isJsxExpression(init) && init.expression) return this.expr(init.expression, binding.env)
        if (init && ts.isStringLiteral(init)) return this.expr(init, binding.env)
        return [[{ kind: "opaque", node, reason: `renders the \`${name}\` prop` }]]
    }

    private identifier(id: ts.Identifier, env: Env): Alts {
        // `{ child }` shorthand: the name declares the property; the value is the variable it names
        const sym = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? this.checker.getShorthandAssignmentValueSymbol(id.parent) : this.checker.getSymbolAtLocation(id)
        if (!sym) return [[{ kind: "opaque", node: id, reason: `renders \`${id.text}\`` }]]
        const binding = env.bindings.get(sym)
        if (binding) {
            if (binding.kind === "alts") return binding.alts()
            if (binding.kind === "expr") return this.expr(binding.expr, binding.env)
            return [[{ kind: "opaque", node: id, reason: `renders the props object \`${id.text}\`` }]]
        }
        const decl = valueDeclarationOf(sym)
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.name)) {
            if (env.stack.includes(decl)) return [[{ kind: "opaque", node: id, reason: `\`${id.text}\` refers to itself` }]]
            const inner: Env = { ...env, stack: [...env.stack, decl] }
            const alts = [this.expr(decl.initializer, inner)]
            const list = decl.parent
            if (ts.isVariableDeclarationList(list) && !(list.flags & ts.NodeFlags.Const)) {
                for (const rhs of this.assignmentsTo(sym, decl)) alts.push(this.expr(rhs, inner))
            }
            return union(id, ...alts)
        }
        if (isParameterSymbol(sym)) {
            const name = id.text
            return [[{ kind: "opaque", node: id, reason: name === "children" ? "renders the `children` prop (passed-through content)" : `renders the \`${name}\` prop` }]]
        }
        return [[{ kind: "opaque", node: id, reason: `renders \`${id.text}\`` }]]
    }

    /** Right-hand sides of every `x = …` to a `let`/`var` in its enclosing function (or file). */
    private assignmentsTo(sym: ts.Symbol, decl: ts.VariableDeclaration): ts.Expression[] {
        let scope: ts.Node = decl
        while (scope.parent && !isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent
        const out: ts.Expression[] = []
        const visit = (n: ts.Node): void => {
            if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && this.checker.getSymbolAtLocation(n.left) === sym) out.push(n.right)
            ts.forEachChild(n, visit)
        }
        visit(scope)
        return out
    }

    private call(c: ts.CallExpression, env: Env): Alts {
        const name = calleeName(c)
        const last = name.slice(name.lastIndexOf(".") + 1)
        if (last === "createPortal" && c.arguments[0]) return [[{ kind: "portal", node: c, scope: env.scope, content: this.expr(c.arguments[0], env) }]]
        if ((last === "cloneElement" || name.endsWith("Children.only")) && c.arguments[0]) return this.expr(c.arguments[0], env)
        // `useMemo(() => <x/>, deps)` renders what its factory returns
        if (last === "useMemo" && c.arguments[0]) {
            const factory = unwrapExpr(c.arguments[0])
            if ((ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) && !env.stack.includes(factory)) return this.functionAlts(factory, { ...env, stack: [...env.stack, factory] })
        }
        const callee = unwrapExpr(c.expression)
        if (ts.isPropertyAccessExpression(callee) && LIST_METHODS.has(callee.name.text)) return [[{ kind: "opaque", node: c, reason: `renders a list (\`${short(c)}\`)` }]]
        const sym = ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee) ? resolveAlias(this.checker, this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee)) : undefined
        const decl = valueDeclarationOf(sym)
        let fn: FunctionLike | undefined
        if (decl && isFunctionLike(decl)) fn = decl
        else if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
            const init = unwrapExpr(decl.initializer)
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) fn = init
        }
        if (!fn || !fn.body || inNodeModules(fn.getSourceFile().fileName) || fn.getSourceFile().isDeclarationFile) return [[{ kind: "opaque", node: c, reason: `renders the result of \`${short(c)}\`` }]]
        if (env.stack.includes(fn)) return [[{ kind: "opaque", node: c, reason: `\`${name}()\` calls itself` }]]
        const bindings = new Map(env.bindings)
        fn.parameters.forEach((p, i) => {
            const arg = c.arguments[i]
            if (!arg) return
            if (ts.isIdentifier(p.name)) {
                const psym = this.checker.getSymbolAtLocation(p.name)
                if (psym) bindings.set(psym, { kind: "expr", expr: arg, env })
                return
            }
            // `wrap({ child: <x/> })` into `({ child }) => …`: bind each destructured name to its property
            const obj = unwrapExpr(arg)
            if (!ts.isObjectBindingPattern(p.name) || !ts.isObjectLiteralExpression(obj)) return
            for (const b of p.name.elements) {
                if (b.dotDotDotToken || !ts.isIdentifier(b.name)) continue
                const key = b.propertyName && ts.isIdentifier(b.propertyName) ? b.propertyName.text : b.propertyName ? undefined : b.name.text
                const prop = key === undefined ? undefined : obj.properties.find((q) => !!q.name && ts.isIdentifier(q.name) && q.name.text === key)
                const expr = prop && (ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined)
                const bsym = expr && this.checker.getSymbolAtLocation(b.name)
                if (expr && bsym) bindings.set(bsym, { kind: "expr", expr, env })
            }
        })
        return this.functionAlts(fn, { ...env, bindings, scope: ++this.scopes, stack: [...env.stack, fn] })
    }

    // --- JSX -------------------------------------------------------------------------------------

    private children(node: ts.JsxElement | ts.JsxSelfClosingElement, env: Env): Alts {
        if (ts.isJsxElement(node)) return this.childList(node, node.children, env)
        const attr = jsxAttr(node, "children")
        const init = attr?.initializer
        if (init && ts.isJsxExpression(init) && init.expression) return this.expr(init.expression, env)
        return EMPTY
    }

    private childList(node: ts.Node, children: ts.NodeArray<ts.JsxChild>, env: Env): Alts {
        const parts: Alts[] = []
        for (const child of children) {
            if (ts.isJsxText(child)) {
                if (!child.containsOnlyTriviaWhiteSpaces) parts.push([[{ kind: "text", node: child }]])
            } else if (ts.isJsxExpression(child)) {
                if (child.expression) parts.push(this.expr(child.expression, env))
            } else parts.push(this.expr(child, env))
        }
        return product(node, parts)
    }

    private item<T extends ElementItem>(fields: Omit<T, "scope" | "via" | "inline" | "children">, node: ts.JsxElement | ts.JsxSelfClosingElement, env: Env): T {
        let memo: Alts | undefined
        // asChild props merge onto this element only, never onto its children
        const children = () => (memo ??= this.children(node, env.via.length ? { ...env, via: [] } : env))
        return { ...fields, scope: env.scope, via: env.via, inline: env.inline, children } as T
    }

    private element(node: ts.JsxElement | ts.JsxSelfClosingElement, env: Env): Alts {
        const el = openingOf(node)
        const tag = el.tagName
        if (isIntrinsicTag(tag)) return [[this.item<HostItem>({ kind: "host", el, tag: jsxTagText(tag) }, node, env)]]
        const k = this.classify(el)
        switch (k.kind) {
            case "transparent": {
                // <Suspense fallback={…}> renders the fallback in place of its children while they suspend
                const fallback = /(^|\.)Suspense$/.test(jsxTagText(tag)) ? jsxAttr(el, "fallback")?.initializer : undefined
                if (fallback && ts.isJsxExpression(fallback) && fallback.expression) return union(node, this.children(node, env), this.expr(fallback.expression, env))
                return this.children(node, env)
            }
            case "aschild":
                return this.children(node, { ...env, via: [...env.via, el] })
            case "portal":
                return [[{ kind: "portal", node, scope: env.scope, content: this.children(node, env) }]]
            case "delegate":
                return [[this.item<DelegateItem>({ kind: "delegate", el, target: k.target }, node, env)]]
            case "inline": {
                if (env.stack.includes(k.fn)) return [[{ kind: "opaque", node: el, reason: `<${jsxTagText(tag)}> renders itself` }]]
                const bindings = this.bindProps(k.fn, el, node, env)
                return this.functionAlts(k.fn, { bindings, scope: ++this.scopes, stack: [...env.stack, k.fn], via: env.via, inline: [...env.inline, el] })
            }
            case "libstylist-delegate":
                return [[this.item<LibstylistDelegateItem>({ kind: "libstylist-delegate", el, name: jsxTagText(tag), domless: k.domless }, node, env)]]
            case "foreign":
                return [[this.item<ForeignItem>({ kind: "foreign", el, name: jsxTagText(tag) }, node, env)]]
            case "tagvar":
                return [[this.item<TagVarItem>({ kind: "tagvar", el, name: jsxTagText(tag), members: k.members, typeText: k.typeText }, node, env)]]
            case "opaque":
                return [[{ kind: "opaque", node: el, reason: k.reason }]]
        }
    }

    /** Binds an inlined component's props: `children` to the call site's children, named props to its attributes. */
    private bindProps(fn: FunctionLike, el: ts.JsxOpeningLikeElement, node: ts.JsxElement | ts.JsxSelfClosingElement, env: Env): Map<ts.Symbol, Binding> {
        const bindings = new Map(env.bindings)
        const param = fn.parameters[0]
        if (!param) return bindings
        const children = () => this.children(node, env)
        if (ts.isIdentifier(param.name)) {
            const sym = this.checker.getSymbolAtLocation(param.name)
            if (sym) bindings.set(sym, { kind: "props", el, children, env })
            return bindings
        }
        if (!ts.isObjectBindingPattern(param.name)) return bindings
        for (const b of param.name.elements) {
            if (!ts.isIdentifier(b.name)) continue
            const sym = this.checker.getSymbolAtLocation(b.name)
            if (!sym) continue
            if (b.dotDotDotToken) {
                bindings.set(sym, { kind: "props", el, children, env })
                continue
            }
            const prop = b.propertyName && ts.isIdentifier(b.propertyName) ? b.propertyName.text : b.name.text
            if (prop === "children") {
                bindings.set(sym, { kind: "alts", alts: children })
                continue
            }
            const init = jsxAttr(el, prop)?.initializer
            if (init && ts.isJsxExpression(init) && init.expression) bindings.set(sym, { kind: "expr", expr: init.expression, env })
            else if (init && ts.isStringLiteral(init)) bindings.set(sym, { kind: "expr", expr: init, env })
        }
        return bindings
    }

    private classify(
        el: ts.JsxOpeningLikeElement,
    ):
        | { kind: "transparent" | "aschild" | "portal" | "foreign" }
        | { kind: "libstylist-delegate"; domless: boolean }
        | { kind: "delegate"; target: ComponentEntry }
        | { kind: "inline"; fn: FunctionLike }
        | { kind: "tagvar"; members: string[] | null; typeText: string }
        | { kind: "opaque"; reason: string } {
        const tag = el.tagName
        const text = jsxTagText(tag)
        const sym = resolveAlias(this.checker, this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(tag) ? tag.name : tag))
        const decl = valueDeclarationOf(sym)
        const asChild = isTruthyAttr(jsxAttr(el, "asChild"))
        if (decl) {
            const file = decl.getSourceFile().fileName
            if (decl.getSourceFile().isDeclarationFile || inNodeModules(file)) return this.classifyExternal(tag, sym?.name ?? text, file, decl, asChild)
            if (this.cp.packageOf(file)) {
                const r = resolveSymbolValue(this.checker, sym)
                if (r.kind === "function") {
                    const target = this.index.byImpl.get(r.impl)
                    if (target) return { kind: "delegate", target }
                    return { kind: "inline", fn: r.impl }
                }
                if (r.kind === "external") return this.classifyExternal(tag, r.name, r.file, r.decl, asChild)
                if (ts.isVariableDeclaration(decl) && decl.initializer) {
                    const init = unwrapExpr(decl.initializer)
                    if (ts.isCallExpression(init) && calleeName(init).endsWith("createContext")) return { kind: "transparent" }
                    const inner = resolveExpression(this.checker, decl.initializer)
                    if (inner.kind === "function") return { kind: "inline", fn: inner.impl }
                }
            }
        }
        const t = this.tagType(tag)
        if (t) return t
        if (asChild) return { kind: "aschild" }
        return { kind: "opaque", reason: `renders \`<${text}>\`, which the checker can't resolve` }
    }

    private classifyExternal(
        tag: ts.JsxTagNameExpression,
        name: string,
        file: string,
        decl: ts.Declaration,
        asChild: boolean,
    ): { kind: "transparent" | "aschild" | "portal" | "foreign" } | { kind: "libstylist-delegate"; domless: boolean } | { kind: "opaque"; reason: string } {
        const isReact = /[\\/](@types[\\/]react|react)[\\/]/.test(file)
        if (isReact && REACT_TRANSPARENT.has(name)) return { kind: "transparent" }
        if (name === "Provider") return { kind: "transparent" }
        if (name === "Consumer") return { kind: "opaque", reason: "renders a context consumer (render prop)" }
        if (asChild) return { kind: "aschild" }
        const radix = /@radix-ui[\\/]react-([a-z-]+)/.exec(file)
        if (radix) {
            if (name === "Portal") return { kind: "portal" }
            if ((name === "Root" || name === "Provider") && DOMLESS_RADIX.has(`react-${radix[1]}`)) return { kind: "transparent" }
        }
        // a libstylist library's component (the design system's dist): it forwards stylist props, if it has DOM
        if (declaresLibstylist(file)) return { kind: "libstylist-delegate", domless: this.rendersNoDom(tag, decl) }
        return { kind: "foreign" }
    }

    /**
     * True when a library component is marked `@libstylistRoot none` — on its declaration, or on the
     * function behind its type (`export declare const Loader: typeof LoaderComponent & { Splash }`
     * carries the tag on `LoaderComponent`).
     */
    private rendersNoDom(tag: ts.JsxTagNameExpression, decl: ts.Declaration): boolean {
        if (declaresExemption(decl, "none")) return true
        const signatures = this.checker.getTypeAtLocation(ts.isPropertyAccessExpression(tag) ? tag.name : tag).getCallSignatures()
        return signatures.length > 0 && signatures.every((sig) => !!sig.declaration && declaresExemption(sig.declaration, "none"))
    }

    /** Classifies a tag variable (`<As>`) by its type: string-literal union, unbounded string, or component. */
    private tagType(tag: ts.JsxTagNameExpression): { kind: "tagvar"; members: string[] | null; typeText: string } | { kind: "opaque"; reason: string } | null {
        if (!ts.isIdentifier(tag) && !ts.isPropertyAccessExpression(tag)) return null
        const type = this.checker.getTypeAtLocation(tag)
        const typeText = this.checker.typeToString(type)
        const members: string[] = []
        let stringish = false
        let other = false
        const visit = (t: ts.Type, depth: number): void => {
            if (depth > 4) {
                other = true
                return
            }
            if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never)) return
            if (t.isUnion()) {
                for (const u of t.types) visit(u, depth + 1)
                return
            }
            if (t.isStringLiteral()) {
                members.push(t.value)
                return
            }
            if (t.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) {
                stringish = true
                return
            }
            if (t.flags & ts.TypeFlags.TypeParameter) {
                const c = this.checker.getBaseConstraintOfType(t)
                if (c && c !== t) visit(c, depth + 1)
                else stringish = true
                return
            }
            other = true
        }
        visit(type, 0)
        if (type.flags & ts.TypeFlags.Any) return { kind: "opaque", reason: `renders \`<${jsxTagText(tag)}>\`, typed \`any\`` }
        if (!members.length && !stringish) return other ? { kind: "opaque", reason: `renders a component passed in as \`${jsxTagText(tag)}\`` } : null
        if (other || stringish) return { kind: "tagvar", members: null, typeText }
        return { kind: "tagvar", members: [...new Set(members)].sort(), typeText }
    }
}

function isParameterSymbol(sym: ts.Symbol): boolean {
    const decl = valueDeclarationOf(sym)
    if (!decl) return false
    if (ts.isParameter(decl)) return true
    let n: ts.Node = decl
    while (ts.isBindingElement(n) || ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) n = n.parent
    return ts.isParameter(n)
}

/** A one-line excerpt of an expression for messages. */
export function short(node: ts.Node): string {
    const text = node.getText().replace(/\s+/g, " ")
    return text.length > 48 ? `${text.slice(0, 45)}…` : text
}
