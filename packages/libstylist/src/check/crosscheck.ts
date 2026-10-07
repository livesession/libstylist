// Registry and CSS↔JSX checks over the whole program: tag ownership (T201–T203, across every package,
// shared namespaces included) including member roots bound in a sheet (`@stylist root Popover.Content
// as content` → `elo-popover-content`, owned by Popover's file; S303), unused parts of flipped sheets
// (S301), root bindings that name no component of the sheet's package and namespace (S302), display
// defaults (S304/S305), cx() spread onto components that drop it (S307) and
// className props in the public API (S308; a `@deprecated` one — applied through `legacyClassName`
// or accepted and ignored — is the sanctioned migration path and is counted instead).
import ts from "typescript"

import { SLOT_PROP } from "../conventions/index.js"
import { partArgs } from "../core/index.js"
import { exportName, sameComponent } from "../registry/index.js"
import { enclosingFunction, resolveSymbolValue, type ComponentEntry, type ExportIndex } from "./exports.js"
import { isIdentityName, type FileFacts } from "./migration.js"
import type { CheckProgram } from "./program.js"
import type { RenderEvaluator } from "./render.js"
import type { RootAnalysis, RootAnalyzer } from "./roots.js"
import { finding, type Finding } from "./rules.js"
import { lineIn, type SheetFacts } from "./sheets.js"
import { isIntrinsicTag, jsxAttrName, jsxAttributes, jsxTagText, lineOf, unwrapExpr, type FunctionLike } from "./ts-util.js"

export interface CrossCheckInput {
    cp: CheckProgram
    index: ExportIndex
    analyses: Map<ComponentEntry, RootAnalysis>
    analyzer: RootAnalyzer
    evaluator: RenderEvaluator
    sheets: SheetFacts
    prefix: string
    facts: (sf: ts.SourceFile) => FileFacts
    /** `css.hostParts` of the config. */
    hostParts: Record<string, string>
    /** The config file findings about it point at (relative to the root). */
    configFile: string
}

export interface CrossCheckStats {
    /** Runtime cx() calls in the design-system sources. */
    cxCalls: number
    /** Distinct `scope:part` references. */
    partRefs: number
    /** Custom tags and markers rendered in source. */
    identityOccurrences: number
}

/** A root bound in a sheet to a member no export resolves to, owned by the exported component it extends. */
export interface MemberRoot {
    /** Dotted path from the directive (`Popover.Content`). */
    component: string
    tag: string
    scope: string
    local: string
    display?: string
    owner: ComponentEntry
}

/** A `@deprecated` class prop still in a public props type (burndown counts these until they are removed). */
export interface LegacyClassProp {
    component: string
    prop: string
    file: string
    line: number
    /** True when the component applies it through `legacyClassName(…)`; false when it is accepted and ignored. */
    applied: boolean
}

