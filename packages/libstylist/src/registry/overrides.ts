// Resolving override sheets against the design system's registry (SPEC §9.3): `from "<package>"` → the
// design system (by the package's prefix) and the namespace; the target → the design-system sheet (the
// scope binding the component, or the named scope); every class and reset part → a part of that sheet;
// every `:component()` of the context → an identity of the same design system; `within` → an app
// component of the app's registry. Pure: the caller resolves a package specifier to
// its `libstylist` field (`resolvePackage`). Everything is reported as `RegistryError`s with a
// did-you-mean, so a design-system rename breaks the build loudly instead of silently no-oping.
import { nearest } from "../eslint/suggest.js"
import type { ComponentRef } from "../postcss/refs.js"
import type { OverrideTargetRef } from "../postcss/directives.js"
import { overridePartList, unknownPartMessage, type OverrideSheetInfo, type StylistOverrideOptions } from "../postcss/override.js"
import type { ResetTarget } from "../postcss/reset.js"
import { hasOwn, sameComponent, sortKeys, type Registry, type RegistryError, type RegistryErrorCode, type RegistryScope } from "./types.js"

/** What a component package's `libstylist` field says: the design system it belongs to (prefix) and its namespace. */
export interface OverridePackage {
    prefix: string
    namespace: string
}

/** Resolves `from "<specifier>"` of the override sheet `file` to its package's prefix and namespace, or says why it can't. */
export type ResolvePackage = (specifier: string, file: string) => OverridePackage | { error: string }

/** What an override sheet restyles. */
export interface OverrideTarget {
    /** `component`: `@stylist override Button …`; `sheet`: `@stylist override tooltip …`. */
    kind: "component" | "sheet"
    /** The design system's prefix. */
    prefix: string
    namespace: string
    /** The target sheet (registry scope). */
    scope: string
    /** Component form: the component path as the registry binds it (`ListCollection.Root`); null in the scope form. */
    path: string | null
    /** Component form: the identity tag `.root` compiles to; null in the scope form. */
    tag: string | null
    /** The part on the target's root element: the component's root local (`Table.Tr` → `tr`); in the scope form `root` when the sheet has it. */
    rootPart: string | null
    /** For messages: `Button (core, from "@livesession/eloquentui-react")`, `sheet "tooltip" (core, from "…")`. */
    label: string
}

/** A `within` app component. */
export interface ResolvedWithin {
    namespace: string
    path: string
    tag: string
}

/** An override sheet resolved against its design system. */
export interface ResolvedOverrideSheet {
    file: string
    id: string
    target: OverrideTarget
    /** The package `from` names. */
    from: string
    within: ResolvedWithin | null
    /** The parts the selectors read, sorted (`.root` of the component form is the identity, not a part). */
    uses: string[]
    /** The `:component()` references of the context, resolved, sorted by argument. */
    components: Array<{ arg: string; namespace: string; path: string; tag: string }>
    /** The parts reset, sorted; a whole reset lists every part of the target sheet. */
    resets: string[]
    /** True for `@stylist reset;`. */
    whole: boolean
    /** One reset target per reset part, with the line of the directive that named it. */
    resetTargets: ResetTarget[]
    /** The options `stylistOverride()` compiles the sheet with. */
    plugin: StylistOverrideOptions
}

/** The optional lock sections (SPEC §7): what override sheets resolve, so a design-system change shows up in review. */
export interface OverrideLock {
    /** `<prefix>:<ns>/<Component.Path>` → tag, `<prefix>:<ns>/<scope>:<part>` → attribute: every identity and part an override reads or resets. */
    overrides: Record<string, string>
    /** `<prefix>:<ns>/<scope>:<part>` → attribute: every part a reset strips. */
    resets: Record<string, string>
}

export interface ResolveOverridesContext {
    /** The design systems' registries (`css.overrides.registries`), one per prefix. */
    designSystems: readonly Registry[]
    resolvePackage: ResolvePackage
    /** The app: its prefix (never a design system's) and its registry, which `within` resolves against. */
    app: { prefix: string; registry?: Registry | null }
}

export interface ResolveOverridesInput extends ResolveOverridesContext {
    sheets: readonly OverrideSheetInfo[]
}

export interface ResolveOverridesResult {
    /** The sheets that resolved, in input order (a sheet with an error is left out). */
    sheets: ResolvedOverrideSheet[]
    /** Every reset target, by label. */
    resets: ResetTarget[]
    lock: OverrideLock
    /** Fatal: nothing should be compiled, stripped or written while there is one. */
    errors: RegistryError[]
}

