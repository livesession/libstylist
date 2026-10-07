// The libstylist Babel transform (SPEC §5): data-literal branding for runtime cx() calls, markers,
// custom-tag hosts and dev annotations. Parts are plain runtime values (`cn.icon` is the part
// attribute name), so nothing about them is compiled.
import { dirname, relative, sep } from "node:path"

import { types as t, type BabelFile, type ConfigAPI, type NodePath, type PluginObj, type PluginPass } from "@babel/core"

import { DEV_ATTRS, SLOT_PROP, SVG_GEOMETRY_CX, findRepoRoot, type PackageStylistConfig } from "../conventions/index.js"
import { CX_EXPORT, classifyCxCall, normalizePartMaps, partArgs, resolvePartMap, unwrapNode, type AnyNode, type CxEnv, type PartMapRef } from "../core/index.js"
import { isCustomElementName, isGenericTag, isIdentityName } from "../naming/index.js"
import { componentName } from "./component-name.js"
import { DEFAULT_RUNTIME_MODULE, loadRegistry, resolveFileConfig, type DevMode, type LibstylistBabelOptions, type StylistPartRegistry } from "./options.js"
import { HelperImports, type RuntimeHelper } from "./runtime-imports.js"

const DATA_ARIA = /^(data|aria)-/
const NATIVE_ROOT_TAG = /@libstylistRoot\s+native\b/

/** What the transform records in `file.metadata.libstylist`. */
export interface LibstylistFileMetadata {
    changed: boolean
    /** Inline data literals branded with `cxData`. */
    dataLiterals: number
    helpers: RuntimeHelper[]
}

interface FileContext {
    file: BabelFile
    filename: string | undefined
    config: PackageStylistConfig
    nativeRoots: boolean
    registry: StylistPartRegistry | null
    onUnknownPart: "error" | "warn"
    dev: DevMode
    source: string
    imports: HelperImports
    runtime: RuntimeBindings
    env: CxEnv
    /** The scope most of the file's part-map members read (unqualified in `_cxpart`), or null. */
    primaryScope: string | null
    changed: boolean
}

interface ElementKind {
    /** Lowercase/hyphenated intrinsic element (vs a component or dynamic host like `<As>`). */
    host: boolean
    /** Tag name for hosts, last member name for components. */
    name: string
    /** SVG element whose `cx` is geometry. */
    geometry: boolean
    /** Custom element host (`<elo-alert>`). */
    custom: boolean
}

type Attr = t.JSXAttribute | t.JSXSpreadAttribute

function classify(name: t.JSXOpeningElement["name"]): ElementKind {
    if (name.type === "JSXIdentifier") {
        const host = /^[a-z]/.test(name.name) || name.name.includes("-")
        return { host, name: name.name, geometry: host && SVG_GEOMETRY_CX.includes(name.name), custom: host && isCustomElementName(name.name) }
    }
    if (name.type === "JSXMemberExpression") {
        const last = name.property.name
        return { host: false, name: last, geometry: SVG_GEOMETRY_CX.includes(last), custom: false }
    }
    return { host: true, name: `${name.namespace.name}:${name.name.name}`, geometry: false, custom: false }
}

const attrName = (attr: t.JSXAttribute): string | null => (attr.name.type === "JSXIdentifier" ? attr.name.name : null)

/** A value-less (or `""`) attribute — the only form a marker takes. */
function isEmptyValue(value: t.JSXAttribute["value"]): boolean {
    if (value === null || value === undefined) return true
    if (value.type === "StringLiteral") return value.value === ""
    return value.type === "JSXExpressionContainer" && value.expression.type === "StringLiteral" && value.expression.value === ""
}

/** Expressions that can never be boolean, so `cxAttr` would be a no-op. */
function isNonBoolean(e: t.Expression | t.JSXEmptyExpression): boolean {
    return (
        e.type === "JSXEmptyExpression" ||
        e.type === "StringLiteral" ||
        e.type === "NumericLiteral" ||
        e.type === "TemplateLiteral" ||
        e.type === "NullLiteral" ||
        (e.type === "Identifier" && e.name === "undefined")
    )
}

/** Printable ASCII except `"`, `&` and backslash: what a JSX attribute literal carries verbatim (JSX strings have no escapes but decode entities). */
const JSX_VERBATIM = /^[\x20\x21\x23-\x25\x27-\x5b\x5d-\x7e]*$/

