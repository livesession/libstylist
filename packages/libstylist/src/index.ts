// Isomorphic entry: naming, hashing and conventions. Build-time integrations live on subpaths
// (`/babel`, `/postcss`, `/vite`, `/eslint`, `/stylelint`, `/check`), the JSX runtime on `/runtime`.
export * from "./hash/index.js"
export * from "./naming/index.js"
export {
    DEFAULT_HASH_LENGTH,
    DEFAULT_SOURCES,
    DEV_ATTRS,
    GENERIC_ROOT_TAGS,
    HASH_VERSION,
    PART_ATTR_PREFIX,
    PART_RE,
    PREFIX_RE,
    SLOT_PROP,
    SVG_GEOMETRY_CX,
    TAG_RE,
    namespaceDirOf,
    normalizeNamespaceDir,
    normalizeNamespaces,
    normalizePackageConfig,
    normalizeSources,
    type DirectoryNamespace,
    type PackageStylistConfig,
    type RawNamespaceEntry,
    type RawPackageStylistConfig,
} from "./conventions/index.js"
