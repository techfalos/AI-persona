// Checks persona files against the spec.
//
//   npm run validate -- path/to/persona.json
//   npm run validate -- path/to/folder          (a folder holding persona.json)
//   npm run validate -- path/to/someone.persona.zip
//
// It checks, in order:
//   1. the JSON Schema (every field present and well-formed, values from the spec's lists)
//   2. ids: unique among the items of their kind, and every reference names an item that exists
//   3. the rules that span fields: dates in order, approximate flags, deceased, primaryLanguage
//   4. for a folder or a .persona.zip, that every file the persona names is in the package
//
// Exits 1 if any file has an error.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { unzipSync } from 'fflate';
import { loadSpec, splitLeaf, parseType, isNote, SCHEMA_PATH, REFERENCE_TOKENS, FILE_TOKENS } from './spec.mjs';

const spec = loadSpec();
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, verbose: true });
const validateSchema = ajv.compile(schema);
const PACKAGE_FOLDERS = Object.values(FILE_TOKENS);

// ---------- loading ----------

function load(target) {
  if (!existsSync(target)) throw new Error('No such file or folder');
  if (statSync(target).isDirectory()) {
    const jsonPath = join(target, 'persona.json');
    if (!existsSync(jsonPath)) throw new Error('The folder has no persona.json');
    const files = new Set();
    for (const folder of PACKAGE_FOLDERS) {
      const dir = join(target, folder);
      if (existsSync(dir)) for (const name of readdirSync(dir)) files.add(`${folder}/${name}`);
    }
    return { text: readFileSync(jsonPath, 'utf8'), files, extras: [] };
  }
  if (target.toLowerCase().endsWith('.zip')) {
    const entries = unzipSync(new Uint8Array(readFileSync(target)));
    if (!entries['persona.json']) throw new Error('The package has no persona.json at its root');
    const files = new Set();
    const extras = [];
    for (const name of Object.keys(entries)) {
      if (name.endsWith('/') || name === 'persona.json') continue;
      const [folder, ...rest] = name.split('/');
      if (PACKAGE_FOLDERS.includes(folder) && rest.length === 1) files.add(name);
      else extras.push(name);
    }
    return { text: new TextDecoder().decode(entries['persona.json']), files, extras };
  }
  return { text: readFileSync(target, 'utf8'), files: null, extras: [] };
}

// ---------- reporting ----------

function readablePath(pointer) {
  if (!pointer) return '(top level)';
  return pointer
    .split('/')
    .slice(1)
    .map((part) => (/^\d+$/.test(part) ? `[${part}]` : `.${part.replace(/~1/g, '/').replace(/~0/g, '~')}`))
    .join('')
    .replace(/^\./, '');
}

const short = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? 'nothing' : text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

function describe(e) {
  const where = readablePath(e.instancePath);
  if (e.keyword === 'required') return `${where}: missing field "${e.params.missingProperty}"`;
  if (e.keyword === 'additionalProperties') return `${where}: unknown field "${e.params.additionalProperty}"`;
  if (e.keyword === 'enum') return `${where}: ${short(e.data)} is not one of the values the spec lists`;
  if (e.keyword === 'const') return `${where}: must be ${short(e.params.allowedValue)}, not ${short(e.data)}`;
  return `${where}: ${e.message} (got ${short(e.data)})`;
}