const where = (file: string, line: number | undefined): string => `${file}${line ? `:${line}` : ""}`
const collapse = (path: string): string => path.replace(/\.Root$/, "")
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort()
const listOf = (xs: readonly string[], max = 6): string => (xs.length > max ? `${xs.slice(0, max).join(", ")}, …` : xs.join(", "))

type Failure = { code: RegistryErrorCode; message: string }
const isFailure = (x: object): x is Failure => "code" in x && "message" in x

/**
 * Resolves an override target in one namespace of a design system's registry (SPEC §9.3): a component
 * path to the scope whose `@stylist root` binds it (`Path` and `Path.Root` alike), a sheet id to that
 * scope. `from` only labels messages. An unknown target is `unknown-target`, with the nearest name, the
 * namespace that has it when another one does, the members when the path is a family with no identity
 * of its own (`UserMenu` → `UserMenu.Item`, or the `user-menu` sheet).
 */
export function resolveOverrideTarget(registry: Registry, namespace: string, ref: OverrideTargetRef, from: string): OverrideTarget | Failure {
    const scopes = Object.entries(registry.scopes)
    const inNamespace = scopes.filter(([, s]) => s.namespace === namespace)
    if (ref.kind === "sheet") {
        const hit = inNamespace.find(([scope]) => scope === ref.scope)
        if (hit) {
            const [scope, info] = hit
            return { kind: "sheet", prefix: registry.prefix, namespace, scope, path: null, tag: null, rootPart: hasOwn(info.parts, "root") ? "root" : null, label: `sheet "${scope}" (${namespace}, from "${from}")` }
        }
        const guess = nearest(ref.scope, inNamespace.map(([scope]) => scope))
        const elsewhere = hasOwn(registry.scopes, ref.scope) ? registry.scopes[ref.scope].namespace : null
        return {
            code: "unknown-target",
            message: `"${ref.scope}" is not a sheet of namespace "${namespace}" (from "${from}")${guess ? ` — did you mean "${guess}"?` : ""}${elsewhere ? ` It is a sheet of namespace "${elsewhere}": name the package that exports its components.` : ""}`,
        }
    }
    const path = ref.path
    for (const [scope, info] of inNamespace) {
        const root = info.roots.find(r => sameComponent(r.component, path))
        if (root) {
            return { kind: "component", prefix: registry.prefix, namespace, scope, path: root.component, tag: root.tag, rootPart: root.local, label: `${collapse(root.component)} (${namespace}, from "${from}")` }
        }
    }
    const candidates = inNamespace.flatMap(([, s]) => s.roots.map(r => collapse(r.component)))
    const guess = nearest(collapse(path), candidates)
    const hints: string[] = []
    const elsewhere = sorted(scopes.filter(([, s]) => s.namespace !== namespace && s.roots.some(r => sameComponent(r.component, path))).map(([, s]) => s.namespace))
    if (elsewhere.length) hints.push(`It is a component of namespace ${elsewhere.map(ns => `"${ns}"`).join(", ")}: name the package that exports it.`)
    const members = inNamespace
        .map(([scope, s]) => [scope, s.roots.filter(r => collapse(r.component).startsWith(`${collapse(path)}.`)).map(r => r.component)] as const)
        .filter(([, roots]) => roots.length > 0)
    if (members.length) {
        const [scope, roots] = members[0]
        hints.push(
            `${collapse(path)} has no identity of its own; the ${scope} sheet binds ${listOf(roots)}: override a member (@stylist override ${roots[0]} from "${from}";) or the sheet (@stylist override ${scope} from "${from}";).`,
        )
    } else {
        // a component that renders another one (Tooltip renders a Popover) styles what it adds with a
        // sheet of its own, named after it and binding no identity: that sheet is its override target
        const own = sheetNamedAfter(path, inNamespace)
        if (own) {
            const [scope, info] = own
            hints.push(
                `${collapse(path)} renders another component's identity; its own look is the ${scope} sheet: @stylist override ${scope} from "${from}"; (its parts: ${overridePartList(info.parts, false).join(", ")}).`,
            )
        }
    }
    if (!guess && !hints.length) hints.push("A component that renders another one has no sheet of its own: override the component it renders.")
    return { code: "unknown-target", message: `${path} is not a component of namespace "${namespace}" (from "${from}")${guess ? ` — did you mean "${guess}"?` : ""}${hints.length ? ` ${hints.join(" ")}` : ""}` }
}

