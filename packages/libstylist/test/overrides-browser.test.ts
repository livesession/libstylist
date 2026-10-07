// The computed-style proof of override sheets and resets (SPEC §9), in headless Chromium
// (./fixtures/overrides/browser.ts: skipped when no Playwright Chromium is found).
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { partAttr } from "../src/hash/index.js"
import { resetCss } from "../src/postcss/index.js"
import { compileOverride } from "../src/workspace/index.js"
import { computed, differences, launch, type Browser, type Page } from "./fixtures/overrides/browser.js"
import { designSystem, resolveSheets } from "./fixtures/overrides/design-system.js"

const attr = (scope: string, part: string) => partAttr({ prefix: "ds", namespace: "core", scope, part })
const STATEMENT = ["reset", "tokens", "components", "utilities", "app.overrides", "app.core", "app.render"]

/** The design system with `resets` stripped, the compiled override sheets and an app layer, then `body`. */
async function page(browser: Browser, sheets: Record<string, string>, body: string, appCss = ""): Promise<Page> {
    const { styles } = await designSystem()
    const r = await resolveSheets(sheets)
    assert.deepEqual(r.errors, [])
    const stripped = resetCss(styles, r.resets).css ?? styles
    const compiled = await Promise.all(r.sheets.map(s => compileOverride(sheets[s.file], { from: s.file, plugin: s.plugin, statement: STATEMENT })))
    const p = await browser.newPage()
    const style = (css: string) => `<style>${css}</style>`
    await p.setContent(`<!doctype html><html><head>${style(stripped)}${compiled.map(c => style(c.css)).join("")}${style(`@layer ${STATEMENT.join(", ")};\n${appCss}`)}</head><body>${body}</body></html>`)
    return p
}

const launched = await launch()
const skip = typeof launched === "string" ? launched : false

describe("override sheets in the browser", { skip }, () => {
    let browser: Browser
    before(() => {
        browser = launched as Browser
    })
    after(async () => {
        if (typeof launched !== "string") await launched.close()
    })

    const button = (id: string, extra = "", inner = "") =>
        `<button ds-button ${attr("button", "root")} data-size="medium" data-kind="primary" data-theme="fill" id="${id}" ${extra}><span ${attr("button", "content")}>${inner}</span></button>`

    test("the override wins over a more specific design-system rule — the layer decides; an app component's layer wins over the override", async () => {
        const p = await page(
            browser,
            { "o/button.css": "@stylist override Button from \"@ds/react\";\n.root { border-radius: 2px; color: rgb(1, 2, 3); }" },
            `${button("plain")}${button("mine", "crm-x")}`,
            "@layer app.core { [crm-x] { border-radius: 9px; } }",
        )
        // the design system sets both in a (0,3,0) [root][data-kind][data-theme] rule
        assert.deepEqual(await computed(p, "plain", ["border-top-left-radius", "color"]), { "border-top-left-radius": "2px", color: "rgb(1, 2, 3)" })
        assert.deepEqual(await computed(p, "mine", ["border-top-left-radius", "color"]), { "border-top-left-radius": "9px", color: "rgb(1, 2, 3)" })
    })

    test("a reset part carries no design-system declaration; its sibling alternative keeps the shared rule", async () => {
        const loader = attr("button", "loader")
        const inner = [
            `<span ${loader} data-hidden id="loader"></span><span id="control"></span>`,
            `<span ${attr("button", "icon")} data-align="left" id="icon"></span><span data-align="left" id="icon-control"></span>`,
            `<span ${attr("button", "chevron")} id="chevron"></span>`,
        ].join("")
        const src = "@stylist override Button from \"@ds/react\";\n@stylist reset loader icon;\n.root { border-radius: 2px; }"
        const p = await page(browser, { "o/button.css": src }, button("b", "data-loading", inner))
        assert.deepEqual(await differences(p, "loader", "control"), [])
        assert.deepEqual(await differences(p, "icon", "icon-control"), [])
        // the chevron keeps the icon slot's display and --btn-icon-w width
        assert.deepEqual(await computed(p, "chevron", ["display", "width", "margin-left"]), { display: "flex", width: "16px", "margin-left": "8px" })

        // without the reset, the loader is styled (the control of the proof)
        const unreset = await page(browser, { "o/button.css": "@stylist override Button from \"@ds/react\";\n.root {}" }, button("b", "data-loading", inner))
        assert.notDeepEqual(await differences(unreset, "loader", "control"), [])
    })

    test("a reset custom-tag member keeps its display default; the reset root keeps the design system's custom properties", async () => {
        const header = attr("modal", "header")
        const p = await page(
            browser,
            { "o/modal.css": "@stylist override Modal from \"@ds/react\";\n@stylist reset header;" },
            `<ds-modal-header ${header} id="header">h</ds-modal-header><ds-modal-header id="control">h</ds-modal-header>`,
        )
        assert.deepEqual(await differences(p, "header", "control"), [])
        assert.deepEqual(await computed(p, "header", ["display", "position"]), { display: "block", position: "static" })

        const root = await page(
            browser,
            { "o/button.css": "@stylist override Button from \"@ds/react\";\n@stylist reset root;\n.root { height: var(--btn-h); }" },
            button("b"),
        )
        // --btn-h comes from the kept [root][data-size="medium"] rule; the root's own display: flex is gone
        assert.deepEqual(await computed(root, "b", ["height", "display"]), { height: "32px", display: "inline-block" })
    })

    test("within: only inside the app component", async () => {
        const td = attr("table", "td")
        const p = await page(
            browser,
            { "o/table-in-cart.css": "@stylist override Table from \"@ds/react\" within RenderCart;\n.td { color: rgb(4, 5, 6); }" },
            `<app-render-cart><ds-table-td ${td} id="inside"></ds-table-td></app-render-cart><ds-table-td ${td} id="outside"></ds-table-td>`,
        )
        assert.equal((await computed(p, "inside", ["color"])).color, "rgb(4, 5, 6)")
        assert.notEqual((await computed(p, "outside", ["color"])).color, "rgb(4, 5, 6)")
    })
})