/** A readable name for the function rendering an element. */
function functionName(fn: FunctionLike | undefined): string {
    if (!fn) return "module code"
    if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text
    if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text
    if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return fn.name.text
    return "an anonymous function"
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Runs every registry and CSS↔JSX check. */
export function crossCheck(input: CrossCheckInput): { findings: Finding[]; stats: CrossCheckStats; memberRoots: MemberRoot[]; legacyClassProps: LegacyClassProp[] } {
    const { cp, index, analyses, analyzer, evaluator, sheets, prefix, facts, hostParts, configFile } = input
    const findings: Finding[] = []
    const stats: CrossCheckStats = { cxCalls: 0, partRefs: 0, identityOccurrences: 0 }
    const cx = analyzer.cx
    const at = (node: ts.Node) => ({ file: cp.rel(node.getSourceFile().fileName), line: lineOf(node) })

    // T201: one owner per tag
    const byTag = new Map<string, ComponentEntry[]>()
    for (const c of index.components) if (c.tag) byTag.set(c.tag, [...(byTag.get(c.tag) ?? []), c])
    for (const [tag, owners] of byTag) {
        for (const other of owners.slice(1)) {
            const { file, line } = at(other.anchor)
            // packages sharing a namespace: say which package each one is in
            const label = (c: ComponentEntry) => (other.pkg === owners[0].pkg ? c.id : `${c.id} (${c.pkg.name})`)
            findings.push(finding("T201", tag, `<${tag}> is the tag of both ${label(owners[0])} and ${label(other)} — rename one component (tags are unique across packages)`, file, line))
        }
    }

    // S302 / member roots: every @stylist root names an exported component of the sheet's package in the
    // sheet's namespace, or a member of one
    const memberRoots = new Map<string, MemberRoot>()
    for (const [scope, info] of Object.entries(sheets.registry.scopes)) {
        const sheetPackage = sheets.sheetPackage.get(scope)
        const inNamespace = index.components.filter((c) => c.namespace === info.namespace && (!sheetPackage || c.pkg === sheetPackage))
        for (const root of info.roots) {
            if (inNamespace.some((c) => sameComponent(c.path.join("."), root.component))) continue
            const path = root.component.split(".")
            let owner: ComponentEntry | undefined
            for (let n = path.length - 1; n > 0 && !owner; n--) owner = inNamespace.find((c) => c.path.join(".") === path.slice(0, n).join("."))
            if (owner && !byTag.has(root.tag)) {
                memberRoots.set(root.tag, { component: root.component, tag: root.tag, scope, local: root.local, ...(root.display ? { display: root.display } : {}), owner })
                continue
            }
            const line = lineIn(sheets.sheetText.get(scope), new RegExp(`@stylist\\s+root\\s+${escapeRe(root.component)}(?![A-Za-z0-9.])`, "i"))
            const of = sheetPackage ? ` of ${sheetPackage.name}` : ""
            findings.push(finding("S302", `${scope}:${root.component}`, `@stylist root ${root.component} in ${scope} names no exported component${of} in namespace "${info.namespace}" (nor a member of one)`, info.file, line))
        }
    }

    // ownership: elements that were identity elements of each component's analysis
    const owned = new Map<ts.Node, Set<ComponentEntry>>()
    for (const [component, analysis] of analyses) {
        for (const hit of analysis.identities) {
            for (const el of [...hit.item.via, hit.el]) owned.set(el, (owned.get(el) ?? new Set()).add(component))
        }
    }
    const lexicallyInside = (node: ts.Node, impl: FunctionLike) => {
        for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) if (fn === impl) return true
        return false
    }
    const memberSites = new Map<string, ts.JsxOpeningLikeElement[]>()

    // named slots (`inputCx`): a slot passed to a component must be one of its props, and the component
    // must use it — spread it onto an element, or pass it on to a component that does. Only a provable
    // drop is reported: a slot the component mentions in any other way counts as used.
    const checker = cp.checker
    const declares = (fn: FunctionLike, slot: string): boolean => {
        const param = fn.parameters[0]
        const type = param ? checker.getTypeAtLocation(param) : undefined
        return !!type && !!checker.getPropertyOfType(type, slot)
    }
    const implOf = (el: ts.JsxOpeningLikeElement): FunctionLike | null | undefined => {
        if (isIntrinsicTag(el.tagName)) return undefined
        const tag = el.tagName
        const r = resolveSymbolValue(checker, checker.getSymbolAtLocation(ts.isPropertyAccessExpression(tag) ? tag.name : tag))
        if (r.kind === "function" && cp.packageOf(r.impl.getSourceFile().fileName)) return r.impl
        return r.kind === "external" ? null : undefined
    }
    /** True unless `fn` provably drops the slot it receives. */
    const usesSlot = (fn: FunctionLike, slot: string, seen: Set<FunctionLike>): boolean => {
        if (seen.has(fn) || seen.size > 8) return true
        seen.add(fn)
        const param = fn.parameters[0]
        if (!param || !fn.body) return true
        // the slot's own binding (`{ inputCx }`), or the props object that carries it
        let slotSym: ts.Symbol | undefined
        let propsSym: ts.Symbol | undefined
        if (ts.isIdentifier(param.name)) propsSym = checker.getSymbolAtLocation(param.name)
        else if (ts.isObjectBindingPattern(param.name)) {
            for (const b of param.name.elements) {
                const key = b.propertyName && ts.isIdentifier(b.propertyName) ? b.propertyName.text : ts.isIdentifier(b.name) ? b.name.text : undefined
                if (b.dotDotDotToken && ts.isIdentifier(b.name)) propsSym = checker.getSymbolAtLocation(b.name)
                else if (key === slot && ts.isIdentifier(b.name)) slotSym = checker.getSymbolAtLocation(b.name)
            }
            if (slotSym) propsSym = undefined // the rest no longer carries it
        } else return true
        let used = false
        const passOn = (el: ts.JsxOpeningLikeElement) => {
            const impl = implOf(el)
            if (impl === undefined) return true // an unresolvable callee: not a provable drop
            return impl !== null && declares(impl, slot) && usesSlot(impl, slot, seen)
        }
        const visit = (node: ts.Node): void => {
            if (used) return
            const isSlotRef = (e: ts.Expression) => {
                const x = unwrapExpr(e)
                if (slotSym && ts.isIdentifier(x)) return checker.getSymbolAtLocation(x) === slotSym
                if (propsSym && ts.isPropertyAccessExpression(x) && x.name.text === slot && ts.isIdentifier(x.expression)) return checker.getSymbolAtLocation(x.expression) === propsSym
                return false
            }
            if (ts.isJsxSpreadAttribute(node)) {
                const e = unwrapExpr(node.expression)
                if (isSlotRef(e)) used = true
                else if (propsSym && ts.isIdentifier(e) && checker.getSymbolAtLocation(e) === propsSym && passOn(node.parent.parent as ts.JsxOpeningLikeElement)) used = true
                if (used) return
            } else if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && isSlotRef(node as ts.Expression)) {
                // anything but an attribute passing it to a component that drops it counts as a use
                const attr = node.parent && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) ? node.parent.parent : undefined
                if (!attr || passOn(attr.parent.parent as ts.JsxOpeningLikeElement)) used = true
                return
            }
            ts.forEachChild(node, visit)
        }
        visit(fn.body)
        return used
    }
    const slotCache = new Map<string, string | null>()
    const slotLoss = (target: ComponentEntry, slot: string): string | null => {
        const key = `${target.id}:${slot}`
        if (!slotCache.has(key)) {
            const name = target.path.join(".")
            slotCache.set(
                key,
                !declares(target.impl, slot)
                    ? `${name} has no \`${slot}\` prop — use one of its named slots, or spread cx() on it for its root`
                    : !usesSlot(target.impl, slot, new Set())
                      ? `${name} declares \`${slot}\` but never passes it to an element's cx() call ({...cx(cn.field, ${slot})}) or on to a component`
                      : null,
            )
        }
        return slotCache.get(key) as string | null
    }

    // one pass over every JSX element of the design-system sources
    const used = new Set<string>()
    for (const sf of cp.files) {
        // parts referenced (S301): every part-map member read, in cx() calls or anywhere else
        cx.memberReads(sf, (scope, part) => used.add(`${scope}:${part}`))
        stats.cxCalls += cx.countCalls(sf)
        if (sf.languageVariant !== ts.LanguageVariant.JSX) continue
        const rel = cp.rel(sf.fileName)
        const visit = (node: ts.Node): void => {
            if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) inspect(node)
            ts.forEachChild(node, visit)
        }
        const inspect = (el: ts.JsxOpeningLikeElement) => {
            // a cx() spread (it carries parts) or a named slot on a component that drops it (S307)
            if (!isIntrinsicTag(el.tagName)) {
                const spreads = cx.spreadsOf(el)
                const carries = spreads.some((s) => partArgs(s.args).length > 0)
                // a data literal spread on a design-system component: its cx() forwards parts and markers only
                const data = spreads.some((s) => s.args.some((a) => a.kind === "data"))
                const slots = jsxAttributes(el).filter((a) => SLOT_PROP.test(jsxAttrName(a)))
                const target = carries || data || slots.length ? evaluator.delegateOf(el) : null
                const tag = jsxTagText(el.tagName)
                if (target && carries && !analyzer.forwards(target)) {
                    // a DOM-less delegate passes the props on with its marker; any other component from its identity element's cx()
                    const hit = analyses.get(target)?.identities.find((h) => h.form === "forwarded")
                    const how = hit
                        ? `its delegate must receive them with the marker: <${jsxTagText(hit.el.tagName)} ${target.tag} {...cx(rest)}>`
                        : `its identity element must pass them to its cx() call: {...cx(cn.root, rest)}`
                    findings.push(finding("S307", `${rel}>${target.id}`, `cx() on <${tag}> is lost — ${target.path.join(".")} doesn't pass its props on to its DOM (${how})`, rel, lineOf(el)))
                }
                if (target && data) {
                    findings.push(
                        finding(
                            "S307",
                            `${rel}>${target.id}:data`,
                            `data on <${tag}> is lost — design-system components forward only parts and markers from their props (${target.path.join(".")}'s cx() never renders a caller's data-*); pass the state as one of its props, or put it on your own element`,
                            rel,
                            lineOf(el),
                        ),
                    )
                }
                for (const slot of target ? slots : []) {
                    const name = jsxAttrName(slot)
                    const lost = slotLoss(target as ComponentEntry, name)
                    if (lost) findings.push(finding("S307", `${rel}>${(target as ComponentEntry).id}:${name}`, `${name} on <${tag}> is lost — ${lost}`, rel, lineOf(slot)))
                }
            }
            // tags and markers (T202/T203)
            const occurrences: Array<{ name: string; node: ts.Node }> = []
            if (ts.isIdentifier(el.tagName) && isIdentityName(el.tagName.text, prefix)) occurrences.push({ name: el.tagName.text, node: el.tagName })
            for (const attr of jsxAttributes(el)) {
                const name = jsxAttrName(attr)
                if (isIdentityName(name, prefix)) occurrences.push({ name, node: attr })
            }
            for (const { name, node } of occurrences) {
                stats.identityOccurrences++
                const member = memberRoots.get(name)
                if (member) {
                    if (sf === member.owner.impl.getSourceFile() || lexicallyInside(el, member.owner.impl)) memberSites.set(name, [...(memberSites.get(name) ?? []), el])
                    else {
                        const home = at(member.owner.impl)
                        findings.push(
                            finding(
                                "T203",
                                `${name}@${rel}`,
                                `${name} is the member root ${member.component} of ${member.owner.id} (${home.file}) — only that component's file renders it; render <${member.owner.path.join(".")}> instead`,
                                rel,
                                lineOf(node),
                            ),
                        )
                    }
                    continue
                }
                const owner = index.byTag.get(name)
                if (!owner) {
                    findings.push(finding("T202", `${name}@${rel}`, `<${name}> is not the tag of any exported component or bound member root — rename it to its component's tag, export the component, or bind the member in its sheet (@stylist root Owner.Member as local)`, rel, lineOf(node)))
                    continue
                }
                if ([...(owned.get(el) ?? [])].some((c) => c.tag === name) || lexicallyInside(el, owner.impl)) continue
                const by = functionName(enclosingFunction(el))
                const home = at(owner.impl)
                findings.push(
                    finding(
                        "T203",
                        `${name}@${rel}`,
                        `${name} is the identity of ${owner.id} (${home.file}:${home.line}), but ${by} renders it — only the owner renders its tag or marker; render <${owner.path.join(".")}> instead`,
                        rel,
                        lineOf(node),
                    ),
                )
            }
        }
        visit(sf)
    }
    stats.partRefs = used.size

    // S303 (+ S304/S305 for member tags): a member root is rendered by its owner's file with its local part
    const locals = (scope: string) => sheets.displayLocals.get(scope) ?? new Set<string>()
    for (const member of [...memberRoots.values()].sort((a, b) => (a.tag < b.tag ? -1 : 1))) {
        const sites = memberSites.get(member.tag) ?? []
        const owner = member.owner
        if (!sites.length) {
            const info = sheets.registry.scopes[member.scope]
            const line = lineIn(sheets.sheetText.get(member.scope), new RegExp(`@stylist\\s+root\\s+${escapeRe(member.component)}(?![A-Za-z0-9.])`, "i"))
            findings.push(
                finding(
                    "S303",
                    member.tag,
                    `@stylist root ${member.component} binds the member root <${member.tag}>, but ${owner.id}'s file never renders it — put the marker on the member's host with its part and the slot that brings the caller's parts (<… ${member.tag} {...cx(${exportName(member.scope)}.${member.local}, contentCx)}>)`,
                    info.file,
                    line,
                ),
            )
            continue
        }
        const tagSite = sites.some((el) => ts.isIdentifier(el.tagName) && el.tagName.text === member.tag)
        for (const el of sites) {
            const { file, line } = at(el)
            if (!cx.partsOf(el).some((p) => p.scope === member.scope && p.part === member.local)) {
                findings.push(
                    finding(
                        "S303",
                        member.tag,
                        `the member root <${member.tag}> must carry its bound part — add ${cx.localOf(el.getSourceFile(), member.scope) ?? exportName(member.scope)}.${member.local} to its cx() call, next to the slot that brings the caller's parts ({...cx(${cx.localOf(el.getSourceFile(), member.scope) ?? exportName(member.scope)}.${member.local}, contentCx)}; the ${member.scope} sheet binds ${member.component} as ${member.local})`,
                        file,
                        line,
                    ),
                )
            }
            const isTag = ts.isIdentifier(el.tagName) && el.tagName.text === member.tag
            if (isTag && !member.display && !locals(member.scope).has(member.local)) {
                findings.push(
                    finding("S304", member.tag, `<${member.tag}> has no display default — custom elements are inline; declare \`@stylist root ${member.component} as ${member.local} display <keyword>;\` in ${member.scope}`, file, line, owner.id),
                )
            } else if (!isTag && !tagSite && member.display) {
                findings.push(finding("S305", `${owner.namespace}/${member.component}`, `@stylist root ${member.component} declares display ${member.display}, but <${member.tag}> is rendered as a marker — the default only applies to custom tags; drop it`, file, line, owner.id))
            }
        }
    }

    // S301: parts no element carries (flipped sheets only — an unflipped sheet is not bound to its
    // components yet; host parts are carried by elements outside the design-system sources)
    for (const [scope, info] of Object.entries(sheets.registry.scopes)) {
        if (sheets.unboundScopes.has(scope) || !sheets.flippedScopes.has(scope)) continue
        for (const part of Object.keys(info.parts)) {
            if (used.has(`${scope}:${part}`) || Object.prototype.hasOwnProperty.call(hostParts, `${scope}:${part}`)) continue
            const line = lineIn(sheets.sheetText.get(scope), new RegExp(`\\.${escapeRe(part)}(?![A-Za-z0-9_-])`))
            findings.push(
                finding(
                    "S301",
                    `${scope}:${part}`,
                    `part "${part}" of ${scope} is carried by no element — nothing reads ${exportName(scope)}.${part} from the part map; spread it with cx() on the element it styles, delete its rules, or list it in css.hostParts when code outside the design-system sources carries it`,
                    info.file,
                    line,
                ),
            )
        }
    }

    // S306: host parts name a real part that no design-system element carries
    for (const key of Object.keys(hostParts)) {
        const [scope, part] = key.split(":")
        const info = Object.prototype.hasOwnProperty.call(sheets.registry.scopes, scope) ? sheets.registry.scopes[scope] : undefined
        if (!info || !Object.prototype.hasOwnProperty.call(info.parts, part)) {
            findings.push(finding("S306", key, `css.hostParts lists ${key}, but ${info ? `the ${scope} sheet has no part "${part}"` : `no sheet has scope ${scope}`} — remove the entry`, configFile, 0))
        } else if (used.has(key)) {
            const line = lineIn(sheets.sheetText.get(scope), new RegExp(`\\.${escapeRe(part)}(?![A-Za-z0-9_-])`))
            findings.push(finding("S306", key, `css.hostParts lists ${key}, but design-system source reads it from the part map — it is an ordinary part now; remove the entry`, info.file, line))
        }
    }

    // S304/S305: display defaults for custom tags; none on components that never render their tag
    // (one that renders the tag in some branches and a marker in others — Truncate's div/span vs <p>
    // — needs the default for its tag branches)
    for (const [component, analysis] of analyses) {
        const rendersTag = analysis.identities.some((hit) => hit.rendersTag)
        for (const hit of analysis.identities) {
            const { file, line } = at(hit.el)
            const tag = component.tag
            if (!tag) continue
            if (hit.rendersTag) {
                if (hit.binding?.display) continue
                if (hit.binding && locals(hit.binding.scope).has(hit.binding.local)) continue
                if (hit.parts.some((p) => p.static && locals(p.scope).has(p.part))) continue
                const where = hit.binding ? `${hit.binding.scope}` : "its sheet"
                findings.push(
                    finding("S304", tag, `<${tag}> has no display default — custom elements are inline; declare \`@stylist root ${component.path.join(".")} display <keyword>;\` in ${where} or set display on its root part`, file, line, component.id),
                )
            } else if (!rendersTag && hit.binding?.display && hit.binding.source === "registry") {
                findings.push(
                    finding(
                        "S305",
                        component.id,
                        `@stylist root ${component.path.join(".")} declares display ${hit.binding.display}, but ${component.path.join(".")} renders a marker root (${hit.names.join(" ")}) — the default only applies to custom tags; drop it`,
                        file,
                        line,
                        component.id,
                    ),
                )
            }
        }
    }

    // S308: no className in public props (a @deprecated one consumed by legacyClassName is counted instead)
    const legacyClassProps: LegacyClassProp[] = []
    for (const component of index.components) {
        const param = component.impl.parameters[0]
        if (!param) continue
        const type = checker.getTypeAtLocation(param)
        const members = type.isUnion() ? type.types : [type]
        const seen = new Set<string>()
        for (const t of members) {
            for (const prop of checker.getPropertiesOfType(t)) {
                const name = prop.name
                if (seen.has(name) || !(name === "className" || /[a-z0-9]ClassName$/.test(name))) continue
                seen.add(name)
                const decl = prop.valueDeclaration ?? prop.declarations?.[0]
                const own = decl && cp.packageOf(decl.getSourceFile().fileName) ? decl : undefined
                const anchor = own ?? param
                const { file, line } = at(anchor)
                // a @deprecated class prop is the sanctioned migration path (applied through legacyClassName,
                // or accepted and ignored for source compatibility); burndown counts it until it is removed
                if (own && ts.getJSDocTags(own).some((tag) => tag.tagName.text === "deprecated")) {
                    const consumed = [component.impl.getSourceFile(), own.getSourceFile()].some((sf) => facts(sf).legacyClassNameArgs.has(name))
                    legacyClassProps.push({ component: component.id, prop: name, file, line, applied: consumed })
                    continue
                }
                const slot = name === "className" ? "cx() spread onto the component" : `a named slot (${name.replace(/ClassName$/, "Cx")})`
                const keep = ` — while callers still pass it, mark it \`@deprecated\` (and apply it with legacyClassName(${name}) if it must still work)`
                findings.push(
                    finding("S308", `${component.id}:${name}`, `${component.path.join(".")} props declare \`${name}\` — the public API has no className; consumers style through ${slot}, tags/markers and the part map${keep}`, file, line, component.id),
                )
            }
        }
    }

    return { findings, stats, memberRoots: [...memberRoots.values()], legacyClassProps }
}
