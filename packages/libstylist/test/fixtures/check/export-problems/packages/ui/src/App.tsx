import * as React from "react"

import { cx } from "@livesession/libstylist/runtime"

function AppBase(props: object) {
    return <elo-app {...cx(props)} />
}

function AppDock(props: object) {
    return <nav elo-app-dock {...cx(props)} />
}

export const App = Object.assign(AppBase, { Dock: AppDock })
