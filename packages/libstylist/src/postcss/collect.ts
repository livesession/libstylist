// Pass 1 of the css build (SPEC §4.1, §7): read a source sheet without transforming it — scope,
// root directives, local classes (= parts), :global usages, keyframes and cross-sheet references.
// Parse-only: nested source is fine, nothing is flattened.
import { basename, extname } from "node:path"

import postcss, { type Node, type Root } from "postcss"
import selectorParser from "postcss-selector-parser"

import { PART_RE } from "../conventions/index.js"
import { readDirectives, type RootDirective } from "./directives.js"
import { isInsideKeyframes, isKeyframesAtRule, isKeyframesIdent } from "./keyframes.js"
import { parseComponentRef, parseCxRef, replaceRefs, type ComponentRef, type CxRef } from "./refs.js"
import { globalProblem, globalText, isClassAttribute, isGlobalPseudo, isInsideGlobal, preludeSelectors } from "./selectors.js"

export interface SheetMeta {
    /** Path of the sheet (used for the default scope and in reports). */
    file: string
    /** css build group (`components`, `player`, …). */
    group: string
    /** Default scope when the sheet doesn't pin one; the file's basename otherwise. */
    scope?: string
}

/** What a sheet problem is about; `directive` covers every `@stylist` grammar/placement issue. */
export type SheetIssueKind = "parse" | "directive" | "scope" | "keyframes" | "selector"

export interface SheetIssue {
    kind: SheetIssueKind
    message: string
    line?: number
}

export interface SheetRoot extends RootDirective {
    line?: number
}

export interface SheetComponentRef extends ComponentRef {
    line?: number
}

export interface SheetCxRef extends CxRef {
    line?: number
}

export interface SheetInfo {
    file: string
    group: string
    scope: string
    /** True when the scope comes from `@stylist scope`. */
    pinned: boolean
    /** `@stylist root` bindings; empty when the sheet has no directive yet. */
    roots: SheetRoot[]
    /** Every local class used in a selector (rules, `@scope`/`@supports selector()` preludes) outside `:global()`, sorted. */
    classes: string[]
    /** Every `:global(…)` argument, sorted. */
    globals: string[]
    /** Local `@keyframes` names, sorted. */
    keyframes: string[]
    /** `:component(…)` references, in source order. */
    components: SheetComponentRef[]
    /** `:cx(scope:part)` references, in source order. */
    cx: SheetCxRef[]
    /** Grammar problems; the plugin throws on the first of these. */
    errors: SheetIssue[]
}

/** The default scope of a sheet: its basename without extension (`text-input.css` → `text-input`). */
export const scopeFromFile = (file: string): string => basename(file, extname(file))

const lineOf = (node: Node): number | undefined => node.source?.start?.line

/** Reads a source sheet's libstylist facts without transforming it (SPEC §4.1). Never throws. */
export function collectSheet(css: string, meta: SheetMeta): SheetInfo {
    const info: SheetInfo = {
        file: meta.file,
        group: meta.group,
        scope: meta.scope ?? scopeFromFile(meta.file),
        pinned: false,
        roots: [],
        classes: [],
        globals: [],
        keyframes: [],
        components: [],
        cx: [],
        errors: [],
    }
    let root: Root
    try {
        root = postcss.parse(css, { from: meta.file })
    } catch (err) {
        info.errors.push({ kind: "parse", message: (err as Error).message, line: (err as { line?: number }).line })
        return info
    }

    const directives = readDirectives(root)
    for (const e of directives.errors) info.errors.push({ kind: "directive", message: e.message, line: lineOf(e.node) })
    if (directives.scope !== undefined) {
        info.scope = directives.scope
        info.pinned = true
    }
    if (!PART_RE.test(info.scope)) info.errors.push({ kind: "scope", message: `scope "${info.scope}" is not kebab-case — rename the sheet or pin one with @stylist scope <id>;` })
    info.roots = directives.roots.map(({ node, ...r }) => ({ ...r, line: lineOf(node) }))

    const classes = new Set<string>()
    const globals = new Set<string>()
    const keyframes = new Set<string>()
    root.walkAtRules(at => {
        if (!isKeyframesAtRule(at)) return
        const name = at.params.trim()
        if (isKeyframesIdent(name)) keyframes.add(name)
        else info.errors.push({ kind: "keyframes", message: `@${at.name} ${name}: only plain identifiers can be namespaced`, line: lineOf(at) })
    })
    const readSelector = (selector: string, line: number | undefined) => {
        let ast: selectorParser.Root
        try {
            const neutral = replaceRefs(selector, ref => {
                if (ref.kind === "component") info.components.push({ ...parseComponentRef(ref.arg, ref), line })
                else info.cx.push({ ...parseCxRef(ref.arg, ref), line })
                return "[_]"
            })
            ast = selectorParser().astSync(neutral)
        } catch (err) {
            info.errors.push({ kind: "selector", message: (err as Error).message, line })
            return
        }
        ast.walk(n => {
            if (isGlobalPseudo(n)) {
                const problem = globalProblem(n)
                if (problem) info.errors.push({ kind: "selector", message: problem, line })
                else globals.add(globalText(n))
            } else if (n.type === "class") {
                if (isInsideGlobal(n)) return
                if (PART_RE.test(n.value)) classes.add(n.value)
                else info.errors.push({ kind: "selector", message: `.${n.value} is not a valid part name — local classes are kebab-case; legacy hooks go in :global()`, line })
            } else if (isClassAttribute(n) && !isInsideGlobal(n)) {
                info.errors.push({ kind: "selector", message: `${String(n).trim()} selects a class — style a part (.local) instead; legacy hooks go in :global()`, line })
            }
        })
    }
    root.walk(node => {
        if (node.type === "rule" && !isInsideKeyframes(node)) readSelector(node.selector, lineOf(node))
        else if (node.type === "atrule") for (const { start, end } of preludeSelectors(node)) readSelector(node.params.slice(start, end), lineOf(node))
    })
    info.classes = [...classes].sort()
    info.globals = [...globals].sort()
    info.keyframes = [...keyframes].sort()
    return info
}
