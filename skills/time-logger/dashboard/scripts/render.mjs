// Renders the JSON data store from the markdown sources of truth.
// Deterministic sections: todos, calendar, slack, summaries.
// Time entries are NOT rendered here — the dashboard reads them live, per request, straight
// from time_logs/*.md via dashboard/server.mjs's /api/entries/* routes (see
// dashboard/scripts/entries-store.mjs). Todo evidence is likewise not computed here — it's
// recomputed only when todos or their inputs change (see refresh-todo-evidence.mjs) and read
// from dashboard/data/todo_evidence.json below. Both used to be recomputed on every single
// call to this script, including ones triggered by an unrelated single-entry edit.
// The digest is the newest summaries/*_daily-digest.md. artifacts.json is agent-written and left untouched;
// their timestamps are folded into meta.json for the UI's staleness badges.
import { readFile, writeFile, readdir, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_HOME, uiConfig } from './capabilities.mjs';
import { parseTodosFile } from './todo-format.mjs';

// Dynamic state lives in the data home; this folder holds only code.
const DATA = join(DATA_HOME, 'dashboard', 'data');
const CONFIG = uiConfig();
const NOW = new Date().toISOString();
const URL_RE = /https?:\/\/[^\s)>\]]+/g;

const read = (p) => readFile(p, 'utf8').catch(() => null);

// Atomic write: the UI polls these files, so a plain writeFile can be read half-done.
async function writeJson(path, payload) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2));
  await rename(tmp, path);
}
const listMd = async (dir) =>
  (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md')).sort();

// ---- client map: Orgs + Clients sections of user-preferences.md -----------
// Lines look like:  - **Name** — org: X — kind: client — matches: ...
// Everyone is a client under an org; the org named by capabilities client.org is the one
// this install logs time for (see CONFIG.org).
function parseClientMap(md) {
  const orgs = {}, clients = {};
  const section = (title) => {
    const m = md && md.match(new RegExp(`^## ${title}\\s*\\n([\\s\\S]*?)(?=^## |^---\\s*$)`, 'm'));
    return m ? m[1] : '';
  };
  const rows = (text) => [...text.matchAll(/^- \*\*([^*]+)\*\*(.*)$/gm)].map(([, name, rest]) => {
    const fields = {};
    for (const part of rest.split(' — ').slice(1)) {
      const kv = part.match(/^\s*([a-z_]+):\s*(.*)$/i);
      if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
    }
    return { name: name.trim(), ...fields };
  });
  for (const r of rows(section('Orgs'))) orgs[r.name] = { billing: r.billing || null };
  for (const r of rows(section('Clients'))) {
    clients[r.name] = { org: r.org || null, kind: (r.kind || 'client').toLowerCase() };
  }
  return { orgs, clients };
}
let CLIENT_MAP = { orgs: {}, clients: {} };

// ---- todos: dashboard.todos_file in capabilities.yml (optional) ----------
// Schema v2 (see ../../todo/CHANGELOG.md and ./todo-format.mjs): a `todos:` list of flat
// items, each with `state`, `backend`, `id`, `project`, `text`, `url`, `group`, `priority`,
// `created`, `done`, `notes`. `kind` is just the item's own `backend` (local/github/jira/...);
// `backend: jira` additionally links through `client.jira_browse_url`. `project` is shown as
// this item's one tag.
//
// Grouping: an item's `group` field names a group explicitly if set, else its `project` is
// used, so nothing that writes this file has to know this dashboard's display conventions.
// Groups merge by name across the whole file regardless of each item's `state`, so a project
// split across pending/in-progress items still renders as one group. "Done"-ness is purely
// per item (`state: done`) — a group is only omitted entirely once every item in it is done.
const SLACK_LINK_RE = /https?:\/\/[a-z0-9-]+\.slack\.com\/archives\/[^\s)>\]]+/gi;
const PR_LINK_RE = /https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/gi;

// Some writers (agents composing text by hand) encode priority as a leading
// "**(HIGH)**"/"**(MEDIUM)**"/"**(LOW)**" marker in `text` instead of the structured
// `priority` field. Parse it out so it renders as the real priority chip instead of
// literal asterisks, and doesn't clutter the displayed text.
const INLINE_PRIORITY_RE = /^\s*\*\*\(?(high|medium|low)\)?\*\*\s*/i;

