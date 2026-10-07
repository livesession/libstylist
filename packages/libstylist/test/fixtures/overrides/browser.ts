// Headless Chromium for the computed-style proofs of override sheets and resets: jsdom and happy-dom
// implement no layered cascade (happy-dom drops rules inside `@layer` blocks), so only a browser can say
// which declaration wins. Playwright is not a dependency of libstylist: `playwright-core` comes from
// LIBSTYLIST_PLAYWRIGHT (a package directory), from libstylist's resolution, or from an ancestor pnpm
// store (the design-system checkout has one for its Storybook harnesses); the tests skip when none is
// found or Chromium is not installed.
import { existsSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface Page {
    setContent(html: string): Promise<void>
    evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>
}
export interface Browser {
    newPage(): Promise<Page>
    close(): Promise<void>
}
type Chromium = { launch(): Promise<Browser> }

const HERE = dirname(fileURLToPath(import.meta.url))

function findPlaywright(): string | null {
    if (process.env.LIBSTYLIST_PLAYWRIGHT) return process.env.LIBSTYLIST_PLAYWRIGHT
    try {
        return dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"))
    } catch {
        // not resolvable from libstylist: look for a pnpm store above
    }
    for (let dir = HERE; ; dir = dirname(dir)) {
        const store = join(dir, "node_modules", ".pnpm")
        if (existsSync(store)) {
            const hit = readdirSync(store).filter(d => /^playwright-core@\d/.test(d)).sort().pop()
            if (hit) return join(store, hit, "node_modules", "playwright-core")
        }
        if (dirname(dir) === dir) return null
    }
}

/** A launched Chromium, or why there is none (the test's skip reason). */
export async function launch(): Promise<Browser | string> {
    const dir = findPlaywright()
    if (!dir) return "no playwright-core found (set LIBSTYLIST_PLAYWRIGHT to a playwright-core package directory)"
    try {
        const { chromium } = createRequire(join(dir, "package.json"))(dir) as { chromium: Chromium }
        return await chromium.launch()
    } catch (err) {
        return `Chromium is not available: ${(err as Error).message.split("\n")[0]}`
    }
}

/** Every computed property that differs between two elements (same parent, so inherited values agree). */
export function differences(p: Page, a: string, b: string): Promise<string[]> {
    return p.evaluate(([x, y]) => {
        const [csa, csb] = [x, y].map(id => getComputedStyle(document.getElementById(id) as Element))
        const out: string[] = []
        for (let i = 0; i < csa.length; i++) {
            const prop = csa[i]
            if (csa.getPropertyValue(prop) !== csb.getPropertyValue(prop)) out.push(`${prop}: ${csa.getPropertyValue(prop)} ≠ ${csb.getPropertyValue(prop)}`)
        }
        return out
    }, [a, b])
}

/** The computed values of `props` on the element with id `id`. */
export const computed = (p: Page, id: string, props: string[]): Promise<Record<string, string>> =>
    p.evaluate(([el, names]) => {
        const cs = getComputedStyle(document.getElementById(el as string) as Element)
        return Object.fromEntries((names as string[]).map(n => [n, cs.getPropertyValue(n)]))
    }, [id, props] as const)