/** A JSX attribute value for a generated string: a literal when JSX reads it verbatim, else an expression container. */
const jsxString = (value: string): t.StringLiteral | t.JSXExpressionContainer =>
    JSX_VERBATIM.test(value) ? t.stringLiteral(value) : t.jsxExpressionContainer(t.stringLiteral(value))

function frameError(file: BabelFile, node: t.Node, message: string): Error {
    return (file as unknown as { buildCodeFrameError(node: t.Node, msg: string): Error }).buildCodeFrameError(node, `[libstylist] ${message}`)
}

function processEnvGuard(): t.Expression {
    const nodeEnv = t.memberExpression(t.memberExpression(t.identifier("process"), t.identifier("env")), t.identifier("NODE_ENV"))
    return t.binaryExpression("!==", nodeEnv, t.stringLiteral("production"))
}

function sourcePath(filename: string | undefined, sourceRoot: string | undefined): string {
    if (!filename) return "unknown"
    const root = sourceRoot ?? findRepoRoot(dirname(filename))
    return relative(root, filename).split(sep).join("/")
}

const importedName = (s: t.ImportSpecifier): string => (s.imported.type === "Identifier" ? s.imported.name : s.imported.value)

/** Resolves the file's bindings of the runtime `cx` and of part-map imports (SPEC §5.2). */
class RuntimeBindings {
    constructor(
        private readonly imports: HelperImports,
        private readonly registry: StylistPartRegistry | null,
        private readonly partMaps: LibstylistBabelOptions["partMaps"],
    ) {}

    /** The import declaration a binding visible at `scope` under `name` comes from, with the specifier. */
    private importOf(scope: NodePath["scope"], name: string): { decl: t.ImportDeclaration; spec: t.ImportDeclaration["specifiers"][number] } | null {
        const binding = scope.getBinding(name)
        if (!binding || binding.kind !== "module") return null
        const spec = binding.path.node as t.ImportDeclaration["specifiers"][number]
        const decl = binding.path.parent as t.ImportDeclaration
        if (decl.type !== "ImportDeclaration" || decl.importKind === "type" || decl.importKind === "typeof") return null
        return { decl, spec }
    }

    /** True when `callee` (read at `scope`) is the runtime `cx`: an import of it, or `ns.cx` of a namespace import of the runtime. */
    isCx(scope: NodePath["scope"], callee: AnyNode): boolean {
        const c = unwrapNode(callee)
        if (c.type === "Identifier") {
            const hit = this.importOf(scope, c.name)
            return !!hit && hit.spec.type === "ImportSpecifier" && hit.spec.importKind !== "type" && importedName(hit.spec) === CX_EXPORT && this.imports.isRuntimeModule(hit.decl.source.value)
        }
        if (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier" && c.property.name === CX_EXPORT && c.object.type === "Identifier") {
            const hit = this.importOf(scope, c.object.name)
            return !!hit && hit.spec.type === "ImportNamespaceSpecifier" && this.imports.isRuntimeModule(hit.decl.source.value)
        }
        return false
    }

    /** The part map an identifier (read at `scope`) is bound to. */
    partMap(scope: NodePath["scope"], id: AnyNode): PartMapRef | null {
        if (id.type !== "Identifier") return null
        const hit = this.importOf(scope, id.name)
        if (!hit || hit.spec.type !== "ImportSpecifier" || hit.spec.importKind === "type") return null
        return resolvePartMap(id.name, importedName(hit.spec), hit.decl.source.value, this.registry, this.partMaps)
    }

    env(scope: NodePath["scope"]): CxEnv {
        return { isCx: (callee) => this.isCx(scope, callee), partMap: (id) => this.partMap(scope, id) }
    }
}

class ElementTransform {
    private readonly out: Attr[] = []
    /** The runtime cx() spreads on this element. */
    private readonly cxSpreads = new Set<Attr>()
    private readonly labels: string[] = []
    private hasCx = false
    private hasMarker = false
    private changed = false

    constructor(
        private readonly ctx: FileContext,
        private readonly path: NodePath<t.JSXOpeningElement>,
        private readonly kind: ElementKind,
    ) {}

    run(): void {
        const { node } = this.path
        for (const attr of node.attributes) {
            if (attr.type === "JSXSpreadAttribute") this.spread(attr)
            else this.attribute(attr)
        }
        this.devAnnotations()
        const hoisted = this.hoistKey()
        if (this.changed || hoisted) {
            node.attributes = this.out
            this.ctx.changed = true
        }
    }

