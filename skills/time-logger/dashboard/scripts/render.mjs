// Renders the JSON data store from the markdown sources of truth.
// Deterministic sections: time_entries, todos, calendar, slack.
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

// ---- time entries: time_logs/time_entries_YYYYMMDD.md -------------------
// "7:30 - 9:00 AM" / "10:00 AM - 12:00 PM" -> decimal-hour {start, end}; null if unparseable.
function parseRange(time) {
  if (!time) return null;
  const m = time.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*[\u2013\u2014-]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!m) return null;
  const toDec = (h, min, ap) => {
    let hh = Number(h) % 12;
    if ((ap || '').toUpperCase() === 'PM') hh += 12;
    return hh + Number(min || 0) / 60;
  };
  const end = toDec(m[4], m[5], m[6]);
  let start = toDec(m[1], m[2], m[3] || m[6]);
  if (start >= end) start -= 12; // "11:30 - 12:30 PM" style: start was morning
  return start < 0 ? null : { start, end };
}

// Client tag: `[client: Name]` anywhere in the heading. Legacy `[non-Snowpack]` maps to
// "Other" so older files still separate cleanly. No tag → null (shown as untagged).
function parseClient(heading) {
  const m = heading.match(/\[client:\s*([^\]]+)\]/i);
  if (m) return m[1].trim();
  if (/\[non-snowpack\]/i.test(heading)) return 'Other';
  return null;
}

function parseTimeEntries(md, date) {
  const header = {};
  for (const [, key, val] of md.matchAll(/^\*\*(Hours|Span|Clients|Tickets|Repos|PRs)\*\*:\s*(.+)$/gm)) {
    header[key.toLowerCase()] = val.trim();
  }
  const entries = [];
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const blockRe = /^### (.+?)\n([\s\S]*?)(?=\n---|\n### |$)/gm;
  for (const [, rawHeading, body] of md.matchAll(blockRe)) {
    const client = parseClient(rawHeading);
    const non_billable = /\[non-billable\]\s*$/i.test(rawHeading);
    // Strip client tags before parsing so "(Xh)" is found whether the tag precedes or follows it.
    // Also strip [non-billable] here — it's a toggleable UI flag, not part of the entry's
    // identity, so it must never appear in `heading` (the stable key comments/reviewed-state
    // match on) or it would change every time the flag is flipped.
    const heading = rawHeading.replace(/\s*\[client:[^\]]*\]/gi, '').replace(/\s*\[non-snowpack\]/gi, '').replace(/\s*\[non-billable\]\s*$/i, '').trim();
    const m = heading.match(/^(.+?)\s+—\s+(.+?)(?:\s+\(([\d.]+)h\))?$/);
    const time = m ? m[1].trim() : null;
    entries.push({
      letter: LETTERS[entries.length % 26].repeat(Math.floor(entries.length / 26) + 1),
      range: parseRange(time),
      heading: rawHeading.replace(/\s*\[non-billable\]\s*$/i, '').trim(),
      time,
      title: m ? m[2].trim() : heading,
      hours: m && m[3] ? Number(m[3]) : null,
      is_meeting: /\[meeting\]/i.test(heading),
      client,
      non_billable,
      body: body.trim(),
      tickets: [...new Set(body.match(/[A-Z]{2,}-\d+/g) || [])],
    });
  }
  // Per-client and per-org hour totals, computed from the entries so they never drift from
  // the header. Org/kind come from the Clients map; unknown clients fall into "unknown".
  const client_hours = {}, org_hours = {};
  const add = (o, k, h) => { o[k] = Math.round(((o[k] || 0) + (h || 0)) * 100) / 100; };
  for (const e of entries) {
    const k = e.client || 'untagged';
    const meta = CLIENT_MAP.clients[k];
    e.org = meta ? meta.org : null;
    e.kind = meta ? meta.kind : null;
    // in_org: belongs to the org this install logs time for (capabilities client.org)
    e.in_org = !!(meta && meta.org && CONFIG.org && meta.org === CONFIG.org);
    add(client_hours, k, e.hours);
    add(org_hours, meta && meta.org ? meta.org : 'unknown', e.hours);
  }
  return { date, ...header, client_hours, org_hours, entries };
}

