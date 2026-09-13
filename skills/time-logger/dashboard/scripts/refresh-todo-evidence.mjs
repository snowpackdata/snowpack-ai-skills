// Computes todo evidence — which time entries, PRs, and Slack messages mention each open
// todo — and writes it to dashboard/data/todo_evidence.json, keyed by todo id.
//
// This used to be computed live inside render.mjs on *every* render call, including ones
// triggered by an unrelated single-entry edit (e.g. toggling non-billable), which meant every
// such edit paid for a full rescan of every open todo against up to 365 days of entries plus
// PRs and Slack. Evidence only actually changes when todos.yaml changes or new entries/PRs/Slack
// activity land, so this now runs only on those triggers (call refreshTodoEvidence() after
// writing todos.yaml, or on the normal /time-logger refresh cadence) — never on a plain
// time-entry write. render.mjs's todos section reads this file instead of recomputing.
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_HOME, get, expandHome } from './capabilities.mjs';
import { parseTodosFile } from './todo-format.mjs';
import { getRange } from './entries-store.mjs';

const DATA = join(DATA_HOME, 'dashboard', 'data');
const EVIDENCE_FILE = join(DATA, 'todo_evidence.json');
const SLACK_LINK_RE = /https?:\/\/[a-z0-9-]+\.slack\.com\/archives\/[^\s)>\]]+/gi;
const PR_LINK_RE = /https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/gi;

// How far back to scan for evidence — bounded, unlike the old render.mjs pass which rescanned
// up to 365 days on every call. A todo still open after 90 days with nothing mentioning it in
// that window isn't going to get flagged "done" by evidence anyway.
const LOOKBACK_DAYS = 90;
const SLACK_LOOKBACK_DAYS = 5;

function todoFields(item) {
  const url = item.url || null;
  return {
    ticket: item.backend === 'jira' ? String(item.id).replace(/^jira:/, '') : null,
    links: url ? [url] : [],
    pr_keys: url ? [...url.matchAll(PR_LINK_RE)].map((m) => `${m[1]}#${m[2]}`) : [],
  };
}

function parseSlack(md) {
  const messages = [];
  const re = /^\*\*(.+?)\*\*\s*\|\s*(.+)$\n((?:(?!^\*\*|^---)[^\n]*\n?)*)/gm;
  for (const [, time, target, rest] of md.matchAll(re)) {
    messages.push({ time, target: target.trim(), text: rest.trim() });
  }
  return messages;
}

async function slackDays(n) {
  const dir = join(DATA_HOME, 'raw', 'slack');
  const files = (await readdir(dir).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-n);
  const out = [];
  for (const f of files) {
    const md = await readFile(join(dir, f), 'utf8').catch(() => null);
    if (md) out.push({ date: f.replace('.md', ''), messages: parseSlack(md) });
  }
  return out;
}

// Proof a todo was worked: time entries that cite its ticket or links, PRs that name the
// ticket or are linked from it, Slack messages that mention either. A hint for the user to
// comment "done — close it"; nothing is auto-closed.
function computeEvidence(todo, ctx) {
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

// Recomputes evidence for every open (non-done) todo and writes the sidecar. Returns the
// written map. Safe to call often — it only ever reads (never writes) todos.yaml, entries,
// PRs, and Slack.
export async function refreshTodoEvidence() {
  await mkdir(DATA, { recursive: true });
  const todosFile = expandHome(get('dashboard.todos_file', ''));
  const raw = todosFile ? await readFile(todosFile, 'utf8').catch(() => null) : null;
  if (!raw) {
    await writeFile(EVIDENCE_FILE, JSON.stringify({}, null, 2));
    return {};
  }
  const { todos: items } = parseTodosFile(raw);

  const today = new Date().toISOString().slice(0, 10);
  const from = new Date();
  from.setDate(from.getDate() - LOOKBACK_DAYS);
  const days = await getRange(from.toISOString().slice(0, 10), today);

  const prStore = JSON.parse(await readFile(join(DATA, 'github_prs.json'), 'utf8').catch(() => 'null'));
  const prs = prStore?.data ? [...(prStore.data.open || []), ...(prStore.data.recently_closed || [])] : [];

  const ctx = { days, prs, slackDays: await slackDays(SLACK_LOOKBACK_DAYS) };
  const out = {};
  for (const item of items) {
    if (item.state === 'done') continue;
    const { evidence, suggest_done } = computeEvidence(todoFields(item), ctx);
    out[item.id] = { evidence, suggest_done, computed_at: new Date().toISOString() };
  }
  await writeFile(EVIDENCE_FILE, JSON.stringify(out, null, 2));
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  refreshTodoEvidence()
    .then((out) => console.log(`todo evidence: ${Object.keys(out).length} open todo(s)`))
    .catch((e) => { console.error(e); process.exit(1); });
}
