// Local store server: serves the built app, the JSON data store, and accepts
// feedback annotations from the UI. No external network access.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_HOME, get } from './scripts/capabilities.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(ROOT, 'dist');
// Dynamic state lives in the data home; this folder holds only code.
const DATA = join(DATA_HOME, 'dashboard', 'data');
const FEEDBACK = join(DATA_HOME, 'dashboard', 'feedback');
const PENDING = join(FEEDBACK, 'pending.json');
const REVIEWED = join(FEEDBACK, 'reviewed.json');
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

async function readReviewed() {
  try { return JSON.parse(await readFile(REVIEWED, 'utf8')); }
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

  // Reviewed days: dates the user has signed off on in the UI.
  if (path === '/api/reviewed' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(await readReviewed()));
  }
  if (path === '/api/reviewed' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { date, reviewed } = JSON.parse(body);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
      const set = new Set(await readReviewed());
      if (reviewed) set.add(date); else set.delete(date);
      const list = [...set].sort();
      await mkdir(FEEDBACK, { recursive: true });
      await writeFile(REVIEWED, JSON.stringify(list, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, reviewed: list }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // Reviewed entries: individual time entries the user has signed off on (by date + heading).
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
      const stableOf = (line) => line.replace(/\s*\[non-billable\]\s*$/i, '').trim();
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
