// Source of the runtime helpers served as `virtual:libstylist/runtime`, so library builds bundle them.
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

let cached: Promise<string> | null = null

/**
 * The runtime module as ESM JavaScript: the compiled `dist/runtime/index.js` next to this module, or —
 * when running from source — `src/runtime/index.ts` with its types stripped by Vite's esbuild.
 */
export function runtimeSource(): Promise<string> {
    cached ??= load().catch((e: unknown) => {
        cached = null
        throw e
    })
    return cached
}

async function load(): Promise<string> {
    const here = dirname(fileURLToPath(import.meta.url))
    const js = join(here, "..", "runtime", "index.js")
    if (existsSync(js)) return readFileSync(js, "utf8")
    const ts = join(here, "..", "runtime", "index.ts")
    const { transformWithEsbuild } = await import("vite")
    const result = await transformWithEsbuild(readFileSync(ts, "utf8"), ts, { loader: "ts", format: "esm", target: "es2020", sourcemap: false })
    return result.code
}
