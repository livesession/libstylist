// Tags typed `React.ElementType`, as in TextInput (`as?: React.ElementType`), and a literal tag
// union, as in Button (`button | a`). They compile with the generated explicit keys, which add
// only literal keys to `keyof JSX.IntrinsicElements`. The opt-in StylistTagMap key adds
// `elo-${string}` instead, and every `React.ElementType` tag then fails with TS2604 on 4.9 and 5.x.
import * as React from "react"

type InputProps = { as?: React.ElementType; id?: string }
export function Input({ as: As = "input", id }: InputProps) {
    return <As id={id} data-size="small" />
}

type TitledProps = { as?: React.ElementType<{ title?: string }> }
export function Titled({ as: Tag = "div" }: TitledProps) {
    return <Tag title="t" />
}

export function Action({ link }: { link: boolean }) {
    const As = link ? "a" : "button"
    return <As elo-button />
}
