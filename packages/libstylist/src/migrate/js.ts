// TS/JS through the migration map. Only string and template contexts are touched — never code:
//
//   rewritten   selector arguments of querySelector / querySelectorAll / closest / matches, jQuery
//               `$()`, Playwright and Cypress locators (page.locator, $, $$, waitForSelector, click,
//               cy.get, …; `>>` chains and `css=` engines), styled-components / emotion / linaria
//               css template literals and object-style selector keys, `animation(-name)` values, and
//               class selectors built from a part map value there (`.${fe.row}` → `[${fe.row}]`)
//   reported    class usages (`className="ls-x"`, classList.add("ls-x"), clsx("ls-x"),
//               getElementsByClassName, toHaveClass) — a part attribute can't be a class; part map
//               values used as classes (`className={fe.row}`: they hold attribute names now); reads of
//               data-component / data-part; props the design system removed (`<Popover className>`,
//               `styled(Button)`) and removed exports; selector-looking strings outside a known
//               selector API
//   collected   the legacy classes / data-component values the file puts on its own elements: a
//               selector naming one styles the app's element too, so it is never rewritten
import { parseSync, traverse, types as t, type NodePath } from "@babel/core"
import postcss from "postcss"

import { analyzeStylesheet } from "./css.js"
import { hasPrefix, isCutShort, unknownHint, type AppliedHooks, type ApiEntry, type ClassEntry, type MapIndex, type PartMapKey } from "./map.js"
import { analyzeSelector, legacyTokens, type Finding, type MigrateOptions, type SelectorRewrite } from "./selector.js"
import { oneLine, PLACEHOLDER_RE, plain, templated, valueTokens, type Edit, type Templated } from "./text.js"

export interface ScriptContext {
    index: MapIndex
    options: MigrateOptions
    /** Legacy hooks the rest of the project puts on its own elements (this file's own are collected here). */
    applied?: AppliedHooks
}

/** A legacy class / data-component value this file puts on its own elements (a literal className, clsx, JSX data-component). */
export interface AppliedHook {
    kind: "class" | "data-component"
    name: string
    /** Offset in the source. */
    start: number
}

export interface ScriptAnalysis {
    edits: Edit[]
    rewrites: SelectorRewrite[]
    findings: Finding[]
    applied: AppliedHook[]
}

/** DOM selector APIs: the first argument is a CSS selector. */
const DOM_SELECTOR_METHODS = new Set(["querySelector", "querySelectorAll", "closest", "matches", "webkitMatchesSelector", "msMatchesSelector"])
/** Playwright / Puppeteer methods whose first argument is always a selector (engines and `>>` chains allowed). */
const LOCATOR_METHODS = new Set(["locator", "$", "$$", "$eval", "$$eval", "waitForSelector", "frameLocator", "dragAndDrop"])
/**
 * Page-level actions (`page.click(selector, …)`). On a Locator the same names take options only, so a
 * string first argument is a selector.
 */
const PAGE_ACTIONS = new Set(["click", "dblclick", "hover", "focus", "check", "uncheck", "tap", "isVisible", "isHidden", "isChecked", "isEnabled", "isDisabled", "isEditable", "textContent", "innerText", "innerHTML", "inputValue"])
/**
 * Page-level actions with a value (`page.fill(selector, value)`). A Locator's `fill(value)` /
 * `press(key)` takes the value first, so the first argument is a selector only when a string value
 * follows it.
 */
const PAGE_VALUE_ACTIONS = new Set(["fill", "type", "press", "selectOption", "setInputFiles", "dispatchEvent"])
/** jQuery / Cypress traversal: a selector only on a `cy.…`, `$(…)`, `jQuery(…)` or `$name` chain. */
const CHAIN_METHODS = new Set(["get", "find", "filter", "children", "parents", "parent", "siblings", "not", "is", "has", "next", "prev", "contains"])
const isChainRoot = (name: string | null) => name !== null && (name === "cy" || name === "jQuery" || name.startsWith("$"))
/** Plain calls whose first argument is a selector. */
const SELECTOR_FUNCTIONS = new Set(["$", "$$", "jQuery", "globalStyle"])
/** Calls that join class names. */
const CLASS_FUNCTIONS = new Set(["clsx", "classnames", "classNames", "cx", "cn", "twMerge", "twJoin", "cva"])
const CLASSLIST_METHODS = new Set(["add", "remove", "toggle", "contains", "replace"])
const CLASS_MATCHERS = new Set(["toHaveClass", "toContainClass"])
/** Attribute reads: the attribute name is the first argument (`toHaveAttribute(name, value)`). */
const ATTRIBUTE_READS = new Set(["getAttribute", "hasAttribute", "getAttributeNode", "toHaveAttribute"])
const isClassAttribute = (name: string) => name === "className" || name === "class" || /ClassName$/.test(name)
/** Tag / callee roots of CSS-in-JS. */
const CSS_IN_JS_ROOTS = new Set(["styled", "css", "keyframes", "createGlobalStyle", "injectGlobal"])
/** Modules whose imports are CSS-in-JS helpers too (`style`, `globalStyle`, `makeStyles`, …). */
const CSS_IN_JS_MODULE = /^(styled-components|@emotion\/|@linaria\/|goober|@stitches\/|@vanilla-extract\/css|@compiled\/react|astroturf|@mui\/styles|@mui\/(material|system)\/styles)/
const ANIMATION_KEYS = /^(-?(webkit|moz|ms|o)-?)?animation(-?name)?$/i

const isName = (key: t.Node, names: Set<string> | ((name: string) => boolean)): string | null => {
    const name = t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : null
    if (name === null) return null
    return (typeof names === "function" ? names(name) : names.has(name)) ? name : null
}

/** `a.b` / `a?.b` with a plain property name. */
const member = (n: t.Node): { object: t.Node; property: string } | null =>
    (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) && !n.computed && t.isIdentifier(n.property) ? { object: n.object, property: n.property.name } : null

