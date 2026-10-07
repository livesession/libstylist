// The checker's side of the shared forwarding predicate (`carriesProps`, core): which bindings are the
// component's props. ESLint's forward-props suite (eslint-rules-identity.test.ts) pins the same cases.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

import ts from "typescript"

import { CxReader } from "../src/check/cx.js"

const tmp = mkdtempSync(join(tmpdir(), "libstylist-props-"))
after(() => rmSync(tmp, { recursive: true, force: true }))

/** `carriesProps` for the argument of every `probe(…)` call in `code`, in source order. */
function probes(code: string): boolean[] {
    const file = join(tmp, "probe.tsx")
    writeFileSync(file, `declare function probe(x: unknown): unknown\n${code}`)
    const program = ts.createProgram([file], { jsx: ts.JsxEmit.Preserve, noEmit: true, strict: false, types: [] })
    const reader = new CxReader(program.getTypeChecker(), null, null)
    const out: boolean[] = []
    const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "probe") out.push(reader.carriesProps(n.arguments[0]))
        ts.forEachChild(n, visit)
    }
    visit(program.getSourceFile(file)!)
    return out
}

// review open issue: a `.map((item) => …)` parameter was accepted as the component's props, so
// `cx(cn.root, item)` on an identity element inside a map passed R112 / forward-props
test("a callback's parameter, or a later parameter, is never the component's props", () => {
    const code = `
declare function memo<T>(f: T): T
declare function forwardRef<T>(f: T): T
declare function observer<T>(f: T): T
declare const React: { memo<T>(f: T): T; forwardRef<T>(f: T): T }
declare const items: Array<Record<string, string>>
export function A(props: object) { return probe(props) }
export function B(props: object) { return items.map((item) => probe(item)) }
export function C(props: object) { return items.map(({ id, ...rest }) => probe(rest)) }
export function D(props: object) { return items.forEach(function (item) { probe(item) }) }
export const E = forwardRef((props: object, ref: object) => [probe(props), probe(ref)])
export const F = React.memo(({ ...rest }: object) => probe(rest))
export const G = Object.assign((props: object) => probe(props), { X: 1 })
export const H = observer(function H(props: object) { return probe(props) })
export function I({ items, ...rest }: any) { return items.map((i: unknown) => probe(rest)) }
export function J(props: object) { const render = (p: object) => probe(p); return render(props) }
export const K = React.forwardRef(((props: object) => probe(props)) as any)
export const L = memo((props: object) => probe(props), (prev: object, next: object) => !!probe(prev))
`
    assert.deepEqual(probes(code), [
        true, // A: the parameter
        false, // B: a .map callback's parameter
        false, // C: …or the rest of its pattern
        false, // D: a function-expression callback
        true, // E: forwardRef's first parameter…
        false, // …but not its ref
        true, // F: React.memo's pattern rest
        true, // G: Object.assign's root
        true, // H: observer
        true, // I: the outer rest, read inside a callback
        true, // J: a local helper (not a callback) receives what it is called with
        true, // K: through a cast
        true, // L: memo's component…
        false, // …but not its comparator (a later argument)
    ])
})
