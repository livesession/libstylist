// Text plumbing for `libstylist migrate-selectors`: offset edits applied to the original source (so
// formatting outside a rewrite never changes), line/column lookup, templated text (a template
// literal's quasis joined by placeholders, mapped back to source offsets) and the small scanners
// the CSS side needs (animation-value tokens, `//` comment masking for SCSS/LESS without a parser).

export interface Edit {
    start: number
    end: number
    text: string
}

/** Applies non-overlapping edits to `code`; throws when two edits overlap. */
export function applyEdits(code: string, edits: readonly Edit[]): string {
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
    let out = ""
    let last = 0
    for (const edit of sorted) {
        if (edit.start < last) throw new Error(`overlapping edits at ${edit.start}`)
        out += code.slice(last, edit.start) + edit.text
        last = edit.end
    }
    return out + code.slice(last)
}

/** Shifts edits by `delta` (a selector's offset inside the file). */
export const shiftEdits = (edits: readonly Edit[], delta: number): Edit[] => edits.map((e) => ({ start: e.start + delta, end: e.end + delta, text: e.text }))

/** 1-based line/column of offsets in one text. */
export class LineIndex {
    private readonly starts: number[] = [0]

    constructor(text: string) {
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1)
    }

    position(offset: number): { line: number; column: number } {
        let lo = 0
        let hi = this.starts.length - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (this.starts[mid] <= offset) lo = mid
            else hi = mid - 1
        }
        return { line: lo + 1, column: offset - this.starts[lo] + 1 }
    }

    /** Offset of a 1-based line and 1-based column. */
    offset(line: number, column: number): number {
        return (this.starts[line - 1] ?? 0) + column - 1
    }
}

/** Whitespace runs collapsed to one space, trimmed — how selectors are shown in reports. */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

// ---------------------------------------------------------------------------------------------
// Templated text: `a ${x} b` as "a /*__elo_expr_0__*/ b". A comment is valid wherever CSS allows
// whitespace, so the text still parses as a stylesheet or a selector; offsets map back per quasi.
// ---------------------------------------------------------------------------------------------

export const PLACEHOLDER_RE = /\/\*__elo_expr_\d+__\*\//g
const placeholder = (i: number) => `/*__elo_expr_${i}__*/`

export interface Quasi {
    /** Raw source text of the quasi. */
    raw: string
    /** Source offset of its first character. */
    start: number
}

export interface Templated {
    text: string
    /** Maps a text range back to the source; null when it overlaps a placeholder or spans quasis. */
    toSource(start: number, end: number): { start: number; end: number } | null
    /** Source offset of a text offset (the placeholder's expression start when it hits one). */
    offsetOf(offset: number): number
    /** True when the text range touches a placeholder (an interpolated name like `.ls-${x}`). */
    touchesPlaceholder(start: number, end: number): boolean
}

export function templated(quasis: readonly Quasi[], expressionStarts: readonly number[] = []): Templated {
    const segments: Array<{ textStart: number; textEnd: number; sourceStart: number }> = []
    const holes: Array<{ start: number; end: number; source: number }> = []
    let text = ""
    quasis.forEach((q, i) => {
        segments.push({ textStart: text.length, textEnd: text.length + q.raw.length, sourceStart: q.start })
        text += q.raw
        if (i < quasis.length - 1) {
            const p = placeholder(i)
            holes.push({ start: text.length, end: text.length + p.length, source: expressionStarts[i] ?? q.start + q.raw.length })
            text += p
        }
    })
    return {
        text,
        toSource(start, end) {
            const s = segments.find((seg) => seg.textStart <= start && end <= seg.textEnd)
            return s ? { start: s.sourceStart + start - s.textStart, end: s.sourceStart + end - s.textStart } : null
        },
        offsetOf(offset) {
            const hole = holes.find((h) => offset >= h.start && offset < h.end)
            if (hole) return hole.source
            const s = segments.find((seg) => seg.textStart <= offset && offset <= seg.textEnd) ?? segments[segments.length - 1]
            return s.sourceStart + Math.min(offset, s.textEnd) - s.textStart
        },
        touchesPlaceholder(start, end) {
            return holes.some((h) => h.start <= end && h.end >= start)
        },
    }
}

/** Plain text (a string literal's value) as a Templated with an identity mapping from `start`. */
export function plain(text: string, start: number): Templated {
    return templated([{ raw: text, start }])
}

// ---------------------------------------------------------------------------------------------
// CSS scanners
// ---------------------------------------------------------------------------------------------

export interface Token {
    value: string
    start: number
    end: number
    /** Followed by `(`: a function name, never a keyframes name. */
    fn: boolean
}

/**
 * Identifier-like tokens of a declaration value with their offsets: runs between whitespace, commas,
 * slashes and parentheses. Quoted strings and comments are skipped. (The same token rule as the
 * PostCSS plugin's keyframes renaming.)
 */
export function valueTokens(value: string): Token[] {
    const out: Token[] = []
    let i = 0
    while (i < value.length) {
        const ch = value[i]
        if (ch === '"' || ch === "'") {
            let j = i + 1
            while (j < value.length && value[j] !== ch) j += value[j] === "\\" ? 2 : 1
            i = j + 1
            continue
        }
        if (ch === "/" && value[i + 1] === "*") {
            const close = value.indexOf("*/", i + 2)
            i = close < 0 ? value.length : close + 2
            continue
        }
        if (/[\s,()/]/.test(ch)) {
            i++
            continue
        }
        let j = i
        while (j < value.length && !/[\s,()/"']/.test(value[j])) j += value[j] === "\\" ? 2 : 1
        out.push({ value: value.slice(i, j), start: i, end: j, fn: value[j] === "(" })
        i = j
    }
    return out
}

/**
 * Replaces `//` line comments with spaces (same length, so offsets survive) — lets the plain CSS
 * parser read SCSS/LESS when postcss-scss / postcss-less are not installed. Strings, block
 * comments and `url(…)` are left alone.
 */
export function maskLineComments(code: string): string {
    let out = ""
    let i = 0
    while (i < code.length) {
        const ch = code[i]
        if (ch === '"' || ch === "'") {
            let j = i + 1
            while (j < code.length && code[j] !== ch && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1
            out += code.slice(i, j + 1)
            i = j + 1
            continue
        }
        if (ch === "/" && code[i + 1] === "*") {
            const close = code.indexOf("*/", i + 2)
            const end = close < 0 ? code.length : close + 2
            out += code.slice(i, end)
            i = end
            continue
        }
        if (/^url\(/i.test(code.slice(i, i + 4)) && !/[\w-]/.test(code[i - 1] ?? "")) {
            const close = code.indexOf(")", i)
            const end = close < 0 ? code.length : close + 1
            out += code.slice(i, end)
            i = end
            continue
        }
        if (ch === "/" && code[i + 1] === "/") {
            let j = i
            while (j < code.length && code[j] !== "\n") j++
            out += " ".repeat(j - i)
            i = j
            continue
        }
        out += ch
        i++
    }
    return out
}
