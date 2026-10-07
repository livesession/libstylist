// `libstylist migrate-selectors` on TS/JS: selector strings are rewritten only inside selector APIs,
// test locators and CSS-in-JS; class usages, removed props and loose strings are TODOs.
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { DEFAULT_OPTIONS, indexMap, loadMigrationMap, migrateCode, type Entry, type MigrateOptions } from "../src/migrate/index.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const index = indexMap(loadMigrationMap(join(HERE, "fixtures", "migrate", "map.json")))

const run = (code: string, file = "app.tsx", options: Partial<MigrateOptions> = {}) => migrateCode(code, file, index, { ...DEFAULT_OPTIONS, ...options }, tmpdir())
const kinds = (entries: Entry[], kind: Entry["kind"]) => entries.filter((e) => e.kind === kind)
const todos = (entries: Entry[]) => kinds(entries, "todo").map((e) => `${e.reason} ${e.old}${e.new ? ` → ${e.new}` : ""}`)

test("DOM selector APIs: querySelector / querySelectorAll / closest / matches", async () => {
    const code = [
        `document.querySelector(".ls-alert .ls-alert__icon")`,
        `el.querySelectorAll('[data-component="Tabs"] > a')`,
        `el.closest(".ls-button")`,
        `el?.matches(".ls-alert")`,
        `el.querySelector(\`.ls-alert[data-id="\${id}"] .ls-alert__close\`)`,
    ].join("\n")
    const r = await run(code, "dom.ts")
    assert.equal(
        r.output,
        [
            `document.querySelector("[_cxclass_elo-aaaaaa] [_cxclass_elo-bbbbbb]")`,
            `el.querySelectorAll(':is(elo-tabs,[elo-tabs]) > a')`,
            `el.closest("[_cxclass_elo-cccccc]")`,
            `el?.matches("[_cxclass_elo-aaaaaa]")`,
            `el.querySelector(\`[_cxclass_elo-aaaaaa][data-id="\${id}"] [_cxclass_elo-bbbbb2]\`)`,
        ].join("\n"),
    )
    assert.equal(kinds(r.entries, "rewrite").length, 5)
})

test("Playwright / Testing Library / Cypress locators: css engine, >> chains, other engines untouched", async () => {
    const code = [
        `await page.locator(".ls-alert__icon").click()`,
        `await page.$(".ls-button"); await page.$$(".ls-alert")`,
        `await page.click("css=.ls-button >> text=Save")`,
        `await page.locator("text=.ls-alert")`,
        `await frame.waitForSelector(".ls-alert >> nth=0")`,
        `await page.locator("xpath=//div[contains(@class, 'ls-alert')]")`,
        `cy.get(".ls-alert").find(".ls-alert__close")`,
        `$(".ls-button").hide()`,
        `within(screen.getByRole("dialog")).container.querySelector(".ls-alert")`,
        `await page.fill(".ls-alert__icon", ".ls-alert"); await page.locator("input").fill(".ls-alert")`,
        `await page.locator("input").press(".ls-alert", { delay: 1 }); $el.find(".ls-button"); seen.has(".ls-alert")`,
    ].join("\n")
    const r = await run(code, "e2e.spec.ts")
    assert.equal(
        r.output,
        [
            `await page.locator("[_cxclass_elo-bbbbbb]").click()`,
            `await page.$("[_cxclass_elo-cccccc]"); await page.$$("[_cxclass_elo-aaaaaa]")`,
            `await page.click("css=[_cxclass_elo-cccccc] >> text=Save")`,
            `await page.locator("text=.ls-alert")`,
            `await frame.waitForSelector("[_cxclass_elo-aaaaaa] >> nth=0")`,
            `await page.locator("xpath=//div[contains(@class, 'ls-alert')]")`,
            `cy.get("[_cxclass_elo-aaaaaa]").find("[_cxclass_elo-bbbbb2]")`,
            `$("[_cxclass_elo-cccccc]").hide()`,
            `within(screen.getByRole("dialog")).container.querySelector("[_cxclass_elo-aaaaaa]")`,
            `await page.fill("[_cxclass_elo-bbbbbb]", ".ls-alert"); await page.locator("input").fill(".ls-alert")`,
            `await page.locator("input").press(".ls-alert", { delay: 1 }); $el.find("[_cxclass_elo-cccccc]"); seen.has(".ls-alert")`,
        ].join("\n"),
        "typed values are never selectors; generic names are selectors only on jQuery / Cypress chains",
    )
    assert.deepEqual(
        todos(r.entries).filter((x) => !x.startsWith("selector-string .ls-alert →")),
        ["selector-string ls-alert → [_cxclass_elo-aaaaaa]"],
        "the xpath engine is reported, the text engine is text",
    )
})

