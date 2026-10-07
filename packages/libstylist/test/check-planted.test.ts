// No false negatives: each case copies a conforming fixture that models a pilot component (Badge,
// Button's wrappers, Tooltip's and ModalConfirm's marker forwarding, Popover's portaled member root),
// plants one violation in the copy and asserts `libstylist check` reports it as an error — and that
// the untouched fixture does not.
import assert from "node:assert/strict"
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

import { runCheck, type CheckResult } from "../src/check/index.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, "fixtures", "check")

// realpath: macOS tmpdir is a symlink, and the copies must resolve react & co. like the fixtures do
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "libstylist-planted-")))
symlinkSync(join(HERE, "..", "node_modules"), join(tmp, "node_modules"), "dir")
after(() => rmSync(tmp, { recursive: true, force: true }))

interface Plant {
    name: string
    fixture: string
    /** File (relative to the fixture) → [search, replace] edits, applied in order; each search must match. */
    edits: Record<string, Array<[string, string]>>
    /** `RULE key` findings the plant must add as errors. */
    expect: string[]
}

const PLANTS: Plant[] = [
    { name: "Badge's cx() no longer receives its props", fixture: "zero", edits: { "packages/ui/src/Badge.tsx": [["{...cx(cn.root, rest)}", "{...cx(cn.root)}"]] }, expect: ["R112 core/Badge"] },
    {
        name: "Badge's cx() carries only data, no props",
        fixture: "zero",
        edits: { "packages/ui/src/Badge.tsx": [["{...cx(cn.root, rest)}", "{...cx(cn.root, { size: \"s\" })}"]] },
        expect: ["R112 core/Badge"],
    },
    {
        name: "Badge renders a plain div",
        fixture: "zero",
        edits: { "packages/ui/src/Badge.tsx": [["<elo-badge {...cx", "<div {...cx"], ["</elo-badge>", "</div>"]] },
        expect: ["R101 core/Badge"],
    },
    { name: "Badge loses its root part", fixture: "zero", edits: { "packages/ui/src/Badge.tsx": [["{...cx(cn.root, rest)}", "{...cx(rest)}"]] }, expect: ["R113 core/Badge"] },
    { name: "Badge's root part moves to its inner element", fixture: "zero", edits: { "packages/ui/src/Badge.tsx": [["{...cx(cn.root, rest)}", "{...cx(cn.label, rest)}"], ["<span {...cx(cn.label)}>", "<span {...cx(cn.root)}>"]] }, expect: ["R113 core/Badge"] },
    {
        name: "Badge's tag without a display default",
        fixture: "zero",
        edits: { "packages/css/src/ui/badge.css": [["@stylist root Badge display inline-flex;", "@stylist root Badge;"]] },
        expect: ["S304 elo-badge"],
    },
    { name: "a part nothing carries", fixture: "zero", edits: { "packages/css/src/ui/badge.css": [[".label {", ".ghost { color: red; }\n.label {"]] }, expect: ["S301 badge:ghost"] },
    { name: "a part no element reads from the map any more", fixture: "zero", edits: { "packages/ui/src/Badge.tsx": [["<span {...cx(cn.label)}>", "<span>"]] }, expect: ["S301 badge:label"] },
    {
        name: "another component renders Badge's tag",
        fixture: "zero",
        edits: { "packages/ui/src/index.ts": [["", 'export * from "./Copy"\n']] },
        expect: ["R103 core/Copy", "T203 elo-badge@packages/ui/src/Copy.tsx"],
    },
    {
        name: "Button-like: the Tip branch loses the identity (slot identity)",
        fixture: "wrapper",
        edits: { "packages/ui/src/Action.tsx": [["<Tip text={tooltip}>{content}</Tip>", "<Tip text={tooltip}>{label}</Tip>"]] },
        expect: ["R106 core/Action"],
    },
    {
        name: "Button-like: the <label> branch loses the identity",
        fixture: "wrapper",
        edits: { "packages/ui/src/Action.tsx": [["<span {...cx(cn.label)}>{label}</span>\n            {renderAction()}", "<span {...cx(cn.label)}>{label}</span>"]] },
        expect: ["R102 core/Action"],
    },
    { name: "Button-like: a generic polymorphic member", fixture: "wrapper", edits: { "packages/ui/src/Action.tsx": [['as?: "button" | "a"', 'as?: "button" | "a" | "div"']] }, expect: ["R108 core/Action"] },
    { name: "Button-like: an unbounded polymorphic tag", fixture: "wrapper", edits: { "packages/ui/src/Action.tsx": [['as?: "button" | "a"', "as?: string"]] }, expect: ["R107 core/Action"] },
    { name: "Button-like: a valued marker", fixture: "wrapper", edits: { "packages/ui/src/Action.tsx": [["<As elo-action {...cx", '<As elo-action="yes" {...cx']] }, expect: ["R110 core/Action"] },
    {
        name: "ModalConfirm-like: the marker is not forwarded",
        fixture: "forwarding",
        edits: { "packages/ui/src/Confirm.tsx": [["<Dialog elo-confirm title", "<Dialog title"]] },
        expect: ["R106 core/Confirm"],
    },
    {
        name: "Modal.Footer-like: the delegate's member drops stylist props",
        fixture: "forwarding",
        edits: { "packages/ui/src/Dialog.tsx": [["<elo-dialog-footer {...cx(cn.footer, rest)}>", "<elo-dialog-footer {...cx(cn.footer)}>"]] },
        expect: ["R112 core/Dialog.Footer", "R106 core/Confirm.Footer"],
    },
    {
        name: "Tooltip-like: the rest is no longer passed on, so a caller's cx() is lost",
        fixture: "forwarding",
        edits: { "packages/ui/src/Hint.tsx": [["content={<span {...cx(cn.bubble)}>{text}</span>} {...rest} />", "content={<span {...cx(cn.bubble)}>{text}</span>} />"]] },
        expect: ["S307 packages/ui/src/Caller.tsx>core/Hint"],
    },
    {
        name: "a cx() spread with a part onto a component that drops its props",
        fixture: "forwarding",
        edits: { "packages/ui/src/Caller.tsx": [['<Hint {...cx(cn.hint)} text="reaches Pop\'s root" />', '<Hint {...cx(cn.hint)} text="reaches Pop\'s root" />\n            <Sink {...cx(cn.hint)} />'], ['import { Hint } from "./Hint"', 'import { Hint } from "./Hint"\nimport { Sink } from "./Sink"']] },
        expect: ["S307 packages/ui/src/Caller.tsx>core/Sink"],
    },
    {
        name: "Popover-like: the member root loses its bound part",
        fixture: "member-roots",
        edits: { "packages/ui/src/Pop.tsx": [["<P.Content elo-pop-content {...cx(cn.content)}>", "<P.Content elo-pop-content>"]] },
        expect: ["S303 elo-pop-content"],
    },
    {
        name: "Popover-like: the trigger span's native exemption is removed",
        fixture: "member-roots",
        edits: { "packages/ui/src/Pop.tsx": [[" * @libstylistRoot native the Radix asChild trigger writes boolean ARIA onto its host span\n", ""]] },
        expect: ["R101 core/Pop"],
    },
    {
        name: "a `none` exemption on a component with a generic root excuses nothing",
        fixture: "zero",
        edits: {
            "packages/ui/src/Badge.tsx": [
                ["export function Badge", "/** @libstylistRoot none claims it renders no DOM of its own */\nexport function Badge"],
                ["<elo-badge {...cx", "<div {...cx"],
                ["</elo-badge>", "</div>"],
            ],
        },
        expect: ["R101 core/Badge", "X122 core/Badge", "X123 none"],
    },
]

