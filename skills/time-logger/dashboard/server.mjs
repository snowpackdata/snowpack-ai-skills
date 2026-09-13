// Local store server: serves the built app, the JSON data store, and accepts
// feedback annotations from the UI. No external network access.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_HOME, get, expandHome } from './scripts/capabilities.mjs';
import { parseTodosFile, stringifyTodosFile } from './scripts/todo-format.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(ROOT, 'dist');
// Dynamic state lives in the data home; this folder holds only code.
const DATA = join(DATA_HOME, 'dashboard', 'data');
const FEEDBACK = join(DATA_HOME, 'dashboard', 'feedback');
const PENDING = join(FEEDBACK, 'pending.json');
const REVIEWED_ENTRIES = join(FEEDBACK, 'reviewed_entries.json');
const TIME_LOGS = join(DATA_HOME, 'time_logs');
const PORT = process.env.PORT || get('dashboard.port', 4680);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function readPending() {
  try { return JSON.parse(await readFile(PENDING, 'utf8')); }
  catch { return []; }
}

async function readReviewedEntries() {
  try { return JSON.parse(await readFile(REVIEWED_ENTRIES, 'utf8')); }
  catch { return []; }
}

// Manual triggers for the same shell scripts the launchd crons run.
const JOBS = {
  refresh: join(ROOT, 'scripts', 'scheduled-refresh.sh'),
  morning: join(ROOT, 'scripts', 'morning-run.sh'),
  feedback: join(ROOT, 'scripts', 'feedback-run.sh'),
};
const jobRuns = {}; // name -> { running, started_at, exit_code, finished_at }
const LOGS_DIR = join(DATA_HOME, 'dashboard', 'logs'); // one <name>.log per job, same key as JOBS

// Shared by the non-billable and time-range handlers below: both match an entry by its
// heading with the toggleable [non-billable] suffix stripped, since that suffix isn't part
// of the entry's stable identity.
const stableOf = (line) => line.replace(/\s*\[non-billable\]\s*$/i, '').trim();

// "9:00 AM – 9:45 AM" — always explicit AM/PM on both sides (simpler to generate than
// reproducing the omit-when-unambiguous style some entries have on disk; render.mjs's
// parseRange accepts either form).
function formatHourRange(startHour, endHour) {
  const fmt = (hour) => {
    const totalMinutes = Math.round(hour * 60);
    let h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
  };
  return `${fmt(startHour)} – ${fmt(endHour)}`;
}

