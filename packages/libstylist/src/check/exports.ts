// Export discovery: walks each package entry's exported values (re-exports followed) and finds
// the public components — PascalCase functions, arrow functions, memo/forwardRef results — plus
// their compound members (Object.assign(X, {…}), expando `X.Y = …`, plain-object namespaces,
// aliases). A component is named in the namespace of its implementation file (a package's
// `namespaces` directory, else its own). Reports unresolvable or any-typed members (C001), paths that
// form no valid tag (C002) and one implementation exported under several tags (C003).
import ts from "typescript"

import type { PackageStylistConfig } from "../conventions/index.js"
import { splitPath, tagName } from "../naming/index.js"
import { namingOf, type CheckConfig, type CheckPackage } from "./config.js"
import type { CheckProgram } from "./program.js"
import { finding, type Finding } from "./rules.js"
import { hasAnyAssertion, isFunctionLike, lineOf, resolveAlias, symbolOf, unwrapExpr, valueDeclarationOf, type FunctionLike } from "./ts-util.js"

export interface ComponentEntry {
    /**
     * `<namespace>/<Path>` (`core/Modal.Header`) — the key of every per-component finding. When packages
     * sharing a namespace export one path (a duplicate tag, T201), the later package's id is
     * `<namespace>/<Path>@<package dir>` so each keeps findings of its own.
     */
    id: string
    /** The package holding the implementation. */
    pkg: CheckPackage
    /** The namespace of the implementation file (the package's, or its `namespaces` directory's). */
    namespace: string
    /** The naming the tag derives from (that namespace's segment and word). */
    naming: PackageStylistConfig
    /** The entry subpath it was first found under (`"."`). */
    entry: string
    /** Public export path (`["Modal", "Header"]`). */
    path: string[]
    /** Expected identity tag; `null` when the path forms no valid tag (C002). */
    tag: string | null
    impl: FunctionLike
    /** Where findings about the export point (the member declaration or the function). */
    anchor: ts.Node
    /** Nodes whose JSDoc may carry `@libstylistRoot` (the function, its variable, the export). */
    docHosts: ts.Node[]
    /** Other export paths of the same implementation (reported as C003, not analyzed). */
    aliases: string[]
}

export interface ExportIndex {
    /** Canonical components, sorted by id. */
    components: ComponentEntry[]
    /** Implementation → its canonical component. */
    byImpl: Map<FunctionLike, ComponentEntry>
    /** Every exported tag → owning component. */
    byTag: Map<string, ComponentEntry>
    findings: Finding[]
}

/** How a value resolves. */
export type Resolution =
    | { kind: "function"; impl: FunctionLike; anyTyped: boolean; hosts: ts.Node[] }
    | { kind: "namespace"; object: ts.ObjectLiteralExpression; anyTyped: boolean }
    /** A module namespace (`export * as Icons from "./icons"`, `import * as X` re-exported): its exports are members. */
    | { kind: "module"; symbol: ts.Symbol; node: ts.Node }
    | { kind: "class"; node: ts.ClassLikeDeclaration }
    /** Declared in a `.d.ts` or under `node_modules` (a library's component). */
    | { kind: "external"; name: string; file: string; decl: ts.Declaration }
    | { kind: "factory"; callee: string; node: ts.CallExpression; callable: boolean }
    | { kind: "other"; anyTyped: boolean }
    | { kind: "unresolved"; reason: string }

const PASCAL = /^[A-Z](?=[A-Za-z0-9]*[a-z])[A-Za-z0-9]*$/
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef"])
const NON_COMPONENT_FACTORIES = new Set(["createContext", "createElement", "lazy"])

const isPascal = (name: string) => PASCAL.test(name)
const inNodeModules = (file: string) => file.split(/[\\/]/).includes("node_modules")

/** The last identifier of a callee (`React.memo` → `memo`). */
export function calleeName(call: ts.CallExpression): string {
    const c = unwrapExpr(call.expression)
    if (ts.isIdentifier(c)) return c.text
    if (ts.isPropertyAccessExpression(c)) return `${ts.isIdentifier(c.expression) ? `${c.expression.text}.` : ""}${c.name.text}`
    return c.getText()
}

const lastName = (callee: string) => callee.slice(callee.lastIndexOf(".") + 1)

/**
 * Resolves a value symbol to what it is: a function component implementation (through memo,
 * forwardRef, Object.assign bases, casts and aliases), a plain-object namespace, a class, a value
 * from node_modules, a factory result or something else.
 */
