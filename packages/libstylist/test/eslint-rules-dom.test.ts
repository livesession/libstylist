// RuleTester suites for the DOM-level rules: no-imperative-class, no-anonymous-container,
// no-class-query, no-hash-literal.
import { describe, it } from "node:test"

import tsParser from "@typescript-eslint/parser"
import { RuleTester, type Rule } from "eslint"

import noAnonymousContainer from "../src/eslint/rules/no-anonymous-container.js"
import noClassQuery from "../src/eslint/rules/no-class-query.js"
import noHashLiteral from "../src/eslint/rules/no-hash-literal.js"
import noImperativeClass from "../src/eslint/rules/no-imperative-class.js"
import reflectedProps from "../src/eslint/rules/reflected-props.js"

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { libstylist: { prefix: "elo", namespace: "core", segments: [] } },
})

const run = (name: string, rule: unknown, tests: Parameters<RuleTester["run"]>[2]) => tester.run(name, rule as Rule.RuleModule, tests)

describe("libstylist/no-imperative-class", () => {
    run("no-imperative-class", noImperativeClass, {
        valid: [
            `el.dataset.open = "true"`,
            `el.setAttribute("data-open", "")`,
            `el.toggleAttribute("hidden", !open)`,
            `const c = el.getAttribute("class")`,
            `const c = el.className`,
            `const { dataset } = el`,
            `el.setAttribute(name, "x")`,
            `const o = { classList: [] }`,
            `type T = HTMLElement["classList"]`,
        ],
        invalid: [
            { code: `el.classList.add("x")`, errors: [{ messageId: "classList" }] },
            { code: `el.classList.toggle("open", on)`, errors: [{ messageId: "classList" }] },
            { code: `if (el.classList.contains("x")) {}`, errors: [{ messageId: "classList" }] },
            { code: `el?.classList.remove("x")`, errors: [{ messageId: "classList" }] },
            { code: `el["classList"].add("x")`, errors: [{ messageId: "classList" }] },
            { code: `const { classList } = el`, errors: [{ messageId: "classList" }] },
            { code: `el.className = "x"`, errors: [{ messageId: "className" }] },
            { code: `el.className += " x"`, errors: [{ messageId: "className" }] },
            { code: `el.setAttribute("class", "x")`, errors: [{ messageId: "attribute", data: { method: "setAttribute", name: "class" } }] },
            { code: `el.setAttribute("className", "x")`, errors: [{ messageId: "attribute", data: { method: "setAttribute", name: "className" } }] },
            { code: `el.removeAttribute("class")`, errors: [{ messageId: "attribute" }] },
            { code: `el.toggleAttribute("class")`, errors: [{ messageId: "attribute" }] },
            { code: `el.setAttributeNS(null, "class", "x")`, errors: [{ messageId: "attribute", data: { method: "setAttributeNS", name: "class" } }] },
        ],
    })
})

describe("libstylist/no-anonymous-container", () => {
    run("no-anonymous-container", noAnonymousContainer, {
        valid: [
            `document.createElement("elo-toast-region")`,
            `document.createElement("textarea")`,
            `React.createElement("div")`,
            `createElement("div")`,
            `document.createElement(tag)`,
            `document.createElementNS("http://www.w3.org/2000/svg", "svg")`,
            `factory.createElement("div")`,
        ],
        invalid: [
            {
                code: `document.createElement("div")`,
                errors: [{ messageId: "anonymous", data: { method: "document.createElement", tag: "div", prefix: "elo" } }],
            },
            { code: `el.ownerDocument.createElement("span")`, errors: [{ messageId: "anonymous" }] },
            { code: `ownerDocument.createElement("div")`, errors: [{ messageId: "anonymous" }] },
            { code: `window.document.createElement("DIV")`, errors: [{ messageId: "anonymous", data: { method: "document.createElement", tag: "DIV", prefix: "elo" } }] },
            { code: "document.createElement(`span`)", errors: [{ messageId: "anonymous" }] },
            { code: `const TAG = "div"\ndocument.createElement(TAG)`, errors: [{ messageId: "anonymous" }] },
            { code: `document.createElementNS("http://www.w3.org/1999/xhtml", "div")`, errors: [{ messageId: "anonymous", data: { method: "document.createElementNS", tag: "div", prefix: "elo" } }] },
            {
                code: `document.createElement("div")`,
                settings: { libstylist: { prefix: "app", namespace: "core" } },
                errors: [{ messageId: "anonymous", data: { method: "document.createElement", tag: "div", prefix: "app" } }],
            },
        ],
    })
})

