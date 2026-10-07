// `@livesession/libstylist/babel` — the JSX transform (SPEC §5).
import { libstylistBabel } from "./plugin.js"

export { libstylistBabel, type LibstylistFileMetadata } from "./plugin.js"
export { componentName, fileComponentName } from "./component-name.js"
export {
    DEFAULT_RUNTIME_MODULE,
    resolveFileConfig,
    type DevMode,
    type LibstylistBabelOptions,
    type StylistPartRegistry,
} from "./options.js"
export type { RuntimeHelper } from "./runtime-imports.js"

export default libstylistBabel
