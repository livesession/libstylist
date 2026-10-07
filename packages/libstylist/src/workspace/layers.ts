// The cascade layers of a workspace build: the design system's, declared first by its aggregate, and
// the overrides layer's place among them and the app's namespace layers (SPEC §9.4). Dependency-free, so
// the config loader, the workspace build and the override helpers share it.

/** The design system's cascade layers (`@livesession/eloquentui-css`'s order statement), declared before the app's. */
export const DESIGN_SYSTEM_LAYERS: readonly string[] = ["reset", "tokens", "components", "utilities"]

/** The cascade layer override sheets compile into when `css.overrides.layer` is unset. */
export const DEFAULT_OVERRIDES_LAYER = "app.overrides"

/**
 * Why `layer` can't hold the override sheets in an order statement, or null when it can (SPEC §9.4):
 * the statement declares it after the design system's `components` layer — an override must beat the
 * design system's component rules, and since the design-system aggregate declares its layers first,
 * nothing the app writes can move a layer before `utilities` anyway — and before every namespace layer
 * of the app (`app.core`, `app.render`), whose components' contextual styling of a design-system element
 * must beat the global override. It must not be one of those layers either.
 */
export function overridesLayerProblem(statement: readonly string[], layer: string, namespaceLayers: readonly string[]): string | null {
    if (DESIGN_SYSTEM_LAYERS.includes(layer)) return `the overrides layer "${layer}" is a design-system layer — override sheets need a layer of their own (default "${DEFAULT_OVERRIDES_LAYER}")`
    if (namespaceLayers.includes(layer)) return `the overrides layer "${layer}" is a namespace's layer — override sheets need a layer of their own (default "${DEFAULT_OVERRIDES_LAYER}")`
    const at = statement.indexOf(layer)
    if (at < 0) return `css.layers.statement does not declare "${layer}", the layer of the override sheets — add it after "components" and before ${namespaceLayers.map(l => `"${l}"`).join(", ") || "the app's layers"}`
    const components = statement.indexOf("components")
    if (components < 0 || components > at) return `css.layers.statement declares "${layer}" before the design system's "components" layer — override sheets must come after it, or the design system's rules win`
    const before = namespaceLayers.filter(l => statement.indexOf(l) >= 0 && statement.indexOf(l) < at)
    if (before.length) return `css.layers.statement declares "${layer}" after ${before.map(l => `"${l}"`).join(", ")} — the app's own components (their contextual styling of a design-system element) must beat a global override; move "${layer}" before them`
    return null
}

/** A cascade layer as a stylesheet first declares it: its full name and the `@layer` at-rule that did. */
export interface DeclaredLayer {
    /** Dotted (`app.overrides`). */
    name: string
    /** The first `@layer` at-rule declaring it, as `@layer a, b` (its prelude, whitespace collapsed). */
    at: string
}

/**
 * Why the layer order a bundle declares (`order`: every layer by first declaration, sublayers after their
 * parent — `declaredLayerOrder`) breaks the overrides layer's place, or null when it holds (SPEC §9.4):
 * after the design system's `components` and before every namespace layer of the app. The first `@layer`
 * statement of the bundle fixes the order; a hand-written one that lists the app's layers without the
 * overrides layer (a theme or globals sheet imported before the override sheets) makes `app.overrides` a
 * sublayer declared after `app.core`, and every global override beats the app's own components.
 */
export function bundleLayerProblem(order: readonly DeclaredLayer[], layer: string, namespaceLayers: readonly string[]): string | null {
    const index = (name: string) => order.findIndex(l => l.name === name)
    const at = index(layer)
    if (at < 0) return null
    const components = index("components")
    const culprit = (name: string) => order[index(name)].at
    if (components > at) return `the bundle declares "${layer}" before the design system's "components" layer (first by "${culprit(layer)}") — import the design system's CSS before the override sheets`
    const before = namespaceLayers.filter(l => index(l) >= 0 && index(l) < at)
    if (before.length === 0) return null
    return `the bundle declares "${layer}" after ${before.map(l => `"${l}"`).join(", ")}: "${culprit(before[0])}" declares ${before.length === 1 ? "it" : "them"} first and does not list "${layer}" — every @layer order statement the app writes lists "${layer}" where css.layers.statement puts it (after "components", before the app's own layers), or the override sheets beat the app's components`
}