/** The leftmost name of `<A.B.C>`. */
const rootJsxName = (n: t.JSXMemberExpression | t.JSXIdentifier | t.JSXNamespacedName): string => (t.isJSXMemberExpression(n) ? rootJsxName(n.object) : t.isJSXIdentifier(n) ? n.name : "")

/** `styled.div.attrs(…)` → `styled`, `css` → `css`. */
function rootName(expr: t.Node): string | null {
    if (t.isIdentifier(expr)) return expr.name
    if (t.isMemberExpression(expr) || t.isOptionalMemberExpression(expr)) return rootName(expr.object)
    if (t.isCallExpression(expr) || t.isOptionalCallExpression(expr)) return rootName(expr.callee)
    if (t.isTSInstantiationExpression?.(expr)) return rootName(expr.expression)
    return null
}

const parserPlugins = (filename: string): Array<"jsx" | "typescript" | "decorators-legacy"> => {
    if (/\.(c|m)?ts$/.test(filename)) return ["typescript", "decorators-legacy"]
    if (/\.tsx$/.test(filename)) return ["jsx", "typescript", "decorators-legacy"]
    return ["jsx", "decorators-legacy"]
}

/** Top-level `>>` segments of a Playwright selector, with the CSS ones marked. */
function locatorSegments(text: string): Array<{ start: number; end: number; css: boolean; xpath?: boolean }> {
    const out: Array<{ start: number; end: number; css: boolean; xpath?: boolean }> = []
    let depth = 0
    let quote: string | null = null
    let segStart = 0
    const push = (end: number) => {
        let s = segStart
        while (s < end && /\s/.test(text[s])) s++
        let e = end
        while (e > s && /\s/.test(text[e - 1])) e--
        const engine = /^(internal:[\w-]+|[a-zA-Z][\w-]*)\s*=/.exec(text.slice(s, e))
        if (engine) {
            if (engine[1] === "css") out.push({ start: s + engine[0].length, end: e, css: true })
            else out.push({ start: s, end: e, css: false, xpath: engine[1] === "xpath" })
        } else {
            const xpath = /^(\/\/|\.\.)/.test(text.slice(s, e))
            out.push({ start: s, end: e, css: !xpath && !/^["']/.test(text.slice(s, e)), xpath })
        }
    }
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (quote) {
            if (ch === "\\") i++
            else if (ch === quote) quote = null
            continue
        }
        if (ch === '"' || ch === "'") quote = ch
        else if (ch === "(" || ch === "[") depth++
        else if (ch === ")" || ch === "]") depth--
        else if (depth === 0 && ch === ">" && text[i + 1] === ">") {
            push(i)
            segStart = i + 2
            i++
        }
    }
    push(text.length)
    return out
}

/** A string literal's text as a Templated: offsets into the value map into the source when the literal has no escapes. */
function literalText(node: t.StringLiteral, code: string): { tm: Templated; exact: boolean } {
    const raw = code.slice(node.start! + 1, node.end! - 1)
    return { tm: plain(node.value, node.start! + 1), exact: raw === node.value }
}

const quoteLike = (code: string, node: t.StringLiteral, value: string): string => {
    const q = code[node.start!] === "'" ? "'" : '"'
    return q + value.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), `\\${q}`).replace(/\n/g, "\\n").replace(/\r/g, "\\r") + q
}

