// Reads the annotated spec (spec/persona.annotated.json), where every field is
// written as "<the values it may take> — <what it means>". Both the schema
// builder and the validator take their rules from it, so the spec stays the
// one source of truth.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SPEC_PATH = join(ROOT, 'spec', 'persona.annotated.json');
export const SCHEMA_PATH = join(ROOT, 'schema', 'persona.schema.json');

export function loadSpec(path = SPEC_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Keys beginning with $ are notes, never part of persona.json.
export const isNote = (key) => key.startsWith('$');

// "<values> — <meaning>" -> { type, desc }
export function splitLeaf(text) {
  const at = text.indexOf(' — ');
  if (at < 0) throw new Error(`Spec leaf has no " — ": ${text.slice(0, 80)}`);
  return { type: text.slice(0, at).trim(), desc: text.slice(at + 3).trim() };
}

// Splits "a|<b>|[c|d]|null" on | outside brackets.
function splitAlternatives(type) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of type) {
    if (ch === '[' || ch === '<') depth++;
    if (ch === ']' || ch === '>') depth--;
    if (ch === '|' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Returns a list of alternatives:
//   { kind: 'null' } | { kind: 'boolean' } | { kind: 'literal', value }
//   { kind: 'token', value: '<text>' } | { kind: 'array', items: [...] }
export function parseType(type) {
  const alts = [];
  let sawTrue = false;
  let sawFalse = false;
  for (const part of splitAlternatives(type)) {
    if (part === 'null') alts.push({ kind: 'null' });
    else if (part === 'true') sawTrue = true;
    else if (part === 'false') sawFalse = true;
    else if (part.startsWith('<') && part.endsWith('>')) alts.push({ kind: 'token', value: part });
    else if (part.startsWith('[') && part.endsWith(']')) alts.push({ kind: 'array', items: parseType(part.slice(1, -1)) });
    else alts.push({ kind: 'literal', value: part });
  }
  if (sawTrue && sawFalse) alts.push({ kind: 'boolean' });
  else if (sawTrue || sawFalse) alts.push({ kind: 'literal', value: sawTrue });
  return alts;
}

// Tokens that name another item of the file, and which list they point into.
export const REFERENCE_TOKENS = {
  '<profile id>': 'profiles',
  '<relationship id>': 'relationships',
  '<group id>': 'relationshipGroups',
  '<place id>': 'places',
  '<slice id>': 'slices',
  '<sub-event id>': 'subEvents', // within the event being read
};

// Tokens that name a file in the package, and the folder it lives in.
export const FILE_TOKENS = {
  '<picture file>': 'pictures',
  '<audio file>': 'audio',
  '<avatar file>': 'avatars',
};
