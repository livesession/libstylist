// Injects named imports of the runtime helpers a file actually uses (SPEC §6), with collision-free locals.
import { types as t, type NodePath } from "@babel/core"

import { RUNTIME_MODULES } from "../core/index.js"

export type RuntimeHelper = "cxData" | "cxAttr" | "hostProps" | "cxCompiled"

type Scope = NodePath["scope"]

const importedName = (s: t.ImportSpecifier): string => (s.imported.type === "Identifier" ? s.imported.name : s.imported.value)

/** Tracks helper usage for one file and writes a single import declaration for the new ones. */
export class HelperImports {
    /** Helpers this transform imports itself, by local name (collision-free anywhere in the file). */
    private readonly added = new Map<RuntimeHelper, string>()
    /** Every helper referenced by generated code, in first-use order. */
    private readonly used = new Set<RuntimeHelper>()
    private names: Set<string> | null = null
    /** Author imports of the runtime (the configured module, the package subpath or the virtual id), one module in a build. */
    private readonly modules: ReadonlySet<string>

    constructor(
        private readonly program: NodePath<t.Program>,
        private readonly module: string,
    ) {
        this.modules = new Set([module, ...RUNTIME_MODULES])
    }

    /** True when `source` is an import id of the runtime (the configured module, the package subpath or the virtual id). */
    isRuntimeModule(source: string): boolean {
        return this.modules.has(source)
    }

    /** The local name `helper` is visible under at `scope` (author import or already allocated); null otherwise (never allocates). */
    localName(helper: RuntimeHelper, scope: Scope): string | null {
        return this.existing(helper, scope) ?? this.added.get(helper) ?? null
    }

    /**
     * An identifier referring to `helper` at `scope`: the author's own import when it is the binding visible there
     * (never one shadowed by a local of the same name), else a collision-free import added on first use.
     */
    use(helper: RuntimeHelper, scope: Scope): t.Identifier {
        this.used.add(helper)
        const existing = this.existing(helper, scope)
        if (existing) return t.identifier(existing)
        let local = this.added.get(helper)
        if (!local) {
            local = this.unique(helper)
            this.added.set(helper, local)
        }
        return t.identifier(local)
    }

    /**
     * Writes `import { … } from "<module>"` for newly used helpers — after the file's leading imports, so
     * header comments and pragmas stay first — and returns every helper used.
     */
    inject(): RuntimeHelper[] {
        if (this.added.size > 0) {
            const specifiers = [...this.added].map(([helper, local]) => t.importSpecifier(t.identifier(local), t.identifier(helper)))
            // join the author's named value import of the runtime (`import { cx } from …`) when there is one
            const author = this.program.node.body.find(
                (s): s is t.ImportDeclaration =>
                    s.type === "ImportDeclaration" &&
                    this.modules.has(s.source.value) &&
                    s.importKind !== "type" &&
                    s.importKind !== "typeof" &&
                    s.specifiers.length > 0 &&
                    s.specifiers.every((x) => x.type === "ImportSpecifier"),
            )
            if (author) {
                author.specifiers.push(...specifiers)
                return [...this.used]
            }
            const decl = t.importDeclaration(specifiers, t.stringLiteral(this.module))
            const body = this.program.get("body")
            let last = -1
            while (last + 1 < body.length && body[last + 1].isImportDeclaration()) last++
            if (last >= 0) body[last].insertAfter(decl)
            else this.program.unshiftContainer("body", decl)
        }
        return [...this.used]
    }

    /** The local of an author value import of `helper` from the runtime, if that import is what `scope` sees under it. */
    private existing(helper: RuntimeHelper, scope: Scope): string | null {
        for (const stmt of this.program.node.body) {
            if (stmt.type !== "ImportDeclaration" || !this.modules.has(stmt.source.value)) continue
            if (stmt.importKind === "type" || stmt.importKind === "typeof") continue
            for (const s of stmt.specifiers) {
                if (s.type !== "ImportSpecifier" || s.importKind === "type" || importedName(s) !== helper) continue
                if (scope.getBinding(s.local.name)?.path.node === s) return s.local.name
            }
        }
        return null
    }

    /** `helper`, or `_helper`, `_helper2`, … when the name appears anywhere in the file. */
    private unique(base: string): string {
        if (!this.names) {
            const names = new Set<string>()
            this.program.traverse({
                Identifier(p) {
                    names.add(p.node.name)
                },
                JSXIdentifier(p) {
                    names.add(p.node.name)
                },
            })
            this.names = names
        }
        let name = base
        for (let i = 1; this.names.has(name); i++) name = `_${base}${i > 1 ? i : ""}`
        this.names.add(name)
        return name
    }
}
