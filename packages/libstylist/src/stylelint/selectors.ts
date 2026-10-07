// Selector helpers shared by the libstylist stylelint rules: raw selector access, the
// libstylist pseudo-classes (`:component()`, `:cx()`, `:global()` — SPEC §4.2), masking of
// their non-selector arguments, nesting resolution and compound splitting.
import type { AtRule, Node as PostcssNode, Rule } from "postcss"
import parser from "postcss-selector-parser"

/** Pseudo-classes whose argument is not a selector (a component path, a `scope:part` ref). */
export const OPAQUE_PSEUDOS: readonly string[] = ["component", "cx"]

/** Every pseudo-class libstylist adds to source CSS. */
export const STYLIST_PSEUDOS: readonly string[] = ["component", "cx", "global"]

/** A `:name(…)` call found in raw selector text. Indices are relative to that text. */
export interface PseudoCall {
    /** Lowercased name without the colon (`component`). */
    name: string
    /** The name as written (`Component`); the build only recognizes the lowercase spelling. */
    written: string
    /** Index of the `:`. */
    start: number
    /** Index of the first argument character; -1 when written without parentheses. */
    argStart: number
    /** Index of the closing `)`; -1 when written without parentheses or left unbalanced. */
    argEnd: number
    /** The argument text as written (untrimmed). */
    arg: string
}

/** The selector exactly as written, comments included — what report indices are relative to. */
export function ruleSelector(rule: Rule): string {
    const raw = (rule.raws as { selector?: { raw?: string } }).selector?.raw
    return raw ?? rule.selector
}

const skipString = (text: string, from: number): number => {
    const quote = text[from]
    let i = from + 1
    while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1
    return i + 1
}

const skipComment = (text: string, from: number): number => {
    const end = text.indexOf("*/", from + 2)
    return end < 0 ? text.length : end + 2
}

/** Index of the `)` matching the `(` at `open`, or -1 when unbalanced. */
export function matchParen(text: string, open: number): number {
    let depth = 0
    let i = open
    while (i < text.length) {
        const ch = text[i]
        if (ch === "\\") {
            i += 2
            continue
        }
        if (ch === "\"" || ch === "'") {
            i = skipString(text, i)
            continue
        }
        if (ch === "/" && text[i + 1] === "*") {
            i = skipComment(text, i)
            continue
        }
        if (ch === "(") depth++
        else if (ch === ")" && --depth === 0) return i
        i++
    }
    return -1
}

/**
 * Finds `:name(…)` calls for the given pseudo-class names in raw selector text, skipping
 * strings, comments, escapes and pseudo-elements. The interiors of opaque calls
 * (`:component()`, `:cx()`) are not scanned; the interiors of other calls are.
 */
export function findPseudoCalls(selector: string, names: readonly string[]): PseudoCall[] {
    const calls: PseudoCall[] = []
    let i = 0
    while (i < selector.length) {
        const ch = selector[i]
        if (ch === "\\") {
            i += 2
            continue
        }
        if (ch === "\"" || ch === "'") {
            i = skipString(selector, i)
            continue
        }
        if (ch === "/" && selector[i + 1] === "*") {
            i = skipComment(selector, i)
            continue
        }
        if (ch === ":" && selector[i + 1] !== ":" && selector[i - 1] !== ":") {
            const match = /^[A-Za-z_-][A-Za-z0-9_-]*/.exec(selector.slice(i + 1))
            if (match) {
                const written = match[0]
                const name = written.toLowerCase()
                const after = i + 1 + written.length
                if (names.includes(name)) {
                    if (selector[after] === "(") {
                        const close = matchParen(selector, after)
                        const arg = close < 0 ? selector.slice(after + 1) : selector.slice(after + 1, close)
                        calls.push({ name, written, start: i, argStart: after + 1, argEnd: close, arg })
                        if (OPAQUE_PSEUDOS.includes(name)) {
                            i = close < 0 ? selector.length : close + 1
                            continue
                        }
                    } else {
                        calls.push({ name, written, start: i, argStart: -1, argEnd: -1, arg: "" })
                    }
                }
                i = after
                continue
            }
        }
        i++
    }
    return calls
}

