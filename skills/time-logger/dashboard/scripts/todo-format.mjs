// Reader/writer for the `todo` skill's v2 file (schema in skills/todo/CHANGELOG.md).
//
// This is NOT a general YAML parser — it understands exactly the restricted shape `/todo`
// emits: a top-level `todos:` key, then a flat sequence of mappings, each starting with
// `  - id: <value>` and followed by fixed-name scalar fields at 4-space indent, plus one
// list-valued field (`notes:`, either `[]` or a block sequence of quoted strings at 6-space
// indent). Keep this in sync with the copy at ../../scripts/todo-format.mjs (used by
// update-todo.mjs) if the schema changes.
const ITEM_START_RE = /^  - id:\s*(.*)$/;
const FIELD_RE = /^    ([a-z_]+):\s*(.*)$/;
const NOTE_RE = /^      - (.*)$/;

function unquote(raw) {
  const v = raw.trim();
  if (v === '' || v === 'null' || v === '~') return null;
  const singleQuoted = v.match(/^'(.*)'$/);
  if (singleQuoted) return singleQuoted[1].replace(/''/g, "'");
  const doubleQuoted = v.match(/^"(.*)"$/);
  if (doubleQuoted) return doubleQuoted[1].replace(/\\"/g, '"');
  return v;
}

function quote(value) {
  if (value === null || value === undefined || value === '') return 'null';
  const s = String(value);
  return /^[A-Za-z_][A-Za-z0-9_./#:@-]*$/.test(s) && s !== 'null' && s !== 'true' && s !== 'false'
    ? s
    : `'${s.replace(/'/g, "''")}'`;
}

// Parses text in the shape above into `{ todos: [{ id, project, text, state, backend, url,
// group, priority, created, done, notes: [] }, ...] }`. Unknown/missing fields are left
// undefined/absent rather than guessed.
export function parseTodosFile(text) {
  const todos = [];
  let current = null;
  let inNotes = false;
  for (const line of (text || '').split('\n')) {
    const start = line.match(ITEM_START_RE);
    if (start) {
      if (current) todos.push(current);
      current = { id: unquote(start[1]), notes: [] };
      inNotes = false;
      continue;
    }
    if (!current) continue;
    if (inNotes) {
      const note = line.match(NOTE_RE);
      if (note) { current.notes.push(unquote(note[1])); continue; }
      inNotes = false;
    }
    const field = line.match(FIELD_RE);
    if (field) {
      const [, key, rawVal] = field;
      if (key === 'notes') {
        inNotes = rawVal.trim() !== '[]';
        if (!inNotes) current.notes = [];
        continue;
      }
      current[key] = unquote(rawVal);
    }
  }
  if (current) todos.push(current);
  return { todos };
}

const FIELD_ORDER = ['project', 'text', 'state', 'backend', 'url', 'group', 'priority', 'created', 'done'];

export function stringifyTodosFile({ todos }) {
  const lines = [
    "# todos.yaml — canonical todo store written by the `todo` skill (schema v2).",
    '# Structure only: keep each item\'s keys/order — see skills/todo/SKILL.md and CHANGELOG.md.',
    'todos:',
  ];
  for (const t of todos) {
    lines.push(`  - id: ${quote(t.id)}`);
    for (const key of FIELD_ORDER) lines.push(`    ${key}: ${quote(t[key] ?? null)}`);
    if (!t.notes || t.notes.length === 0) {
      lines.push('    notes: []');
    } else {
      lines.push('    notes:');
      for (const n of t.notes) lines.push(`      - ${quote(n)}`);
    }
  }
  return lines.join('\n') + '\n';
}