    /**
     * Keeps `key` ahead of the element's cx() spreads: a `key` after a spread makes the automatic JSX runtime
     * fall back to `createElement`. Only when no other spread precedes it (then it already did). A cx() result
     * never carries `key`, so the move changes nothing else.
     */
    private hoistKey(): boolean {
        const keyAt = this.out.findIndex((a) => a.type === "JSXAttribute" && attrName(a) === "key")
        const first = this.out.findIndex((a) => this.cxSpreads.has(a))
        if (keyAt < 0 || first < 0 || first > keyAt) return false
        if (this.out.slice(0, keyAt).some((a) => a.type === "JSXSpreadAttribute" && !this.cxSpreads.has(a))) return false
        const [key] = this.out.splice(keyAt, 1)
        this.out.splice(first, 0, key)
        return true
    }

    private error(node: t.Node, message: string): Error {
        return frameError(this.ctx.file, node, message)
    }

    private helper(name: RuntimeHelper): t.Identifier {
        return this.ctx.imports.use(name, this.path.scope)
    }

    private isRuntimeCall(e: t.Node, name: "cx" | "hostProps"): boolean {
        if (e.type !== "CallExpression") return false
        if (name === "cx") return this.ctx.runtime.isCx(this.path.scope, e.callee as AnyNode)
        const local = this.ctx.imports.localName("hostProps", this.path.scope)
        return !!local && e.callee.type === "Identifier" && e.callee.name === local
    }

    private spread(attr: t.JSXSpreadAttribute): void {
        const arg = attr.argument
        if (this.isRuntimeCall(arg, "cx")) {
            this.cxSpreads.add(attr)
            this.cxLabels(arg as t.CallExpression)
            this.out.push(attr)
            return
        }
        if (!this.kind.custom || this.isRuntimeCall(arg, "hostProps")) {
            this.out.push(attr)
            return
        }
        this.out.push(t.jsxSpreadAttribute(t.callExpression(this.helper("hostProps"), [arg])))
        this.changed = true
    }

    /**
     * `_cxpart` labels of a cx() spread: its part members, nested calls included (SPEC §5.5). A part of the
     * file's own sheet (the scope most of its part-map members read) is labelled by name; a part of any
     * other sheet as `scope:part`. A file reading no scope most is labelled against the element's first part.
     */
    private cxLabels(call: t.CallExpression): void {
        this.hasCx = true
        const parts = partArgs(classifyCxCall(call as AnyNode, this.ctx.env))
        const home = this.ctx.primaryScope ?? parts[0]?.map.scope ?? null
        for (const p of parts) {
            const label = p.map.scope && p.map.scope !== home ? `${p.map.scope}:${p.part}` : p.part
            if (!this.labels.includes(label)) this.labels.push(label)
        }
    }

    private attribute(attr: t.JSXAttribute): void {
        const name = attrName(attr)
        if (name && isIdentityName(name, this.ctx.config.prefix) && isEmptyValue(attr.value)) return this.marker(attr)
        if (name && this.kind.custom && DATA_ARIA.test(name)) return this.dataAria(attr)
        this.out.push(attr)
    }

    private marker(attr: t.JSXAttribute): void {
        this.hasMarker = true
        if (this.kind.host && isGenericTag(this.kind.name) && !this.ctx.nativeRoots) {
            const name = attrName(attr)
            throw this.error(attr, `marker "${name}" on <${this.kind.name}> — a generic root is written as the custom tag <${name}> instead (or document a third-party host with @libstylistRoot native)`)
        }
        if (attr.value === null || attr.value === undefined) {
            this.out.push(t.jsxAttribute(attr.name, t.stringLiteral("")))
            this.changed = true
        } else this.out.push(attr)
    }

    /** Boolean `data-*`/`aria-*` on custom tags serialize like they did on the native element (SPEC §5.3). */
    private dataAria(attr: t.JSXAttribute): void {
        const v = attr.value
        if (v === null || v === undefined) {
            this.out.push(t.jsxAttribute(attr.name, t.stringLiteral("true")))
            this.changed = true
            return
        }
        const cxAttrLocal = this.ctx.imports.localName("cxAttr", this.path.scope)
        const callee = v.type === "JSXExpressionContainer" && v.expression.type === "CallExpression" && v.expression.callee.type === "Identifier" ? v.expression.callee.name : null
        if (v.type !== "JSXExpressionContainer" || isNonBoolean(v.expression) || (cxAttrLocal && callee === cxAttrLocal)) {
            this.out.push(attr)
            return
        }
        const e = v.expression as t.Expression
        const value = e.type === "BooleanLiteral" ? t.stringLiteral(String(e.value)) : t.jsxExpressionContainer(t.callExpression(this.helper("cxAttr"), [e]))
        this.out.push(t.jsxAttribute(attr.name, value))
        this.changed = true
    }

