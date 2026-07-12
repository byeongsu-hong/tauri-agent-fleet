# Runner instruction format

Fleet uses [TOON](https://github.com/toon-format/toon) for structured data sent
to and returned by runner models. TOON is a human-readable, token-oriented,
lossless encoding of the JSON data model.

`encodeInstruction(value)` converts a JSON-compatible value to TOON and
`decodeInstruction(text)` converts it back:

```ts
deepEqual(decodeInstruction(encodeInstruction(value)), value)
```

For text-to-text conversion, use `jsonToInstruction(json)` and
`instructionToJson(toon)`. Fleet keeps config, suite, protocol, and artifact
files as JSON; only the model boundary uses TOON.

## Turn input

```toon
objective: Rename the current document to notes.md.
pass[1]:
  - expect:
      role: textbox
      name: Document name
      value: notes.md
observation:
  snapshot: "textbox \"Document name\" value=Untitled"
remaining:
  steps: 3
  seconds: 20
  tokens: 4000
```

`previousAction` is omitted on the first turn and included on later turns.

## Action output

The model returns one TOON object and no prose:

```toon
type: fill
role: textbox
name: Document name
value: notes.md
```

`parseAction` remains the trust-boundary validator. Invalid TOON, extra fields,
unsupported actions, unsafe waits, and missing fields become `runner_failure`.
Valid JSON action objects remain accepted as a compatibility fallback when a
model ignores the requested output format.
