import * as React from "react"

/** The app's own shell: outside the package's sources — gen-types never declares its tag, the transform never compiles it. */
export function Root() {
    return <crm-shell />
}