test("styled-components / emotion templates: selectors and keyframes, interpolations kept", async () => {
    const code = [
        `import styled, { css } from "styled-components"`,
        `const Wrap = styled.div\``,
        `  color: \${(p) => p.color};`,
        `  .ls-alert { color: red; }`,
        `  \${Button} .ls-button__content, & > .ls-alert__icon { gap: 8px; }`,
        `  animation: ls-popover-fade-in 1s;`,
        `  .ls-toast__\${kind} { a: b; }`,
        `\``,
        `const mixin = css\`div.ls-alert:hover { a: b }\``,
        `const Other = styled(Link).attrs({})<Props>\`&:hover .ls-alert { a: b }\``,
    ].join("\n")
    const r = await run(code, "styles.tsx")
    assert.equal(
        r.output,
        code
            .replace("  .ls-alert { color", "  [_cxclass_elo-aaaaaa] { color")
            .replace(".ls-button__content, & > .ls-alert__icon", "[_cxclass_elo-dddddd], & > [_cxclass_elo-bbbbbb]")
            .replace("ls-popover-fade-in 1s", "elo-popover-fade-in 1s")
            .replace("div.ls-alert:hover", "elo-alert[_cxclass_elo-aaaaaa]:hover")
            .replace("&:hover .ls-alert", "&:hover [_cxclass_elo-aaaaaa]"),
    )
    assert.deepEqual(todos(r.entries), ["dynamic .ls-toast__"])
    assert.equal(kinds(r.entries, "unknown").length, 0)
})

test("object styles: selector keys and animation values", async () => {
    const code = [
        `const s = css({ "& .ls-alert": { color: "red", "&:hover .ls-alert__icon": { a: 1 } }, animation: "ls-toast-fade-out 1s" })`,
        `const el = <div sx={{ ".ls-button &": { a: 1 } }} style={{ animationName: "ls-popover-fade-in" }} />`,
        `node.style.animation = "ls-popover-fade-in 2s"`,
    ].join("\n")
    const r = await run(code, "objects.tsx")
    assert.equal(
        r.output,
        [
            `const s = css({ "& [_cxclass_elo-aaaaaa]": { color: "red", "&:hover [_cxclass_elo-bbbbbb]": { a: 1 } }, animation: "elo-toast-fade-out 1s" })`,
            `const el = <div sx={{ "[_cxclass_elo-cccccc] &": { a: 1 } }} style={{ animationName: "elo-popover-fade-in" }} />`,
            `node.style.animation = "elo-popover-fade-in 2s"`,
        ].join("\n"),
    )
})

