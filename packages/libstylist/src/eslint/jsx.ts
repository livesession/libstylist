// JSX helpers: element/attribute names, identity detection (custom tag or marker), element kinds
// and the removed `cx` attribute.
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils"

import { SLOT_PROP, SVG_GEOMETRY_CX } from "../conventions/index.js"
import { isCustomElementName } from "../naming/index.js"

/** The written name of a JSX element: `div`, `elo-alert`, `Modal.Header`, `svg:circle`. */
export function elementName(name: TSESTree.JSXTagNameExpression): string {
    switch (name.type) {
        case AST_NODE_TYPES.JSXIdentifier:
            return name.name
        case AST_NODE_TYPES.JSXNamespacedName:
            return `${name.namespace.name}:${name.name.name}`
        case AST_NODE_TYPES.JSXMemberExpression:
            return `${elementName(name.object)}.${name.property.name}`
    }
}

/** The written name of a JSX attribute (`className`, `data-x`, `xlink:href`). */
export function attrName(attr: TSESTree.JSXAttribute): string {
    return attr.name.type === AST_NODE_TYPES.JSXNamespacedName ? `${attr.name.namespace.name}:${attr.name.name.name}` : attr.name.name
}

/** The named attributes of an opening element (spreads skipped). */
export function attributes(opening: TSESTree.JSXOpeningElement): TSESTree.JSXAttribute[] {
    return opening.attributes.filter((a): a is TSESTree.JSXAttribute => a.type === AST_NODE_TYPES.JSXAttribute)
}

/** The spread attributes of an opening element. */
export function spreads(opening: TSESTree.JSXOpeningElement): TSESTree.JSXSpreadAttribute[] {
    return opening.attributes.filter((a): a is TSESTree.JSXSpreadAttribute => a.type === AST_NODE_TYPES.JSXSpreadAttribute)
}

/** The element's opening node for an attribute (attributes always sit on an opening element). */
export const ownerElement = (attr: TSESTree.JSXAttribute | TSESTree.JSXSpreadAttribute): TSESTree.JSXOpeningElement => attr.parent as TSESTree.JSXOpeningElement

const DATA_ARIA = /^(data|aria)-/

/** True for an attribute name that claims the prefix's identity namespace (`elo-…`), well-formed or not. */
export const hasIdentityPrefix = (name: string, prefix: string): boolean => name.startsWith(`${prefix}-`) && !DATA_ARIA.test(name)

/** True when the element name is a custom element of `prefix` (`elo-…`), well-formed or not. */
export const isPrefixedTag = (name: string, prefix: string): boolean => isCustomElementName(name) && name.startsWith(`${prefix}-`)

/** Where an element's identity comes from. */
export type Identity =
    | { kind: "tag"; name: string; node: TSESTree.JSXIdentifier }
    | { kind: "marker"; name: string; node: TSESTree.JSXAttribute }

/**
 * The identity an element declares: its custom tag (`<elo-alert>`) or, on any other element, its
 * first marker attribute (`<button elo-button>`, `<Modal elo-modalconfirm>`). `null` otherwise.
 */
export function identityOf(opening: TSESTree.JSXOpeningElement, prefix: string): Identity | null {
    if (opening.name.type === AST_NODE_TYPES.JSXIdentifier && isPrefixedTag(opening.name.name, prefix)) return { kind: "tag", name: opening.name.name, node: opening.name }
    for (const attr of attributes(opening)) {
        const name = attrName(attr)
        if (hasIdentityPrefix(name, prefix)) return { kind: "marker", name, node: attr }
    }
    return null
}

/** How the transform classifies an element (mirrors the Babel plugin, so lint and build agree). */
export interface ElementKind {
    /** Lowercase or hyphenated intrinsic element (`div`, `elo-alert`, `svg:circle`), vs a component (`Icon`, `motion.circle`). */
    host: boolean
    /** The tag for hosts; the last member name for member expressions (`circle` in `motion.circle`). */
    name: string
    /** An SVG element whose `cx` is geometry, never a part list (SPEC §5.3). */
    geometry: boolean
}

/** Classifies an element exactly like the transform does. */
export function elementKind(opening: TSESTree.JSXOpeningElement): ElementKind {
    const n = opening.name
    if (n.type === AST_NODE_TYPES.JSXIdentifier) {
        const host = /^[a-z]/.test(n.name) || n.name.includes("-")
        return { host, name: n.name, geometry: host && SVG_GEOMETRY_CX.includes(n.name) }
    }
    if (n.type === AST_NODE_TYPES.JSXMemberExpression) return { host: false, name: n.property.name, geometry: SVG_GEOMETRY_CX.includes(n.property.name) }
    return { host: true, name: `${n.namespace.name}:${n.name.name}`, geometry: false }
}

/** True when `cx` on this element is SVG geometry (SPEC §5.3). */
export const isGeometryElement = (opening: TSESTree.JSXOpeningElement): boolean => elementKind(opening).geometry

/** The removed `cx` part-list attribute: `cx` on any element but SVG geometry (SPEC §5.2). */
export function isLegacyCxAttribute(attr: TSESTree.JSXAttribute): boolean {
    return attrName(attr) === "cx" && !isGeometryElement(ownerElement(attr))
}

/** A named slot prop (`inputCx`). */
export const isSlotAttribute = (attr: TSESTree.JSXAttribute): boolean => SLOT_PROP.test(attrName(attr))
