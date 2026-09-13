import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SECTIONS = ['config', 'digest', 'time_entries', 'todos', 'calendar', 'slack', 'slack_conversations', 'artifacts', 'github_prs', 'summaries'];
// Client-specific values come from data/config.json (rendered from capabilities.yml by
// render.mjs) — nothing is hardcoded in the built app. Updated in useStore when it loads.
let CONFIG = { jira_browse_url: '', client_name: '', org: '', orgs: {}, clients: {} };

// Client tags: everyone is a client under an org (Orgs/Clients sections of
// user-preferences.md, rendered into config.json). Clients under the configured org
// (config.org) render neutral; clients under any other org render amber; unknown/untagged
// render red.
function clientMeta(name) {
  if (!name || name === 'untagged' || /^unknown$/i.test(name)) return { org: null, kind: null };
  return CONFIG.clients?.[name] || { org: null, kind: null };
}
function orgClass(org) {
  if (!org || org === 'unknown') return 'client-unknown';
  return CONFIG.org && org === CONFIG.org ? 'client-primary' : 'client-other';
}
function clientClass(name) { return orgClass(clientMeta(name).org); }
function ClientChip({ client }) {
  const label = client || 'untagged';
  const m = clientMeta(client);
  const title = m.org ? `${m.org} › ${label} (${m.kind})` : 'Client tag from the time-entry heading';
  return (
    <span className={`chip ${clientClass(client)}`} title={title}>
      {m.org && m.org !== label && <span className="chip-org">{m.org} › </span>}{label}
    </span>
  );
}
// "Snowpack 6.5h (Snowpack 4h · Grindr 2.5h) · Jonathan 3h (Hotlap 3h)"
function OrgTotals({ day }) {
  const byOrg = {};
  for (const [c, h] of Object.entries(day.client_hours || {})) {
    const org = clientMeta(c).org || 'unknown';
    (byOrg[org] ||= []).push([c, h]);
  }
  return Object.entries(byOrg).map(([org, cs]) => {
    const total = Math.round(cs.reduce((n, [, h]) => n + h, 0) * 100) / 100;
    return (
      <span key={org} className={`chip ${orgClass(org)}`}>
        <b>{org}</b> {total}h
        {cs.length > 1 || cs[0][0] !== org ? <span className="chip-org"> ({cs.map(([c, h]) => `${c} ${h}h`).join(' · ')})</span> : null}
      </span>
    );
  });
}

// Primary-org hours vs everything else (other orgs, personal, unknown) for a day, so the
// day list can show "10/6h" instead of one combined total that hides how much was billable.
function orgSplit(day) {
  let primary = 0, other = 0;
  for (const [c, h] of Object.entries(day.client_hours || {})) {
    if (CONFIG.org && clientMeta(c).org === CONFIG.org) primary += h; else other += h;
  }
  const round = (n) => Math.round(n * 100) / 100;
  return { primary: round(primary), other: round(other) };
}
function DayHours({ day }) {
  const { primary, other } = orgSplit(day);
  if (!other) return <span className="muted num">{day.hours}</span>;
  return (
    <span className="muted num">
      {primary}<span className="other-hours" title="Non-client hours (other orgs, personal)">/{other}</span>h
    </span>
  );
}

function TicketLink({ id, className = 'ticket' }) {
  if (!CONFIG.jira_browse_url) return <span className={className}>{id}</span>;
  return <a className={className} href={CONFIG.jira_browse_url + id} target="_blank" rel="noreferrer">{id}</a>;
}
const STALE_HOURS = 14;
// Sidebar navigation, grouped. Groups are headers only; the list can grow without wrapping.
const NAV = [
  { label: 'Today', items: [
    { id: 'overview', label: 'Overview', icon: 'sun' },
    { id: 'time', label: 'Time entries', icon: 'clock' },
    { id: 'todos', label: 'Todos', icon: 'list' },
  ] },
  { label: 'Sources', items: [
    { id: 'prs', label: 'GitHub PRs', icon: 'git' },
    { id: 'slack', label: 'Slack', icon: 'chat' },
  ] },
  { label: 'Writing', items: [
    { id: 'summaries', label: 'Summaries', icon: 'doc' },
    { id: 'artifacts', label: 'Artifacts', icon: 'box' },
  ] },
];
const TABS = NAV.flatMap((g) => g.items);

// Inline SVG icons (stroke, currentColor) — no emoji, so they render the same everywhere.
const ICON_PATHS = {
  sun: 'M12 4V2M12 22v-2M4.9 4.9 3.5 3.5M20.5 20.5l-1.4-1.4M4 12H2M22 12h-2M4.9 19.1l-1.4 1.4M20.5 3.5l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  git: 'M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  chat: 'M21 12a8 8 0 0 1-11.6 7.2L4 21l1.8-5.4A8 8 0 1 1 21 12z',
  doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  check: 'M5 12.5 9.5 17 19 7',
  alert: 'M12 3 2 21h20zM12 9v5M12 18h.01',
  x: 'M6 6l12 12M18 6 6 18',
  comment: 'M21 12a8 8 0 0 1-11.6 7.2L4 21l1.8-5.4A8 8 0 1 1 21 12z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  external: 'M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5',
  send: 'M22 2 11 13M22 2 15 22l-4-9-9-4z',
  merge: 'M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9c0 4-3 6-6 6H9',
  timer: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2 2M9 2h6',
  reply: 'M9 17 4 12l5-5M4 12h11a5 5 0 0 1 0 10h-1',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  plus: 'M12 5v14M5 12h14',
};
function Icon({ name, className = 'ico' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name] || ''} />
    </svg>
  );
}

