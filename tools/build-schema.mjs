// Builds schema/persona.schema.json (JSON Schema 2020-12) from the annotated
// spec. Run after every change to the spec:
//
//   npm run build:schema          write the schema
//   npm run build:schema -- --check   fail if the schema is out of date
//
// The schema checks that a file is a well-formed persona.json of exactly this
// specVersion: every field present, no unknown fields, every value one the
// spec lists. Readers are more forgiving (see the README); the schema is for
// checking what a writer produces. Rules that span fields (ids that must
// exist, dates in order, files in the package) are checked by validate.mjs.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadSpec, splitLeaf, parseType, isNote, SCHEMA_PATH } from './spec.mjs';

const spec = loadSpec();

// Shared definitions for the value kinds listed in the spec's $values.
const defs = {
  text: { type: 'string', maxLength: 200, description: spec.$values['<text>'] },
  longText: { type: 'string', maxLength: 5000, description: spec.$values['<long text>'] },
  date: {
    type: 'string',
    pattern: '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
    description: spec.$values['<date>'],
  },
  timestamp: {
    type: 'string',
    pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$',
    description: spec.$values['<timestamp>'],
  },
  uuid: {
    type: 'string',
    pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    description: spec.$values['<uuid>'],
  },
  id: { type: 'string', minLength: 1, maxLength: 64, description: spec.$values['<id>'] },
  score: { type: 'number', minimum: 0, maximum: 100, description: spec.$values['<0-100>'] },
  color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: spec.$values['<#rrggbb>'] },
  pictureFile: {
    type: 'string',
    maxLength: 200,
    pattern: '^[^./\\\\][^/\\\\]*\\.([jJ][pP][eE]?[gG]|[pP][nN][gG]|[wW][eE][bB][pP])$',
    description: spec.$values['<picture file>'],
  },
  audioFile: {
    type: 'string',
    maxLength: 200,
    pattern: '^[^./\\\\][^/\\\\]*\\.([mM][pP]3|[wW][aA][vV]|[wW][eE][bB][mM]|[oO][gG][gG]|[mM]4[aA])$',
    description: spec.$values['<audio file>'],
  },
  avatarFile: {
    type: 'string',
    maxLength: 200,
    pattern: '^[^./\\\\][^/\\\\]*\\.[gG][lL][bB]$',
    description: spec.$values['<avatar file>'],
  },
};

const TOKEN_DEFS = {
  '<text>': 'text',
  '<long text>': 'longText',
  '<date>': 'date',
  '<timestamp>': 'timestamp',
  '<uuid>': 'uuid',
  '<id>': 'id',
  '<profile id>': 'id',
  '<relationship id>': 'id',
  '<group id>': 'id',
  '<place id>': 'id',
  '<slice id>': 'id',
  '<sub-event id>': 'id',
  '<0-100>': 'score',
  '<#rrggbb>': 'color',
  '<picture file>': 'pictureFile',
  '<audio file>': 'audioFile',
  '<avatar file>': 'avatarFile',
};

function tokenSchema(token) {
  const def = TOKEN_DEFS[token];
  if (!def) throw new Error(`Unknown value kind in spec: ${token}`);
  return { $ref: `#/$defs/${def}` };
}

// Long lists of values used in several places (languages, accents, religions,
// pronouns...) go into $defs once, named after the field that holds them.
const DEF_NAMES = { languages: 'language', primaryLanguage: 'language', daysItem: 'weekday' };

const enumUses = new Map();
function countEnums(node, key) {
  if (typeof node === 'string') {
    collect(parseType(splitLeaf(node).type), key);
  } else if (Array.isArray(node)) {
    countEnums(node[0], key);
  } else {
    for (const [k, v] of Object.entries(node)) if (!isNote(k)) countEnums(v, k);
  }
  function collect(alts, k) {
    const literals = alts.filter((a) => a.kind === 'literal' && typeof a.value === 'string').map((a) => a.value);
    if (literals.length > 1) {
      const sig = JSON.stringify(literals);
      enumUses.set(sig, (enumUses.get(sig) ?? 0) + 1);
    }
    for (const a of alts) if (a.kind === 'array') collect(a.items, `${k}Item`);
  }
}
countEnums(spec, 'persona');

