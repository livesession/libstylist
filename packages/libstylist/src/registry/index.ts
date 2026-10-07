// `@livesession/libstylist/registry`: the css build's registry, lock file, part maps and rename map (SPEC §7).
export { HASH_VERSION_NUMBER, buildRegistry, resolveGroups, type BuildRegistryInput, type BuildRegistryResult, type RegistrySheet } from "./build.js"
export { exportName, partMapValue, toPartMapModules, type PartMapModules } from "./modules.js"
export { diffLock, formatLockDiff, toLock, type LockChange, type LockDiff, type StylistLock } from "./lock.js"
export { toSelectorRenameMap, type LegacyClassMaps, type RenameMapOptions } from "./rename.js"
export { createResolvers, namingFromGroups, stylistOptions, type RegistryResolvers } from "./resolvers.js"
export {
    overrideLock,
    resolveOverrideSheet,
    resolveOverrideTarget,
    resolveOverrides,
    resolveWithin,
    type OverrideLock,
    type OverridePackage,
    type OverrideTarget,
    type ResolvePackage,
    type ResolveOverridesContext,
    type ResolveOverridesInput,
    type ResolveOverridesResult,
    type ResolvedOverrideSheet,
    type ResolvedWithin,
} from "./overrides.js"
export {
    REGISTRY_VERSION,
    sameComponent,
    type Registry,
    type RegistryError,
    type RegistryErrorCode,
    type RegistryGroup,
    type RegistryRoot,
    type RegistryScope,
} from "./types.js"