// Writers often flag a stalled item inline ("blocked on X", "blocked w/ Y", "PENDING
// VERIFICATION") in `text` or a `notes` entry rather than a structured status field.
// Surface it as a chip so it doesn't get lost inside a wall of text.
const BLOCKED_RE = /\bblocked\b|\bpending verification\b/i;
function isBlocked(item) {
  return BLOCKED_RE.test([item.text, ...(item.notes || [])].filter(Boolean).join(' '));
}

function todoFields(item) {
  const url = item.url || null;
  const inlineMatch = !item.priority && (item.text || '').match(INLINE_PRIORITY_RE);
  const text = inlineMatch ? item.text.slice(inlineMatch[0].length) : (item.text || '');
  const priority = item.priority || (inlineMatch ? inlineMatch[1].toLowerCase() : null);
  return {
    text,
    ticket: item.backend === 'jira' ? String(item.id).replace(/^jira:/, '') : null,
    kind: item.backend || 'local',
    tags: item.project ? [item.project] : [],
    priority,
    links: url ? [url] : [],
    pr_keys: url ? [...url.matchAll(PR_LINK_RE)].map((m) => `${m[1]}#${m[2]}`) : [],
    slack_links: url ? (url.match(SLACK_LINK_RE) || []) : [],
  };
}

// Evidence (which time entries/PRs/Slack messages mention each todo) is no longer computed
// here — it's a bounded, separately-triggered scan (see refresh-todo-evidence.mjs) written to
// dashboard/data/todo_evidence.json. Read that sidecar and merge it in by id; a todo with no
// entry there (not yet scanned, or done) just shows no evidence rather than blocking the render.
async function readEvidenceMap() {
  try { return JSON.parse(await read(join(DATA, 'todo_evidence.json')) || '{}'); }
  catch { return {}; }
}

async function renderTodos() {
  const raw = CONFIG.todos_file ? await read(CONFIG.todos_file) : null;
  if (!raw) return { generated_at: NOW, status: 'missing', data: { groups: [] } };
  const { todos: items } = parseTodosFile(raw);
  const evidenceMap = await readEvidenceMap();
  const groupsByName = new Map();
  const order = [];
  const getGroup = (name) => {
    let g = groupsByName.get(name);
    if (!g) { g = { name, items: [] }; groupsByName.set(name, g); order.push(name); }
    return g;
  };
  for (const item of items) {
    const done = item.state === 'done';
    const todo = todoFields(item);
    const notes = Array.isArray(item.notes) ? item.notes : [];
    const blocked = !done && isBlocked(item);
    const { evidence = [], suggest_done = false } = done ? {} : (evidenceMap[item.id] || {});
    const entry = { id: item.id, done, notes, blocked, ...todo, evidence, suggest_done };
    getGroup(item.group || item.project || 'Ungrouped').items.push(entry);
  }
  const groups = order.map((name) => groupsByName.get(name)).filter((g) => g.items.some((t) => !t.done));
  return { generated_at: NOW, status: 'ok', data: { groups } };
}

// ---- calendar / slack: raw/<source>/YYYY-MM-DD.md -------------------------
async function latestRawFile(source, preferToday) {
  const dir = join(DATA_HOME, 'raw', source);
  const files = await listMd(dir);
  if (!files.length) return { date: null, md: null };
  const today = new Date().toISOString().slice(0, 10);
  const pick = preferToday && files.includes(`${today}.md`) ? `${today}.md` : files[files.length - 1];
  return { date: pick.replace('.md', ''), md: await read(join(dir, pick)) };
}

async function renderCalendar() {
  const { date, md } = await latestRawFile('calendar', true);
  if (!md) return { generated_at: NOW, status: 'missing', data: { date, events: [] } };
  const events = [];
  const re = /^\*\*(.+?)\*\*\s*\|\s*(.+)$\n?((?:(?!^\*\*|^---)[^\n]*\n?)*)/gm;
  for (const [, time, title, rest] of md.matchAll(re)) {
    const lines = rest.split('\n').map((l) => l.trim()).filter(Boolean);
    const rsvp = (lines.find((l) => l.startsWith('RSVP:')) || '').replace('RSVP:', '').trim() || null;
    const desc = lines.filter((l) => !l.startsWith('RSVP:')).join(' ');
    events.push({ time, title: title.trim(), rsvp, description: desc || null, links: desc.match(URL_RE) || [] });
  }
  return { generated_at: NOW, status: 'ok', data: { date, events } };
}