/** `DatePicker` → `date-picker`, `UserMenu.Item` → `user-menu-item`. */
const kebab = (path: string): string => path.replace(/\./g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").toLowerCase()

/** The sheet of a namespace named after a component path (the whole path, or its family): `Tooltip` → `tooltip`, `Dropdown.Item` → `dropdown`. */
function sheetNamedAfter(path: string, scopes: ReadonlyArray<readonly [string, RegistryScope]>): readonly [string, RegistryScope] | null {
    const collapsed = collapse(path)
    for (const id of [kebab(collapsed), kebab(collapsed.split(".")[0])]) {
        const hit = scopes.find(([scope]) => scope === id)
        if (hit) return hit
    }
    return null
}

/**
 * Resolves the `:component()` references an override sheet uses as context against the design system:
 * `Path` in the target's namespace, `ns/Path` in that one. The target's own component (or a member of
 * its sheet) is written with its class, not as a reference.
 */
function resolveComponentRef(registry: Registry, target: OverrideTarget, ref: { arg: string; namespace: string | null; path: string }, from: string): { namespace: string; path: string; tag: string } | Failure {
    const namespace = ref.namespace ?? target.namespace
    const scopes = Object.entries(registry.scopes).filter(([, s]) => s.namespace === namespace)
    for (const [scope, info] of scopes) {
        const root = info.roots.find(r => sameComponent(r.component, ref.path))
        if (!root) continue
        if (scope === target.scope) {
            const own = root.local === target.rootPart && target.kind === "component" ? ".root" : `.${root.local}`
            return { code: "unresolved-ref", message: `:component(${ref.arg}) is an identity of the ${scope} sheet this sheet overrides — write ${own}` }
        }
        return { namespace, path: root.component, tag: root.tag }
    }
    if (!scopes.length) return { code: "unresolved-ref", message: `:component(${ref.arg}): the design system of "${from}" has no namespace "${namespace}"` }
    const guess = nearest(collapse(ref.path), scopes.flatMap(([, s]) => s.roots.map(r => collapse(r.component))))
    return {
        code: "unresolved-ref",
        message: `:component(${ref.arg}): ${collapse(ref.path)} is not a component of namespace "${namespace}" of the design system of "${from}"${guess ? ` — did you mean "${guess}"?` : ""} (an override's :component() names a component of the same design system; an app component is \`within\`)`,
    }
}

/** Resolves a `within [ns/]Path` against the app's registry: a root in the named namespace, or in exactly one of them. */
export function resolveWithin(registry: Registry | null | undefined, ref: ComponentRef): ResolvedWithin | Failure {
    const written = `${ref.namespace ? `${ref.namespace}/` : ""}${ref.path}`
    if (!registry) return { code: "unknown-within", message: `within ${written} needs the app's registry — build the workspace (libstylist build) with the override sheets` }
    const hits: ResolvedWithin[] = []
    for (const s of Object.values(registry.scopes)) {
        if (ref.namespace && s.namespace !== ref.namespace) continue
        for (const r of s.roots) if (sameComponent(r.component, ref.path)) hits.push({ namespace: s.namespace, path: r.component, tag: r.tag })
    }
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) {
        hits.sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0))
        return { code: "unknown-within", message: `within ${written} is ambiguous: ${hits.map(h => `${h.namespace}/${collapse(h.path)}`).join(", ")} — name the namespace, within ${hits[0].namespace}/${collapse(ref.path)}` }
    }
    const candidates = Object.values(registry.scopes).filter(s => !ref.namespace || s.namespace === ref.namespace).flatMap(s => s.roots.map(r => collapse(r.component)))
    const guess = nearest(collapse(ref.path), candidates)
    return { code: "unknown-within", message: `within ${written}: the app has no component ${collapse(ref.path)}${ref.namespace ? ` in namespace "${ref.namespace}"` : ""}${guess ? ` — did you mean "${guess}"?` : ""}` }
}

/**
 * Resolves one override sheet (pass 1 facts from `collectOverrideSheet`): its package, design system,
 * target, parts, resets and `within`. Returns the resolved sheet, or null with the errors.
 */
