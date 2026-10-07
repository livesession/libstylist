// A .ts file: it can't contain JSX, so <elo-in-a-ts-comment> is never collected, and the
// generic below must still parse.
export const pick = <T,>(items: Array<T>): T | undefined => items[0]
export const html = "<elo-in-a-ts-string></elo-in-a-ts-string>"
