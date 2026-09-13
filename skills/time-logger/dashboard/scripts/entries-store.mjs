// Single access layer for time_logs/time_entries_YYYYMMDD.md — the only module that should
// read or write these files. Every read re-parses straight off disk for exactly the file(s)
// asked for: there is no cache to invalidate, so a write made through setEntryField is visible
// to the very next read with nothing else to do. This replaces the old pattern where server.mjs
// hand-edited lines with its own regex and then shelled out to render.mjs to re-derive
// everything from scratch — parsing now lives in one place, and reads are scoped to what's
// actually being looked at instead of the whole year.
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_HOME } from './capabilities.mjs';

const TIME_LOGS = join(DATA_HOME, 'time_logs');
const FILE_RE = /^time_entries_(\d{4})(\d{2})(\d{2})\.md$/;

const dateToFile = (date) => join(TIME_LOGS, `time_entries_${date.replace(/-/g, '')}.md`);
const fileToDate = (f) => {
  const m = f.match(FILE_RE);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

// ---- client map: Orgs + Clients sections of user-preferences.md -----------
// Lines look like:  - **Name** — org: X — kind: client — matches: ...
// Everyone is a client under an org; the org named by capabilities client.org is the one
// this install logs time for. Read fresh every call — the file is tiny, so there's nothing
// worth caching (and caching it would reintroduce the invalidation problem this module exists
// to avoid).
function parseClientMap(md) {
  const clients = {};
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
  for (const r of rows(section('Clients'))) {
    clients[r.name] = { org: r.org || null, kind: (r.kind || 'client').toLowerCase() };
  }
  return clients;
}

async function clientMap() {
  const md = await readFile(join(DATA_HOME, 'user-preferences.md'), 'utf8').catch(() => null);
  return parseClientMap(md);
}

async function orgOf() {
  const { get } = await import('./capabilities.mjs');
  return get('client.org', '');
}

// ---- parsing: time_logs/time_entries_YYYYMMDD.md -------------------------
// "7:30 - 9:00 AM" / "10:00 AM - 12:00 PM" -> decimal-hour {start, end}; null if unparseable.
function parseRange(time) {
  if (!time) return null;
  const m = time.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*[–—-]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
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

function parseTimeEntries(md, date, clients, org) {
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
  // the header. Org/kind come from the Clients map; unknown clients fall into "untagged".
  const client_hours = {}, org_hours = {};
  const add = (o, k, h) => { o[k] = Math.round(((o[k] || 0) + (h || 0)) * 100) / 100; };
  for (const e of entries) {
    const k = e.client || 'untagged';
    const meta = clients[k];
    e.org = meta ? meta.org : null;
    e.kind = meta ? meta.kind : null;
    e.in_org = !!(meta && meta.org && org && meta.org === org);
    add(client_hours, k, e.hours);
    add(org_hours, meta && meta.org ? meta.org : 'unknown', e.hours);
  }
  return { date, ...header, client_hours, org_hours, entries };
}

async function readDayFile(date) {
  const file = dateToFile(date);
  const md = await readFile(file, 'utf8').catch(() => null);
  if (md == null) return null;
  const clients = await clientMap();
  const org = await orgOf();
  const day = parseTimeEntries(md, date, clients, org);
  day.updated_at = await stat(file).then((st) => st.mtime.toISOString()).catch(() => null);
  return day;
}

// ---- reads ------------------------------------------------------------

// One day, read fresh. Returns null if no file exists for that date.
export async function getDay(date) {
  return readDayFile(date);
}

// Every day in [fromDate, toDate] (inclusive) that has a file — never touches files outside
// that range. Most-recent-first, matching the old render.mjs shape.
export async function getRange(fromDate, toDate) {
  const files = (await readdir(TIME_LOGS).catch(() => []))
    .map((f) => ({ f, date: fileToDate(f) }))
    .filter(({ date }) => date && date >= fromDate && date <= toDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const clients = await clientMap();
  const org = await orgOf();
  const days = [];
  for (const { f, date } of files) {
    const md = await readFile(join(TIME_LOGS, f), 'utf8').catch(() => null);
    if (md == null) continue;
    const day = parseTimeEntries(md, date, clients, org);
    day.updated_at = await stat(join(TIME_LOGS, f)).then((st) => st.mtime.toISOString()).catch(() => null);
    days.push(day);
  }
  days.reverse(); // most recent first
  return days;
}

// Cheap bounds check: filenames only, no file content read at all. Used for week-nav
// boundaries and "most recent day with data" defaults without having to load a wide range
// just to find them.
export async function getBounds() {
  const dates = (await readdir(TIME_LOGS).catch(() => []))
    .map(fileToDate)
    .filter(Boolean)
    .sort();
  return { earliest: dates[0] || null, latest: dates[dates.length - 1] || null };
}

// ---- writes -------------------------------------------------------------
// A line's stable identity strips the toggleable [non-billable] suffix, since that suffix
// isn't part of what identifies the entry (comments/reviewed-state match on the stripped form).
const stableOf = (line) => line.replace(/\s*\[non-billable\]\s*$/i, '').trim();

// "9:00 AM – 9:45 AM" — always explicit AM/PM on both sides (simpler to generate than
// reproducing the omit-when-unambiguous style some entries have on disk; parseRange above
// accepts either form).
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

// Generic single-entry field patch: finds the `###` block whose stable heading matches, applies
// `patch`, rewrites just that line, writes the file back. Always touches exactly one file.
// Supported patches: { nonBillable: bool } or { startHour, endHour } (numbers, hours 0-24).
export async function setEntryField(date, heading, patch) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  if (!heading) throw new Error('heading required');
  const file = dateToFile(date);
  const md = await readFile(file, 'utf8');
  let found = false;
  const updated = md.split('\n').map((line) => {
    if (!line.startsWith('### ') || found) return line;
    const content = line.slice(4);
    if (stableOf(content) !== heading) return line;
    found = true;
    if ('nonBillable' in patch) {
      return '### ' + (patch.nonBillable ? `${stableOf(content)} [non-billable]` : stableOf(content));
    }
    if ('startHour' in patch && 'endHour' in patch) {
      const { startHour, endHour } = patch;
      if (typeof startHour !== 'number' || typeof endHour !== 'number' || !(startHour >= 0 && endHour <= 24 && startHour < endHour)) {
        throw new Error('startHour/endHour must be numbers with 0 <= startHour < endHour <= 24');
      }
      const m = content.match(/^(.+?)\s+—\s+(.*)$/);
      if (!m) throw new Error('entry line is not in "{time} — {rest}" form');
      const durationHours = Math.round((endHour - startHour) * 100) / 100;
      const newRest = m[2].replace(/(\d+(?:\.\d+)?)h/, `${durationHours}h`);
      return `### ${formatHourRange(startHour, endHour)} — ${newRest}`;
    }
    throw new Error(`unsupported patch: ${Object.keys(patch).join(',')}`);
  });
  if (!found) throw new Error('entry not found for that date/heading');
  await writeFile(file, updated.join('\n'));
}
