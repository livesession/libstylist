// `data-react-component` (SPEC §5.5): the innermost PascalCase enclosing function's name.
import { basename, dirname, extname } from "node:path"

import type { NodePath } from "@babel/core"
import type { types as t } from "@babel/core"

/** Calls a component is commonly wrapped in; the name comes from what the call is assigned to. */
const WRAPPER_CALLEES = new Set(["memo", "forwardRef", "observer"])

const TRANSPARENT = new Set([
    "TSAsExpression",
    "TSSatisfiesExpression",
    "TSNonNullExpression",
    "TSTypeAssertion",
    "TypeCastExpression",
    "ParenthesizedExpression",
])

const isPascalPath = (name: string): boolean => name.split(".").every((s) => /^[A-Z]/.test(s))

/** `Alert.tsx` → `Alert`, `text-input.tsx` → `TextInput`, `Button/index.tsx` → `Button`. */
export function fileComponentName(filename: string | undefined): string | null {
    if (!filename) return null
    let base = basename(filename, extname(filename))
    if (base === "index") base = basename(dirname(filename))
    const name = base
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("")
    return /^[A-Z]/.test(name) ? name : null
}

/** `X`, `X.Y`, `X.Y.Z` for non-computed identifier member chains; null otherwise. */
function memberName(node: t.Node): string | null {
    if (node.type === "Identifier") return node.name
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
        const obj = memberName(node.object)
        return obj ? `${obj}.${node.property.name}` : null
    }
    return null
}

function calleeName(node: t.Node): string | null {
    if (node.type === "Identifier") return node.name
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") return node.property.name
    return null
}

const keyName = (key: t.Node, computed: boolean): string | null => {
    if (computed) return null
    if (key.type === "Identifier") return key.name
    if (key.type === "StringLiteral") return key.value
    return null
}

/**
 * Climbs through TS wrappers, parentheses, `memo`/`forwardRef`/`observer` calls and the target of
 * `Object.assign(<root>, { … })` — the root component is named by what the assign result is bound to.
 */
function climbWrappers(path: NodePath): NodePath {
    let p = path
    for (;;) {
        const parent = p.parentPath
        if (!parent) return p
        if (TRANSPARENT.has(parent.node.type)) {
            p = parent
            continue
        }
        if (parent.node.type === "CallExpression" && p.listKey === "arguments") {
            const callee = calleeName(parent.node.callee)
            if ((callee && WRAPPER_CALLEES.has(callee)) || (p.key === 0 && memberName(parent.node.callee) === "Object.assign")) {
                p = parent
                continue
            }
        }
        return p
    }
}

/** The name an expression (function, class or object) is bound to by its context. */
function contextName(path: NodePath, filename: string | undefined): string | null {
    const p = climbWrappers(path)
    const parent = p.parentPath
    if (!parent) return null
    const node = parent.node
    switch (node.type) {
        case "VariableDeclarator":
            return p.key === "init" && node.id.type === "Identifier" ? node.id.name : null
        case "AssignmentExpression":
            return p.key === "right" ? memberName(node.left) : null
        case "ObjectProperty":
            return p.key === "value" ? objectMemberName(parent as NodePath<t.ObjectProperty>, filename) : null
        case "ExportDefaultDeclaration":
            return fileComponentName(filename)
        case "ClassProperty":
        case "ClassPrivateProperty":
            return p.key === "value" ? classNameOf(parent.parentPath?.parentPath ?? null, filename) : null
        default:
            return null
    }
}

/**
 * `const X = { Y: fn }` → `X.Y`; `Object.assign(X, { Y: fn })` → `X.Y`, where X is the name the call
 * result is bound to (`export const Button = Object.assign(ButtonComponent, { … })` → `Button.…`),
 * else the assign target. Otherwise just `Y`.
 */
function objectMemberName(member: NodePath<t.ObjectProperty | t.ObjectMethod>, filename: string | undefined): string | null {
    const key = keyName(member.node.key, member.node.computed)
    if (!key) return null
    const objPath = member.parentPath
    if (!objPath || objPath.node.type !== "ObjectExpression") return key
    const outer = climbWrappers(objPath)
    const parent = outer.parentPath
    if (parent?.node.type === "CallExpression" && outer.listKey === "arguments" && typeof outer.key === "number" && outer.key >= 1) {
        const call = parent.node
        if (memberName(call.callee) === "Object.assign" && call.arguments[0]) {
            const owner = contextName(parent, filename) ?? memberName(call.arguments[0])
            if (owner) return `${owner}.${key}`
        }
        return key
    }
    const owner = contextName(objPath, filename)
    return owner ? `${owner}.${key}` : key
}

function classNameOf(classPath: NodePath | null, filename: string | undefined): string | null {
    if (!classPath) return null
    const node = classPath.node
    if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") return null
    if (node.id) return node.id.name
    if (classPath.parentPath?.node.type === "ExportDefaultDeclaration") return fileComponentName(filename)
    return contextName(classPath, filename)
}

/** The name of one function, from its own id or from the context it is bound in. */
export function functionName(fn: NodePath<t.Function>, filename: string | undefined): string | null {
    const node = fn.node
    switch (node.type) {
        case "ClassMethod":
        case "ClassPrivateMethod":
            return classNameOf(fn.parentPath?.parentPath ?? null, filename)
        case "ObjectMethod":
            return objectMemberName(fn as NodePath<t.ObjectMethod>, filename)
        case "FunctionDeclaration":
            if (node.id) return node.id.name
            return fn.parentPath?.node.type === "ExportDefaultDeclaration" ? fileComponentName(filename) : null
        case "FunctionExpression":
            // `forwardRef(function button() {…})` bound to `Button`: a lowercase own name defers to the binding
            if (node.id && isPascalPath(node.id.name)) return node.id.name
            return contextName(fn, filename) ?? node.id?.name ?? null
        default:
            return contextName(fn, filename)
    }
}

/**
 * The innermost enclosing PascalCase component name for a JSX path (SPEC §5.5): looks through
 * `memo`/`forwardRef`/`observer`, TS casts, `X.Y =` expandos, `Object.assign(X, { Y })` and object
 * namespaces, uses the file's PascalCase basename for anonymous default exports and the class name in
 * class components. Lowercase helpers (`renderItem`) are skipped. Null when nothing qualifies.
 */
export function componentName(path: NodePath, filename: string | undefined): string | null {
    let fn = path.getFunctionParent()
    while (fn) {
        const name = functionName(fn, filename)
        if (name && isPascalPath(name)) return name
        fn = fn.getFunctionParent()
    }
    return null
}