function parseSlack(md) {
  const messages = [];
  const re = /^\*\*(.+?)\*\*\s*\|\s*(.+)$\n((?:(?!^\*\*|^---)[^\n]*\n?)*)/gm;
  for (const [, time, target, rest] of md.matchAll(re)) {
    const text = rest.trim();
    messages.push({
      time,
      target: target.trim(),
      is_dm: /^DM\b/.test(target),
      text,
      links: text.match(URL_RE) || [],
    });
  }
  return messages;
}

async function renderSlack() {
  const { date, md } = await latestRawFile('slack', true);
  if (!md) return { generated_at: NOW, status: 'missing', data: { date, messages: [] } };
  return { generated_at: NOW, status: 'ok', data: { date, messages: parseSlack(md) } };
}

// ---- summaries: summaries/YYYY-MM-DD_<slug>.md (written by /time-logger summary) ----
function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#.*$/, '').trim().replace(/^"(.*)"$/, '$1');
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
    meta[kv[1].toLowerCase()] = v;
  }
  return { meta, body: m[2].trim() };
}

async function renderSummaries() {
  const dir = join(DATA_HOME, 'summaries');
  const files = (await listMd(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}_.+\.md$/.test(f));
  if (!files.length) return { generated_at: NOW, status: 'missing', data: { summaries: [] } };
  const summaries = [];
  for (const f of files) {
    const md = await read(join(dir, f));
    if (!md) continue;
    const { meta, body } = parseFrontmatter(md);
    const [, date, slug] = f.match(/^(\d{4}-\d{2}-\d{2})_(.+)\.md$/);
    summaries.push({
      id: f.replace(/\.md$/, ''),
      date: meta.date || date,
      slug,
      title: meta.title || slug.replace(/-/g, ' '),
      focus: meta.focus || null,
      audience: meta.audience || null,
      format: meta.format || null,
      range: meta.range || null,
      sources: Array.isArray(meta.sources) ? meta.sources : meta.sources ? [meta.sources] : [],
      sent: meta.sent || null,
      updated_at: await stat(join(dir, f)).then((st) => st.mtime.toISOString()).catch(() => null),
      body,
    });
  }
  summaries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
  const newest = summaries.map((x) => x.updated_at).filter(Boolean).sort().pop() || NOW;
  return { generated_at: newest, status: 'ok', data: { summaries } };
}

// ---- meta.json ------------------------------------------------------------
async function readGeneratedAt(name) {
  try { return JSON.parse(await readFile(join(DATA, name), 'utf8')).generated_at || null; }
  catch { return null; }
}

async function main() {
  await mkdir(DATA, { recursive: true });
  CLIENT_MAP = parseClientMap(await read(join(DATA_HOME, 'user-preferences.md')));
  // Time entries have no section here — the dashboard reads them live via
  // dashboard/server.mjs's /api/entries/* routes (see entries-store.mjs). Todo evidence is
  // likewise not computed here; renderTodos() reads the sidecar refresh-todo-evidence.mjs
  // maintains.
  const sections = {
    todos: await renderTodos(),
    calendar: await renderCalendar(),
    slack: await renderSlack(),
    summaries: await renderSummaries(),
  };
  // The Overview digest is just the most recent daily-digest summary.
  const digest = (sections.summaries.data.summaries || []).find((x) => x.slug === 'daily-digest');
  sections.digest = digest
    ? { generated_at: digest.updated_at || NOW, status: 'ok', data: { as_of: digest.date, ...digest } }
    : { generated_at: NOW, status: 'missing', data: null };
  for (const [name, payload] of Object.entries(sections)) {
    await writeJson(join(DATA, `${name}.json`), payload);
  }
  // Client-specific UI values (ticket-link base, client name, feature flags) come from
  // capabilities.yml so the built app has nothing hardcoded.
  await writeJson(join(DATA, 'config.json'), { generated_at: NOW, status: 'ok', data: { ...CONFIG, ...CLIENT_MAP } });
  const meta = { rendered_at: NOW, sections: { config: NOW } };
  for (const [name, payload] of Object.entries(sections)) meta.sections[name] = payload.generated_at || NOW;
  for (const name of ['artifacts', 'slack_conversations', 'github_prs']) {
    meta.sections[name] = await readGeneratedAt(`${name}.json`);
  }
  await writeJson(join(DATA, 'meta.json'), meta);
  console.log('rendered:', Object.keys(meta.sections).join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
