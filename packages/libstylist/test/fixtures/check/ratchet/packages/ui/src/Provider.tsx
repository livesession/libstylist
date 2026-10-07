import * as React from "react"

const Ctx = React.createContext(0)

/** @libstylistRoot none a context provider that renders only its children */
export function Provider({ children }: { children?: React.ReactNode }) {
    return <Ctx.Provider value={1}>{children}</Ctx.Provider>
}