const COPY = `import * as React from "react"

import { badge as cn } from "@fx/css"
import { cx } from "@livesession/libstylist/runtime"

export function Copy(props: { children?: React.ReactNode }) {
    return <elo-badge {...cx(cn.label, props)} />
}
`

const keys = (r: CheckResult) => r.findings.filter((f) => f.severity === "error").map((f) => `${f.rule} ${f.key}`)

const baselines = new Map<string, Promise<CheckResult>>()
const baseline = (fixture: string) => {
    let b = baselines.get(fixture)
    if (!b) baselines.set(fixture, (b = runCheck({ config: join(FIXTURES, fixture, "libstylist.config.mjs") })))
    return b
}

PLANTS.forEach((plant, i) => {
    test(`planted: ${plant.name} → ${plant.expect.join(", ")}`, async () => {
        const dir = join(tmp, `${i}-${plant.fixture}`)
        cpSync(join(FIXTURES, plant.fixture), dir, { recursive: true })
        if (plant.name.startsWith("another component")) writeFileSync(join(dir, "packages/ui/src/Copy.tsx"), COPY)
        for (const [file, edits] of Object.entries(plant.edits)) {
            const path = join(dir, file)
            let text = readFileSync(path, "utf8")
            for (const [search, replace] of edits) {
                if (search === "") {
                    text = replace + text
                    continue
                }
                assert.ok(text.includes(search), `${file} contains ${JSON.stringify(search)}`)
                text = text.replace(search, replace)
            }
            writeFileSync(path, text)
        }
        const before = keys(await baseline(plant.fixture))
        const after = keys(await runCheck({ config: join(dir, "libstylist.config.mjs") }))
        for (const expected of plant.expect) {
            assert.ok(!before.includes(expected), `the untouched ${plant.fixture} fixture already reports ${expected}`)
            assert.ok(after.includes(expected), `expected ${expected} among the errors:\n${after.join("\n")}`)
        }
    })
})