// ---------- data hooks ----------
function useStore() {
  const [store, setStore] = useState({});
  const failed = useRef(new Set());

  const fetchSection = useCallback(async (name) => {
    try {
      const r = await fetch(`/data/${name}.json`);
      if (!r.ok) throw new Error(r.status);
      const json = await r.json();
      failed.current.delete(name);
      if (name === 'config' && json?.data) CONFIG = { ...CONFIG, ...json.data };
      setStore((s) => ({ ...s, [name]: json }));
    } catch {
      // Transient failures (mid-write file, server restart) retry on the next poll tick.
      failed.current.add(name);
      setStore((s) => ({ ...s, [name]: { status: 'missing', generated_at: null, data: null } }));
    }
  }, []);

  useEffect(() => {
    SECTIONS.forEach(fetchSection);
  }, [fetchSection]);

  // Poll meta.json; refetch sections whose timestamp changed.
  useEffect(() => {
    let prev = {};
    const tick = async () => {
      try {
        const r = await fetch('/data/meta.json');
        if (!r.ok) return;
        const m = await r.json();
        for (const [name, ts] of Object.entries(m.sections || {})) {
          if (prev[name] && prev[name] !== ts) fetchSection(name);
        }
        prev = m.sections || {};
        for (const name of [...failed.current]) fetchSection(name);
      } catch { /* server not up yet */ }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [fetchSection]);

  return { store };
}

function usePendingFeedback() {
  const [pending, setPending] = useState([]);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/feedback');
      if (r.ok) setPending(await r.json());
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const submit = useCallback(async (item) => {
    const r = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
    if (!r.ok) throw new Error('feedback save failed');
    await refresh();
  }, [refresh]);
  const remove = useCallback(async (id) => {
    const r = await fetch(`/api/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error('feedback delete failed');
    await refresh();
  }, [refresh]);
  return { pending, submit, remove };
}

function useReviewedEntries() {
  const [reviewedEntries, setReviewedEntries] = useState([]);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/reviewed-entries');
      if (r.ok) setReviewedEntries(await r.json());
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const toggle = useCallback(async (date, heading, val) => {
    const r = await fetch('/api/reviewed-entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, heading, reviewed: val }),
    });
    if (!r.ok) throw new Error('reviewed-entry toggle failed');
    await refresh();
  }, [refresh]);
  return { reviewedEntries, toggle };
}

function useJobs() {
  const [jobs, setJobs] = useState({});
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/run');
      if (r.ok) setJobs(await r.json());
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  // Poll while anything is running so buttons re-enable when the script exits.
  useEffect(() => {
    if (!Object.values(jobs).some((j) => j?.running)) return;
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [jobs, refresh]);
  const trigger = useCallback(async (name) => {
    await fetch(`/api/run/${name}`, { method: 'POST' });
    await refresh();
  }, [refresh]);
  return { jobs, trigger };
}

// A manual snapshot of a job's log, not a live stream — open it, optionally hit Refresh to
// pull the latest tail while the job is still running, close it, done.
function LogModal({ name, onClose }) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/logs/${name}?lines=300`);
      const json = await r.json();
      setText(json.text || '(no log written yet)');
      setFetchedAt(json.fetched_at);
    } catch {
      setText('Could not load the log.');
    } finally {
      setLoading(false);
    }
  }, [name]);
  useEffect(() => { load(); }, [load]);
  const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
  return (
    <div className="modal-backdrop" onClick={onClose} onKeyDown={onKeyDown} tabIndex={-1} ref={(el) => el?.focus()}>
      <div className="modal log-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{name} log</h2>
          <span className="spacer" />
          <button className="btn ghost" onClick={load} disabled={loading}><Icon name="refresh" />Refresh</button>
          <button className="icon-btn" onClick={onClose} title="Close"><Icon name="x" /></button>
        </div>
        <pre className="log-view">{text}</pre>
        {fetchedAt && <p className="small dim">Last fetched {ageLabel(fetchedAt)}{loading ? ' — loading…' : ''}</p>}
      </div>
    </div>
  );
}

function useHashTab() {
  const get = () => {
    const t = window.location.hash.replace(/^#\/?/, '');
    return TABS.some((x) => x.id === t) ? t : 'overview';
  };
  const [tab, setTabState] = useState(get);
  useEffect(() => {
    const on = () => setTabState(get());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const setTab = (t) => { window.location.hash = `#/${t}`; };
  return [tab, setTab];
}

// ---------- helpers ----------
function ageLabel(iso) {
  if (!iso) return null;
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function Badge({ section, dataDate }) {
  if (!section || section.status === 'missing' || !section.generated_at) {
    return <span className="badge missing"><Icon name="x" />no data</span>;
  }
  // Date-scoped panels: freshness means "showing today", not "recently rendered".
  if (dataDate !== undefined) {
    const today = new Date().toISOString().slice(0, 10);
    if (!dataDate) return <span className="badge missing"><Icon name="x" />no data</span>;
    if (dataDate !== today) return <span className="badge stale"><Icon name="alert" />from {fmtDay(dataDate)}</span>;
    return <span className="badge fresh"><Icon name="check" />today · {ageLabel(section.generated_at)}</span>;
  }
  const hrs = (Date.now() - new Date(section.generated_at).getTime()) / 3600000;
  const fresh = hrs <= STALE_HOURS;
  return <span className={`badge ${fresh ? 'fresh' : 'stale'}`}><Icon name={fresh ? 'check' : 'alert'} />{ageLabel(section.generated_at)}</span>;
}

function Panel({ title, section, dataDate, extra, scroll, children }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {extra}
        <span className="spacer" />
        <Badge section={section} dataDate={dataDate} />
      </div>
      {scroll ? <div className="panel-scroll">{children}</div> : children}
    </section>
  );
}

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function Linkify({ text }) {
  const parts = String(text).split(/(https?:\/\/[^\s)>\]]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p)
      ? <a key={i} href={p} target="_blank" rel="noreferrer">{p.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}</a>
      : p
  );
}

function FbItem({ f, remove }) {
  const [busy, setBusy] = useState(false);
  const del = async () => {
    setBusy(true);
    try { await remove(f.id); } finally { setBusy(false); }
  };
  return (
    <div className="fb-item">
      <Icon name="comment" /><span>{f.comment} <span className="muted small">· queued {ageLabel(f.submitted_at)}</span></span>
      <button className="fb-del" onClick={del} disabled={busy} title="Delete comment"><Icon name="x" /></button>
    </div>
  );
}

// ---------- overview panels ----------
function Digest({ section }) {
  const d = section?.data;
  return (
    <Panel title="Daily digest" section={section} scroll
      extra={d ? <span className="small muted">{fmtDay(d.as_of)} · <a href="#/summaries">all summaries</a></span> : null}>
      {!d ? <p className="muted">No digest yet — run <code>/time-logger refresh digest</code> or <code>/time-logger morning</code>.</p>
          : <SummaryView summary={d} compact />}
    </Panel>
  );
}

function Calendar({ section }) {
  const d = section?.data;
  return (
    <Panel title="Meetings" section={section} dataDate={d?.date ?? null}>
      {!d?.events?.length ? <p className="muted">No calendar data. Run a prefetch for today.</p> :
        d.events.map((e, i) => (
          <div className="event" key={i}>
            <span className="time">{e.time}</span>
            <span>
              {e.title}
              {e.rsvp && <span className="rsvp muted"> · {e.rsvp}</span>}
              {e.links?.map((l, j) => <span key={j}> · <a href={l} target="_blank" rel="noreferrer">join</a></span>)}
            </span>
          </div>
        ))}
    </Panel>
  );
}

function EvidenceChip({ e }) {
  if (e.type === 'pr') {
    return <a className={`chip ev ev-pr ev-${e.state}`} href={e.url} target="_blank" rel="noreferrer" title={e.title}>PR #{e.key.split('#')[1]} · {e.state}</a>;
  }
  if (e.type === 'time_entry') {
    return <a className="chip ev ev-time" href="#/time" title={e.heading}><Icon name="timer" />{fmtDay(e.date)}{e.hours ? ` · ${e.hours}h` : ''}</a>;
  }
  if (e.type === 'slack') {
    const label = <><Icon name="chat" />{fmtDay(e.date)} {e.target}</>;
    return e.url
      ? <a className="chip ev ev-slack" href={e.url} target="_blank" rel="noreferrer" title={e.snippet}>{label}</a>
      : <span className="chip ev ev-slack" title={e.snippet}>{label}</span>;
  }
  return null;
}

// Long todo text (a multi-sentence status log) collapses to a short preview by default so
// the list stays scannable; "more" expands the full text in place.
const TODO_PREVIEW_LEN = 220;
function TodoText({ text }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > TODO_PREVIEW_LEN;
  const shown = long && !expanded ? text.slice(0, TODO_PREVIEW_LEN).replace(/\s+\S*$/, '') + '…' : text;
  return (
    <>
      {inlineMd(shown)}
      {long && (
        <button className="todo-more" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}>
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </>
  );
}

function TodoRow({ group, todo, pending, submit, remove, showTag = true, onToggleDone, busy }) {
  const [open, setOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const key = todo.id;
  const fb = pending.filter((f) => f.type === 'todo_comment' && f.todo_key === key && !f.resolved);
  const evidence = todo.evidence || [];
  const notes = todo.notes || [];
  return (
    <div className={`todo-block ${todo.suggest_done ? 'has-evidence' : ''}`}>
      <div className="todo">
        <button
          type="button" className={`box ${busy ? 'busy' : ''}`} disabled={busy}
          onClick={() => onToggleDone?.(todo)} title="Mark done" aria-label="Mark done" />
        <span>
          {todo.ticket && <><TicketLink id={todo.ticket} />{' '}</>}
          <TodoText text={todo.text} />
          {todo.priority && <span className={`chip prio-${todo.priority}`}>{todo.priority}</span>}
          {todo.blocked && <span className="chip blocked" title="Mentions being blocked or pending verification">blocked</span>}
          <span className={`chip kind kind-${todo.kind}`}>{todo.kind}</span>
          {showTag && (todo.tags || []).map((t) => <span key={t} className="chip tag">#{t}</span>)}
          {notes.length > 0 && (
            <button className="chip tag notes-toggle" onClick={() => setNotesOpen(!notesOpen)}>
              {notesOpen ? 'hide' : notes.length} {notes.length === 1 ? 'note' : 'notes'}
            </button>
          )}
          {' '}
          <button className="comment-btn" onClick={() => setOpen(!open)} title="Comment for the agent"><Icon name="comment" /></button>
        </span>
      </div>
      {notesOpen && notes.length > 0 && (
        <ul className="todo-notes small">
          {notes.map((n, i) => <li key={i}>{inlineMd(n)}</li>)}
        </ul>
      )}
      {evidence.length > 0 && (
        <div className="evidence small">
          {todo.suggest_done && <span className="chip ev ev-done" title="Time was logged or a PR merged against this — comment to close it"><Icon name="check" />evidence</span>}
          {evidence.map((e, i) => <EvidenceChip key={i} e={e} />)}
        </div>
      )}
      {fb.map((f) => <FbItem key={f.id} f={f} remove={remove} />)}
      {open && (
        <CommentBox
          context={{ type: 'todo_comment', todo_key: key, group: group.name, ticket: todo.ticket, text: todo.text, evidence }}
          submit={submit} onDone={() => setOpen(false)}
          placeholder={todo.suggest_done
            ? "Note for the agent — e.g. 'done — close it', 'not done yet, PR still needs QA', or 'reword: ...'"
            : "Note for the agent — e.g. 'mark done', 'bump to HIGH', 'move to next week', or 'reword: ...'"} />
      )}
    </div>
  );
}

// Quick add: always writes backend: local (routing to a real backend needs an agent to
// follow that project's instructions file — out of scope for a plain HTTP endpoint).
function AddTodoForm({ projects, defaultProject, onDone }) {
  const [text, setText] = useState('');
  const [project, setProject] = useState(defaultProject || '');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await fetch('/api/todos/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, project }),
      });
      setText('');
      onDone();
    } finally { setBusy(false); }
  };
  const onKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  return (
    <div className="comment-box">
      <input type="text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
        autoFocus placeholder="New local todo…" />
      <div className="row">
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">unfiled</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button className="btn" onClick={add} disabled={busy || !text.trim()}>Add</button>
        <button className="btn ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

// Todos page: a project sidebar (same layout as Time entries/Summaries) + that project's open
// items on the right, or every project's when "All" is selected. Completed items stay counted,
// never shown — this is a working list, not an archive.
function TodosPage({ section, pending, submit, remove }) {
  const groups = section?.data?.groups || [];
  const [sel, setSel] = useState('all');
  const [busyId, setBusyId] = useState(null);
  const [justDone, setJustDone] = useState(() => new Set());
  const [showAdd, setShowAdd] = useState(false);

  const toggleDone = async (todo) => {
    setBusyId(todo.id);
    try {
      await fetch('/api/todos/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: todo.id, state: 'done' }),
      });
      // Optimistic hide — the next 5s poll will confirm it via the re-rendered store.
      setJustDone((s) => new Set(s).add(todo.id));
    } finally { setBusyId(null); }
  };

  const projects = groups.map((g) => ({
    name: g.name,
    open: g.items.filter((t) => !t.done && !justDone.has(t.id)).length,
  }));
  const totalOpen = projects.reduce((n, p) => n + p.open, 0);
  const shownGroups = sel === 'all' ? groups : groups.filter((g) => g.name === sel);

  return (
    <div className="te-layout">
      <aside className="day-list">
        <div className="panel">
          <div className="panel-head"><h2>Projects</h2><span className="spacer" /><Badge section={section} /></div>
          <button className={`day-item ${sel === 'all' ? 'active' : ''}`} onClick={() => setSel('all')}>
            <span className="day-name">All</span>
            <span className="spacer" />
            <span className="small muted num">{totalOpen}</span>
          </button>
          {projects.map((p) => (
            <button key={p.name} className={`day-item ${sel === p.name ? 'active' : ''}`} onClick={() => setSel(p.name)}>
              <span className="day-name">{p.name}</span>
              <span className="spacer" />
              <span className="small muted num">{p.open}</span>
            </button>
          ))}
          <button className="comment-btn add-todo-btn" onClick={() => setShowAdd(!showAdd)}>
            <Icon name="plus" />{showAdd ? 'Cancel' : 'Add todo'}
          </button>
          {showAdd && (
            <AddTodoForm
              projects={projects.map((p) => p.name)}
              defaultProject={sel !== 'all' ? sel : ''}
              onDone={() => setShowAdd(false)} />
          )}
        </div>
      </aside>
      <div className="te-main">
        {!shownGroups.length ? <div className="panel"><p className="muted">No todos found.</p></div> :
          shownGroups.map((g) => {
            const openItems = g.items.filter((t) => !t.done && !justDone.has(t.id));
            const doneCount = g.items.filter((t) => t.done || justDone.has(t.id)).length;
            return (
              <div className="panel" key={g.name}>
                <div className="panel-head"><h2>{g.name}</h2><span className="spacer" /><span className="small muted">{openItems.length} open</span></div>
                {!openItems.length ? <p className="muted small">Nothing open here.</p> :
                  openItems.map((t) => (
                    <TodoRow key={t.id} group={g} todo={t} pending={pending} submit={submit} remove={remove}
                      showTag={sel === 'all'} onToggleDone={toggleDone} busy={busyId === t.id} />
                  ))}
                {doneCount > 0 && <div className="small muted" style={{ marginTop: 8 }}>{doneCount} completed hidden</div>}
              </div>
            );
          })}
      </div>
    </div>
  );
}

// Slack tab: agent-summarized conversations (data/slack_conversations.json, written by
// refresh) — follow-ups first — with the raw per-message list behind a toggle. Self-DMs are
// excluded from the summaries (they're drafts, not conversations).
function ConversationRow({ c }) {
  const link = c.url || null;
  return (
    <div className={`convo ${c.needs_followup ? 'follow' : ''}`}>
      <div className="convo-head">
        <span className="target">{c.target}</span>
        {c.kind && <span className="chip">{c.kind}</span>}
        {c.needs_followup && <span className="chip ev-done follow-chip"><Icon name="reply" />follow up</span>}
        <span className="spacer" />
        <span className="small muted num">{c.last_active}</span>
        {link && <a className="small" href={link} target="_blank" rel="noreferrer" title="Open in Slack"><Icon name="external" /></a>}
      </div>
      <div className="convo-body"><Markdown text={c.summary} inline /></div>
      {c.followup && <div className="convo-next small"><span className="muted">Next</span> <Markdown text={c.followup} inline /></div>}
    </div>
  );
}

function Slack({ section, conversations }) {
  const d = section?.data;
  const cv = conversations?.data;
  const list = cv?.conversations || [];
  const follow = list.filter((c) => c.needs_followup);
  const rest = list.filter((c) => !c.needs_followup);
  const [showRaw, setShowRaw] = useState(false);
  const raw = (d?.messages || []).filter((m) => !m.is_dm || !/self/i.test(m.target));
  return (
    <div className="col">
      <Panel title="Needs follow-up" section={conversations}
        extra={<span className="small muted">{follow.length} open</span>}>
        {!cv ? <p className="muted">No conversation summary yet — <code>/time-logger refresh slack</code> writes one.</p>
          : !follow.length ? <p className="muted">Nothing waiting on you.</p>
          : follow.map((c, i) => <ConversationRow key={i} c={c} />)}
      </Panel>
      {rest.length > 0 && (
        <Panel title="Recent conversations" section={conversations} extra={<span className="small muted">{cv?.range}</span>}>
          {rest.map((c, i) => <ConversationRow key={i} c={c} />)}
        </Panel>
      )}
      <Panel title="Raw messages" section={section} dataDate={d?.date ?? null}
        extra={<button className="comment-btn" style={{ opacity: 1, margin: 0 }} onClick={() => setShowRaw(!showRaw)}>{showRaw ? 'Hide' : `Show ${raw.length}`}</button>}>
        {showRaw && (!raw.length ? <p className="muted">No Slack data for this day.</p> :
          raw.map((m, i) => (
            <div className="msg" key={i}>
              <div className="head">
                <span className="muted">{m.time}</span>
                <span className="target">{m.target}</span>
              </div>
              <div className="text"><Linkify text={m.text} /></div>
            </div>
          )))}
      </Panel>
    </div>
  );
}

function PRRow({ pr, marker, pending, submit, remove }) {
  const [open, setOpen] = useState(false);
  const fb = pending.filter((f) => f.type === 'pr_comment' && f.pr === `${pr.repo}#${pr.number}` && !f.resolved);
  return (
    <div className="pr-block">
      <div className="pr">
        <span className={marker.cls}>{marker.text}</span>
        {marker.date && <span className="pr-date muted">{marker.date}</span>}
        <span className="pr-body">
          <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a>{' '}
          {pr.title}
          <span className="chip">{pr.repo.split('/')[1]}</span>
          {pr.is_draft && <span className="chip">draft</span>}
          {' '}
          <button className="comment-btn" onClick={() => setOpen(!open)} title="Comment for the agent"><Icon name="comment" /></button>
        </span>
      </div>
      {fb.map((f) => <FbItem key={f.id} f={f} remove={remove} />)}
      {open && (
        <CommentBox
          context={{ type: 'pr_comment', pr: `${pr.repo}#${pr.number}`, url: pr.url, title: pr.title }}
          submit={submit} onDone={() => setOpen(false)}
          placeholder="Note for the agent — e.g. 'close this, superseded' or 'rebase and un-draft' or 'add to my todos'" />
      )}
    </div>
  );
}

function GitHubPRs({ section, pending, submit, remove }) {
  const d = section?.data;
  const open = d?.open || [];
  const closed = d?.recently_closed || [];
  const staleCount = open.filter((p) => p.stale).length;
  return (
    <Panel title="GitHub PRs" section={section}
      extra={<span className="small muted">{open.length} open{staleCount ? ` · ${staleCount} stale` : ''}</span>}>
      {!d ? <p className="muted">No PR data yet — run <code>/time-logger refresh github</code>.</p> : (
        <>
          {open.map((p) => (
            <PRRow key={p.url} pr={p} pending={pending} submit={submit} remove={remove}
              marker={{ cls: `pr-idle ${p.stale ? 'stale-text' : 'muted'}`, text: `${p.idle_days}d idle` }} />
          ))}
          {closed.length > 0 && (
            <>
              <div className="sect" style={{ marginTop: 12 }}>Recently closed ({d.closed_window_days}d)</div>
              {closed.map((p) => (
                <PRRow key={p.url} pr={p} pending={pending} submit={submit} remove={remove}
                  marker={{
                    cls: `pr-idle ${p.merged ? 'merged-text' : 'muted'}`,
                    text: p.merged ? <><Icon name="merge" />merged</> : <><Icon name="x" />closed</>,
                    date: p.closed_at
                      ? new Date(p.closed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : null,
                  }} />
              ))}
            </>
          )}
        </>
      )}
    </Panel>
  );
}

function Artifacts({ section, expanded }) {
  const items = section?.data?.artifacts || [];
  const [showAll, setShowAll] = useState(!!expanded);
  const shown = showAll ? items : items.slice(0, 10);
  return (
    <Panel title="Artifacts" section={section} extra={<span className="small muted">{items.length} published</span>}>
      {shown.map((a) => (
        <div className="artifact" key={a.url}>
          <span className="updated">{a.updated}</span>
          <a href={a.url} target="_blank" rel="noreferrer">{a.title}</a>
        </div>
      ))}
      {items.length > 10 && (
        <button className="comment-btn" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </Panel>
  );
}

// ---------- summaries page ----------
// Markdown for saved summaries and the digest: react-markdown + GFM (standard, handles the
// edge cases a hand-rolled renderer gets wrong). Two small pre-passes on the source text:
//  - Slack-style "• " bullets become "- " so they render as lists.
//  - Bare ticket IDs (PROJ-123) not already part of a link/URL become links when
//    jira_browse_url is configured, so summaries written without explicit links still resolve.
function prepMarkdown(text) {
  let t = String(text || '').replace(/^(\s*)•\s+/gm, '$1- ');
  if (CONFIG.jira_browse_url) {
    // Not preceded by [, /, (, -, letter/digit (inside a URL, link text, or slug) and not
    // followed by ], ), / or a word char.
    t = t.replace(/(^|[^\w\[\/(\-])([A-Z][A-Z0-9]+-\d+)(?![\w\]\)\/])/g, (m, pre, id) => `${pre}[${id}](${CONFIG.jira_browse_url}${id})`);
  }
  return t;
}
const MD_COMPONENTS = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};
const MD_INLINE_COMPONENTS = { ...MD_COMPONENTS, p: ({ node, ...props }) => <span {...props} /> };

function Markdown({ text, inline }) {
  return (
    <div className={inline ? 'md md-inline' : 'md'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={inline ? MD_INLINE_COMPONENTS : MD_COMPONENTS}>
        {prepMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}
// Inline helper kept for callers that render a single string (digest bullets, etc.).
function inlineMd(text) { return <Markdown text={text} inline />; }

function SummariesPage({ section }) {
  const items = section?.data?.summaries || [];
  const [sel, setSel] = useState(0);
  const cur = items[sel];
  return (
    <div className="te-layout summaries-layout">
      <aside className="day-list">
        <div className="panel">
          <div className="panel-head"><h2>Summaries</h2><span className="spacer" /><Badge section={section} /></div>
          {!items.length && <p className="muted small">None saved yet — <code>/time-logger summary &lt;focus&gt;</code> writes one.</p>}
          {items.map((s, i) => (
            <button key={s.id} className={`day-item summary-item ${i === sel ? 'active' : ''}`} onClick={() => setSel(i)} title={s.focus || ''}>
              <span className="summary-date muted small">{fmtDay(s.date)}</span>
              <span className="summary-title">{s.title}</span>
              <span className="spacer" />
              {s.format && <span className="chip tag">{s.format}</span>}
              {s.sent && <span className="rev-chip" title="Sent to Slack"><Icon name="send" /></span>}
            </button>
          ))}
        </div>
      </aside>
      <div className="te-main">
        {!cur ? <div className="panel"><p className="muted">Pick a summary.</p></div> : (
          <div className="panel summary-view"><SummaryView summary={cur} /></div>
        )}
      </div>
    </div>
  );
}

// One view for a saved summary — used by the Summaries tab and the Overview digest. `compact`
// drops the title/meta rows (the panel header already says what it is).
function SummaryView({ summary: cur, compact }) {
  return (
    <div className="summary-view">
      {!compact && (
        <>
          <div className="panel-head">
            <h2>{cur.title}</h2>
            <span className="spacer" />
            <span className="small dim">{new Date(`${cur.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
          </div>
          <div className="meta-rows small">
            {cur.focus && <div><span className="muted">Focus</span> {cur.focus}</div>}
            {cur.audience && <div><span className="muted">Audience</span> {cur.audience}</div>}
            {cur.range && <div><span className="muted">Range</span> {cur.range}</div>}
            {cur.sources?.length > 0 && <div><span className="muted">Sources</span> {cur.sources.join(', ')}</div>}
            {cur.sent && <div><span className="muted">Sent</span> <a href={cur.sent} target="_blank" rel="noreferrer">{cur.sent.replace(/^https?:\/\//, '').slice(0, 60)}</a></div>}
          </div>
        </>
      )}
      <Markdown text={cur.body} />
    </div>
  );
}

// ---------- time entries page ----------
function fmtClock(t) {
  // % 24 first: an end time of exactly 24 (midnight) must read as 12:00 AM, not 12:00 PM —
  // matters for rebuildHeading, which has to match server.mjs's formatHourRange exactly.
  const hRaw = Math.floor(t), m = Math.round((t - hRaw) * 60);
  const h = hRaw % 24;
  const hh = ((h + 11) % 12) + 1, ap = h < 12 ? 'AM' : 'PM';
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

const PX_PER_HOUR = 120; // cards are header-only now (detail moved to the side panel), so this just needs room for one header line at a 15-min slot
const snapQuarter = (h) => Math.round(h * 4) / 4;

// Reconstruct an entry's stable heading text (time prefix + "(Xh)") after a drag, so the
// dashboard can recognize the entry as "already applied" the moment the next poll's data
// comes back — without waiting on the server to echo the new heading. Must produce exactly
// what server.mjs's /api/entries/time-range handler writes to disk (same regex, same
// fmtClock-equivalent time formatting), or the override below never clears.
function rebuildHeading(heading, range) {
  const m = heading.match(/^(.+?)\s+—\s+(.*)$/);
  if (!m) return heading;
  const durationHours = Math.round((range.end - range.start) * 100) / 100;
  const newRest = m[2].replace(/(\d+(?:\.\d+)?)h/, `${durationHours}h`);
  return `${fmtClock(range.start)} – ${fmtClock(range.end)} — ${newRest}`;
}

// Vertical day schedule: a 15-min-snapped grid where each entry is a full-detail card (same
// content as the old plain Entry list — notes, tickets, comment box, reviewed/non-billable
// toggles) positioned by time, draggable by its header to move, or by its top/bottom edge to
// resize — modeled on Cronos's timesheet day view. This *is* the day's entry list now, not a
// decoration above it; only entries without a parseable time (rare — a malformed heading)
// fall outside it, surfaced separately by the caller. Persists directly into the real
// time-entries markdown file (via /api/entries/time-range, the same direct-write-then-rerender
// pattern as the non-billable toggle) the moment you let go of the mouse, rather than queuing a
// comment for the agent to apply later.
function DayGrid({ day, pending, submit, remove, reviewedEntryKeys, toggleEntry, onSelectEntry, selectedLetter }) {
  const items = day.entries.filter((e) => e.range);
  // letter -> { heading, range }: entries this component has already saved locally, ahead of
  // the ~5s poll that will confirm it server-side. Keyed by letter (stable across a pure time
  // edit, since letters are assigned by position in the file and this feature never reorders
  // blocks) rather than heading, because heading itself is what a drag changes.
  const [overrides, setOverrides] = useState({});
  const [preview, setPreview] = useState(null); // { letter, range } — live position while dragging
  const dragRef = useRef(null);

  // Once a fresh poll's heading matches what we already applied locally, drop the override —
  // the server copy has caught up, no need to keep overriding it.
  useEffect(() => {
    setOverrides((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const e of items) {
        if (next[e.letter] && next[e.letter].heading === e.heading) { delete next[e.letter]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [items]);

  if (!items.length) return null;

  const effective = items.map((e) => {
    const ov = overrides[e.letter];
    let out = ov ? { ...e, heading: ov.heading, range: ov.range } : e;
    if (preview && preview.letter === e.letter) out = { ...out, range: preview.range };
    return out;
  });

  const d0 = Math.min(7, Math.floor(Math.min(...effective.map((e) => e.range.start))));
  const d1 = Math.max(18, Math.ceil(Math.max(...effective.map((e) => e.range.end))));

  // Lane-assign PER OVERLAP CLUSTER, not globally — a single busy afternoon shouldn't shrink
  // every unrelated morning card's width too. Sorted by start, a cluster is a maximal run of
  // mutually-touching intervals (next start < the max end seen so far in the run); each
  // cluster gets its own lane count, so an entry with no overlap always gets full width.
  const sorted = [...effective].sort((a, b) => a.range.start - b.range.start);
  const assignClusterLanes = (from, to) => {
    const laneEnds = [];
    for (let i = from; i < to; i++) {
      const e = sorted[i];
      let lane = laneEnds.findIndex((end) => end <= e.range.start + 1e-9);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = e.range.end;
      e.lane = lane;
    }
    for (let i = from; i < to; i++) sorted[i].numLanes = Math.max(1, laneEnds.length);
  };
  let clusterStart = 0, clusterEnd = -Infinity;
  sorted.forEach((e, i) => {
    if (e.range.start >= clusterEnd - 1e-9) {
      if (i > clusterStart) assignClusterLanes(clusterStart, i);
      clusterStart = i;
      clusterEnd = e.range.end;
    } else {
      clusterEnd = Math.max(clusterEnd, e.range.end);
    }
  });
  if (sorted.length) assignClusterLanes(clusterStart, sorted.length);

  const gaps = [];
  let cur = sorted[0].range.start;
  sorted.forEach((e) => {
    if (e.range.start > cur + 1e-9) gaps.push([cur, e.range.start]);
    cur = Math.max(cur, e.range.end);
  });

  const onMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaHours = (event.clientY - drag.startClientY) / PX_PER_HOUR;
    let start = drag.original.start, end = drag.original.end;
    if (drag.kind === 'move') {
      const duration = drag.original.end - drag.original.start;
      start = snapQuarter(drag.original.start + deltaHours);
      start = Math.max(drag.windowD0, Math.min(start, drag.windowD1 - duration));
      end = start + duration;
    } else if (drag.kind === 'resize-top') {
      start = snapQuarter(drag.original.start + deltaHours);
      start = Math.max(drag.windowD0, Math.min(start, drag.original.end - 0.25));
    } else {
      end = snapQuarter(drag.original.end + deltaHours);
      end = Math.min(drag.windowD1, Math.max(end, drag.original.start + 0.25));
    }
    drag.current = { start, end };
    setPreview({ letter: drag.letter, range: { start, end } });
  };

  const onUp = async () => {
    const drag = dragRef.current;
    dragRef.current = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.userSelect = '';
    setPreview(null);
    if (!drag) return;
    const finalRange = drag.current || drag.original;
    if (finalRange.start === drag.original.start && finalRange.end === drag.original.end) {
      // No actual movement — this was a click, not a drag. Only 'move' (the card's header/body,
      // not a resize handle) opens the side panel; a no-op resize-handle click does nothing.
      if (drag.kind === 'move') onSelectEntry?.(drag.entry);
      return;
    }
    try {
      const res = await fetch('/api/entries/time-range', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: day.date, heading: drag.heading, startHour: finalRange.start, endHour: finalRange.end }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const newHeading = rebuildHeading(drag.heading, finalRange);
      setOverrides((prev) => ({ ...prev, [drag.letter]: { heading: newHeading, range: finalRange } }));
    } catch (err) {
      console.error('Error saving dragged/resized entry:', err);
    }
  };

  const beginDrag = (entry, kind, event) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      letter: entry.letter,
      kind,
      startClientY: event.clientY,
      original: { ...entry.range },
      heading: entry.heading,
      entry,
      windowD0: d0,
      windowD1: d1,
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div className="dg-wrap">
      <div className="dg" style={{ height: (d1 - d0) * PX_PER_HOUR }}>
        <div className="dg-hours">
          {Array.from({ length: d1 - d0 + 1 }, (_, i) => d0 + i).map((h) => (
            <span key={h} className="dg-hour-label" style={{ top: (h - d0) * PX_PER_HOUR }}>
              {((h + 11) % 12) + 1}{h < 12 ? 'a' : 'p'}
            </span>
          ))}
        </div>
        <div className="dg-track">
          {sorted.map((e) => {
            const entryKey = `${day.date}|${e.heading}`;
            return (
              <div
                key={e.letter}
                className={`dg-cell ${e.letter === selectedLetter ? 'selected' : ''}`}
                title={`${e.time} — ${e.title}${e.hours != null ? ` (${e.hours}h)` : ''}${e.non_billable ? ' [non-billable]' : ''}${e.body ? `\n\n${e.body}` : ''}`}
                style={{
                  top: (e.range.start - d0) * PX_PER_HOUR,
                  height: (e.range.end - e.range.start) * PX_PER_HOUR,
                  left: `${(e.lane / e.numLanes) * 100}%`,
                  width: `${100 / e.numLanes}%`,
                }}
              >
                <div className="dg-resize-handle top" onMouseDown={(ev) => beginDrag(e, 'resize-top', ev)} />
                <Entry
                  day={day} entry={e} pending={pending} submit={submit} remove={remove}
                  isReviewed={reviewedEntryKeys.has(entryKey)}
                  toggleReviewed={(val) => toggleEntry(day.date, e.heading, val)}
                  variant="card"
                  onDragHandleMouseDown={(ev) => beginDrag(e, 'move', ev)}
                />
                <div className="dg-resize-handle bottom" onMouseDown={(ev) => beginDrag(e, 'resize-bottom', ev)} />
              </div>
            );
          })}
        </div>
      </div>
      {gaps.length > 0 && (
        <div className="dg-gaplbl">Unscheduled gaps: {gaps.map(([a, b]) => `${fmtClock(a)}–${fmtClock(b)}`).join(', ')}</div>
      )}
    </div>
  );
}

function CommentBox({ context, submit, onDone, placeholder }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await submit({ ...context, comment: text.trim() });
      setText('');
      onDone();
    } finally { setBusy(false); }
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      save();
    }
  };
  return (
    <div className="comment-box">
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} autoFocus
        placeholder={placeholder || "Comment for the agent — e.g. 'this was 2h, not 1h' or 'split out the LookML work'"} />
      <div className="row">
        <button className="btn" onClick={save} disabled={busy || !text.trim()}>Save for agent</button>
        <button className="btn ghost" onClick={onDone}>Cancel</button>
        <span className="kbd">shift + enter saves</span>
      </div>
    </div>
  );
}

// variant 'list' (default): plain stacked row, as always. variant 'card': same content, sized
// to fill whatever positioned wrapper the caller (DayGrid) puts it in, scrolling internally if
// the wrapper's time-proportional height is too short for the content. onDragHandleMouseDown,
// card mode only: wired to the badge/time header specifically (not the whole card) so dragging
// to move an entry doesn't fight with clicking a button, ticket link, or the notes text inside it.
function Entry({ day, entry, pending, submit, remove, isReviewed, toggleReviewed, variant = 'list', onDragHandleMouseDown }) {
  const [open, setOpen] = useState(false);
  const [nbBusy, setNbBusy] = useState(false);
  const fb = pending.filter((p) => p.date === day.date && p.heading === entry.heading && !p.resolved);
  // Writes directly into the entry's heading line in the real time-entries file (not a JSON
  // sidecar like "reviewed") — this changes what the entry means, so it has to live in the
  // source of truth to survive Notes API uploads and my_time's parser. The store re-renders
  // server-side before this resolves, so the next 5s poll picks up the change.
  const toggleNonBillable = async () => {
    setNbBusy(true);
    try {
      await fetch('/api/entries/non-billable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: day.date, heading: entry.heading, nonBillable: !entry.non_billable }),
      });
    } finally { setNbBusy(false); }
  };
  const isCard = variant === 'card';
  return (
    <div className={isCard ? 'entry entry-card' : 'entry'}>
      {/* List mode only: its own column (roomy, no width pressure). Card mode folds the letter
          into the header row instead (see entry-badge-inline below) — a whole reserved 28px+gap
          column was wasted space on cards that are often only a couple hundred px wide. */}
      {!isCard && (
        <div className={`entry-badge ${entry.is_meeting ? 'meet' : ''}`}>
          {entry.letter || '·'}
        </div>
      )}
      <div className="entry-main">
        <div className={`entry-head ${isCard ? 'drag-handle' : ''}`} onMouseDown={isCard ? onDragHandleMouseDown : undefined}>
          {isCard && (
            <span className={`entry-badge-inline ${entry.is_meeting ? 'meet' : ''}`}>{entry.letter || '·'}</span>
          )}
          <span className="time">{entry.time}</span>
          <span className="title">{entry.title}</span>
          {entry.is_meeting && <span className="mtag">MEETING</span>}
          <ClientChip client={entry.client} />
          {entry.hours != null && <span className="hours">{entry.hours}h</span>}
          <span className="spacer" />
          {/* Card mode: pinned to the card's top-right corner (see .entry-card .entry-toggles) so
              they're always in the same spot regardless of how the rest of the header wraps —
              they float over the title/tags rather than getting pushed out of the card's box. */}
          <div className="entry-toggles">
            {/* Card mode only — list mode already shows each queued comment inline via FbItem
                (see entry-scroll below), so a count badge here would be redundant there. */}
            {isCard && fb.length > 0 && (
              <span className="fb-count" title={`${fb.length} comment${fb.length > 1 ? 's' : ''} queued for the agent`}>
                <Icon name="comment" />{fb.length}
              </span>
            )}
            <button
              className={`entry-nonbillable-btn ${entry.non_billable ? 'on' : ''}`}
              onMouseDown={(ev) => ev.stopPropagation()}
              onClick={toggleNonBillable} disabled={nbBusy}
              title={entry.non_billable ? 'Non-billable — click to unmark' : 'Mark this entry as non-billable'}>
              {entry.non_billable ? 'Non-billable' : 'Bill?'}
            </button>
            <button
              className={`entry-review-btn ${isReviewed ? 'on' : ''}`}
              onMouseDown={(ev) => ev.stopPropagation()}
              onClick={() => toggleReviewed(!isReviewed)}
              title={isReviewed ? 'Reviewed — click to unmark' : 'Mark this entry as reviewed'}>
              <Icon name="check" />
            </button>
          </div>
        </div>
        {/* Card mode is header-only now — clicking the card opens the side panel for this detail
            (notes/tickets/comment box) instead of showing it inline. */}
        {!isCard && (
          <div className="entry-scroll">
            {!entry.is_meeting && <p className="entry-body">{entry.body}</p>}
            <div>
              {entry.tickets.map((t) => <TicketLink key={t} id={t} className="chip" />)}
            </div>
            {fb.map((f) => <FbItem key={f.id} f={f} remove={remove} />)}
            {open
              ? <CommentBox context={{ type: 'time_entry_comment', date: day.date, heading: entry.heading }} submit={submit} onDone={() => setOpen(false)} />
              : <button className="comment-btn" onClick={() => setOpen(true)}><Icon name="comment" />Comment</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// Sunday-anchored week helpers. Dates are literal 'YYYY-MM-DD' strings throughout this app;
// always round-trip through local noon (never .toISOString(), which is UTC-based and can land
// on the wrong calendar day depending on the viewer's offset) to avoid DST/timezone day-shift.
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfWeek(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() - d.getDay());
  return toISO(d);
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// Sums client_hours across several days into one map — reused by OrgTotals (which only ever
// reads `.client_hours` off whatever object it's handed) to get a week total for free.
function mergeClientHours(days) {
  const merged = {};
  for (const d of days) {
    for (const [c, h] of Object.entries(d?.client_hours || {})) {
      merged[c] = Math.round(((merged[c] || 0) + h) * 100) / 100;
    }
  }
  return merged;
}

// org isolates to entries whose client maps to that org (clientMeta is the same client->org
// mapping OrgTotals/ClientChip already use, from CONFIG.clients); hideNonBillable drops entries
// flagged [non-billable] in their heading.
function matchesFilters(entry, { org, hideNonBillable }) {
  if (hideNonBillable && entry.non_billable) return false;
  if (org && clientMeta(entry.client).org !== org) return false;
  return true;
}

// Recomputes a day's entries/hours/client_hours under the active filters, for every place that
// reads them (week tiles, week totals, the day-meta header, the grid). Everything else on the
// day object (tickets/repos/PRs/span/updated_at) is left as the server rendered it — those
// summarize the unfiltered day and aren't worth re-deriving client-side just for a filter.
function applyFiltersToDay(day, filters) {
  const entries = day.entries.filter((e) => matchesFilters(e, filters));
  const hours = Math.round(entries.reduce((n, e) => n + (e.hours || 0), 0) * 100) / 100;
  const client_hours = {};
  for (const e of entries) {
    const k = e.client || 'untagged';
    client_hours[k] = Math.round(((client_hours[k] || 0) + (e.hours || 0)) * 100) / 100;
  }
  return { ...day, entries, hours, client_hours };
}

// Org isolate + hide-non-billable, applied across the whole time-entries page. Recomputed
// client-side (applyFiltersToDay) rather than round-tripping to the server.
function FilterBar({ orgs, orgFilter, setOrgFilter, hideNonBillable, setHideNonBillable }) {
  const active = !!orgFilter || hideNonBillable;
  return (
    <div className="panel filter-bar">
      <span className="muted small">Filter</span>
      <select className="filter-select" value={orgFilter || ''} onChange={(e) => setOrgFilter(e.target.value || null)}>
        <option value="">All orgs</option>
        {orgs.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <label className="filter-check">
        <input type="checkbox" checked={hideNonBillable} onChange={(e) => setHideNonBillable(e.target.checked)} />
        Hide non-billable
      </label>
      {active && (
        <button className="btn ghost" onClick={() => { setOrgFilter(null); setHideNonBillable(false); }}>Clear</button>
      )}
    </div>
  );
}

// Replaces the old vertical "Days" sidebar: always shows the selected week's 7 tiles (real data
// or an empty placeholder), Previous/Today/Next to page between weeks, and a week-level
// per-client hour total underneath.
function WeekStrip({ section, days, weekStart, selectedDate, onSelectDate, onShiftWeek, onToday, pending, reviewedDates }) {
  const unresolved = pending.filter((p) => !p.resolved && p.type === 'time_entry_comment');
  const countFor = (date) => unresolved.filter((p) => p.date === date).length;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekDays = weekDates.map((date) => byDate.get(date)).filter(Boolean);
  // days is most-recent-first (see render.mjs), so the last element is the oldest on record.
  const earliestDate = days.length ? days[days.length - 1].date : null;
  const canGoBack = !earliestDate || addDays(weekStart, -7) >= startOfWeek(earliestDate);
  const weekTotals = mergeClientHours(weekDays);

  return (
    <div className="panel week-strip">
      <div className="panel-head">
        <h2>{fmtDay(weekDates[0])} – {fmtDay(weekDates[6])}</h2>
        <span className="spacer" />
        <Badge section={section} />
      </div>
      <div className="week-strip-nav">
        <button className="btn ghost" onClick={() => onShiftWeek(-7)} disabled={!canGoBack}>‹ Previous</button>
        <button className="btn ghost" onClick={onToday}>Today</button>
        <button className="btn ghost" onClick={() => onShiftWeek(7)}>Next ›</button>
      </div>
      <div className="week-tiles">
        {weekDates.map((date) => {
          const d = byDate.get(date);
          return (
            <button
              key={date}
              className={`week-tile ${date === selectedDate ? 'active' : ''} ${!d ? 'empty' : ''}`}
              onClick={() => onSelectDate(date)}
            >
              <span className="week-tile-name">{fmtDay(date)}</span>
              {d ? <DayHours day={d} /> : <span className="muted num">0h</span>}
              <span className="week-tile-flags">
                {reviewedDates.has(date) && <span className="rev-chip" title="Reviewed"><Icon name="check" /></span>}
                {countFor(date) > 0 && <span className="fb-count"><Icon name="comment" />{countFor(date)}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {Object.keys(weekTotals).length > 0 && (
        <div className="meta-rows small" style={{ marginTop: 10 }}>
          <div><span className="muted">This week</span>{' '}<OrgTotals day={{ client_hours: weekTotals }} /></div>
        </div>
      )}
      {unresolved.length > 0 && (
        <p className="small pending-note" style={{ marginTop: 10 }}>
          <Icon name="alert" /> {unresolved.length} comment{unresolved.length > 1 ? 's' : ''} queued — run
          {' '}<code>/time-logger feedback</code> to apply.
        </p>
      )}
    </div>
  );
}

function TimeEntriesPage({ section, pending, submit, remove }) {
  const days = section?.data?.days || [];

  // undefined = the user hasn't touched the org filter yet, so default to CONFIG.org (client.org
  // in capabilities.yml — "the org this install logs time for", already exactly the concept
  // "default org to isolate to" means; no separate config key to keep in sync with it). CONFIG
  // itself only populates once the store's initial fetch resolves, so this can't just be a
  // useState(CONFIG.org) initializer (would freeze at whatever CONFIG.org was — usually still
  // '' — on the very first render); recomputing the fallback every render picks it up live.
  // null (once the user explicitly picks "All orgs") is a real, distinct choice from "untouched".
  const [orgFilterOverride, setOrgFilterOverride] = useState(undefined);
  const orgFilter = orgFilterOverride !== undefined ? orgFilterOverride : (CONFIG.org || null);
  const [hideNonBillable, setHideNonBillable] = useState(true);
  const filtersActive = !!orgFilter || hideNonBillable;
  // Same dates either way — filtering only ever drops entries within a day, never a day itself —
  // so everything downstream (week nav, day lookup, "earliest date on record") stays correct
  // whether or not a filter is active.
  const filteredDays = useMemo(
    () => (filtersActive ? days.map((d) => applyFiltersToDay(d, { org: orgFilter, hideNonBillable })) : days),
    [days, orgFilter, hideNonBillable]
  );
  // Every org actually in use across all loaded days (not just the visible week), so the
  // dropdown doesn't go empty just because this week happens not to include one.
  const orgOptions = useMemo(() => {
    const set = new Set();
    for (const d of days) {
      for (const c of Object.keys(d.client_hours || {})) {
        const o = clientMeta(c).org;
        if (o) set.add(o);
      }
    }
    return [...set].sort();
  }, [days]);

  // null until the user actually navigates — until then, default to the most recent day with
  // data (same default the old index-based sidebar had), not necessarily today.
  const [selectedDateOverride, setSelectedDateOverride] = useState(null);
  const [weekStartOverride, setWeekStartOverride] = useState(null);
  const selectedDate = selectedDateOverride ?? days[0]?.date ?? toISO(new Date());
  const weekStart = weekStartOverride ?? startOfWeek(selectedDate);
  const day = filteredDays.find((d) => d.date === selectedDate);

  const [selectedEntry, setSelectedEntry] = useState(null); // { entry } | null — always for `day`

  const selectDate = (date) => {
    setSelectedDateOverride(date);
    setWeekStartOverride(startOfWeek(date));
    setSelectedEntry(null);
  };
  const shiftWeek = (deltaDays) => {
    const dayIndex = new Date(`${selectedDate}T12:00:00`).getDay();
    const newWeekStart = addDays(weekStart, deltaDays);
    setWeekStartOverride(newWeekStart);
    setSelectedDateOverride(addDays(newWeekStart, dayIndex));
    setSelectedEntry(null);
  };
  const goToday = () => {
    const today = toISO(new Date());
    setSelectedDateOverride(today);
    setWeekStartOverride(startOfWeek(today));
    setSelectedEntry(null);
  };
  const onSelectEntry = (entry) => {
    setSelectedEntry((prev) => (prev && prev.entry.letter === entry.letter ? null : { entry }));
  };

  const { reviewedEntries, toggle: toggleEntry } = useReviewedEntries();
  const reviewedEntryKeys = new Set(reviewedEntries.map((e) => `${e.date}|${e.heading}`));
  // A day counts as reviewed when every one of its (currently filtered-in) entries has been
  // individually marked reviewed — no separate day-level flag to fall out of sync with that.
  const isDayReviewed = (d) => d.entries.length > 0 && d.entries.every((e) => reviewedEntryKeys.has(`${d.date}|${e.heading}`));
  const reviewedDates = new Set(filteredDays.filter(isDayReviewed).map((d) => d.date));
  const [revBusy, setRevBusy] = useState(false);
  // "Mark reviewed" is now a bulk shortcut over the same per-entry state the grid's own checkmarks
  // use — marks (or unmarks) every entry in the day at once rather than writing a separate flag.
  const toggleReviewed = async (d) => {
    setRevBusy(true);
    const target = !isDayReviewed(d);
    try {
      for (const e of d.entries) await toggleEntry(d.date, e.heading, target);
    } finally { setRevBusy(false); }
  };
  // A selection can outlive a filter change that hides it (e.g. you select an entry, then flip
  // "Hide non-billable" and it happened to be non-billable) — rather than clearing it, just stop
  // treating it as visible; toggling the filter back off naturally restores it with no extra state.
  const selectedVisible = !!(selectedEntry && day && day.entries.some((e) => e.letter === selectedEntry.entry.letter));

  return (
    <div className="te-week-layout">
      <WeekStrip
        section={section} days={filteredDays} weekStart={weekStart} selectedDate={selectedDate}
        onSelectDate={selectDate} onShiftWeek={shiftWeek} onToday={goToday}
        pending={pending} reviewedDates={reviewedDates}
      />
      <FilterBar
        orgs={orgOptions} orgFilter={orgFilter} setOrgFilter={setOrgFilterOverride}
        hideNonBillable={hideNonBillable} setHideNonBillable={setHideNonBillable}
      />
      <div className="te-body">
        <div className="te-main">
          {!day ? <div className="panel"><p className="muted">No time entries rendered yet.</p></div> : (
            <>
              <div className="panel day-meta">
                <div className="panel-head">
                  <h2>{new Date(`${day.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
                  <button
                    className={`rev-btn ${reviewedDates.has(day.date) ? 'on' : ''}`}
                    onClick={() => toggleReviewed(day)} disabled={revBusy}
                    title={reviewedDates.has(day.date) ? 'Unmark reviewed' : 'Mark this day as reviewed'}>
                    {reviewedDates.has(day.date) ? <><Icon name="check" />Reviewed</> : 'Mark reviewed'}
                  </button>
                  <span className="spacer" />
                  {day.updated_at && <span className="small dim" title={new Date(day.updated_at).toLocaleString()}>drafted {ageLabel(day.updated_at)} ·</span>}
                  <span className="small dim num" title="Sum of entry durations (billable); entries may overlap">{day.hours}</span>
                  {day.span && <span className="small muted num" title="First start to last end">· {day.span}</span>}
                </div>
                <div className="meta-rows small">
                  {day.client_hours && Object.keys(day.client_hours).length > 0 && (
                    <div><span className="muted">Clients</span>{' '}<OrgTotals day={day} /></div>
                  )}
                  {day.tickets && <div><span className="muted">Tickets</span> {day.tickets}</div>}
                  {day.repos && <div><span className="muted">Repos</span> {day.repos.replace(/`/g, '')}</div>}
                  {day.prs && <div><span className="muted">PRs</span> {day.prs}</div>}
                </div>
              </div>
              {day.entries.some((e) => e.range) && (
                <div className="panel">
                  <DayGrid
                    key={day.date} day={day} pending={pending} submit={submit} remove={remove}
                    reviewedEntryKeys={reviewedEntryKeys} toggleEntry={toggleEntry} onSelectEntry={onSelectEntry}
                    selectedLetter={selectedEntry?.entry?.letter}
                  />
                </div>
              )}
              {day.entries.some((e) => !e.range) && (
                <div className="panel">
                  <div className="panel-head"><h2>Unscheduled</h2></div>
                  <p className="small muted" style={{ marginTop: -4, marginBottom: 10 }}>
                    No parseable time range — shown here instead of on the grid above.
                  </p>
                  {day.entries.filter((e) => !e.range).map((e) => {
                    const entryKey = `${day.date}|${e.heading}`;
                    return (
                      <Entry key={entryKey} day={day} entry={e} pending={pending} submit={submit} remove={remove}
                        isReviewed={reviewedEntryKeys.has(entryKey)}
                        toggleReviewed={(val) => toggleEntry(day.date, e.heading, val)} />
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
        {/* Always present (not conditionally mounted) — reserves its width permanently so
            selecting/deselecting an entry never reflows the grid next to it. */}
        <div className="panel te-side-panel">
          <div className="panel-head">
            <h2>Entry detail</h2>
            <span className="spacer" />
            {selectedVisible && <button className="btn ghost" onClick={() => setSelectedEntry(null)}>Close</button>}
          </div>
          {selectedVisible ? (
            <Entry
              day={day} entry={selectedEntry.entry} pending={pending} submit={submit} remove={remove}
              isReviewed={reviewedEntryKeys.has(`${day.date}|${selectedEntry.entry.heading}`)}
              toggleReviewed={(val) => toggleEntry(day.date, selectedEntry.entry.heading, val)}
            />
          ) : (
            <p className="muted small">Click an entry on the grid to see its full detail here.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- app ----------
export default function App() {
  const { store } = useStore();
  const { pending, submit, remove } = usePendingFeedback();
  const { jobs, trigger } = useJobs();
  const [tab, setTab] = useHashTab();
  const [logJob, setLogJob] = useState(null); // job name whose log modal is open, or null

  const tiles = useMemo(() => {
    const days = store.time_entries?.data?.days || [];
    const latest = days[0];
    const todoGroups = store.todos?.data?.groups || [];
    const openTodos = todoGroups.reduce((n, g) => n + g.items.filter((t) => !t.done).length, 0);
    const meetings = store.calendar?.data?.events?.length ?? 0;
    const unresolved = pending.filter((p) => !p.resolved).length;
    const unresolvedTime = pending.filter((p) => !p.resolved && p.type === 'time_entry_comment').length;
    const unresolvedPr = pending.filter((p) => !p.resolved && p.type === 'pr_comment').length;
    return { latest, openTodos, meetings, unresolved, unresolvedTime, unresolvedPr };
  }, [store, pending]);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const pageTitle = TABS.find((t) => t.id === tab)?.label || 'Overview';
  // Comments the headless feedback run will apply (PR comments stay pending for an interactive run).
  const applicable = pending.filter((p) => !p.resolved && (p.type === 'time_entry_comment' || p.type === 'todo_comment')).length;
  const meetingsDate = store.calendar?.data?.date;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <div className="client">Daybook</div>
          <div className="product">Morning dashboard</div>
        </div>
        <nav aria-label="Sections">
          {NAV.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-label">{g.label}</div>
              {g.items.map((t) => (
                <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
                  <Icon name={t.icon} />
                  <span>{t.label}</span>
                  {t.id === 'time' && tiles.unresolvedTime > 0 && <span className="count">{tiles.unresolvedTime}</span>}
                  {t.id === 'prs' && tiles.unresolvedPr > 0 && <span className="count">{tiles.unresolvedPr}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="act-row">
            <button className="act" disabled={jobs.refresh?.running} onClick={() => trigger('refresh')}
              title="Refetch today's sources, redraft today's entries, re-render (same script as the scheduled refresh)">
              <Icon name="refresh" /><span>{jobs.refresh?.running ? 'Refreshing…' : 'Refresh'}</span>
              {jobs.refresh?.finished_at && !jobs.refresh?.running && <span className="sub">{ageLabel(jobs.refresh.finished_at)}</span>}
            </button>
            <button className="log-btn" onClick={() => setLogJob('refresh')} title="View the refresh log"><Icon name="doc" /></button>
          </div>
          <div className="act-row">
            <button className="act" disabled={jobs.morning?.running} onClick={() => trigger('morning')}
              title="Run the full headless morning flow (same script as the 6:45 job)">
              <Icon name="sun" /><span>{jobs.morning?.running ? 'Running…' : 'Morning run'}</span>
              {jobs.morning?.finished_at && !jobs.morning?.running && <span className="sub">{ageLabel(jobs.morning.finished_at)}</span>}
            </button>
            <button className="log-btn" onClick={() => setLogJob('morning')} title="View the morning-run log"><Icon name="doc" /></button>
          </div>
          <div className="act-row">
            <button className="act" disabled={jobs.feedback?.running || applicable === 0} onClick={() => trigger('feedback')}
              title={applicable === 0
                ? 'No time-entry or todo comments queued'
                : `Apply ${applicable} queued comment${applicable === 1 ? '' : 's'} to the markdown (same as /time-logger feedback, minus PR actions)`}>
              <Icon name="comment" /><span>{jobs.feedback?.running ? 'Applying…' : 'Apply comments'}</span>
              {applicable > 0 && !jobs.feedback?.running && <span className="sub attention">{applicable}</span>}
              {applicable === 0 && jobs.feedback?.finished_at && <span className="sub">{ageLabel(jobs.feedback.finished_at)}</span>}
            </button>
            <button className="log-btn" onClick={() => setLogJob('feedback')} title="View the feedback-apply log"><Icon name="doc" /></button>
          </div>
          {tiles.unresolvedPr > 0 && (
            <p className="side-note">{tiles.unresolvedPr} PR comment{tiles.unresolvedPr === 1 ? '' : 's'} need an interactive <code>/time-logger feedback</code>.</p>
          )}
        </div>
      </aside>
      {logJob && <LogModal name={logJob} onClose={() => setLogJob(null)} />}

      <main className="main">
        <div className="main-inner">
          <div className="page-head">
            <h1>{tab === 'overview' ? today : pageTitle}</h1>
            {tab !== 'overview' && <span className="date">{today}</span>}
          </div>

          {tab === 'overview' && (
            <>
              <div className="strip">
                <button className="stat linky" onClick={() => setTab('time')}>
                  <span className="k">Last logged</span>
                  <span className="v">{tiles.latest?.hours ?? '—'}</span>
                  <span className="s">{tiles.latest ? fmtDay(tiles.latest.date) : 'no entries'}</span>
                </button>
                <span className="stat">
                  <span className="k">Meetings</span>
                  <span className="v">{tiles.meetings}</span>
                  <span className="s">{meetingsDate ? fmtDay(meetingsDate) : ''}</span>
                </span>
                {store.todos?.status === 'ok' && (
                  <button className="stat linky" onClick={() => setTab('todos')}>
                    <span className="k">Open todos</span>
                    <span className="v">{tiles.openTodos}</span>
                  </button>
                )}
                <button className={`stat linky ${tiles.unresolved ? 'attention' : ''}`} onClick={() => setTab('time')}>
                  <span className="k">Comments queued</span>
                  <span className="v">{tiles.unresolved}</span>
                  {tiles.unresolved > 0 && <span className="s">run /time-logger feedback</span>}
                </button>
              </div>

              <div className="grid">
                <div className="col">
                  <Digest section={store.digest} />
                </div>
                <div className="col">
                  <Calendar section={store.calendar} />
                </div>
              </div>
            </>
          )}

          {tab === 'time' && (
            <TimeEntriesPage section={store.time_entries} pending={pending} submit={submit} remove={remove} />
          )}

          {tab === 'todos' && (
            <TodosPage section={store.todos} pending={pending} submit={submit} remove={remove} />
          )}

          {tab === 'prs' && (
            <div className="page-single">
              <GitHubPRs section={store.github_prs} pending={pending} submit={submit} remove={remove} />
            </div>
          )}

          {tab === 'slack' && (
            <div className="page-single">
              <Slack section={store.slack} conversations={store.slack_conversations} />
            </div>
          )}

          {tab === 'summaries' && (
            <SummariesPage section={store.summaries} />
          )}

          {tab === 'artifacts' && (
            <div className="page-single">
              <Artifacts section={store.artifacts} expanded />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
