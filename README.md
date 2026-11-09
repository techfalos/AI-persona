# A Persona Format Suitable for AI-Human Representation

An open file format for one person's life over time so that software (an AI that speaks as them, a family archive, a genealogy tool) can represent them as they were on a given day.

## What's here

```
spec/persona.annotated.json   the specification
schema/persona.schema.json    JSON Schema 2020-12, generated from the spec
examples/hazel/persona.json   a complete example persona (fictional)
tools/build-schema.mjs        regenerates the schema from the spec
tools/validate.mjs            checks persona files
```

## Reading the spec

`[spec/persona.annotated.json](spec/persona.annotated.json)` is the specification. Example specification entries: 

```json
"deceased": "true|false — whether the persona has died: true when they have died, with or without a deathDate; false while living. ..."
```

`$values` at the top explains the notation (`<date>`, `<text>`, `a|b|c`). Keys beginning with `$` are notes and never appear in a real file. A list shows one entry, standing for every entry.

The JSON Schema is generated from this file, so the spec is the single source of truth.

## A persona package

A persona travels as a zip with `persona.json` at its root and its media in three folders:

```
someone.persona.zip
├── persona.json
├── pictures/   .jpg .jpeg .png .webp
├── audio/      .mp3 .wav .webm .ogg .m4a
└── avatars/    .glb
```

`persona.json` names each file by its plain name (`"picture": "hazel-1985.jpg"`); the field it is in says which folder it lives in.

## Example: Hazel Whitaker

`[examples/hazel/persona.json](examples/hazel/persona.json)` is a complete persona for Hazel Whitaker, a fictitious person 

## Validating a file

Requires Node.js 18 or later.

```sh
npm install
npm run validate -- examples/hazel
npm run validate -- path/to/someone.persona.zip
npm run validate -- path/to/persona.json
```

The validator checks:

1. the JSON Schema: every field present, no unknown fields, every value one the spec lists
2. ids: unique among items of their kind, and every reference (a relationship, place, slice, profile, group or sub-event) names something that exists
3. rules that span fields: end dates after start dates, no approximate flag on a missing date, a death date means `deceased`, a pet with a death date `died`, the primary language among the languages, events of at most 30 days with their parts on those days
4. for a folder or `.persona.zip`: every file the persona names is in the package, with a warning for files nothing names

It exits with code 1 if any file has an error.

## Reading and writing persona files

**Writers** write every field, with values only from the lists in the spec for their `specVersion`. The schema and validator check this strictly.

**Readers** are forgiving, so that older software can read newer files:

- Ignore any field you do not know.
- Read a value you do not know as the spec says: `other` where the list has it, `unspecified` or `null` where those are allowed, and otherwise as the field itself says. An unknown visibility level is read as `secret`, so a newer file never reveals more than it should.
- Honor `visibility`. 
- A null end date means ongoing; for someone who has died, it runs until their death.

## Security & Privacy

A full `persona.json` holds a whole life, possibly including what the person kept from the people around them. It should be treated with the utmost of security and with proper privacy concerns.

## Changing the spec

1. Edit `spec/persona.annotated.json`. Bump `specVersion` whenever a field or a value is added, or one changes meaning.
2. Run `npm run build:schema` to regenerate the schema.
3. Run `npm test`, which checks that the schema matches the spec and that the example still validates.

Pull requests run the same check.

## Implementations

- [My Locket](https://my-locket.com) lets family and friends talk with someone as they were on any day of their life. You may use My Locket for free to create and export `persona.zip` packages.

Using the format somewhere? Open an issue or a pull request to add it here.

## License

MIT. See [LICENSE](LICENSE).