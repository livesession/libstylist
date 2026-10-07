// Part-map modules (the css package's `classes.*` / `<group>-classes.*` exports): one export per
// scope, `{ [part]: attr, $tags: { [ComponentPath]: tag } }`, as ESM, CJS and a literal-typed d.ts.
import type { Registry, RegistryScope } from "./types.js"

// Every ECMAScript reserved word (and strict-mode/future one) that a camelCased scope could
// spell — a superset of the list in packages/css/scripts/build.ts, so names match it wherever
// that list produced valid JavaScript.
const RESERVED = new Set([
    "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
    "export", "extends", "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof", "interface",
    "let", "new", "null", "package", "private", "protected", "public", "return", "static", "super", "switch", "this", "throw",
    "true", "try", "typeof", "var", "void", "while", "with", "yield",
])

/** The export name of a scope's part map: camelCase, reserved words suffixed (`switch` → `switchClasses`). */
export function exportName(scope: string): string {
    const name = scope.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    return RESERVED.has(name) ? `${name}Classes` : name
}

export interface PartMapModules {
    mjs: string
    cjs: string
    dts: string
}

/** The value exported for one scope: its parts plus `$tags` (component path → tag). */
export function partMapValue(scope: RegistryScope): Record<string, string | Record<string, string>> {
    const $tags: Record<string, string> = {}
    for (const r of scope.roots) $tags[r.component] = r.tag
    return { ...scope.parts, $tags }
}

/** Renders the part-map modules of one css group (every scope whose `group` matches). */
export function toPartMapModules(registry: Registry, group: string): PartMapModules {
    const seen = new Map<string, string>()
    const entries: Array<{ name: string; value: Record<string, string | Record<string, string>> }> = []
    for (const [scope, info] of Object.entries(registry.scopes)) {
        if (info.group !== group) continue
        const name = exportName(scope)
        if (seen.has(name)) throw new Error(`libstylist: scopes "${seen.get(name)}" and "${scope}" both export as "${name}"`)
        seen.set(name, scope)
        entries.push({ name, value: partMapValue(info) })
    }
    if (entries.length === 0) return { mjs: "export {};\n", cjs: "", dts: "export {};\n" }
    const json = (v: unknown) => JSON.stringify(v, null, 2)
    return {
        mjs: entries.map(e => `export const ${e.name} = ${json(e.value)};`).join("\n\n") + "\n",
        cjs: entries.map(e => `exports.${e.name} = ${json(e.value)};`).join("\n\n") + "\n",
        dts: entries.map(e => `export declare const ${e.name}: ${literalType(e.value, "")};`).join("\n\n") + "\n",
    }
}

function literalType(value: Record<string, string | Record<string, string>>, indent: string): string {
    const keys = Object.keys(value)
    if (keys.length === 0) return "{}"
    const inner = `${indent}  `
    const fields = keys.map(key => {
        const v = value[key]
        const type = typeof v === "string" ? JSON.stringify(v) : literalType(v, inner)
        return `${inner}readonly ${JSON.stringify(key)}: ${type};`
    })
    return `{\n${fields.join("\n")}\n${indent}}`
}
