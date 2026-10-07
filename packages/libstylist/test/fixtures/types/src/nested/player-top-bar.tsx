// Nested source with member-style tags, a marker (an attribute, never collected) and a string that
// only looks like a tag.
import React from "react" // the default-import style (allowSyntheticDefaultImports), as in half the DS sources

import { cx } from "@livesession/libstylist/runtime"

import { playerTopBar as cn } from "../parts"

const template = `<elo-in-a-template>`

export function PlayerTopBar({ url }: { url: string }) {
    return (
        <elo-player-topbar {...cx(cn.root, { compact: true })}>
            <elo-player-topbar-url {...cx(cn.url)} title={template}>
                {url}
            </elo-player-topbar-url>
            <button elo-player-topbar-close {...cx(cn.close)} type="button" />
            <elo-player-topbar-url {...cx(cn.url)} />
        </elo-player-topbar>
    )
}