/**
 * Replaces the arguments of the named pseudo-classes with same-length filler (line breaks kept),
 * so every index stays aligned with the raw text. A call nested inside a masked one is covered by
 * the outer mask.
 */
export function maskPseudoArgs(selector: string, names: readonly string[]): string {
    const calls = findPseudoCalls(selector, names).filter((c) => c.argStart >= 0 && c.argEnd >= 0)
    if (calls.length === 0) return selector
    let out = ""
    let last = 0
    for (const call of calls) {
        if (call.argStart < last) continue
        out += selector.slice(last, call.argStart)
        out += call.arg.replace(/[^\n]/g, "_")
        last = call.argEnd
    }
    return out + selector.slice(last)
}

/**
 * Masks the arguments of `:component()`/`:cx()`, so selectors like `:component(core/Modal.Header)`
 * parse and `Modal.Header` / `scope:part` are not read as classes or pseudo-classes.
 */
export const maskOpaque = (selector: string): string => maskPseudoArgs(selector, OPAQUE_PSEUDOS)

/** The message stylelint's core rules use for an unparseable selector. */
export const parseErrorText = (error: unknown): string => `Cannot parse selector (${String(error)})`

/**
 * Parses a selector after masking opaque arguments. Returns the AST, or the parse error's message
 * (worded like stylelint's own) when the selector can't be parsed.
 */
export function tryParseSelector(selector: string): parser.Root | string {
    try {
        return parser().astSync(maskOpaque(selector))
    } catch (error) {
        return parseErrorText(error)
    }
}

/** Parses a selector (after masking opaque arguments); `null` when it can't be parsed. */
export function parseSelector(selector: string): parser.Root | null {
    const ast = tryParseSelector(selector)
    return typeof ast === "string" ? null : ast
}

/** The pseudo-class name without colons, lowercased (`:Component` → `component`). */
export const pseudoName = (node: parser.Pseudo): string => node.value.replace(/^:+/, "").toLowerCase()

/** True for the pseudo-classes whose arguments name foreign things (`:global`, `:component`, `:cx`). */
export const isForeignPseudo = (node: parser.Pseudo): boolean => STYLIST_PSEUDOS.includes(pseudoName(node))

/** True for `:component()`/`:cx()`, whose arguments are not selectors. */
export const isOpaquePseudo = (node: parser.Pseudo): boolean => OPAQUE_PSEUDOS.includes(pseudoName(node))

/** Any selector container: the root list, a selector, or a pseudo-class with arguments. */
export type AnyContainer = parser.Container<string | undefined, parser.Node>

/** Depth-first walk that does not descend into pseudo-classes matched by `skip`. */
export function walkSkipping(container: AnyContainer, visit: (node: parser.Node) => void, skip: (pseudo: parser.Pseudo) => boolean): void {
    container.each((node: parser.Node) => {
        visit(node)
        if (node.type === "pseudo" && skip(node)) return
        if ("nodes" in node && Array.isArray(node.nodes)) walkSkipping(node as AnyContainer, visit, skip)
    })
}

export interface Compounds {
    /** Compound selectors left to right; a relative selector (`> .x`) starts with an empty one. */
    compounds: parser.Node[][]
    /** `combinators[i]` joins `compounds[i]` and `compounds[i + 1]` (`" "`, `">"`, `"+"`, `"~"`). */
    combinators: string[]
}

/** Splits one complex selector into compounds and the combinators between them. */
export function splitCompounds(selector: parser.Selector): Compounds {
    const compounds: parser.Node[][] = [[]]
    const combinators: string[] = []
    for (const node of selector.nodes) {
        if (node.type === "comment") continue
        if (node.type === "combinator") {
            combinators.push(node.value.trim() || " ")
            compounds.push([])
            continue
        }
        compounds[compounds.length - 1].push(node)
    }
    return { compounds, combinators }
}