export function resolveOverrideSheet(info: OverrideSheetInfo, ctx: ResolveOverridesContext): { sheet: ResolvedOverrideSheet | null; errors: RegistryError[] } {
    const errors: RegistryError[] = []
    const fail = (code: RegistryErrorCode, line: number | undefined, message: string) => errors.push({ code, message: `${where(info.file, line)}: ${message}`, files: [info.file] })
    for (const e of info.errors) fail("invalid-override", e.line, e.message)
    const override = info.override
    if (!override || errors.length) return { sheet: null, errors }

    const line = override.line
    const pkg = ctx.resolvePackage(override.from, info.file)
    if ("error" in pkg) {
        fail("unresolved-package", line, `from "${override.from}": ${pkg.error}`)
        return { sheet: null, errors }
    }
    if (pkg.prefix === ctx.app.prefix) {
        fail("unresolved-package", line, `"${override.from}" is a package of the app itself (prefix "${pkg.prefix}") — an override sheet restyles a design-system component; style an app component in its own sheet`)
        return { sheet: null, errors }
    }
    const registry = ctx.designSystems.find(r => r.prefix === pkg.prefix)
    if (!registry) {
        const configured = sorted(ctx.designSystems.map(r => r.prefix))
        fail("unresolved-package", line, `"${override.from}" belongs to the design system of prefix "${pkg.prefix}", whose registry is not configured (css.overrides.registries${configured.length ? `: prefix ${configured.join(", ")}` : " is empty"})`)
        return { sheet: null, errors }
    }
    const target = resolveOverrideTarget(registry, pkg.namespace, override.target, override.from)
    if (isFailure(target)) {
        fail(target.code, line, target.message)
        return { sheet: null, errors }
    }
    const scope = registry.scopes[target.scope] as RegistryScope
    const componentForm = target.kind === "component"

    let within: ResolvedWithin | null = null
    if (override.within) {
        const hit = resolveWithin(ctx.app.registry, override.within)
        if (isFailure(hit)) fail(hit.code, line, hit.message)
        else within = hit
    }

    // the classes the selectors use
    const uses: string[] = []
    for (const c of info.classes) {
        if (c.name === "root" && componentForm) continue
        if (hasOwn(scope.parts, c.name)) uses.push(c.name)
        else if (c.name === "root") fail("unknown-part", c.line, `${target.label} has no "root" part — in an override of a sheet, .root is that sheet's root part. Its parts: ${overridePartList(scope.parts, false).join(", ")}`)
        else fail("unknown-part", c.line, unknownPartMessage(target.label, c.name, scope.parts, componentForm))
    }

    // the other components of the context
    const components: ResolvedOverrideSheet["components"] = []
    for (const ref of info.components) {
        const hit = resolveComponentRef(registry, target, ref, override.from)
        if (isFailure(hit)) fail(hit.code, ref.line, hit.message)
        else components.push({ arg: ref.arg, ...hit })
    }

    // resets
    const resets = new Map<string, number | undefined>()
    let whole = false
    for (const r of info.resets) {
        if (override.within) {
            fail("reset-within", r.line, `@stylist reset in a sheet scoped with within — a reset edits the design system's stylesheets at build time, so it can't depend on where ${target.label} renders; reset it in the global override sheet of ${collapse(target.path ?? target.scope)}`)
            continue
        }
        if (r.parts.length === 0) {
            if (componentForm) {
                const own = collapse(target.path as string)
                const others = scope.roots.map(x => collapse(x.component)).filter(c => c !== own && !c.startsWith(`${own}.`))
                if (others.length) {
                    fail("shared-reset", r.line, `@stylist reset; resets the whole ${target.scope} sheet, which also styles ${listOf(others)} — reset ${own}'s parts by name (@stylist reset <part> …;), or override the sheet (@stylist override ${target.scope} from "${override.from}";) to reset all of it`)
                    continue
                }
            }
            whole = true
            for (const part of Object.keys(scope.parts)) resets.set(part, r.line)
            continue
        }
        for (const name of r.parts) {
            const part = name === "root" && componentForm ? (target.rootPart as string) : name
            if (!hasOwn(scope.parts, part)) {
                fail("unknown-part", r.line, name === "root" ? `${target.label} has no "root" part to reset. Its parts: ${overridePartList(scope.parts, false).join(", ")}` : unknownPartMessage(target.label, name, scope.parts, componentForm))
                continue
            }
            resets.set(part, r.line)
        }
    }

    for (const local of info.keyframes) {
        if (hasOwn(scope.keyframes, local)) fail("keyframes-clash", line, `@keyframes ${local}: ${target.label} has keyframes "${local}" too, so "animation: ${local}" would be ambiguous — rename yours`)
    }
    if (errors.length) return { sheet: null, errors }

    const tagOf = new Map(scope.roots.map(r => [r.local, r.tag]))
    const resetTargets = sorted(resets.keys()).map((part): ResetTarget => ({
        prefix: registry.prefix,
        namespace: target.namespace,
        scope: target.scope,
        part,
        attr: scope.parts[part],
        label: `${registry.prefix}:${target.namespace}/${target.scope}:${part}`,
        tag: tagOf.get(part) ?? null,
        sheet: info.file,
        line: resets.get(part),
        ...(whole ? { whole: true } : {}),
    }))
    const sheet: ResolvedOverrideSheet = {
        file: info.file,
        id: info.id,
        target,
        from: override.from,
        within,
        uses: sorted(uses),
        components,
        resets: sorted(resets.keys()),
        whole,
        resetTargets,
        plugin: {
            prefix: registry.prefix,
            appPrefix: ctx.app.prefix,
            label: target.label,
            parts: scope.parts,
            identity: target.tag,
            keyframes: scope.keyframes,
            sheetId: info.id,
            within: within?.tag ?? null,
            components: Object.fromEntries(components.map(c => [c.arg, c.tag])),
        },
    }
    return { sheet, errors }
}

