// Smoke test over the design system's real stylesheets (read-only; the checkout LIBSTYLIST_DESIGN_SYSTEM
// names — see ./design-system.ts; skipped without it): every sheet goes through postcss-nesting + the
// plugin; the audit must pass and every rewritten rule must keep the specificity of its flattened
// source, rule by rule and selector by selector.
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { test } from "node:test"

import postcss, { type Root } from "postcss"
import nesting from "postcss-nesting"

import {
    displayDefaultRule,
    findClassSelectors,
    formatSpecificity,
    isKeyframesAtRule,
    specificityList,
    stylist,
} from "../src/postcss/index.js"
import { buildRegistry, stylistOptions, type Registry, type RegistryGroup } from "../src/registry/index.js"
import { designSystemPath, skipWithoutDesignSystem } from "./design-system.js"

const skip = skipWithoutDesignSystem

const GROUPS: Record<string, RegistryGroup> = {
    components: { namespace: "core" },
    "app-ui": { namespace: "app" },
    player: { namespace: "player" },
    gram: { namespace: "gram" },
    infinity: { namespace: "inf" },
    ai: { namespace: "ai" },
    code: { namespace: "code", word: "Code" },
    devtools: { namespace: "devtools", word: "DevTools" },
    clickmaps: { namespace: "clickmaps", word: "Clickmap" },
    charts: { namespace: "charts", word: "Chart" },
    "replay-inspector": { namespace: "replayinspector", word: "Inspector" },
    unity: { namespace: "unity", word: "Unity" },
    rich: { namespace: "rich", word: "Rich" },
}

interface RealSheet {
    file: string
    group: string
    scope: string
    css: string
}

interface RealSheets {
    sheets: RealSheet[]
    registry: Registry
    errors: ReturnType<typeof buildRegistry>["errors"]
}

/** The real sheets and the registry built from them, read once per process and only when a gated test runs. */
let cached: RealSheets | undefined
function real(): RealSheets {
    if (cached) return cached
    const sheets: RealSheet[] = Object.keys(GROUPS).flatMap(group =>
        readdirSync(designSystemPath("packages", "css", "src", group))
            .filter(f => f.endsWith(".css"))
            .sort()
            .map(f => ({ file: `packages/css/src/${group}/${f}`, group, scope: f.slice(0, -4), css: readFileSync(designSystemPath("packages", "css", "src", group, f), "utf8") })),
    )
    const { registry, errors } = buildRegistry({ prefix: "elo", groups: GROUPS, sheets })
    return (cached = { sheets, registry, errors })
}

const ruleSelectors = (root: Root): string[] => {
    const out: string[] = []
    root.walkRules(r => {
        if (!isKeyframesAtRule(r.parent as never)) out.push(r.selector)
    })
    return out
}

const flatten = async (s: RealSheet) => (await postcss([nesting()]).process(s.css, { from: designSystemPath(s.file) })).css

const pluginFor = (registry: Registry, s: RealSheet) => stylist({ ...stylistOptions(registry, s.scope, GROUPS), reportGlobals: false })

/**
 * The display defaults a flipped sheet declares (`@stylist root … display <kw>`, SPEC §4.2 step 6): new
 * zero-specificity rules on the custom tags, emitted first in the sheet, with no legacy counterpart —
 * a custom element is `inline` where the `div` it replaces was `block`. The comparisons below set them
 * aside (and check they are exactly the declared ones), like verify-migration's `expectDisplay`.
 */
const displayDefaults = (registry: Registry, s: RealSheet) =>
    registry.scopes[s.scope].roots.filter(r => r.display && displayDefaultRule(r.tag, r.display)).map(r => ({ tag: r.tag, display: r.display as string }))
const displaySelectors = (registry: Registry, s: RealSheet) => new Set(displayDefaults(registry, s).map(d => `:where(${d.tag}:not([hidden]))`))

/** The rule selectors of a plugin output without the sheet's declared display defaults (asserted present). */
const outputSelectors = (registry: Registry, s: RealSheet, root: Root): string[] => {
    const all = ruleSelectors(root)
    const display = displaySelectors(registry, s)
    const rest = all.filter(sel => !display.has(sel))
    assert.equal(all.length - rest.length, display.size, `${s.file}: one display default per declared display root`)
    return rest
}

test("real sheets: registry is clean", { skip }, () => {
    const { sheets, errors } = real()
    assert.ok(sheets.length >= 80, `expected the design system's sheets, found ${sheets.length}`)
    assert.deepEqual(errors, [])
})

test("real sheets: plugin audit passes and every rule keeps its specificity", { skip }, async t => {
    const { sheets, registry } = real()
    let rules = 0
    let globalRules = 0
    const mismatches: string[] = []
    for (const s of sheets) {
        const flat = await flatten(s)
        const source = ruleSelectors(postcss.parse(flat))
        const result = await postcss([pluginFor(registry, s)]).process(flat, { from: designSystemPath(s.file) })
        const output = outputSelectors(registry, s, result.root)
        assert.equal(output.length, source.length, `${s.file}: rule count changed`)
        // audit (the plugin throws on a surviving local class); only :global() splices may remain
        const survivors = findClassSelectors(result.root).map(h => h.className)
        const allowed = new Set(registry.scopes[s.scope].globals.flatMap(g => [...g.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1])))
        assert.deepEqual(survivors.filter(c => !allowed.has(c)), [], `${s.file}: classes survived outside :global()`)
        source.forEach((before, i) => {
            rules++
            if (before.includes(":global")) {
                globalRules++
                return
            }
            const a = specificityList(before)
            const b = specificityList(output[i])
            if (a.length !== b.length || a.some((x, j) => formatSpecificity(x) !== formatSpecificity(b[j]))) {
                mismatches.push(`${s.file}: ${before} ${a.map(formatSpecificity)} → ${output[i]} ${b.map(formatSpecificity)}`)
            }
        })
    }
    assert.deepEqual(mismatches, [])
    assert.ok(rules > 900)
    t.diagnostic(`${sheets.length} sheets, ${rules} rules compared; ${globalRules} rules with legacy :global() excluded from the specificity check`)
})

test("real sheets: :global() rules keep their specificity too (spliced verbatim)", { skip }, async () => {
    const { sheets, registry } = real()
    for (const s of sheets) {
        const flat = await flatten(s)
        const source = ruleSelectors(postcss.parse(flat))
        const output = outputSelectors(registry, s, (await postcss([pluginFor(registry, s)]).process(flat, { from: designSystemPath(s.file) })).root)
        source.forEach((before, i) => {
            if (before.includes(":global")) assert.deepEqual(specificityList(output[i]), specificityList(before), `${s.file}: ${before}`)
        })
    }
})