export function analyzeScript(code: string, filename: string, ctx: ScriptContext): ScriptAnalysis {
    const out: ScriptAnalysis = { edits: [], rewrites: [], findings: [], applied: [] }
    const { index, options } = ctx
    const ast = parseSync(code, {
        filename,
        babelrc: false,
        configFile: false,
        sourceType: "unambiguous",
        // recoverable errors (a duplicate import binding, a stray `await`) don't stop the strings being read
        parserOpts: { plugins: parserPlugins(filename), errorRecovery: true },
    })
    if (!ast) return out

    const visited = new Set<t.Node>()
    const finding = (f: Omit<Finding, "start" | "end">, start: number, end = start) => out.findings.push({ ...f, start, end })

    // ── the legacy hooks this file puts on its own elements: a rule selecting them styles the app's element too ──
    collectApplied(ast, index, out.applied)
    const applied: AppliedHooks = { classes: new Map(ctx.applied?.classes), dataComponent: new Map(ctx.applied?.dataComponent) }
    const lineOf = (offset: number) => code.slice(0, offset).split("\n").length
    for (const a of out.applied) (a.kind === "class" ? applied.classes : applied.dataComponent).set(a.name, `line ${lineOf(a.start)}`)

    // ── imports: design-system components (api), part maps and CSS-in-JS helpers ─────────────
    const apiPackages = new Set(index.api.map((e) => e.package))
    const packageOf = (source: string) => [...apiPackages].find((p) => source === p || source.startsWith(`${p}/`))
    const dsImports = new Map<string, { package: string; imported: string }>()
    /** Local name → the part map it names (`import { filterEditor as fe } from "@livesession/eloquentui-css/infinity"`). */
    const partMapImports = new Map<string, { module: string; export: string }>()
    /** Local name → module, for `import * as css from "@livesession/eloquentui-css"`. */
    const partMapNamespaces = new Map<string, string>()
    const cssInJs = new Set<string>(CSS_IN_JS_ROOTS)
    for (const stmt of ast.program.body) {
        if (!t.isImportDeclaration(stmt)) continue
        visited.add(stmt.source)
        const source = stmt.source.value
        if (CSS_IN_JS_MODULE.test(source)) for (const s of stmt.specifiers) cssInJs.add(s.local.name)
        const partMaps = index.partMaps.get(source)
        if (partMaps) {
            for (const spec of stmt.specifiers) {
                if (t.isImportNamespaceSpecifier(spec)) partMapNamespaces.set(spec.local.name, source)
                else if (t.isImportSpecifier(spec)) {
                    const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value
                    if (partMaps.has(imported)) partMapImports.set(spec.local.name, { module: source, export: imported })
                }
            }
        }
        const pkg = packageOf(source)
        if (!pkg) continue
        for (const spec of stmt.specifiers) {
            if (t.isImportNamespaceSpecifier(spec)) dsImports.set(spec.local.name, { package: pkg, imported: "*" })
            else if (t.isImportSpecifier(spec)) {
                const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value
                dsImports.set(spec.local.name, { package: pkg, imported })
                const removed = index.api.find((e) => e.package === pkg && e.removed === `export ${imported}`)
                if (removed) finding({ kind: "todo", old: `import { ${imported} }`, reason: "api", message: `${pkg} no longer exports ${imported}${removed.note ? ` (${removed.note})` : ""}`, suggestion: removed.replacement }, spec.start!, spec.end!)
            }
        }
    }
    const apiFor = (pkg: string, component: string): ApiEntry[] => index.api.filter((e) => e.package === pkg && e.component === component)
    const componentOf = (name: t.Node): { package: string; component: string } | null => {
        const path: string[] = []
        let n: t.Node = name
        while (t.isJSXMemberExpression(n) || t.isMemberExpression(n)) {
            const prop = n.property
            if (!t.isIdentifier(prop) && !t.isJSXIdentifier(prop)) return null
            path.unshift(prop.name)
            n = n.object
        }
        if (!t.isIdentifier(n) && !t.isJSXIdentifier(n)) return null
        const imp = dsImports.get(n.name)
        if (!imp) return null
        return { package: imp.package, component: imp.imported === "*" ? path.join(".") : [imp.imported, ...path].join(".") }
    }

    // ── part maps: `fe.row` held the class ls-filter-editor__row; it holds the attribute name now ──
    interface PartMapUse {
        key: PartMapKey
        /** The expression as written (`fe.row`, `fe["value-input"]`, `css.filterEditor.row`). */
        text: string
        exportName: string
        keyName: string
        /** The key the part is under now, when BASE's key names nothing or another part. */
        renamed: string | null
    }
    const partMapUseOf = (n: t.Node): PartMapUse | null => {
        if (!t.isMemberExpression(n) && !t.isOptionalMemberExpression(n)) return null
        const keyName = !n.computed && t.isIdentifier(n.property) ? n.property.name : n.computed && t.isStringLiteral(n.property) ? n.property.value : null
        if (keyName === null) return null
        let target: { module: string; export: string } | undefined
        if (t.isIdentifier(n.object)) target = partMapImports.get(n.object.name)
        else {
            const inner = member(n.object)
            if (inner && t.isIdentifier(inner.object) && partMapNamespaces.has(inner.object.name)) target = { module: partMapNamespaces.get(inner.object.name)!, export: inner.property }
        }
        const keys = target && index.partMaps.get(target.module)?.get(target.export)
        const key = keys?.get(keyName)
        if (!target || !key) return null
        const now = key.entry.partMap?.key ?? keyName
        return { key, text: code.slice(n.start!, n.end!), exportName: target.export, keyName, renamed: now === keyName ? null : now }
    }
    const partMapBase = (pm: PartMapUse) =>
        `${pm.text} held the class ${pm.key.name}; the part map holds the part attribute name ${pm.key.entry.attr} now${pm.renamed ? ` — under the key ${pm.exportName}["${pm.renamed}"] (${pm.text} ${[...(index.partMaps.get(pm.key.entry.partMap!.module)?.get(pm.exportName)?.values() ?? [])].some((k) => k.entry.partMap?.key === pm.keyName) ? "names another part now" : "is undefined now"})` : ""}`
    /** Member expressions a selector / css template already rewrote (`.${fe.row}` → `[${fe.row}]`). */
    const handledPartMaps = new Set<t.Node>()
    /** The holes of a template that build a class selector from a part map (`.${fe.row}`) — rewritable to `[${fe.row}]`. */
    const partMapHoles = (tpl: t.TemplateLiteral): number[] =>
        tpl.expressions.flatMap((e, i) => {
            if (!tpl.quasis[i].value.raw.endsWith(".")) return []
            const pm = partMapUseOf(e)
            return pm && !pm.renamed && pm.key.entry.attr ? [i] : []
        })
    /** The text with those holes' placeholders turned into a same-length class name, so the selector still parses. */
    const maskHoles = (text: string, holes: number[]): string => {
        let masked = text
        for (const i of holes) {
            const ph = `/*__elo_expr_${i}__*/`
            const at = masked.indexOf(ph)
            if (at >= 0) masked = masked.slice(0, at) + `__elo_pm_${i}`.padEnd(ph.length, "_") + masked.slice(at + ph.length)
        }
        return masked
    }
    /** `.${fe.row}` → `[${fe.row}]`: only the template's text changes, never the expression. */
    const rewriteHole = (tpl: t.TemplateLiteral, i: number) => {
        const dot = tpl.quasis[i].end! - 1
        const after = tpl.quasis[i + 1].start!
        const expr = tpl.expressions[i]
        const text = code.slice(expr.start!, expr.end!)
        out.edits.push({ start: dot, end: dot + 1, text: "[" }, { start: after, end: after, text: "]" })
        out.rewrites.push({ start: dot, end: after, old: `.\${${text}}`, new: `[\${${text}}]`, notes: [`${text} holds the part attribute name now: an attribute selector, same specificity`] })
        handledPartMaps.add(expr)
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────
    /**
     * A report string with the template's placeholders shown as the expressions they stand for — a
     * masked part map hole (`.${fe.row}`) as written (`old`) or as it is rewritten (`new`: `[${fe.row}]`).
     */
    const shownWith = (exprs: readonly t.Node[]) => (s: string, rewritten = false) => {
        const expr = (i: string) => {
            const e = exprs[Number(i)]
            return e ? `\${${code.slice(e.start!, e.end!)}}` : "${…}"
        }
        return s.replace(/\.__elo_pm_(\d+)_*/g, (_, i: string) => (rewritten ? `[${expr(i)}]` : `.${expr(i)}`)).replace(PLACEHOLDER_RE, (ph) => expr(/\d+/.exec(ph)![0]))
    }
    const mapAnalysis = (tm: Templated, a: { edits: Edit[]; rewrites: SelectorRewrite[]; findings: Finding[] }, what: string, literal?: { node: t.StringLiteral; exact: boolean }, exprs: readonly t.Node[] = []) => {
        const shown = shownWith(exprs)
        for (const f of a.findings) out.findings.push({ ...f, old: shown(f.old), ...(f.suggestion ? { suggestion: shown(f.suggestion, true) } : {}), start: tm.offsetOf(f.start), end: tm.offsetOf(Math.max(f.start, f.end - 1)) + 1 })
        if (a.edits.length === 0) return
        if (literal && !literal.exact) {
            // escapes in the literal: rewrite it whole
            let value = literal.node.value
            for (const e of [...a.edits].sort((x, y) => y.start - x.start)) value = value.slice(0, e.start) + e.text + value.slice(e.end)
            const text = quoteLike(code, literal.node, value)
            out.edits.push({ start: literal.node.start!, end: literal.node.end!, text })
            for (const r of a.rewrites) out.rewrites.push({ ...r, start: literal.node.start!, end: literal.node.end! })
            return
        }
        const mapped = a.edits.map((e) => ({ e, r: tm.toSource(e.start, e.end) }))
        if (mapped.some((m) => !m.r)) {
            for (const r of a.rewrites) finding({ kind: "todo", old: shown(r.old), reason: "dynamic", message: `${what}: the rewrite crosses an interpolation — apply it by hand`, suggestion: shown(r.new, true) }, tm.offsetOf(r.start))
            return
        }
        for (const { e, r } of mapped) out.edits.push({ start: r!.start, end: r!.end, text: e.text })
        for (const r of a.rewrites) out.rewrites.push({ ...r, old: shown(r.old), new: shown(r.new, true), start: tm.offsetOf(r.start), end: tm.offsetOf(Math.max(r.start, r.end - 1)) + 1 })
    }

    /** A selector argument: a string literal or a template literal. */
    const selectorArgument = (node: t.Node | undefined, locator: boolean) => {
        if (!node) return
        let tm: Templated
        let literal: { node: t.StringLiteral; exact: boolean } | undefined
        let holes: number[] = []
        if (t.isStringLiteral(node)) {
            const lt = literalText(node, code)
            tm = lt.tm
            literal = { node, exact: lt.exact }
        } else if (t.isTemplateLiteral(node)) {
            tm = templated(
                node.quasis.map((q) => ({ raw: q.value.raw, start: q.start! })),
                node.expressions.map((e) => e.start!),
            )
            holes = partMapHoles(node)
        } else return
        visited.add(node)
        const segments: Array<{ start: number; end: number; css: boolean; xpath?: boolean }> = locator ? locatorSegments(tm.text) : [{ start: 0, end: tm.text.length, css: true }]
        const merged = { edits: [] as Edit[], rewrites: [] as SelectorRewrite[], findings: [] as Finding[] }
        const masked = maskHoles(tm.text, holes)
        for (const seg of segments) {
            const text = masked.slice(seg.start, seg.end)
            if (!seg.css) {
                if (!seg.xpath) continue
                for (const tok of legacyTokens(text, index)) {
                    if (index.classes.has(tok.value)) merged.findings.push({ kind: "todo", start: seg.start + tok.start, end: seg.start + tok.end, old: tok.value, reason: "selector-string", message: "a legacy class in an XPath locator — rewrite it by hand (the part attribute is an attribute: @_cxclass_…)", suggestion: index.classes.get(tok.value)!.selector })
                }
                continue
            }
            const a = analyzeSelector(text, { index, options, applied })
            merged.edits.push(...a.edits.map((e) => ({ ...e, start: e.start + seg.start, end: e.end + seg.start })))
            merged.rewrites.push(...a.rewrites.map((r) => ({ ...r, start: r.start + seg.start, end: r.end + seg.start })))
            merged.findings.push(...a.findings.map((f) => ({ ...f, start: f.start + seg.start, end: f.end + seg.start })))
        }
        mapAnalysis(tm, merged, "selector", literal, t.isTemplateLiteral(node) ? node.expressions : [])
        if (t.isTemplateLiteral(node)) {
            // a hole inside a CSS segment of the locator (not text= / xpath=) builds a class selector
            const cssAt = (offset: number) => segments.some((s) => s.css && s.start <= offset && offset < s.end)
            for (const i of holes) if (cssAt(masked.indexOf(`__elo_pm_${i}`))) rewriteHole(node, i)
        }
    }

    /** The CSS of a styled-components / emotion template. */
    const cssTemplate = (tpl: t.TemplateLiteral) => {
        for (const q of tpl.quasis) visited.add(q)
        visited.add(tpl)
        const tm = templated(
            tpl.quasis.map((q) => ({ raw: q.value.raw, start: q.start! })),
            tpl.expressions.map((e) => e.start!),
        )
        const holes = partMapHoles(tpl)
        const text = maskHoles(tm.text, holes)
        let root: postcss.Root
        try {
            root = postcss.parse(text)
        } catch {
            for (const tok of legacyTokens(text, index)) {
                if (index.classes.has(tok.value)) finding({ kind: "todo", old: tok.value, reason: "unparseable", message: "the CSS template does not parse with placeholders for its interpolations — rewrite by hand", suggestion: index.classes.get(tok.value)!.selector }, tm.offsetOf(tok.start))
            }
            return
        }
        mapAnalysis(tm, analyzeStylesheet(text, root, { index, options, syntax: "css", applied }), "css template", undefined, tpl.expressions)
        for (const i of holes) rewriteHole(tpl, i)
    }

    /** `{ "& .ls-x": { … } }` object styles: keys are selectors. */
    const objectStyles = (obj: t.ObjectExpression) => {
        for (const prop of obj.properties) {
            if (!t.isObjectProperty(prop)) continue
            const key = prop.key
            if (t.isStringLiteral(key) && /[&.[:#*>+~]/.test(key.value)) selectorArgument(key, false)
            if (t.isObjectExpression(prop.value)) objectStyles(prop.value)
        }
    }

    /** Class names inside an expression (a className value, clsx args): reported, never rewritten. */
    const classStrings = (root: t.Node | null | undefined, how: "class" | "contains" | "by-class-name", path?: NodePath) => {
        if (!root) return
        const visit = (node: t.Node) => {
            if (visited.has(node)) return
            if (t.isStringLiteral(node)) {
                visited.add(node)
                classTokens(node.value, node.start! + 1, how)
            } else if (t.isTemplateLiteral(node)) {
                visited.add(node)
                node.quasis.forEach((q, i) => classTokens(q.value.raw, q.start!, how, { before: i > 0, after: i < node.quasis.length - 1 }))
            }
        }
        visit(root)
        if (path) {
            path.traverse({
                noScope: true,
                StringLiteral: (p) => visit(p.node),
                TemplateLiteral: (p) => visit(p.node),
            })
        } else t.traverseFast(root, (n) => (n === root ? undefined : visit(n)))
    }

    const isPartial = (token: string) => isCutShort(index, token)
    const dynamicName = (token: string, at: number) =>
        finding({ kind: "todo", old: token, reason: "dynamic", message: "a legacy class name built from pieces — list the successors of the names it can produce by hand" }, at, at + token.length)

    const classTokens = (text: string, start: number, how: "class" | "contains" | "by-class-name", joined: { before?: boolean; after?: boolean } = {}) => {
        for (const m of text.matchAll(/[^\s]+/g)) {
            const token = m[0]
            const at = start + m.index!
            const touches = (joined.before && m.index === 0) || (joined.after && m.index! + token.length === text.length)
            if (hasPrefix(token, index.classPrefixes) || (index.classPrefixes.includes(token) && touches)) {
                const entry = index.classes.get(token)
                if (touches || (!entry && isPartial(token))) dynamicName(token, at)
                else if (!entry) finding({ kind: "unknown", old: token, reason: "unknown", message: `not in the migration map${unknownHint(index, token)}` }, at, at + token.length)
                else finding(classUsage(token, entry, how), at, at + token.length)
            } else if (options.literals === "all" && index.literals.has(token)) {
                const lit = index.literals.get(token)!
                finding({ kind: "todo", old: token, reason: "literal", message: `a literal hook used as a class — ${lit.kind}: ${lit.replacement}`, ...(lit.selector ? { suggestion: lit.selector } : {}) }, at, at + token.length)
            }
        }
    }

    const classUsage = (token: string, entry: ClassEntry, how: "class" | "contains" | "by-class-name"): Omit<Finding, "start" | "end"> => {
        if (entry.kind === "removed" || !entry.attr || !entry.selector) return { kind: "todo", old: token, reason: "class-usage", message: `removed — ${entry.note ?? "no successor"}` }
        const part = `${entry.scope}.${entry.part}`
        if (how === "contains") return { kind: "todo", old: token, reason: "class-usage", message: `the design system marks ${part} with the attribute ${entry.attr}, not a class`, suggestion: `hasAttribute("${entry.attr}") / toHaveAttribute("${entry.attr}")` }
        if (how === "by-class-name") return { kind: "todo", old: token, reason: "class-usage", message: `no class to look up any more: ${part} is the attribute ${entry.attr}`, suggestion: `querySelectorAll("${entry.selector}")` }
        return {
            kind: "todo",
            old: token,
            reason: "class-usage",
            message: `a class can't carry ${part} any more (it is the attribute ${entry.attr}): render the design-system component${entry.component ? ` (${entry.component})` : ""} — with libstylist, {...cx(yourMap.part)} on it for your own styles — or select ${entry.selector}`,
            suggestion: entry.selector,
        }
    }

    /** Keyframes names in an `animation` value string. */
    const animationValue = (node: t.Node) => {
        if (!t.isStringLiteral(node)) return
        visited.add(node)
        const { exact } = literalText(node, code)
        const edits: Edit[] = []
        for (const token of valueTokens(node.value)) {
            const renamed = !token.fn && index.keyframes.get(token.value)
            if (renamed) edits.push({ start: token.start, end: token.end, text: renamed })
        }
        if (edits.length === 0) return
        let value = node.value
        for (const e of [...edits].sort((a, b) => b.start - a.start)) value = value.slice(0, e.start) + e.text + value.slice(e.end)
        if (exact) out.edits.push(...edits.map((e) => ({ start: node.start! + 1 + e.start, end: node.start! + 1 + e.end, text: e.text })))
        else out.edits.push({ start: node.start!, end: node.end!, text: quoteLike(code, node, value) })
        out.rewrites.push({ start: node.start!, end: node.end!, old: oneLine(code.slice(node.start!, node.end!)), new: oneLine(quoteLike(code, node, value)), notes: [] })
    }

    /** The message for a read of an attribute the design system no longer renders. */
    const attributeGone = (attr: string) =>
        attr === "data-component"
            ? "the design system no longer renders data-component — tell components apart by their identity (element.matches() with the tag / marker the map lists for the value)"
            : `the design system no longer renders ${attr} on its parts — test the part attribute instead (element.matches() / hasAttribute() with the map's successor)`

    /** `getAttribute("data-component")`, `toHaveAttribute("data-part", "list")`: attributes the design system no longer renders. */
    const attributeRead = (method: string, nameNode: t.StringLiteral, valueNode: t.Node | undefined) => {
        const attr = nameNode.value.toLowerCase()
        if (attr !== "data-component" && !index.hookAttributes.has(attr)) return
        visited.add(nameNode)
        const value = t.isStringLiteral(valueNode) ? valueNode.value : null
        let suggestion: string | undefined
        if (value !== null) {
            if (attr === "data-component") suggestion = index.dataComponent.get(value)?.selector
            else {
                const c = index.dataPart.get(`[${attr}=${JSON.stringify(value)}]`) ?? []
                suggestion = c.length === 1 ? c[0].selector : c.length > 1 ? `:is(${c.map((x) => x.selector).join(", ")})` : undefined
            }
        }
        finding(
            { kind: "todo", old: `${method}("${nameNode.value}"${value !== null ? `, "${value}"` : ""})`, reason: "attribute-read", message: attributeGone(attr), ...(suggestion ? { suggestion } : {}) },
            nameNode.start!,
            nameNode.end!,
        )
    }

    /** `el.dataset.component`, `el.dataset.part`. */
    const datasetRead = (node: t.MemberExpression | t.OptionalMemberExpression) => {
        const prop = !node.computed && t.isIdentifier(node.property) ? node.property.name : node.computed && t.isStringLiteral(node.property) ? node.property.value : null
        if (!prop || member(node.object)?.property !== "dataset") return
        const attr = `data-${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
        if (attr !== "data-component" && !index.hookAttributes.has(attr)) return
        finding({ kind: "todo", old: code.slice(node.start!, node.end!), reason: "attribute-read", message: attributeGone(attr) }, node.start!, node.end!)
    }

    /** Where a value lands: a class (className, clsx, classList.add), a class test, or nowhere known. */
    const classContextOf = (path: NodePath): "class" | "contains" | "matcher" | "by-class-name" | null => {
        let from: t.Node = path.node
        for (let p: NodePath | null = path.parentPath; p; from = p.node, p = p.parentPath) {
            const n = p.node
            if (t.isStatement(n) || t.isFunction(n) || t.isJSXElement(n) || t.isJSXFragment(n) || t.isVariableDeclarator(n) || t.isClass(n)) return null
            if (t.isJSXAttribute(n)) return t.isJSXIdentifier(n.name) && isClassAttribute(n.name.name) ? "class" : null
            if (t.isObjectProperty(n)) return n.value === from && isName(n.key, isClassAttribute) ? "class" : null
            if (t.isAssignmentExpression(n) && n.right === from && t.isMemberExpression(n.left) && isName(n.left.property, new Set(["className"]))) return "class"
            if (t.isCallExpression(n) || t.isOptionalCallExpression(n)) {
                if (t.isIdentifier(n.callee) && CLASS_FUNCTIONS.has(n.callee.name)) return "class"
                const m = member(n.callee)
                if (m) {
                    if (member(m.object)?.property === "classList" && CLASSLIST_METHODS.has(m.property)) return m.property === "contains" ? "contains" : "class"
                    if (CLASS_MATCHERS.has(m.property)) return "matcher"
                    if (m.property === "getElementsByClassName") return "by-class-name"
                    if (m.property === "setAttribute" && t.isStringLiteral(n.arguments[0]) && n.arguments[0].value === "class") return "class"
                }
            }
        }
        return null
    }

    /**
     * Already used as the attribute name it is now: `[${fe.row}]`, `"[" + fe.row + "]"`, `{ [fe.row]: "" }`,
     * `el.hasAttribute(fe.row)` — nothing to report (and a second run over rewritten code stays quiet).
     */
    const ATTRIBUTE_METHODS = new Set(["hasAttribute", "getAttribute", "setAttribute", "removeAttribute", "toggleAttribute", "toHaveAttribute"])
    const usedAsAttribute = (path: NodePath<t.MemberExpression | t.OptionalMemberExpression>): boolean => {
        const node = path.node
        const parent = path.parentPath?.node
        if (!parent) return false
        if (t.isTemplateLiteral(parent)) {
            const i = parent.expressions.indexOf(node)
            return i >= 0 && /\[\s*$/.test(parent.quasis[i].value.raw) && /^\s*[\]~|^$*=]/.test(parent.quasis[i + 1].value.raw)
        }
        if (t.isObjectProperty(parent) && parent.computed && parent.key === node) return true
        if ((t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) && parent.arguments[0] === node) {
            const m = member(parent.callee)
            return Boolean(m && ATTRIBUTE_METHODS.has(m.property))
        }
        if (t.isBinaryExpression(parent, { operator: "+" }) && parent.right === node) {
            const left = parent.left
            const before = t.isStringLiteral(left) ? left.value : t.isBinaryExpression(left) && t.isStringLiteral(left.right) ? left.right.value : null
            return Boolean(before && /\[\s*$/.test(before))
        }
        return false
    }

    /** A part map value (`fe.row`): it held a class, it holds the part attribute name now. */
    const partMapUse = (path: NodePath<t.MemberExpression | t.OptionalMemberExpression>) => {
        const node = path.node
        if (handledPartMaps.has(node)) return
        const pm = partMapUseOf(node)
        if (!pm) return
        handledPartMaps.add(node)
        if (usedAsAttribute(path) && !pm.renamed) return
        const report = (old: string, message: string, suggestion?: string) =>
            finding({ kind: "todo", old, reason: "part-map", message: `${partMapBase(pm)} — ${message}`, ...(suggestion ? { suggestion } : {}) }, node.start!, node.end!)
        // a class selector built from it: `.${fe.row}` outside a known selector API, "." + fe.row
        const parent = path.parentPath?.node
        if (parent && t.isTemplateLiteral(parent)) {
            const i = parent.expressions.indexOf(node)
            if (i >= 0 && parent.quasis[i].value.raw.endsWith(".")) return report(`.\${${pm.text}}`, "a class selector no longer matches it: select the attribute", pm.renamed ? undefined : `[\${${pm.text}}]`)
        }
        if (parent && t.isBinaryExpression(parent, { operator: "+" }) && parent.right === node) {
            const left = parent.left
            const before = t.isStringLiteral(left) ? left.value : t.isTemplateLiteral(left) ? left.quasis[left.quasis.length - 1].value.raw : null
            if (before?.endsWith(".")) return report(`"." + ${pm.text}`, "a class selector no longer matches it: select the attribute", pm.renamed ? undefined : `"[" + ${pm.text} + "]"`)
        }
        const how = classContextOf(path)
        const component = pm.key.entry.component
        if (how === "class") return report(pm.text, `a class can't carry it: set it on the element as an attribute ({...{ [${pm.text}]: "" }}) or render the design-system component${component ? ` (${component})` : ""}`)
        if (how === "contains" || how === "matcher") return report(pm.text, "no element carries it as a class: test the attribute", how === "contains" ? `hasAttribute(${pm.text})` : `toHaveAttribute(${pm.text})`)
        if (how === "by-class-name") return report(pm.text, "no element carries it as a class: select the attribute", `querySelectorAll(\`[\${${pm.text}}]\`)`)
        report(pm.text, "check how it is used here: as a class, or in a class selector, it matches nothing now")
    }

    // ── pass 1: the known contexts ───────────────────────────────────────────────────────────
    traverse(ast, {
        noScope: true,
        ExportNamedDeclaration(path) {
            if (path.node.source) visited.add(path.node.source)
        },
        ExportAllDeclaration(path) {
            visited.add(path.node.source)
        },
        TaggedTemplateExpression(path) {
            const root = rootName(path.node.tag)
            if (root && cssInJs.has(root)) cssTemplate(path.node.quasi)
        },
        "CallExpression|OptionalCallExpression"(p) {
            const path = p as NodePath<t.CallExpression | t.OptionalCallExpression>
            const { callee, arguments: args } = path.node
            if ((t.isIdentifier(callee) && callee.name === "require") || t.isImport(callee)) {
                if (args[0]) visited.add(args[0])
                return
            }
            if (t.isIdentifier(callee)) {
                if (SELECTOR_FUNCTIONS.has(callee.name)) selectorArgument(args[0], true)
                else if (CLASS_FUNCTIONS.has(callee.name)) for (const [i, a] of args.entries()) classStrings(a, "class", path.get(`arguments.${i}`) as NodePath)
            }
            const calleeMember = member(callee)
            if (calleeMember) {
                const method = calleeMember.property
                const onClassList = member(calleeMember.object)?.property === "classList"
                if (onClassList && CLASSLIST_METHODS.has(method)) {
                    for (const [i, a] of args.entries()) classStrings(a, method === "contains" ? "contains" : "class", path.get(`arguments.${i}`) as NodePath)
                } else if (method === "getElementsByClassName") classStrings(args[0], "by-class-name")
                else if (CLASS_MATCHERS.has(method)) for (const a of args) classStrings(a, "contains")
                else if (method === "setAttribute" && t.isStringLiteral(args[0]) && args[0].value === "class") classStrings(args[1], "class")
                else if (ATTRIBUTE_READS.has(method) && t.isStringLiteral(args[0])) attributeRead(method, args[0], args[1])
                else if (DOM_SELECTOR_METHODS.has(method)) selectorArgument(args[0], false)
                else if (LOCATOR_METHODS.has(method)) {
                    selectorArgument(args[0], true)
                    if (method === "dragAndDrop") selectorArgument(args[1], true)
                } else if (PAGE_ACTIONS.has(method)) selectorArgument(args[0], true)
                else if (PAGE_VALUE_ACTIONS.has(method) && args.length >= 2 && !t.isObjectExpression(args[1])) selectorArgument(args[0], true)
                else if (CHAIN_METHODS.has(method) && isChainRoot(rootName(calleeMember.object)) && !(method === "contains" && args.length < 2)) selectorArgument(args[0], true)
            }
            const root = rootName(callee)
            if (root && cssInJs.has(root)) for (const a of args) if (t.isObjectExpression(a)) objectStyles(a)
            styledOf(path.node)
        },
        JSXAttribute(path) {
            const name = t.isJSXIdentifier(path.node.name) ? path.node.name.name : null
            if (!name) return
            const value = path.node.value
            if (name === "className" || name === "class" || /ClassName$/.test(name)) {
                if (t.isStringLiteral(value)) classStrings(value, "class")
                else if (t.isJSXExpressionContainer(value)) classStrings(value.expression, "class", path.get("value") as NodePath)
                return
            }
            if ((name === "sx" || name === "css") && t.isJSXExpressionContainer(value) && t.isObjectExpression(value.expression)) objectStyles(value.expression)
        },
        JSXOpeningElement(path) {
            const target = componentOf(path.node.name)
            if (!target) return
            const ns = t.isJSXMemberExpression(path.node.name) && dsImports.get(rootJsxName(path.node.name))?.imported === "*"
            const removedExport = ns && index.api.find((e) => e.package === target.package && e.removed === `export ${target.component}`)
            if (removedExport) finding({ kind: "todo", old: code.slice(path.node.name.start!, path.node.name.end!), reason: "api", message: `${target.package} no longer exports ${target.component}`, suggestion: removedExport.replacement }, path.node.name.start!, path.node.name.end!)
            const entries = apiFor(target.package, target.component)
            if (entries.length === 0) return
            for (const attr of path.node.attributes) {
                if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name)) continue
                const entry = entries.find((e) => e.removed === (attr.name as t.JSXIdentifier).name)
                if (!entry) continue
                finding(
                    {
                        kind: "todo",
                        old: `<${target.component} ${entry.removed}>`,
                        reason: "api",
                        message: `${target.component} no longer accepts ${entry.removed}: ${entry.replacement}${entry.pending ? ` (pending ${entry.pending})` : ""}`,
                        ...(entry.identitySelector ? { suggestion: entry.identitySelector } : {}),
                    },
                    attr.start!,
                    attr.end!,
                )
            }
        },
        "MemberExpression|OptionalMemberExpression"(p) {
            const path = p as NodePath<t.MemberExpression | t.OptionalMemberExpression>
            partMapUse(path)
            datasetRead(path.node)
            const obj = path.node.object
            if (!t.isIdentifier(obj) || dsImports.get(obj.name)?.imported !== "*" || !t.isIdentifier(path.node.property) || path.node.computed) return
            const pkg = dsImports.get(obj.name)!.package
            const removed = index.api.find((e) => e.package === pkg && e.removed === `export ${(path.node.property as t.Identifier).name}`)
            if (removed) finding({ kind: "todo", old: code.slice(path.node.start!, path.node.end!), reason: "api", message: `${pkg} no longer exports ${(path.node.property as t.Identifier).name}`, suggestion: removed.replacement }, path.node.start!, path.node.end!)
        },
        ObjectProperty(path) {
            if (isName(path.node.key, (n) => ANIMATION_KEYS.test(n))) animationValue(path.node.value)
        },
        AssignmentExpression(path) {
            const left = path.node.left
            if (!t.isMemberExpression(left) || left.computed) return
            if (isName(left.property, (n) => ANIMATION_KEYS.test(n))) animationValue(path.node.right)
            else if (isName(left.property, new Set(["className"]))) classStrings(path.node.right, "class", path.get("right") as NodePath)
        },
    })

    function styledOf(call: t.CallExpression | t.OptionalCallExpression) {
        if (!t.isIdentifier(call.callee) || !cssInJs.has(call.callee.name) || call.callee.name !== "styled" || call.arguments.length === 0) return
        const target = componentOf(call.arguments[0])
        if (!target) return
        const entry = apiFor(target.package, target.component).find((e) => e.removed === "className")
        if (!entry) return
        finding(
            {
                kind: "todo",
                old: `styled(${target.component})`,
                reason: "api",
                message: `styled() styles a component through className, which ${target.component} no longer accepts: ${entry.replacement}`,
                ...(entry.identitySelector ? { suggestion: `a wrapper element, or select ${entry.identitySelector}` } : {}),
            },
            call.start!,
            call.end!,
        )
    }

    // ── pass 2: every other string that names a legacy class ───────────────────────────────────
    traverse(ast, {
        noScope: true,
        StringLiteral(path) {
            if (visited.has(path.node) || path.parentPath.isImportDeclaration() || path.parentPath.isTSLiteralType?.()) return
            const node = path.node
            looseString(node.value, node.start! + 1, code.slice(node.start! + 1, node.end! - 1) === node.value)
        },
        TemplateLiteral(path) {
            if (visited.has(path.node)) return
            for (const q of path.node.quasis) if (!visited.has(q)) looseString(q.value.raw, q.start!, true)
        },
    })

    function looseString(text: string, start: number, exact: boolean) {
        if (!index.classPrefixes.some((p) => text.includes(p)) && !text.includes("data-component")) return
        if (/[.[]/.test(text)) {
            const a = analyzeSelector(text, { index, options, applied })
            if (a.edits.length > 0) {
                finding({ kind: "todo", old: oneLine(text), reason: "selector-string", message: "a selector outside a known selector API — if it is used as one, rewrite it", suggestion: oneLine(a.output) }, exact ? start : start - 1)
                return
            }
        }
        for (const tok of legacyTokens(text, index)) {
            const entry = index.classes.get(tok.value)
            if (!entry) {
                if (isPartial(tok.value)) dynamicName(tok.value, exact ? start + tok.start : start - 1)
                continue
            }
            const usage = classUsage(tok.value, entry, "class")
            finding({ ...usage, message: `a legacy class name in a string (context unknown) — ${usage.message}` }, exact ? start + tok.start : start - 1)
        }
    }

    return out
}

/**
 * The legacy classes and data-component values a file puts on its own elements — literal strings in a
 * className / class / *ClassName attribute or property, clsx-style calls, classList.add / toggle /
 * replace, setAttribute("class"), `.className =`, and JSX `data-component="…"`. A part map value
 * (`className={fe.row}`) is not one: its TODO restores the design system's attribute.
 */
function collectApplied(ast: t.File, index: MapIndex, out: AppliedHook[]): void {
    const tokens = (text: string, start: number, joined: { before?: boolean; after?: boolean } = {}) => {
        for (const m of text.matchAll(/[^\s]+/g)) {
            // a token touching an interpolation is a fragment of a runtime name
            if ((joined.before && m.index === 0) || (joined.after && m.index! + m[0].length === text.length)) continue
            if (index.classes.has(m[0])) out.push({ kind: "class", name: m[0], start: start + m.index! })
        }
    }
    const strings = (root: t.Node | null | undefined) => {
        if (!root) return
        const visit = (n: t.Node) => {
            if (t.isStringLiteral(n)) tokens(n.value, n.start! + 1)
            else if (t.isTemplateLiteral(n)) n.quasis.forEach((q, i) => tokens(q.value.raw, q.start!, { before: i > 0, after: i < n.quasis.length - 1 }))
        }
        visit(root)
        t.traverseFast(root, (n) => (n === root ? undefined : visit(n)))
    }
    traverse(ast, {
        noScope: true,
        JSXAttribute(path) {
            const name = t.isJSXIdentifier(path.node.name) ? path.node.name.name : null
            const value = path.node.value
            if (!name || !value) return
            const expr = t.isJSXExpressionContainer(value) ? value.expression : value
            if (isClassAttribute(name)) strings(expr as t.Node)
            else if (name === "data-component" && t.isStringLiteral(expr) && index.dataComponent.has(expr.value)) out.push({ kind: "data-component", name: expr.value, start: expr.start! + 1 })
        },
        ObjectProperty(path) {
            if (isName(path.node.key, isClassAttribute)) strings(path.node.value)
        },
        AssignmentExpression(path) {
            const left = path.node.left
            if (t.isMemberExpression(left) && isName(left.property, new Set(["className"]))) strings(path.node.right)
        },
        "CallExpression|OptionalCallExpression"(p) {
            const { callee, arguments: args } = p.node as t.CallExpression
            if (t.isIdentifier(callee) && CLASS_FUNCTIONS.has(callee.name)) for (const a of args) strings(a)
            const m = member(callee)
            if (!m) return
            if (member(m.object)?.property === "classList" && (m.property === "add" || m.property === "toggle" || m.property === "replace")) for (const a of args) strings(a)
            else if (m.property === "setAttribute" && t.isStringLiteral(args[0]) && args[0].value === "class") strings(args[1])
        },
    })
}