// Ajv reports every failed alternative of a field that allows several kinds of
// value (a list or null, say). Boil those down to the one message that helps.
function schemaErrors(errors) {
  const out = [];
  const anyOfPaths = new Set(errors.filter((e) => e.keyword === 'anyOf').map((e) => e.instancePath));
  const hasDeeper = (path) => errors.some((e) => e.instancePath.startsWith(`${path}/`));
  const done = new Set();
  for (const e of errors) {
    const path = e.instancePath;
    if (!anyOfPaths.has(path)) {
      out.push(describe(e));
      continue;
    }
    if (done.has(path)) continue;
    done.add(path);
    if (hasDeeper(path)) continue; // the deeper errors say what is wrong
    const here = errors.filter((x) => x.instancePath === path && x.keyword !== 'anyOf');
    const structural = here.filter((x) => x.keyword === 'required' || x.keyword === 'additionalProperties');
    if (structural.length) {
      out.push(...structural.map(describe));
    } else if (here.some((x) => x.keyword === 'enum')) {
      out.push(describe(here.find((x) => x.keyword === 'enum')));
    } else {
      const description = errors.find((x) => x.instancePath === path && x.keyword === 'anyOf')?.parentSchema?.description;
      out.push(`${readablePath(path)}: ${short(e.data)} is not allowed here${description ? ` (${description})` : ''}`);
    }
  }
  return out;
}

// ---------- checks that follow the spec ----------

// Walks the spec and the persona side by side, so references and file names are
// checked wherever the spec says a field holds one.
function checkAgainstSpec(persona, files, errors) {
  const ids = {};
  for (const list of ['profiles', 'relationships', 'relationshipGroups', 'places', 'slices']) {
    ids[list] = new Set((persona[list] ?? []).map((item) => item?.id));
  }
  const seen = new Map(); // "places[].periods[]" -> Set of ids
  const usedFiles = new Set();

  function leaf(specText, value, path, ctx) {
    if (typeof value !== 'string') return;
    const alts = parseType(splitLeaf(specText).type);
    if (alts.some((a) => a.kind === 'literal' && a.value === value)) return;
    for (const alt of alts) {
      if (alt.kind !== 'token') continue;
      const list = REFERENCE_TOKENS[alt.value];
      if (list) {
        const known = list === 'subEvents' ? new Set((ctx.event?.subEvents ?? []).map((s) => s?.id)) : ids[list];
        if (!known.has(value)) errors.push(`${path}: "${value}" names no item in ${list === 'subEvents' ? "this event's subEvents" : list}`);
      }
      const folder = FILE_TOKENS[alt.value];
      if (folder) {
        usedFiles.add(`${folder}/${value}`);
        if (files && !files.has(`${folder}/${value}`)) errors.push(`${path}: the package has no ${folder}/${value}`);
      }
    }
  }

  function walk(specNode, value, path, pattern, ctx) {
    if (value === undefined || value === null) return;
    if (typeof specNode === 'string') return leaf(specNode, value, path, ctx);
    if (Array.isArray(specNode)) {
      if (!Array.isArray(value)) return;
      value.forEach((item, i) => walk(specNode[0], item, `${path}[${i}]`, `${pattern}[]`, ctx));
      return;
    }
    if (typeof value !== 'object' || Array.isArray(value)) return;
    if (typeof value.id === 'string' && 'id' in specNode && pattern) {
      if (!seen.has(pattern)) seen.set(pattern, new Set());
      if (seen.get(pattern).has(value.id)) errors.push(`${path}.id: "${value.id}" is used by another item of this kind (${pattern})`);
      seen.get(pattern).add(value.id);
    }
    const next = pattern === 'events[]' ? { ...ctx, event: value } : ctx;
    for (const [key, sub] of Object.entries(specNode)) {
      if (!isNote(key)) walk(sub, value[key], path ? `${path}.${key}` : key, pattern ? `${pattern}.${key}` : key, next);
    }
  }

  walk(spec, persona, '', '', {});
  return usedFiles;
}

// ---------- rules that span fields ----------

const day = (date) => Date.parse(`${date}T00:00:00Z`) / 86400000;