async function serveFile(res, path) {
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = normalize(url.pathname);
  if (path.includes('..')) { res.writeHead(400); return res.end(); }

  // Data store (read-only from the UI's perspective)
  if (path.startsWith('/data/')) return serveFile(res, join(DATA, path.slice(6)));

  // Feedback: UI appends annotations; the review-feedback skill drains them.
  if (path === '/api/feedback' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(await readPending()));
  }
  if (path === '/api/feedback' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const item = JSON.parse(body);
      item.submitted_at = new Date().toISOString();
      item.id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const pending = await readPending();
      pending.push(item);
      await mkdir(FEEDBACK, { recursive: true });
      await writeFile(PENDING, JSON.stringify(pending, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id: item.id, pending: pending.length }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // Job triggers: POST /api/run/<name> spawns the cron script with --force; GET polls status.
  if (path === '/api/run' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(jobRuns));
  }
  if (path.startsWith('/api/run/') && req.method === 'POST') {
    const name = path.slice('/api/run/'.length);
    if (!JOBS[name]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: `unknown job: ${name}` }));
    }
    if (jobRuns[name]?.running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'already running' }));
    }
    jobRuns[name] = { running: true, started_at: new Date().toISOString() };
    const child = spawn('/bin/zsh', [JOBS[name], '--force'], { stdio: 'ignore' });
    child.on('exit', (code) => {
      jobRuns[name] = { ...jobRuns[name], running: false, exit_code: code, finished_at: new Date().toISOString() };
    });
    child.on('error', () => {
      jobRuns[name] = { ...jobRuns[name], running: false, exit_code: -1, finished_at: new Date().toISOString() };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, job: name }));
  }

  // Log snapshot for a job: GET /api/logs/<name>?lines=N — a manual, on-demand tail, not a
  // live stream. Same job names as JOBS/jobRuns, so the UI can pair a "view logs" button with
  // whichever run status it's already showing.
  if (path.startsWith('/api/logs/') && req.method === 'GET') {
    const name = path.slice('/api/logs/'.length);
    if (!JOBS[name]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: `unknown job: ${name}` }));
    }
    const n = Math.min(Math.max(Number(url.searchParams.get('lines')) || 200, 1), 1000);
    let text = '';
    try { text = await readFile(join(LOGS_DIR, `${name}.log`), 'utf8'); }
    catch { /* no log written yet */ }
    const tail = text.split('\n').slice(-n).join('\n');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ name, text: tail, running: !!jobRuns[name]?.running, fetched_at: new Date().toISOString() }));
  }

  // Reviewed entries: individual time entries the user has signed off on (by date + heading).
  // (A day itself has no separate reviewed flag — the dashboard derives "day reviewed" from
  // every one of its entries being reviewed, so there's nothing day-level to persist here.)
  if (path === '/api/reviewed-entries' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(await readReviewedEntries()));
  }
  if (path === '/api/reviewed-entries' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { date, heading, reviewed } = JSON.parse(body);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
      if (!heading) throw new Error('heading required');
      const key = (e) => `${e.date}|${e.heading}`;
      const map = new Map((await readReviewedEntries()).map((e) => [key(e), e]));
      if (reviewed) map.set(key({ date, heading }), { date, heading });
      else map.delete(key({ date, heading }));
      const list = [...map.values()];
      await mkdir(FEEDBACK, { recursive: true });
      await writeFile(REVIEWED_ENTRIES, JSON.stringify(list, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, reviewed: list }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // Non-billable: unlike "reviewed", this changes what the entry actually means, so it's
  // written into the entry's own heading line in the real time-entries file (not a JSON
  // sidecar) — that way it survives everywhere the entry goes (Notes API uploads, my_time's
  // parser), not just this dashboard.
  if (path === '/api/entries/non-billable' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { date, heading, nonBillable } = JSON.parse(body);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
      if (!heading) throw new Error('heading required');
      const file = join(TIME_LOGS, `time_entries_${date.replace(/-/g, '')}.md`);
      const md = await readFile(file, 'utf8');
      let found = false;
      const updated = md.split('\n').map((line) => {
        if (!line.startsWith('### ') || found) return line;
        const content = line.slice(4);
        if (stableOf(content) !== heading) return line;
        found = true;
        return '### ' + (nonBillable ? `${stableOf(content)} [non-billable]` : stableOf(content));
      });
      if (!found) throw new Error('entry not found for that date/heading');
      await writeFile(file, updated.join('\n'));
      // Re-render synchronously so the change is visible on the client's next poll, not just
      // after the next /time-logger refresh.
      execFileSync('node', ['scripts/render.mjs'], { cwd: ROOT });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // Day-view drag/resize: rewrites an entry's time range (and, if present, its "(Xh)"
  // duration) in place. Same direct-write-then-rerender pattern as non-billable above; only
  // the time prefix and hours number change, title/client/tags are left untouched.
  if (path === '/api/entries/time-range' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { date, heading, startHour, endHour } = JSON.parse(body);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
      if (!heading) throw new Error('heading required');
      if (typeof startHour !== 'number' || typeof endHour !== 'number' || !(startHour >= 0 && endHour <= 24 && startHour < endHour)) {
        throw new Error('startHour/endHour must be numbers with 0 <= startHour < endHour <= 24');
      }
      const file = join(TIME_LOGS, `time_entries_${date.replace(/-/g, '')}.md`);
      const md = await readFile(file, 'utf8');
      let found = false;
      const updated = md.split('\n').map((line) => {
        if (!line.startsWith('### ') || found) return line;
        const content = line.slice(4);
        if (stableOf(content) !== heading) return line;
        const m = content.match(/^(.+?)\s+—\s+(.*)$/);
        if (!m) throw new Error('entry line is not in "{time} — {rest}" form');
        found = true;
        const durationHours = Math.round((endHour - startHour) * 100) / 100;
        const newRest = m[2].replace(/(\d+(?:\.\d+)?)h/, `${durationHours}h`);
        return `### ${formatHourRange(startHour, endHour)} — ${newRest}`;
      });
      if (!found) throw new Error('entry not found for that date/heading');
      await writeFile(file, updated.join('\n'));
      execFileSync('node', ['scripts/render.mjs'], { cwd: ROOT });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // Todos: direct structured edits to dashboard.todos_file (schema v2 — see
  // ../todo/CHANGELOG.md). Same pattern as non-billable above: write the source file
  // directly, then re-render synchronously so the change is visible on the next poll.
  if (path === '/api/todos/update' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { id, state } = JSON.parse(body);
      if (!id) throw new Error('id required');
      if (!['pending', 'in_progress', 'done'].includes(state)) throw new Error('state must be pending, in_progress, or done');
      const file = expandHome(get('dashboard.todos_file', ''));
      if (!file) throw new Error('dashboard.todos_file not configured');
      const data = parseTodosFile(await readFile(file, 'utf8'));
      const item = data.todos.find((t) => t.id === id);
      if (!item) throw new Error(`no todo with id ${id}`);
      item.state = state;
      item.done = state === 'done' ? (item.done || new Date().toISOString().slice(0, 10)) : null;
      await writeFile(file, stringifyTodosFile(data));
      execFileSync('node', ['scripts/render.mjs'], { cwd: ROOT });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // Todos: quick local add from the dashboard (no backend routing — that needs an agent to
  // follow the project's backend instructions; this always writes backend: local).
  if (path === '/api/todos/add' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { text, project } = JSON.parse(body);
      if (!text || !text.trim()) throw new Error('text required');
      const file = expandHome(get('dashboard.todos_file', ''));
      if (!file) throw new Error('dashboard.todos_file not configured');
      const data = parseTodosFile(await readFile(file, 'utf8').catch(() => ''));
      const nextN = data.todos
        .map((t) => (String(t.id).match(/^t(\d+)$/) || [])[1])
        .filter(Boolean)
        .reduce((max, n) => Math.max(max, Number(n)), 0) + 1;
      data.todos.push({
        id: `t${String(nextN).padStart(3, '0')}`,
        project: (project || 'unfiled').trim() || 'unfiled',
        text: text.trim(),
        state: 'pending',
        backend: 'local',
        url: null,
        group: null,
        priority: null,
        created: new Date().toISOString().slice(0, 10),
        done: null,
        notes: [],
      });
      await writeFile(file, stringifyTodosFile(data));
      execFileSync('node', ['scripts/render.mjs'], { cwd: ROOT });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  if (path.startsWith('/api/feedback/') && req.method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/feedback/'.length));
    const pending = await readPending();
    const rest = pending.filter((p) => p.id !== id);
    if (rest.length === pending.length) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'id not found' }));
    }
    await writeFile(PENDING, JSON.stringify(rest, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, pending: rest.length }));
  }

  // Static app
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<h1>Dashboard not built yet</h1><p>Run <code>/time-logger dashboard build</code> in Claude Code.</p>');
  }
  if (path === '/' || !extname(path)) return serveFile(res, join(DIST, 'index.html'));
  return serveFile(res, join(DIST, path));
});

// Loopback only: the store holds Slack/calendar/time-entry content and /api/run spawns
// local scripts, so this must never be reachable from the network.
// Bind to the literal loopback address (deterministic, not resolver-dependent), but always
// show users the localhost URL — that's what every doc, `open`, and health check uses.
const HOST = process.env.HOST || '127.0.0.1';
const SHOWN_HOST = HOST === '127.0.0.1' || HOST === '::1' ? 'localhost' : HOST;
server.listen(PORT, HOST, () => console.log(`time-logger dashboard → http://${SHOWN_HOST}:${PORT}  (data: ${DATA_HOME})`));