/** True when the node sits inside a `@keyframes` block (its "selectors" are keyframe offsets). */
export function inKeyframes(node: PostcssNode): boolean {
    for (let p = node.parent; p; p = p.parent) {
        if (p.type === "atrule" && /keyframes$/i.test((p as unknown as AtRule).name)) return true
    }
    return false
}

/** The nearest enclosing style rule, skipping at-rules (`@media`, `@layer`, …). */
export function parentRule(node: PostcssNode): Rule | undefined {
    for (let p = node.parent; p; p = p.parent) {
        if (p.type === "rule") return p as Rule
    }
    return undefined
}

/** The top-level complex selectors of a selector list, as written (trimmed). */
export function splitSelectorList(selector: string): string[] | null {
    const ast = parseSelector(selector)
    if (!ast) return null
    const out: string[] = []
    let from = 0
    // Slice the raw text (not the masked AST) so opaque arguments survive for display.
    for (let i = 0; i < ast.nodes.length; i++) {
        const next = ast.nodes[i + 1]
        const end = next ? next.sourceIndex - 1 : selector.length
        const piece = selector.slice(from, end).replace(/^\s*,?\s*/, "").trim()
        if (piece) out.push(piece)
        from = end
    }
    return out
}

const MAX_RESOLVED = 512

/**
 * Resolves CSS-nesting selectors to full complex selectors, the way `postcss-nesting` flattens
 * them: `&` is replaced by the parent selector (wrapped in `:is()` when it is complex and sits
 * mid-compound) and relative children get the parent prepended. Opaque arguments are kept as
 * written. Results are cached per rule.
 */
export class NestingResolver {
    private readonly cache = new Map<Rule, string[]>()

    resolve(rule: Rule): string[] {
        const hit = this.cache.get(rule)
        if (hit) return hit
        const own = splitSelectorList(ruleSelector(rule)) ?? []
        const parent = parentRule(rule)
        let resolved = own
        if (parent) {
            resolved = []
            outer: for (const p of this.resolve(parent)) {
                for (const child of own) {
                    const combined = combineNested(p, child)
                    if (combined !== null) resolved.push(combined)
                    if (resolved.length >= MAX_RESOLVED) break outer
                }
            }
        }
        this.cache.set(rule, resolved)
        return resolved
    }
}

/** Resolves one nested complex selector against one parent complex selector. */
export function combineNested(parent: string, child: string): string | null {
    const ast = parseSelector(child)
    if (!ast) return null
    const nestings: parser.Nesting[] = []
    ast.walkNesting((node) => {
        nestings.push(node)
    })
    if (nestings.length === 0) return `${parent} ${child}`
    const complex = /[\s>+~,]/.test(maskOpaque(parent))
    let out = child
    for (const node of nestings.sort((a, b) => b.sourceIndex - a.sourceIndex)) {
        const prev = node.prev()
        const midCompound = prev !== undefined && prev.type !== "combinator"
        const replacement = midCompound && complex ? `:is(${parent})` : parent
        out = out.slice(0, node.sourceIndex) + replacement + out.slice(node.sourceIndex + 1)
    }
    return out
}

/**
 * The index inside `node`'s source text of an absolute `line`/`column` position (as carried by a
 * postcss Warning), or undefined when the node has no usable source.
 */
export function indexAt(node: PostcssNode, line: number, column: number): number | undefined {
    const source = node.source
    const input = source?.input as ({ css: string; document?: string } | undefined)
    const start = source?.start
    if (!input || !start || start.offset === undefined) return undefined
    const text = input.document ?? input.css
    let l = start.line
    let c = start.column
    for (let i = start.offset; i <= text.length; i++) {
        if (l === line && c === column) return i - start.offset
        if (l > line) return undefined
        if (text[i] === "\n") {
            l++
            c = 1
        } else {
            c++
        }
    }
    return undefined
}
