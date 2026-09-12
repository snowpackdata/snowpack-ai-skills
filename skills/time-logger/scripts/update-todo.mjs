#!/usr/bin/env node
// Deterministically update one item in a `todo` skill v2 file (todos.yaml) by id — used by
// /time-logger's feedback-apply flow (see ../references/review-feedback.md, "Todo comments")
// instead of finding-and-hand-editing a line, now that every field is structured.
//
// Usage:
//   node update-todo.mjs <todos_file> <id> [--state pending|in_progress|done]
//     [--priority high|medium|low|none] [--group <name>] [--text "..."] [--note "..."]
//   node update-todo.mjs <todos_file> <id> --delete
//
// Any number of --state/--priority/--group/--text may be combined in one call; --note may be
// repeated (each appends). Setting --state done also sets `done` to today unless the item
// already has one. --delete removes the item outright and may not be combined with any other
// flag. Exits 1 if the file is missing or no item matches <id>; exits 2 on a usage error.
// Writes atomically (temp file + rename).
import { readFile, writeFile, rename } from 'node:fs/promises';
import { parseTodosFile, stringifyTodosFile } from './todo-format.mjs';

const USAGE = 'usage: update-todo.mjs <todos_file> <id> [--state pending|in_progress|done] '
  + '[--priority high|medium|low|none] [--group <name>] [--text "..."] [--note "..."]\n'
  + '   or: update-todo.mjs <todos_file> <id> --delete';

function parseArgs(argv) {
  const [file, id, ...rest] = argv;
  if (!file || !id) { console.error(USAGE); process.exit(2); }
  if (rest.length === 1 && rest[0] === '--delete') return { file, id, patch: null, notes: [] };
  const patch = {};
  const notes = [];
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const val = rest[i + 1];
    if (flag === '--delete') { console.error(`--delete can't be combined with other flags\n${USAGE}`); process.exit(2); }
    if (val === undefined) { console.error(`${flag} needs a value\n${USAGE}`); process.exit(2); }
    if (flag === '--state') {
      if (!['pending', 'in_progress', 'done'].includes(val)) { console.error(`bad --state: ${val}`); process.exit(2); }
      patch.state = val;
    } else if (flag === '--priority') {
      patch.priority = val === 'none' ? null : val;
    } else if (flag === '--group') {
      patch.group = val;
    } else if (flag === '--text') {
      patch.text = val;
    } else if (flag === '--note') {
      notes.push(val);
    } else {
      console.error(`unknown flag: ${flag}\n${USAGE}`);
      process.exit(2);
    }
  }
  return { file, id, patch, notes };
}

async function main() {
  const { file, id, patch, notes } = parseArgs(process.argv.slice(2));
  const text = await readFile(file, 'utf8').catch(() => {
    console.error(`no such file: ${file}`);
    process.exit(1);
  });
  const data = parseTodosFile(text);
  const idx = data.todos.findIndex((t) => t.id === id);
  if (idx === -1) { console.error(`no todo with id ${id} in ${file}`); process.exit(1); }
  if (patch === null) {
    data.todos.splice(idx, 1);
    await writeFile(`${file}.tmp`, stringifyTodosFile(data));
    await rename(`${file}.tmp`, file);
    console.log(`deleted ${id}`);
    return;
  }
  const item = data.todos[idx];
  Object.assign(item, patch);
  if (patch.state === 'done' && !item.done) item.done = new Date().toISOString().slice(0, 10);
  if (notes.length) item.notes = [...(item.notes || []), ...notes];
  const tmp = `${file}.tmp`;
  await writeFile(tmp, stringifyTodosFile(data));
  await rename(tmp, file);
  console.log(`updated ${id}: ${JSON.stringify({ ...patch, ...(notes.length ? { notes } : {}) })}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