const enumDefNames = new Map();
function enumSchema(key, literals) {
  const sig = JSON.stringify(literals);
  const shared = (enumUses.get(sig) >= 2 && literals.length >= 5) || literals.length > 20;
  if (!shared) return { enum: [...literals] };
  if (!enumDefNames.has(sig)) {
    const name = DEF_NAMES[key] ?? key;
    if (defs[name]) throw new Error(`Two different value lists would both be named "${name}"`);
    defs[name] = { type: 'string', enum: [...literals] };
    enumDefNames.set(sig, name);
  }
  return { $ref: `#/$defs/${enumDefNames.get(sig)}` };
}

function typeSchema(key, alts) {
  const nullable = alts.some((a) => a.kind === 'null');
  const literals = alts.filter((a) => a.kind === 'literal').map((a) => a.value);
  const options = [];

  if (literals.length === 1) options.push({ const: literals[0] });
  else if (literals.length > 1) options.push(enumSchema(key, literals));

  for (const a of alts) {
    if (a.kind === 'boolean') options.push({ type: 'boolean' });
    if (a.kind === 'token') options.push(tokenSchema(a.value));
    if (a.kind === 'array') options.push({ type: 'array', items: typeSchema(`${key}Item`, a.items) });
  }

  if (nullable) {
    // A short inline list takes null as one more value; anything else gets a null branch.
    const only = options.length === 1 ? options[0] : null;
    if (only?.enum) return { enum: [...only.enum, null] };
    options.push({ type: 'null' });
  }
  return options.length === 1 ? options[0] : { anyOf: options };
}

function leafSchema(key, text) {
  const { type, desc } = splitLeaf(text);
  return { ...typeSchema(key, parseType(type)), description: desc };
}

function fieldSchema(key, value) {
  if (typeof value === 'string') return leafSchema(key, value);
  if (Array.isArray(value)) {
    const item = value[0];
    if (typeof item === 'string') {
      const items = leafSchema(key, item);
      const array = { type: 'array', items, description: items.description };
      if (/\bat least one\b/.test(items.description)) array.minItems = 1;
      return array;
    }
    const items = objectSchema(item);
    return { type: 'array', items, description: item.$about };
  }
  return objectSchema(value);
}

function objectSchema(node) {
  const properties = {};
  for (const [k, v] of Object.entries(node)) {
    if (!isNote(k)) properties[k] = fieldSchema(k, v);
  }
  const about = node.$about;
  const schema = { type: 'object', properties, additionalProperties: false };
  // "Every field is written" — except in an object whose $about says fields it
  // leaves alone are left out (tendencyOverrides).
  if (!(about && /\bleft out\b/.test(about))) schema.required = Object.keys(properties);
  if (about) schema.description = about;
  // An object whose $about allows null ("or null when there is none").
  if (about && /\bor null\b/.test(about)) return { anyOf: [schema, { type: 'null' }], description: about };
  return schema;
}

const root = objectSchema({ ...spec, $about: undefined });
const version = spec.specVersion.split(' — ')[0];

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $comment: 'Generated from spec/persona.annotated.json by tools/build-schema.mjs. Do not edit by hand: change the spec and run npm run build:schema.',
  title: `persona.json (persona-interchange-format ${version})`,
  description: spec.$about,
  ...root,
  $defs: defs,
};

const output = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = existsSync(SCHEMA_PATH) ? readFileSync(SCHEMA_PATH, 'utf8') : '';
  if (current !== output) {
    console.error('schema/persona.schema.json is out of date. Run: npm run build:schema');
    process.exit(1);
  }
  console.log('Schema is up to date with the spec.');
} else {
  writeFileSync(SCHEMA_PATH, output);
  console.log(`Wrote ${SCHEMA_PATH} (specVersion ${version}).`);
}