describe("libstylist/no-class-query", () => {
    run("no-class-query", noClassQuery, {
        valid: [
            `el.querySelector("[data-active]")`,
            `root.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')`,
            `el.closest("elo-alert")`,
            `el.matches("[elo-button]")`,
            `el.querySelector('a[href$=".pdf"]')`,
            `el.querySelector('[data-value="1.5"]')`,
            `el.querySelector(selector)`,
            "el.querySelector(`[data-id=\"${id}\"]`)",
            `el.querySelector("[")`,
            `el.querySelector("#main > li")`,
            `const SEL = "[data-dropdown-item]"\nel.querySelectorAll(SEL)`,
            `str.match(".x")`,
        ],
        invalid: [
            { code: `el.querySelector(".ls-alert__icon")`, errors: [{ messageId: "classSelector", data: { method: "querySelector", name: "ls-alert__icon" } }] },
            { code: `el.closest("div.open")`, errors: [{ messageId: "classSelector", data: { method: "closest", name: "open" } }] },
            { code: `el.matches(".a, .b")`, errors: [{ messageId: "classSelector", data: { method: "matches", name: "a" } }] },
            { code: `const SEL = ".item"\nel.querySelectorAll(SEL)`, errors: [{ messageId: "classSelector", data: { method: "querySelectorAll", name: "item" } }] },
            { code: "el.querySelector(`.${cls}`)", errors: [{ messageId: "classSelector", data: { method: "querySelector", name: "${…}" } }] },
            { code: "el.querySelector(`${sel} .hover`)", errors: [{ messageId: "classSelector", data: { method: "querySelector", name: "hover" } }] },
            { code: `el.querySelector("[data-x] " + ".y")`, errors: [{ messageId: "classSelector", data: { method: "querySelector", name: "y" } }] },
            { code: `el.querySelector(":is(.a, [b])")`, errors: [{ messageId: "classSelector", data: { method: "querySelector", name: "a" } }] },
            { code: `document.getElementsByClassName("x")`, errors: [{ messageId: "byClassName" }] },
        ],
    })
})

describe("libstylist/no-hash-literal", () => {
    run("no-hash-literal", noHashLiteral, {
        valid: [
            `const id = "ls-checkbox-label"`,
            "const id = `ls-website-switcher-${n}`",
            `<clipPath id="ls-player-controls-dot-menu" />`,
            `import x from "./ls-alert__x.css"`,
            `export * from "./_cxclass_map"`,
            `const k = "alert.icon"`,
            `const a = "_cxpart"`,
            `const cls = "tools-x__y"`,
        ],
        invalid: [
            { code: `const a = "_cxclass_elo-or4d4l"`, errors: [{ messageId: "hash", data: { match: "_cxclass_elo-or4d4l" } }] },
            { code: `el.querySelector("[_cxclass_elo-or4d4l]")`, errors: [{ messageId: "hash", data: { match: "_cxclass_elo-or4d4l" } }] },
            { code: `const s = ".ls-button"`, errors: [{ messageId: "legacyClass", data: { match: ".ls-button" } }] },
            { code: `const s = "button.ls-button[data-kind]"`, errors: [{ messageId: "legacyClass", data: { match: ".ls-button" } }] },
            { code: `const s = "ls-alert__icon"`, errors: [{ messageId: "legacyClass", data: { match: "ls-alert__icon" } }] },
            { code: "const s = `div .ls-x ${a}`", errors: [{ messageId: "legacyClass", data: { match: ".ls-x" } }] },
            { code: "const s = `${a} ls-text-input__wrapper`", errors: [{ messageId: "legacyClass", data: { match: "ls-text-input__wrapper" } }] },
            { code: `<div data-x="ls-a__b" />`, errors: [{ messageId: "legacyClass" }] },
            { code: `type T = "_cxclass_elo-abc123"`, errors: [{ messageId: "hash" }] },
        ],
    })
})

describe("libstylist/reflected-props", () => {
    const rt = `import { unsetRef } from "@livesession/libstylist/runtime"\n`
    run("reflected-props", reflectedProps, {
        valid: [
            `<elo-alert title="Close" id="x" tabIndex={0} />`,
            `<elo-alert title={\`\${a} b\`} />`,
            `<div title={title} tabIndex={tabIndex} />`,
            `<button elo-button title={title} />`,
            `<elo-alert data-title={title} aria-label={label} role={role} hidden={hidden} spellCheck={check} />`,
            `<ui-thing title={title} />`,
            `const ID = "__ls_cursor"\n;<elo-player-pointer id={ID} />`,
            `const A = "a"; const B = A + "-b"\n;<elo-player-pointer id={B} />`,
            `${rt}<elo-player-time tabIndex={toggle ? 0 : undefined} ref={unsetRef({ tabIndex: toggle ? 0 : undefined })} />`,
            `${rt}<elo-text id={id} title={title} ref={unsetRef({ id, title })} />`,
            `import * as rt from "@livesession/libstylist/runtime"\n<elo-text id={id} ref={rt.unsetRef({ id })} />`,
        ],
        invalid: [
            { code: `<elo-text id={id} />`, errors: [{ messageId: "unguarded", data: { name: "id", tag: "elo-text", attr: "id" } }] },
            { code: `<elo-player-time tabIndex={toggle ? 0 : undefined} />`, errors: [{ messageId: "unguarded", data: { name: "tabIndex", tag: "elo-player-time", attr: "tabindex" } }] },
            { code: `${rt}<elo-text id={id} title={title} ref={unsetRef({ id })} />`, errors: [{ messageId: "unguarded", data: { name: "title", tag: "elo-text", attr: "title" } }] },
            { code: `<elo-text id={id} ref={setRef} />`, errors: [{ messageId: "unguarded" }] },
            { code: `let ID = "x"\n;<elo-text id={ID} />`, errors: [{ messageId: "unguarded" }] },
            { code: `const unsetRef = (x) => x;\n<elo-text id={id} ref={unsetRef({ id })} />`, errors: [{ messageId: "unguarded" }] },
            { code: `<elo-text title={null} lang={lang} dir={dir} />`, errors: [{ messageId: "unguarded" }, { messageId: "unguarded" }, { messageId: "unguarded" }] },
        ],
    })
})
