// The design system's `!important` declarations an override can't beat (SPEC §9.4). For important
// declarations the cascade reverses the layer order: an `!important` in the design system's `components`
// layer wins over every declaration of a later layer — the overrides layer's, `!important` or not. Only a
// reset (`@stylist reset <part>;`) removes it. `importantDeclarations` indexes a design-system stylesheet's
// `!important`s by the elements their subjects name; `importantConflicts` finds the declarations of a
// compiled override sheet they beat.
import postcss, { type Root } from "postcss"
import selectorParser from "postcss-selector-parser"

import { PART_ATTR_PREFIX } from "../conventions/index.js"
import { isInsideKeyframes } from "./keyframes.js"
import { classifySubject, longhandsOf, subjectCompound, type SubjectMatcher } from "./reset.js"

/** A design-system `!important` declaration and the elements its rule's subject names. */
export interface ImportantDeclaration {
    /** The part attributes and identity tags the subject names (lowercase; an identity's tag and marker are one name). */
    names: string[]
    prop: string
    value: string
    /** The complex selector. */
    selector: string
    /** The stylesheet, as reports print it. */
    file: string
    line?: number
}

/** A part attribute (`[_cxclass_…]`), an identity tag (`elo-button`) or marker (`[elo-button]`). */
const elementMatcher: SubjectMatcher = n => {
    if (n.type === "tag") return n.value.includes("-") ? n.value.toLowerCase() : null
    if (n.type !== "attribute" || n.value !== undefined) return null
    const name = n.attribute.toLowerCase()
    if (name.startsWith(PART_ATTR_PREFIX)) return name
    return name.includes("-") && !name.startsWith("data-") && !name.startsWith("aria-") ? name : null
}

const parse = (selector: string): selectorParser.Root | null => {
    try {
        return selectorParser().astSync(selector)
    } catch {
        return null
    }
}

/** Every `!important` declaration of a stylesheet outside `@keyframes` whose rule's subject names a part or an identity. */
export function importantDeclarations(css: string | Root, file: string): ImportantDeclaration[] {
    const root = typeof css === "string" ? postcss.parse(css) : css
    const out: ImportantDeclaration[] = []
    root.walkDecls(decl => {
        if (!decl.important || decl.parent?.type !== "rule") return
        const rule = decl.parent as postcss.Rule
        if (isInsideKeyframes(rule)) return
        for (const complex of parse(rule.selector)?.nodes ?? []) {
            const c = classifySubject(subjectCompound(complex), elementMatcher)
            if (c.match === "none") continue
            out.push({ names: c.names, prop: decl.prop.toLowerCase(), value: decl.value, selector: String(complex).trim(), file, line: decl.source?.start?.line })
        }
    })
    return out
}

/** Shorthands whose longhands are named `<shorthand>-…` (the others are listed in `longhandsOf`). */
const PREFIX_SHORTHANDS = new Set([
    "animation", "background", "border-block", "border-bottom", "border-color", "border-inline", "border-left", "border-right", "border-style", "border-top", "border-width",
    "column-rule", "columns", "font", "inset", "list-style", "margin", "mask", "outline", "padding", "text-decoration", "text-emphasis", "transition",
])
const BORDER_SIDE = /^border-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?(?:-(?:width|style|color))?$|^border-(?:width|style|color)$/

/** True when setting `a` sets `b` or the reverse (the same property, or a shorthand and one of its longhands). */
export function overlappingProperties(a: string, b: string): boolean {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    if (x === y) return true
    const sets = (short: string, long: string) =>
        longhandsOf(short).includes(long) || (PREFIX_SHORTHANDS.has(short) && long.startsWith(`${short}-`)) || (short === "border" && BORDER_SIDE.test(long))
    return sets(x, y) || sets(y, x)
}

/** An override declaration a design-system `!important` beats. */
export interface ImportantConflict {
    /** The override's property. */
    prop: string
    /** The override declaration's line in its source sheet. */
    line?: number
    /** The element name through which they meet (a part attribute or an identity tag). */
    name: string
    important: ImportantDeclaration
}

/**
 * The declarations of a compiled override sheet that a design-system `!important` beats: a rule whose
 * subject names an element of `elements` (the override's names: a part attribute, an identity tag → the
 * design-system names of the same element: the part and, for a component's root, its identity) declaring
 * a property an `!important` of that element sets. One conflict per declaration (the first `!important`).
 */
export function importantConflicts(compiled: string | Root, elements: ReadonlyMap<string, readonly string[]>, importants: readonly ImportantDeclaration[]): ImportantConflict[] {
    if (importants.length === 0 || elements.size === 0) return []
    const root = typeof compiled === "string" ? postcss.parse(compiled) : compiled
    const out: ImportantConflict[] = []
    root.walkRules(rule => {
        if (isInsideKeyframes(rule)) return
        const names = new Set<string>()
        for (const complex of parse(rule.selector)?.nodes ?? []) {
            const c = classifySubject(subjectCompound(complex), elementMatcher)
            if (c.match === "none") continue
            for (const name of c.names) for (const same of elements.get(name) ?? []) names.add(same)
        }
        if (names.size === 0) return
        rule.each(node => {
            if (node.type !== "decl") return
            for (const important of importants) {
                const name = important.names.find(n => names.has(n))
                if (name === undefined || !overlappingProperties(node.prop, important.prop)) continue
                out.push({ prop: node.prop, line: node.source?.start?.line, name, important })
                return
            }
        })
    })
    return out
}