async function renderTimeEntries() {
  const dir = join(DATA_HOME, 'time_logs');
  // Capped at a year, not the ~5 days this used to be — the dashboard's week-strip nav pages
  // backward through real weeks, so it needs more than a handful of recent days available.
  const files = (await listMd(dir)).filter((f) => /^time_entries_\d{8}\.md$/.test(f)).slice(-365);
  const days = [];
  for (const f of files) {
    const md = await read(join(dir, f));
    if (!md) continue;
    const d = f.match(/(\d{4})(\d{2})(\d{2})/);
    const day = parseTimeEntries(md, `${d[1]}-${d[2]}-${d[3]}`);
    // When the draft itself was last written — the intraday refresh regenerates today's file,
    // so this is the honest "how fresh is this" signal, not the render time.
    day.updated_at = await stat(join(dir, f)).then((st) => st.mtime.toISOString()).catch(() => null);
    days.push(day);
  }
  days.reverse(); // most recent first
  const newest = days.map((x) => x.updated_at).filter(Boolean).sort().pop() || NOW;
  return { generated_at: newest, status: 'ok', data: { days } };
}

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

// Proof a todo was worked: time entries that cite its ticket or links, PRs that name the
// ticket or are linked from it, Slack messages that mention either. Deterministic, refreshed
// on every render. A hint for the user to comment "done — close it"; nothing is auto-closed.
function todoEvidence(todo, ctx) {
  const ev = [];
  const needles = [todo.ticket, ...todo.links].filter(Boolean);
  const mentions = (str) => !!str && needles.some((n) => str.includes(n));
  for (const day of ctx.days) {
    for (const e of day.entries) {
      const hit = (todo.ticket && e.tickets.includes(todo.ticket)) || mentions(e.body) || mentions(e.heading);
      if (hit) ev.push({ type: 'time_entry', date: day.date, heading: e.heading, title: e.title, hours: e.hours, client: e.client });
    }
  }
  const todoPrs = new Set(todo.pr_keys);
  for (const p of ctx.prs) {
    const key = `${p.repo}#${p.number}`;
    const hit = todoPrs.has(key) || (todo.ticket && (p.title || '').includes(todo.ticket));
    if (hit) {
      const state = p.merged ? 'merged' : p.closed_at && !/^0001/.test(p.closed_at) ? 'closed' : p.is_draft ? 'draft' : 'open';
      ev.push({ type: 'pr', key, url: p.url, title: p.title, state, closed_at: state === 'open' || state === 'draft' ? null : p.closed_at });
    }
  }
  for (const sd of ctx.slackDays) {
    for (const m of sd.messages) {
      if (mentions(m.text)) ev.push({ type: 'slack', date: sd.date, time: m.time, target: m.target, snippet: m.text.slice(0, 120), url: (m.text.match(SLACK_LINK_RE) || [])[0] || null });
    }
  }
  const suggest_done = ev.some((x) => x.type === 'pr' && x.state === 'merged') || ev.some((x) => x.type === 'time_entry');
  return { evidence: ev, suggest_done };
}

async function renderTodos(ctx) {
  const raw = CONFIG.todos_file ? await read(CONFIG.todos_file) : null;
  if (!raw) return { generated_at: NOW, status: 'missing', data: { groups: [] } };
  const { todos: items } = parseTodosFile(raw);
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
    const entry = { id: item.id, done, notes, blocked, ...todo, ...(done ? { evidence: [], suggest_done: false } : todoEvidence(todo, ctx)) };
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

// Last N days of Slack, for todo evidence.
async function slackDays(n) {
  const dir = join(DATA_HOME, 'raw', 'slack');
  const files = (await listMd(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).slice(-n);
  const out = [];
  for (const f of files) {
    const md = await read(join(dir, f));
    if (md) out.push({ date: f.replace('.md', ''), messages: parseSlack(md) });
  }
  return out;
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
  const time_entries = await renderTimeEntries();
  // Evidence for todos comes from the rendered days, the PR store (written by
  // fetch-github-prs.mjs before render), and the last few days of Slack.
  const prStore = JSON.parse(await read(join(DATA, 'github_prs.json')) || 'null');
  const prs = prStore?.data ? [...(prStore.data.open || []), ...(prStore.data.recently_closed || [])] : [];
  const sections = {
    time_entries,
    todos: await renderTodos({ days: time_entries.data.days, prs, slackDays: await slackDays(5) }),
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
