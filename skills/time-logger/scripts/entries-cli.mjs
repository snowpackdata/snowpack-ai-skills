#!/usr/bin/env node
// Deterministic CLI over dashboard/scripts/entries-store.mjs — the same access layer the
// dashboard server calls in-process, exposed for anything that isn't Node-in-process (the
// generate-time-entry agent, the /time-logger feedback flow, a shell script) so it has one
// write path instead of hand-editing `### ` lines. Same shape as update-todo.mjs.
//
// Usage:
//   node entries-cli.mjs get-day <date>
//   node entries-cli.mjs get-range <from> <to>
//   node entries-cli.mjs bounds
//   node entries-cli.mjs set-non-billable <date> <heading> <true|false>
//   node entries-cli.mjs set-time-range <date> <heading> <startHour> <endHour>
//
// <date>/<from>/<to> are YYYY-MM-DD. <heading> is the entry's stable heading (its `###` line
// with any [client: ...] tag kept and any [non-billable] tag stripped — same string the
// dashboard already uses to address an entry). Prints the resulting JSON on success; exits 1
// with an error message on failure.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Distributed two different ways — as-is in the skill repo (a sibling of dashboard/) and
// copied standalone into <data home>/scripts/ by bootstrap.sh (a sibling of app/dashboard/,
// not dashboard/) — so a single static relative import can't reach entries-store.mjs in both.
// Same fix as update-todo.mjs's.
const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRIES_STORE_CANDIDATES = [
  join(HERE, '../dashboard/scripts/entries-store.mjs'),     // repo layout
  join(HERE, '../app/dashboard/scripts/entries-store.mjs'), // <data home>/scripts layout
];
const entriesStorePath = ENTRIES_STORE_CANDIDATES.find(existsSync);
if (!entriesStorePath) {
  console.error('entries-store.mjs not found in either expected layout');
  process.exit(1);
}
const { getDay, getRange, getBounds, setEntryField } = await import(entriesStorePath);

const USAGE = `usage:
  entries-cli.mjs get-day <date>
  entries-cli.mjs get-range <from> <to>
  entries-cli.mjs bounds
  entries-cli.mjs set-non-billable <date> <heading> <true|false>
  entries-cli.mjs set-time-range <date> <heading> <startHour> <endHour>`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) { console.error(USAGE); process.exit(2); }

  if (cmd === 'get-day') {
    const [date] = rest;
    if (!date) { console.error(USAGE); process.exit(2); }
    console.log(JSON.stringify(await getDay(date), null, 2));
    return;
  }
  if (cmd === 'get-range') {
    const [from, to] = rest;
    if (!from || !to) { console.error(USAGE); process.exit(2); }
    console.log(JSON.stringify(await getRange(from, to), null, 2));
    return;
  }
  if (cmd === 'bounds') {
    console.log(JSON.stringify(await getBounds(), null, 2));
    return;
  }
  if (cmd === 'set-non-billable') {
    const [date, heading, value] = rest;
    if (!date || !heading || (value !== 'true' && value !== 'false')) { console.error(USAGE); process.exit(2); }
    await setEntryField(date, heading, { nonBillable: value === 'true' });
    console.log(JSON.stringify(await getDay(date), null, 2));
    return;
  }
  if (cmd === 'set-time-range') {
    const [date, heading, startHour, endHour] = rest;
    if (!date || !heading || startHour === undefined || endHour === undefined) { console.error(USAGE); process.exit(2); }
    await setEntryField(date, heading, { startHour: Number(startHour), endHour: Number(endHour) });
    console.log(JSON.stringify(await getDay(date), null, 2));
    return;
  }
  console.error(USAGE);
  process.exit(2);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