export function resolveSymbolValue(checker: ts.TypeChecker, input: ts.Symbol | undefined, seen = new Set<ts.Node>()): Resolution {
    const symbol = resolveAlias(checker, input)
    if (!symbol) return { kind: "unresolved", reason: "its import does not resolve" }
    const decl = valueDeclarationOf(symbol)
    if (!decl) return { kind: "unresolved", reason: `"${symbol.name}" has no declaration` }
    const file = decl.getSourceFile().fileName
    if (decl.getSourceFile().isDeclarationFile || inNodeModules(file)) return { kind: "external", name: symbol.name, file, decl }
    if (seen.has(decl)) return { kind: "unresolved", reason: "it refers to itself" }
    seen.add(decl)
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return { kind: "function", impl: decl, anyTyped: false, hosts: [decl] }
    if (ts.isClassDeclaration(decl)) return { kind: "class", node: decl }
    if (ts.isVariableDeclaration(decl)) {
        if (!decl.initializer) return { kind: "unresolved", reason: `"${symbol.name}" is declared without an initializer` }
        return withHost(resolveExpression(checker, decl.initializer, seen), decl)
    }
    if (ts.isPropertyAssignment(decl)) return withHost(resolveExpression(checker, decl.initializer, seen), decl)
    if (ts.isShorthandPropertyAssignment(decl)) return withHost(resolveSymbolValue(checker, checker.getShorthandAssignmentValueSymbol(decl), seen), decl)
    if (ts.isBinaryExpression(decl)) return withHost(resolveExpression(checker, decl.right, seen), decl.parent)
    if (ts.isPropertyAccessExpression(decl) && ts.isBinaryExpression(decl.parent) && decl.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return withHost(resolveExpression(checker, decl.parent.right, seen), decl.parent.parent)
    }
    if (ts.isSourceFile(decl) || ts.isModuleDeclaration(decl)) return { kind: "module", symbol, node: decl }
    if (ts.isEnumDeclaration(decl)) return { kind: "other", anyTyped: false }
    if (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) return { kind: "unresolved", reason: `"${symbol.name}" is only declared by a type` }
    if (ts.isParameter(decl) || ts.isBindingElement(decl)) return { kind: "unresolved", reason: `"${symbol.name}" is a parameter or destructured binding` }
    return { kind: "unresolved", reason: `"${symbol.name}" is a ${ts.SyntaxKind[decl.kind]}` }
}

function withHost(r: Resolution, host: ts.Node | undefined): Resolution {
    if (r.kind === "function" && host) return { ...r, hosts: [...r.hosts, host] }
    return r
}

/** Resolves an expression the same way as {@link resolveSymbolValue}. */
export function resolveExpression(checker: ts.TypeChecker, expr: ts.Expression, seen = new Set<ts.Node>()): Resolution {
    const anyTyped = hasAnyAssertion(expr)
    const e = unwrapExpr(expr)
    const mark = (r: Resolution): Resolution => (anyTyped && (r.kind === "function" || r.kind === "namespace" || r.kind === "other") ? { ...r, anyTyped: true } : r)
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return mark({ kind: "function", impl: e, anyTyped: false, hosts: [e] })
    if (ts.isClassExpression(e)) return { kind: "class", node: e }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
        if (ts.isIdentifier(e) && e.text === "undefined") return mark({ kind: "other", anyTyped: false })
        return mark(resolveSymbolValue(checker, symbolOf(checker, e), seen))
    }
    if (ts.isObjectLiteralExpression(e)) return mark({ kind: "namespace", object: e, anyTyped: false })
    if (ts.isCallExpression(e)) {
        const callee = calleeName(e)
        const name = lastName(callee)
        if (COMPONENT_WRAPPERS.has(name) && e.arguments[0]) return mark(resolveExpression(checker, e.arguments[0], seen))
        if (callee === "Object.assign" && e.arguments[0]) return mark(resolveExpression(checker, e.arguments[0], seen))
        if (NON_COMPONENT_FACTORIES.has(name)) return mark({ kind: "other", anyTyped: false })
        const callable = checker.getTypeAtLocation(e).getCallSignatures().length > 0
        return { kind: "factory", callee, node: e, callable }
    }
    return mark({ kind: "other", anyTyped: false })
}

/** True when a class extends React's Component/PureComponent. */
function isReactClass(node: ts.ClassLikeDeclaration): boolean {
    return !!node.heritageClauses?.some((h) => h.types.some((t) => /(^|\.)(Pure)?Component$/.test(t.expression.getText())))
}

const isAny = (type: ts.Type) => (type.flags & ts.TypeFlags.Any) !== 0

