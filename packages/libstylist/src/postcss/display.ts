// Display defaults of custom-tag roots (SPEC §4.2 step 6). A custom element has no UA styles:
// it is `display: inline; unicode-bidi: normal` — a `span`. A root that replaces a `div`
// declares `display block` and gets the UA `div` pair back (`display: block` plus the
// `unicode-bidi: isolate` the HTML rendering section gives `div`); `display inline` restates
// the custom-element default and emits nothing.

/** The declarations a `display <keyword>` clause emits, in order; empty for `inline`. */
export function displayDefaultDeclarations(keyword: string): Array<[prop: string, value: string]> {
    if (keyword === "inline") return []
    if (keyword === "block") return [["display", "block"], ["unicode-bidi", "isolate"]]
    return [["display", keyword]]
}

/** The zero-specificity rule a `display <keyword>` clause emits for `tag`, or undefined when none. */
export function displayDefaultRule(tag: string, keyword: string): string | undefined {
    const decls = displayDefaultDeclarations(keyword)
    if (decls.length === 0) return undefined
    return `:where(${tag}:not([hidden])) { ${decls.map(([prop, value]) => `${prop}: ${value}`).join("; ")} }`
}