test("class usages are TODOs with the part attribute — never rewritten into a broken class", async () => {
    const code = [
        `const a = <div className="ls-alert mine" />`,
        `const b = <div className={clsx("ls-button", on && "ls-alert__icon")} />`,
        `el.classList.add("ls-alert"); el?.classList.toggle("ls-button", on)`,
        `if (el.classList.contains("ls-alert__icon")) {}`,
        `document.getElementsByClassName("ls-button")`,
        `expect(el).toHaveClass("ls-alert")`,
        `el.className = "ls-button"`,
        `el.setAttribute("class", "ls-alert")`,
        `const c = <div className={\`ls-toast__\${kind} ls-nope\`} />`,
        `const d = <div className="ls-color" />`,
    ].join("\n")
    const r = await run(code, "classes.tsx")
    assert.equal(r.output, code, "nothing is rewritten")
    assert.deepEqual(todos(r.entries), [
        "class-usage ls-alert → [_cxclass_elo-aaaaaa]",
        "class-usage ls-button → [_cxclass_elo-cccccc]",
        "class-usage ls-alert__icon → [_cxclass_elo-bbbbbb]",
        "class-usage ls-alert → [_cxclass_elo-aaaaaa]",
        "class-usage ls-button → [_cxclass_elo-cccccc]",
        'class-usage ls-alert__icon → hasAttribute("_cxclass_elo-bbbbbb") / toHaveAttribute("_cxclass_elo-bbbbbb")',
        'class-usage ls-button → querySelectorAll("[_cxclass_elo-cccccc]")',
        'class-usage ls-alert → hasAttribute("_cxclass_elo-aaaaaa") / toHaveAttribute("_cxclass_elo-aaaaaa")',
        "class-usage ls-button → [_cxclass_elo-cccccc]",
        "class-usage ls-alert → [_cxclass_elo-aaaaaa]",
        "dynamic ls-toast__",
        "class-usage ls-color",
    ])
    assert.deepEqual(
        kinds(r.entries, "unknown").map((e) => e.old),
        ["ls-nope"],
    )
    // T2/D5: the advice names the call API — the removed cx attribute fails the build and the lint
    const asClass = r.entries.find((e) => e.kind === "todo" && e.old === "ls-alert")
    assert.match(asClass?.message ?? "", /render the design-system component.* — with libstylist, \{\.\.\.cx\(yourMap\.part\)\} on it for your own styles — or select \[_cxclass_elo-aaaaaa\]/)
    for (const e of r.entries) assert.doesNotMatch(e.message ?? "", /cx="/, `${e.old}: no cx attribute advice`)
    const all = await run(`const x = <i className="icon-wrapper small" />`, "lit.tsx", { literals: "all" })
    assert.deepEqual(todos(all.entries), ["literal icon-wrapper → :is(elo-icon,[elo-icon])", 'literal small → :is(elo-icon,[elo-icon])[data-size="small"]'])
    assert.equal((await run(`const x = <i className="icon-wrapper small" />`, "lit.tsx")).entries.length, 0, "literals in class names need --literals all")
})

test("removed props and exports of design-system components are TODOs", async () => {
    const code = [
        `import { Button, Popover as Pop, Table, TextInput, EmptyStateShade } from "@livesession/eloquentui-react"`,
        `import * as DS from "@livesession/eloquentui-react"`,
        `import { Button as Other } from "./local"`,
        `import styled from "styled-components"`,
        `const a = <Button className="x" />`,
        `const b = <Pop className={cls} />`,
        `const c = <Table.Td className="x" />`,
        `const d = <TextInput inputClassName="hover" />`,
        `const e = <DS.Button className="x" />`,
        `const f = <Other className="x" />`,
        `const G = styled(Button)\`color: red;\``,
        `const h = <DS.EmptyStateShade />`,
    ].join("\n")
    const r = await run(code, "api.tsx")
    assert.equal(r.output, code)
    assert.deepEqual(todos(r.entries), [
        "api import { EmptyStateShade } → EmptyState.Shade",
        "api <Button className> → [elo-button]",
        "api <Popover className>",
        "api <Table.Td className> → elo-table-td",
        "api <TextInput inputClassName>",
        "api <Button className> → [elo-button]",
        "api styled(Button) → a wrapper element, or select [elo-button]",
        "api DS.EmptyStateShade → EmptyState.Shade",
    ])
    assert.match(kinds(r.entries, "todo").find((e) => e.old === "<TextInput inputClassName>")!.message!, /inputCx slot \(pending P3\)/)
})

test("loose strings: selectors outside a selector API and bare class names are TODOs; import paths and tokens are not", async () => {
    const code = [
        `import "./ls-alert.css"`,
        `import { x } from "../ls-button"`,
        `const SEL = ".ls-alert__icon"`,
        `const ROOT = "ls-alert"`,
        `const color = "var(--ls-color-text)"`,
        `const storage = "ls-session-id"`,
        `export * from "./ls-alert"`,
        `const lazy = import("./ls-button")`,
        `const prefix = ".ls-" + name`,
    ].join("\n")
    const r = await run(code, "loose.ts")
    assert.equal(r.output, code)
    assert.deepEqual(todos(r.entries), ["selector-string .ls-alert__icon → [_cxclass_elo-bbbbbb]", "class-usage ls-alert → [_cxclass_elo-aaaaaa]", "dynamic ls-"])
    assert.equal(kinds(r.entries, "unknown").length, 0, "unknown ls-* strings outside class/selector contexts are not noise")
})

test("strings with escapes are rewritten whole, keeping the quote style", async () => {
    const r = await run(`document.querySelector('.ls-alert[title=\\'a\\']')`, "esc.js")
    assert.equal(r.output, `document.querySelector('[_cxclass_elo-aaaaaa][title=\\'a\\']')`)
})

test("idempotence: TS/JS rewrites converge, TODOs stay", async () => {
    const code = [
        `page.locator(".ls-alert .ls-alert__icon")`,
        `const W = styled.div\`.ls-button { animation: ls-popover-fade-in 1s } \${X} .ls-alert {}\``,
        `const a = <div className="ls-alert" />`,
    ].join("\n")
    const once = await run(code, "idem.tsx")
    assert.ok(once.changed)
    const twice = await run(once.output, "idem.tsx")
    assert.equal(twice.output, once.output)
    assert.equal(kinds(twice.entries, "rewrite").length, 0)
    assert.deepEqual(todos(twice.entries), todos(once.entries))
})

test("JS parse errors surface as errors, not silent skips — recoverable ones don't stop the strings being read", async () => {
    await assert.rejects(run('const = ".ls-alert";', "broken.ts"))
    const dup = await run(`import { a, a } from "./x"\ndocument.querySelector(".ls-alert")`, "dup.ts")
    assert.equal(dup.output, `import { a, a } from "./x"\ndocument.querySelector("[_cxclass_elo-aaaaaa]")`, "a duplicate import binding (esbuild and Babel recover from it)")
})

test("a legacy class the app puts on its own element is never rewritten in its selectors: the rule styles that element too", async () => {
    const code = [
        `import styled from "styled-components"`,
        `const Wrap = styled(Mine)\`&.ls-alert { width: auto; } .ls-button { a: b; }\``,
        `export const X = () => <Wrap className="ls-alert" />`,
        `document.querySelector(".ls-alert > a")`,
    ].join("\n")
    const r = await run(code, "own.tsx")
    assert.equal(r.output, code.replace(".ls-button { a: b; }", "[_cxclass_elo-cccccc] { a: b; }"))
    assert.deepEqual(todos(r.entries), ["app-hook .ls-alert → [_cxclass_elo-aaaaaa]", "class-usage ls-alert → [_cxclass_elo-aaaaaa]", "app-hook .ls-alert → [_cxclass_elo-aaaaaa]"])
    assert.match(kinds(r.entries, "todo")[0].message!, /the app puts the class ls-alert on its own element too \(line 3\)/)
    assert.deepEqual(r.applied, [{ kind: "class", name: "ls-alert", line: 3 }])
    assert.deepEqual(
        (await run(`const x = <div data-component="Tabs" />\nconst y = <div className={\`ls-toast__\${k}\`} />`, "dc.tsx")).applied,
        [{ kind: "data-component", name: "Tabs", line: 1 }],
        "a name built at runtime is not applied as a whole",
    )
})

test("part maps: a key held a class and holds the part attribute name now — class uses are TODOs, class selectors are rewritten", async () => {
    const code = [
        `import { alert as al, tooltip } from "@livesession/eloquentui-css"`,
        `import * as css from "@livesession/eloquentui-css"`,
        `import styled from "styled-components"`,
        `const a = <div className={al.root} />`,
        `const b = <div className={clsx(on && al["icon"], "x")} />`,
        `el.querySelector(\`.\${al.icon} > a, .\${css.alert.root}\`)`,
        `const W = styled.div\`.\${al.icon} { a: b; }\``,
        `expect(el.classList.contains(al.root)).toBe(true)`,
        `const sel = \`.\${al.icon}\``,
        `const c = <div className={tooltip.root} />`,
        `el.querySelector(\`.\${tooltip.root}\`)`,
        `const keep = al.root`,
    ].join("\n")
    const r = await run(code, "maps.tsx")
    assert.equal(
        r.output,
        code.replace(`\`.\${al.icon} > a, .\${css.alert.root}\``, `\`[\${al.icon}] > a, [\${css.alert.root}]\``).replace(`styled.div\`.\${al.icon} {`, `styled.div\`[\${al.icon}] {`),
    )
    assert.deepEqual(
        kinds(r.entries, "rewrite").map((e) => `${e.old} → ${e.new}`),
        ["${al.icon}", "${css.alert.root}", "${al.icon}"].map((x) => `.${x} → [${x}]`),
    )
    assert.deepEqual(todos(r.entries), [
        "part-map al.root",
        'part-map al["icon"]',
        "part-map al.root → hasAttribute(al.root)",
        "part-map .${al.icon} → [${al.icon}]",
        "part-map tooltip.root",
        "part-map .${tooltip.root}",
        "part-map al.root",
    ])
    const [first, , , , renamed, renamedSel, generic] = kinds(r.entries, "todo")
    assert.match(first.message!, /al\.root held the class ls-alert; the part map holds the part attribute name _cxclass_elo-aaaaaa now — a class can't carry it: set it on the element as an attribute \(\{\.\.\.\{ \[al\.root\]: "" \}\}\) or render the design-system component \(Alert\)/)
    assert.match(renamed.message!, /under the key tooltip\["bubble"\] \(tooltip\.root is undefined now\)/)
    assert.equal(renamedSel.new, undefined, "a renamed key is never rewritten: the expression would have to change")
    assert.match(generic.message!, /check how it is used here/)
    const again = await run(r.output, "maps.tsx")
    assert.equal(again.output, r.output, "idempotent")
    assert.deepEqual(todos(again.entries), todos(r.entries), "the rewritten [${…}] selectors are quiet on a second run")
    const attrs = [
        `import { alert as al } from "@livesession/eloquentui-css"`,
        `el.hasAttribute(al.root); el.matches(\`[\${al.icon}] > a\`); const props = { [al.root]: "" }; el.querySelector("[" + al.icon + "]")`,
        `const x = <div {...{ [al.icon]: "" }} />`,
    ].join("\n")
    assert.deepEqual((await run(attrs, "attrs.tsx")).entries, [], "a part map value used as the attribute name it is now")
    const mixed = await run(`import { alert as al } from "@livesession/eloquentui-css"\nel.querySelector(\`.ls-alert > .\${al.icon}\`)`, "mixed.ts")
    assert.equal(mixed.output, `import { alert as al } from "@livesession/eloquentui-css"\nel.querySelector(\`[_cxclass_elo-aaaaaa] > [\${al.icon}]\`)`)
    assert.deepEqual(
        kinds(mixed.entries, "rewrite").map((e) => `${e.old} → ${e.new}`),
        [".ls-alert > .${al.icon} → [_cxclass_elo-aaaaaa] > [${al.icon}]", ".${al.icon} → [${al.icon}]"],
        "the report shows the hole as written and as rewritten",
    )
})

test("reads of data-component / data-part are TODOs: the design system no longer renders them", async () => {
    const code = [
        `expect(el.getAttribute("data-component")).toBe("Tabs")`,
        `expect(el).toHaveAttribute("data-component", "Dock")`,
        `el.hasAttribute("data-part")`,
        `const c = el.dataset.component`,
        `el.getAttribute("data-kind"); el.dataset.kind`,
    ].join("\n")
    const r = await run(code, "reads.test.ts")
    assert.equal(r.output, code)
    assert.deepEqual(todos(r.entries), [
        'attribute-read getAttribute("data-component")',
        'attribute-read toHaveAttribute("data-component", "Dock") → :is(elo-app-dock,[elo-app-dock])',
        'attribute-read hasAttribute("data-part")',
        "attribute-read el.dataset.component",
    ])
})

test("reports show a template's interpolations as written, not as placeholders", async () => {
    const r = await run("document.querySelector(`.ls-alert[data-id=\"${id}\"] .ls-alert__icon`); el.closest(`.ls-button${sel.x}`)", "shown.ts")
    assert.deepEqual(
        kinds(r.entries, "rewrite").map((e) => `${e.old} → ${e.new}`),
        ['.ls-alert[data-id="${id}"] .ls-alert__icon → [_cxclass_elo-aaaaaa][data-id="${id}"] [_cxclass_elo-bbbbbb]'],
    )
    assert.deepEqual(todos(r.entries), ["dynamic .ls-button"], "a class glued to an interpolation is built at runtime")
})