/** Discovers every public component of every configured package. */
export function discoverExports(config: CheckConfig, cp: CheckProgram): ExportIndex {
    const { checker } = cp
    const findings: Finding[] = []
    /** `<package>\0<namespace>/<Path>` → component: one export path names one component per package */
    const byKey = new Map<string, ComponentEntry>()
    const ids = new Set<string>()
    const allByImpl = new Map<FunctionLike, ComponentEntry[]>()
    const segments = new Set(config.packages.flatMap((p) => [p.segment, ...p.namespaces.map((d) => d.config.segment)]).filter(Boolean))
    /** Namespace of an entry file: the id prefix of findings about exports that resolve to no component. */
    const entryNamespace = (pkg: CheckPackage, entry: string) => namingOf(pkg, pkg.entries[entry]).namespace

    const report = (rule: "C001" | "C002" | "C003", key: string, message: string, node: ts.Node) => findings.push(finding(rule, key, message, cp.rel(node.getSourceFile().fileName), lineOf(node)))

    const addComponent = (entryPkg: CheckPackage, entry: string, path: string[], r: Extract<Resolution, { kind: "function" }>, anchor: ts.Node, exportHost: ts.Node | undefined) => {
        // the implementation's package and namespace name it, whichever entry re-exports it
        const file = r.impl.getSourceFile().fileName
        const pkg = cp.packageOf(file) ?? entryPkg
        const naming = namingOf(pkg, file)
        const plainId = `${naming.namespace}/${path.join(".")}`
        const key = `${pkg.name}\u0000${plainId}`
        const existing = byKey.get(key)
        if (existing) {
            if (existing.impl !== r.impl) report("C003", existing.id, `${path.join(".")} is exported by two implementations (${cp.rel(existing.impl.getSourceFile().fileName)}:${lineOf(existing.impl)} and here) — one export path names one component`, anchor)
            return
        }
        // another package sharing the namespace exports the same path (one tag, T201): an id of its own
        const id = ids.has(plainId) ? `${plainId}@${cp.rel(pkg.dir)}` : plainId
        let tag: string | null = null
        try {
            tag = tagName(naming, path)
            const pieces = tag.slice(naming.prefix.length + 1).split("-")
            if (!naming.segment && pieces.length > 1 && segments.has(pieces[0])) {
                report("C002", id, `${path.join(".")} → <${tag}> reads as a tag of the "${pieces[0]}" segment — rename the compound's parent`, anchor)
                tag = null
            }
        } catch (err) {
            report("C002", id, `${path.join(".")} forms no valid tag: ${(err as Error).message}`, anchor)
        }
        const hosts = [...new Set([...r.hosts, ...(exportHost ? [exportHost] : [])])]
        const entryObj: ComponentEntry = { id, pkg, namespace: naming.namespace, naming, entry, path, tag, impl: r.impl, anchor, docHosts: hosts, aliases: [] }
        byKey.set(key, entryObj)
        ids.add(id)
        const list = allByImpl.get(r.impl) ?? []
        list.push(entryObj)
        allByImpl.set(r.impl, list)
    }

    /** Findings point into design-system source; declarations in node_modules or .d.ts fall back to `fallback`. */
    const ownAnchor = (node: ts.Node | undefined, fallback: ts.Node | null): ts.Node | null =>
        node && !node.getSourceFile().isDeclarationFile && cp.packageOf(node.getSourceFile().fileName) ? node : fallback

    const visitMembers = (pkg: CheckPackage, entry: string, path: string[], type: ts.Type, seen: Set<ts.Node>, parentAnchor: ts.Node | null) => {
        const props = [...checker.getPropertiesOfType(type)].filter((p) => isPascal(p.name)).sort((a, b) => (a.name < b.name ? -1 : 1))
        for (const prop of props) {
            const decl = valueDeclarationOf(prop)
            const anchor = ownAnchor(decl, parentAnchor)
            const memberPath = [...path, prop.name]
            const label = memberPath.join(".")
            const r = resolveSymbolValue(checker, prop, new Set(seen))
            const propType = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getTypeOfSymbol(prop)
            visitValue(pkg, entry, memberPath, r, isAny(propType), anchor, undefined, propType, seen, label)
        }
    }

    const visitValue = (
        pkg: CheckPackage,
        entry: string,
        path: string[],
        r: Resolution,
        typedAny: boolean,
        anchor: ts.Node | null,
        exportHost: ts.Node | undefined,
        type: ts.Type | undefined,
        seen: Set<ts.Node>,
        label: string,
    ) => {
        const at = anchor ?? null
        const any = typedAny || ((r.kind === "function" || r.kind === "namespace" || r.kind === "other") && r.anyTyped)
        const id = `${entryNamespace(pkg, entry)}/${label}`
        if (any && at) report("C001", id, `${label} is typed \`any\` — type the member as a component so props and forwarding are checked`, at)
        switch (r.kind) {
            case "function": {
                if (seen.has(r.impl) && path.length > 1) return
                const next = new Set(seen).add(r.impl)
                addComponent(pkg, entry, path, r, at ?? r.impl, exportHost)
                if (type && !isAny(type)) visitMembers(pkg, entry, path, type, next, at ?? r.impl)
                return
            }
            case "namespace": {
                if (seen.has(r.object)) return
                const next = new Set(seen).add(r.object)
                visitMembers(pkg, entry, path, checker.getTypeAtLocation(r.object), next, at ?? r.object)
                return
            }
            case "module": {
                if (seen.has(r.node)) return
                const next = new Set(seen).add(r.node)
                visitMembers(pkg, entry, path, checker.getTypeOfSymbol(r.symbol), next, at)
                return
            }
            case "class":
                if (isReactClass(r.node) && at) report("C001", id, `${label} is a class component — the checker analyzes function components only; convert it`, at)
                return
            case "external":
                if (at && type && (type.getCallSignatures().length > 0 || /Component$/.test(checker.typeToString(type)))) {
                    report("C001", id, `${label} resolves to ${r.name} from ${cp.rel(r.file)} — a third-party component can't carry a design-system identity; wrap it in a component`, at)
                }
                return
            case "factory":
                if (r.callable && at) report("C001", id, `${label} is created by \`${r.callee}()\` — the checker can't see what it renders; export a plain function component`, at)
                return
            case "unresolved":
                if (at) report("C001", id, `${label} can't be resolved: ${r.reason}`, at)
                return
            case "other":
                return
        }
    }

    for (const pkg of config.packages) {
        for (const [entry, file] of Object.entries(pkg.entries)) {
            const sf = cp.program.getSourceFile(file)
            const moduleSymbol = sf && checker.getSymbolAtLocation(sf)
            if (!sf || !moduleSymbol) continue
            const exports = checker.getExportsOfModule(moduleSymbol).filter((s) => isPascal(s.name)).sort((a, b) => (a.name < b.name ? -1 : 1))
            for (const exp of exports) {
                const target = resolveAlias(checker, exp)
                if (!target || !(target.flags & ts.SymbolFlags.Value)) continue
                const decl = valueDeclarationOf(target)
                const r = resolveSymbolValue(checker, exp)
                const type = decl ? checker.getTypeOfSymbolAtLocation(target, decl) : undefined
                const exportHost = decl && ts.isVariableDeclaration(decl) ? decl : undefined
                const anchor = ownAnchor(decl, exp.declarations?.find((d) => cp.packageOf(d.getSourceFile().fileName)) ?? sf)
                visitValue(pkg, entry, [exp.name], r, !!type && isAny(type), anchor, exportHost, type, new Set(), exp.name)
            }
        }
    }

    // one implementation, several tags → keep the most specific path, report the rest (C003)
    const components: ComponentEntry[] = []
    const byImpl = new Map<FunctionLike, ComponentEntry>()
    for (const [impl, list] of allByImpl) {
        const canonical = [...list].sort((a, b) => b.path.length - a.path.length || (a.id < b.id ? -1 : 1))[0]
        for (const other of list) {
            if (other === canonical) continue
            if (other.tag !== null && other.tag === canonical.tag) continue
            canonical.aliases.push(other.id)
            report("C003", other.id, `${other.path.join(".")} is the same component as ${canonical.path.join(".")}${canonical.tag ? ` (<${canonical.tag}>)` : ""} — one element carries one identity; drop the duplicate export`, other.anchor)
        }
        byImpl.set(impl, canonical)
        components.push(canonical)
    }
    components.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    const byTag = new Map<string, ComponentEntry>()
    for (const c of components) if (c.tag && !byTag.has(c.tag)) byTag.set(c.tag, c)
    return { components, byImpl, byTag, findings }
}

/** True when `node` is (inside) one of the functions in `impls`. */
export function enclosingFunction(node: ts.Node): FunctionLike | undefined {
    let n: ts.Node | undefined = node.parent
    while (n) {
        if (isFunctionLike(n)) return n
        n = n.parent
    }
    return undefined
}

export { isPascal, splitPath }