    private devAnnotations(): void {
        const { ctx, kind } = this
        const identity = (kind.host && isIdentityName(kind.name, ctx.config.prefix)) || this.hasMarker
        if (ctx.dev === false || (!this.hasCx && !identity)) return
        const entries: Array<[string, string]> = []
        if (this.labels.length) entries.push([DEV_ATTRS.part, this.labels.join(" ")])
        if (identity) {
            const name = componentName(this.path, ctx.filename)
            if (name) entries.push([DEV_ATTRS.component, name])
        }
        const line = this.path.node.loc?.start.line
        entries.push([DEV_ATTRS.source, line ? `${ctx.source}:${line}` : ctx.source])
        if (ctx.dev === "runtime") {
            const obj = t.objectExpression(entries.map(([k, v]) => t.objectProperty(t.isValidIdentifier(k) ? t.identifier(k) : t.stringLiteral(k), t.stringLiteral(v))))
            this.out.push(t.jsxSpreadAttribute(t.logicalExpression("&&", processEnvGuard(), obj)))
        } else {
            for (const [k, v] of entries) this.out.push(t.jsxAttribute(t.jsxIdentifier(k), jsxString(v)))
        }
        this.changed = true
    }
}

/** A part-map member of a cx() call must name a part of its sheet (when the registry is known). */
function validatePart(file: BabelFile, registry: StylistPartRegistry | null, onUnknownPart: "error" | "warn", map: PartMapRef, part: string, at: t.Node): void {
    if (!registry || !map.scope) return
    const entry = Object.prototype.hasOwnProperty.call(registry.scopes, map.scope) ? registry.scopes[map.scope] : undefined
    if (!entry || Object.prototype.hasOwnProperty.call(entry.parts, part)) return
    const err = frameError(file, at, `unknown part "${part}" of ${map.local} (sheet "${map.scope}"; known: ${Object.keys(entry.parts).sort().join(", ") || "none"})`)
    if (onUnknownPart === "warn") console.warn(err.message)
    else throw err
}

/**
 * The removed source API (SPEC §5.2) fails the build instead of rendering a stray attribute: a `cx`
 * JSX attribute (SVG geometry excepted) and a part list in a named slot (`inputCx="field"`).
 */
function assertNoLegacyCx(path: NodePath<t.JSXOpeningElement>, file: BabelFile): void {
    const kind = classify(path.node.name)
    for (const attr of path.node.attributes) {
        if (attr.type !== "JSXAttribute") continue
        const name = attrName(attr)
        if (name === "cx" && !kind.geometry) {
            throw frameError(
                file,
                attr,
                'the cx attribute was removed — spread a cx() call instead: import the sheet\'s part map (import { alert as cn } from "<css package>") and write {...cx(cn.icon)}; `libstylist codemod` converts a file',
            )
        }
        if (name && !kind.host && SLOT_PROP.test(name)) {
            const v = attr.value
            const e = v && v.type === "JSXExpressionContainer" ? unwrapNode(v.expression as AnyNode) : (v as AnyNode | null | undefined)
            if (e && ["StringLiteral", "TemplateLiteral", "ArrayExpression", "ObjectExpression"].includes(e.type)) {
                throw frameError(file, attr, `named slot ${name} takes a cx() value: ${name}={cx(cn.part)} — a part list string is no longer compiled`)
            }
        }
    }
}

function metadataOf(file: BabelFile): { libstylist?: LibstylistFileMetadata } {
    return file.metadata as { libstylist?: LibstylistFileMetadata }
}

/** True when the module already marks itself compiled (`cxCompiled()`, guarded or not, at the top level) — the transform is idempotent. */
function hasCompiledMark(program: NodePath<t.Program>, imports: HelperImports): boolean {
    const local = imports.localName("cxCompiled", program.scope)
    if (!local) return false
    const isMark = (e: t.Expression): boolean =>
        (e.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === local) || (e.type === "LogicalExpression" && e.operator === "&&" && isMark(e.right))
    return program.node.body.some((s) => s.type === "ExpressionStatement" && isMark(s.expression))
}

