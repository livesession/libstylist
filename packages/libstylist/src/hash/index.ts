// Part-attribute hash (SPEC §3.1): pure, name-derived, identical in Babel, PostCSS and anywhere else.
import { DEFAULT_HASH_LENGTH, HASH_VERSION, PART_ATTR_PREFIX, PART_RE, PREFIX_RE } from "../conventions/index.js"
import { sha256 } from "./sha256.js"

export { sha256, toHex } from "./sha256.js"

const SEP = "\u001f"

export interface PartKey {
    prefix: string
    namespace: string
    scope: string
    part: string
}

/** The hash string (without the attribute prefix) for a part. */
export function partHash({ prefix, namespace, scope, part }: PartKey, length = DEFAULT_HASH_LENGTH): string {
    if (!PREFIX_RE.test(prefix)) throw new Error(`invalid prefix "${prefix}"`)
    if (!PREFIX_RE.test(namespace)) throw new Error(`invalid namespace "${namespace}"`)
    if (!PART_RE.test(scope)) throw new Error(`invalid scope "${scope}"`)
    if (!PART_RE.test(part)) throw new Error(`invalid part "${part}"`)
    const digest = sha256([HASH_VERSION, prefix, namespace, scope, part].join(SEP))
    let n = 0n
    for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(digest[i])
    const mod = 36n ** BigInt(length)
    return (n % mod).toString(36).padStart(length, "0")
}

/** The part attribute name: `_cxclass_<prefix>-<hash>` (SPEC §3.1). */
export function partAttr(key: PartKey, length = DEFAULT_HASH_LENGTH): string {
    return `${PART_ATTR_PREFIX}${key.prefix}-${partHash(key, length)}`
}

/** The CSS selector for a part attribute. */
export const partSelector = (attr: string): string => `[${attr}]`

/** True when `name` is a part attribute of any prefix. */
export const isPartAttr = (name: string): boolean => name.startsWith(PART_ATTR_PREFIX)
