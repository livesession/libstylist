// "Did you mean" support: edit distance and nearest-candidate lookup.

/** Edit distance with adjacent transpositions counted as one edit (optimal string alignment). */
export function editDistance(a: string, b: string): number {
    if (a === b) return 0
    if (!a.length) return b.length
    if (!b.length) return a.length
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)])
    for (let j = 1; j <= b.length; j++) d[0][j] = j
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
        }
    return d[a.length][b.length]
}

/**
 * The candidate closest to `name`, when it is close enough to be a plausible typo (distance at most
 * a third of the name's length, and never more than 3). Ties resolve alphabetically.
 */
export function nearest(name: string, candidates: Iterable<string>): string | null {
    const limit = Math.min(3, Math.max(1, Math.floor(name.length / 3)))
    let best: string | null = null
    let bestDistance = Infinity
    for (const c of [...candidates].sort()) {
        if (c === name) continue
        const d = editDistance(name, c)
        if (d < bestDistance) {
            best = c
            bestDistance = d
        }
    }
    return best !== null && bestDistance <= limit ? best : null
}