function checkRules(persona, errors) {
  // Any object: dates in order, and no approximate flag on a date that is null.
  (function visit(node, path) {
    if (Array.isArray(node)) return node.forEach((item, i) => visit(item, `${path}[${i}]`));
    if (!node || typeof node !== 'object') return;
    const at = (key) => (path ? `${path}.${key}` : key);
    if (typeof node.startDate === 'string' && typeof node.endDate === 'string' && node.endDate < node.startDate) {
      errors.push(`${at('endDate')}: ${node.endDate} is before startDate ${node.startDate}`);
    }
    if (typeof node.birthDate === 'string' && typeof node.deathDate === 'string' && node.deathDate < node.birthDate) {
      errors.push(`${at('deathDate')}: ${node.deathDate} is before birthDate ${node.birthDate}`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key.endsWith('Approximate') && value === true && node[key.slice(0, -'Approximate'.length)] === null) {
        errors.push(`${at(key)}: true, but ${key.slice(0, -'Approximate'.length)} is null`);
      }
      visit(value, at(key));
    }
  })(persona, '');

  // Deceased: a death date means the person has died.
  if (persona.deathDate && persona.deceased === false) errors.push('deceased: false, but the persona has a deathDate');
  (persona.relationships ?? []).forEach((r, i) => {
    if (r?.deathDate && r.deceased === false) errors.push(`relationships[${i}].deceased: false, but there is a deathDate`);
    if (r?.id === 'main') errors.push(`relationships[${i}].id: "main" is reserved for the persona`);
  });

  // A pet with a death date died.
  (persona.pets ?? []).forEach((p, i) => {
    if (p?.deathDate && p.outcome !== 'died') errors.push(`pets[${i}].outcome: must be "died" when there is a deathDate`);
  });

  // The primary language is one of the languages.
  (persona.profiles ?? []).forEach((p, i) => {
    if (Array.isArray(p?.languages) && p.primaryLanguage && !p.languages.includes(p.primaryLanguage)) {
      errors.push(`profiles[${i}].primaryLanguage: "${p.primaryLanguage}" is not among its languages`);
    }
  });

  // Events last a day to 30 days; their parts fall on their days.
  (persona.events ?? []).forEach((e, i) => {
    if (typeof e?.startDate !== 'string' || typeof e?.endDate !== 'string') return;
    if (day(e.endDate) - day(e.startDate) + 1 > 30) errors.push(`events[${i}]: lasts more than 30 days`);
    (e.subEvents ?? []).forEach((s, j) => {
      if (typeof s?.date === 'string' && (s.date < e.startDate || s.date > e.endDate)) {
        errors.push(`events[${i}].subEvents[${j}].date: ${s.date} is not one of the event's days`);
      }
    });
  });
}

// ---------- main ----------

function check(target) {
  const errors = [];
  const warnings = [];
  let loaded;
  try {
    loaded = load(target);
  } catch (e) {
    return { errors: [e.message], warnings };
  }
  let persona;
  try {
    persona = JSON.parse(loaded.text);
  } catch (e) {
    return { errors: [`persona.json is not valid JSON: ${e.message}`], warnings };
  }
  if (!validateSchema(persona)) errors.push(...schemaErrors(validateSchema.errors));
  if (persona && typeof persona === 'object' && !Array.isArray(persona)) {
    const used = checkAgainstSpec(persona, loaded.files, errors);
    checkRules(persona, errors);
    if (loaded.files) {
      for (const file of loaded.files) if (!used.has(file)) warnings.push(`${file} is in the package but nothing names it`);
    } else {
      warnings.push('files named in it were not checked; give the folder or the .persona.zip to check them');
    }
  }
  for (const extra of loaded.extras) warnings.push(`${extra} is outside pictures/, audio/ and avatars/`);
  return { errors, warnings };
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('Usage: npm run validate -- <persona.json | folder | file.persona.zip> [...]');
  process.exit(2);
}

let failed = false;
for (const target of targets) {
  const { errors, warnings } = check(target);
  const name = basename(target);
  if (errors.length) {
    failed = true;
    console.log(`✗ ${name}: ${errors.length} error${errors.length === 1 ? '' : 's'}`);
    for (const e of errors) console.log(`  - ${e}`);
  } else {
    console.log(`✓ ${name}: valid ${spec.spec.split(' — ')[0]} ${spec.specVersion.split(' — ')[0]}`);
  }
  for (const w of warnings) console.log(`  ! ${w}`);
}
process.exit(failed ? 1 : 0);