/** The lock sections of resolved override sheets (SPEC §7): identities read (targets and `:component()` context) and parts read or reset, and the resets. */
export function overrideLock(sheets: readonly ResolvedOverrideSheet[]): OverrideLock {
    const overrides: Record<string, string> = {}
    const resets: Record<string, string> = {}
    for (const s of sheets) {
        const base = `${s.target.prefix}:${s.target.namespace}`
        if (s.target.path && s.target.tag) overrides[`${base}/${s.target.path}`] = s.target.tag
        for (const c of s.components) overrides[`${s.target.prefix}:${c.namespace}/${c.path}`] = c.tag
        for (const part of new Set([...s.uses, ...s.resets])) overrides[`${base}/${s.target.scope}:${part}`] = s.plugin.parts[part]
        for (const part of s.resets) resets[`${base}/${s.target.scope}:${part}`] = s.plugin.parts[part]
    }
    return { overrides: sortKeys(overrides), resets: sortKeys(resets) }
}

/**
 * Resolves every override sheet of an app (SPEC §9.3): each on its own ({@link resolveOverrideSheet}),
 * then across sheets — sheet ids are unique (they namespace keyframes), and one design-system sheet has
 * at most one global override sheet and one per `within` component (`duplicate-override`: two sheets in
 * one layer would be ordered by file name). Returns the resolved sheets, their reset targets and the
 * lock sections; any error is fatal.
 */
export function resolveOverrides(input: ResolveOverridesInput): ResolveOverridesResult {
    const errors: RegistryError[] = []
    const resolved: ResolvedOverrideSheet[] = []
    const ids = new Map<string, string>()
    for (const info of input.sheets) {
        const owner = ids.get(info.id)
        if (owner !== undefined) {
            errors.push({ code: "invalid-override", message: `${owner} and ${info.file} are both override sheet "${info.id}" — the sheet id namespaces its keyframes; rename one`, files: [owner, info.file] })
            continue
        }
        ids.set(info.id, info.file)
        const r = resolveOverrideSheet(info, input)
        errors.push(...r.errors)
        if (r.sheet) resolved.push(r.sheet)
    }
    const owners = new Map<string, ResolvedOverrideSheet>()
    const sheets: ResolvedOverrideSheet[] = []
    for (const sheet of resolved) {
        const key = `${sheet.target.prefix}\u0000${sheet.target.scope}\u0000${sheet.within?.tag ?? ""}`
        const owner = owners.get(key)
        if (owner) {
            errors.push({
                code: "duplicate-override",
                message: `${owner.file} and ${sheet.file} both override the ${sheet.target.scope} sheet of the "${sheet.target.prefix}" design system${sheet.within ? ` within ${collapse(sheet.within.path)}` : ""} (${owner.target.label}, ${sheet.target.label}) — one override sheet per design-system sheet${sheet.within ? " and within component" : ""} keeps the cascade deterministic: merge them`,
                files: [owner.file, sheet.file],
            })
            continue
        }
        owners.set(key, sheet)
        sheets.push(sheet)
    }
    const resets = sheets.flatMap(s => s.resetTargets).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    return { sheets, resets, lock: overrideLock(sheets), errors }
}