/** The scope most part-map members of the file read — the file's own sheet, labelled unqualified. */
function primaryScopeOf(program: NodePath<t.Program>, runtime: RuntimeBindings): string | null {
    const counts = new Map<string, number>()
    program.traverse({
        MemberExpression(p) {
            if (p.node.object.type !== "Identifier") return
            const scope = runtime.partMap(p.scope, p.node.object as AnyNode)?.scope
            if (scope) counts.set(scope, (counts.get(scope) ?? 0) + 1)
        },
    })
    let best: string | null = null
    for (const [scope, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = scope
    return best
}

/**
 * The libstylist Babel plugin (SPEC §5). Brands the inline data literals of runtime `cx()` calls
 * (`cxData({…})`), normalizes markers, adapts custom-tag hosts (`hostProps`, `cxAttr`), appends dev
 * annotations and injects the runtime helpers it used. Required wherever components are compiled:
 * without it a data literal is treated as props and renders nothing.
 */
export function libstylistBabel(api: ConfigAPI | undefined, options: LibstylistBabelOptions = {}): PluginObj<PluginPass> {
    ;(api as { assertVersion?: (v: number) => void } | undefined)?.assertVersion?.(7)
    const dev: DevMode = options.dev ?? "runtime"
    const runtimeModule = options.runtimeModule ?? DEFAULT_RUNTIME_MODULE
    // a path is never matched against an import specifier: fail loudly instead of silently seeing no part maps
    const partMaps = normalizePartMaps(options.partMaps, "partMaps")
    return {
        name: "libstylist",
        visitor: {
            Program(program, state) {
                const file = state.file
                const filename = state.filename ?? (file.opts.filename as string | undefined) ?? undefined
                const registry = loadRegistry(options.registry)
                const imports = new HelperImports(program, runtimeModule)
                const runtime = new RuntimeBindings(imports, registry, partMaps)

                // 1. brand every inline object-literal argument of a runtime cx() call (every file, configured or not)
                let dataLiterals = 0
                let cxCalls = 0
                program.traverse({
                    CallExpression(p) {
                        if (!runtime.isCx(p.scope, p.node.callee as AnyNode)) return
                        cxCalls++
                        for (const part of partArgs(classifyCxCall(p.node as AnyNode, runtime.env(p.scope)))) {
                            validatePart(file, registry, options.onUnknownPart ?? "error", part.map, part.part, part.node as t.Node)
                        }
                        p.get("arguments").forEach((arg) => {
                            if (unwrapNode(arg.node as AnyNode).type !== "ObjectExpression") return
                            arg.replaceWith(t.callExpression(imports.use("cxData", p.scope), [arg.node as t.Expression]))
                            dataLiterals++
                        })
                    },
                    JSXOpeningElement: (p) => assertNoLegacyCx(p, file),
                })

                // 2. markers, custom-tag hosts and dev annotations (files of a libstylist package)
                const config = resolveFileConfig(options, filename)
                let changed = dataLiterals > 0
                if (config) {
                    const comments = file.ast.comments ?? []
                    const ctx: FileContext = {
                        file,
                        filename,
                        config,
                        nativeRoots: comments.some((c) => NATIVE_ROOT_TAG.test(c.value)),
                        registry,
                        onUnknownPart: options.onUnknownPart ?? "error",
                        dev,
                        source: sourcePath(filename, options.sourceRoot),
                        imports,
                        runtime,
                        env: runtime.env(program.scope),
                        primaryScope: dev === false ? null : primaryScopeOf(program, runtime),
                        changed: false,
                    }
                    program.traverse({
                        JSXOpeningElement: (p) => {
                            ctx.env = runtime.env(p.scope)
                            new ElementTransform(ctx, p, classify(p.node.name)).run()
                        },
                    })
                    changed ||= ctx.changed
                }
                // 3. a module with cx() calls tells its copy of the runtime it was compiled, when it loads — so the
                //    development heuristic for unbranded data literals never fires on a props object in compiled code
                if (cxCalls > 0 && !hasCompiledMark(program, imports)) {
                    const mark = t.callExpression(imports.use("cxCompiled", program.scope), [])
                    const statement = t.expressionStatement(dev === "runtime" ? t.logicalExpression("&&", processEnvGuard(), mark) : mark)
                    const body = program.get("body")
                    let last = -1
                    while (last + 1 < body.length && body[last + 1].isImportDeclaration()) last++
                    if (last >= 0) body[last].insertAfter(statement)
                    else program.unshiftContainer("body", statement)
                    changed = true
                }
                const helpers = imports.inject()
                if (changed) program.scope.crawl()
                metadataOf(file).libstylist = { changed, dataLiterals, helpers }
            },
        },
    }
}
