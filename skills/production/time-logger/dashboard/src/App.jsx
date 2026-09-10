import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SECTIONS = ['config', 'digest', 'time_entries', 'todos', 'calendar', 'slack', 'slack_conversations', 'artifacts', 'github_prs', 'uploads', 'summaries'];
// Client-specific values come from data/config.json (rendered from capabilities.yml by
// render.mjs) — nothing is hardcoded in the built app. Updated in useStore when it loads.
let CONFIG = { jira_browse_url: '', client_name: '', org: '', notes_api_enabled: false, orgs: {}, clients: {} };

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

function useReviewed() {
  const [reviewed, setReviewed] = useState([]);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/reviewed');
      if (r.ok) setReviewed(await r.json());
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const toggle = useCallback(async (date, val) => {
    const r = await fetch('/api/reviewed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, reviewed: val }),
    });
    if (!r.ok) throw new Error('reviewed toggle failed');
    await refresh();
  }, [refresh]);
  return { reviewed, toggle };
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

function TodoRow({ group, todo, pending, submit, remove }) {
  const [open, setOpen] = useState(false);
  const key = todo.ticket || todo.text.slice(0, 60);
  const fb = pending.filter((f) => f.type === 'todo_comment' && f.todo_key === key && !f.resolved);
  const shown = todo.text
    .replace(/\[[A-Z]{2,}-\d+\]\s*/, '')
    .replace(/\*\*\((?:HIGH|MEDIUM|LOW)\)\*\*\s*/i, '')
    .replace(/(?:^|\s)#[a-z][a-z0-9-]*/gi, '')
    .trim();
  const evidence = todo.evidence || [];
  return (
    <div className={`todo-block ${todo.suggest_done ? 'has-evidence' : ''}`}>
      <div className="todo">
        <span className="box" aria-hidden="true" />
        <span>
          {todo.ticket && <><TicketLink id={todo.ticket} />{' '}</>}
          <Linkify text={shown} />
          {todo.priority && <span className={`chip prio-${todo.priority}`}>{todo.priority}</span>}
          <span className={`chip kind kind-${todo.kind}`}>{todo.kind}</span>
          {(todo.tags || []).map((t) => <span key={t} className="chip tag">#{t}</span>)}
          {' '}
          <button className="comment-btn" onClick={() => setOpen(!open)} title="Comment for the agent"><Icon name="comment" /></button>
        </span>
      </div>
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

function Todos({ section, pending, submit, remove }) {
  const groups = (section?.data?.groups || []).filter((g) => g.state.toLowerCase() !== 'done');
  return (
    <Panel title="Todos" section={section} scroll>
      {!groups.length ? <p className="muted">No todos found.</p> :
        groups.map((g) => (
          <div className="todo-group" key={g.name}>
            <h3>{g.name}</h3>
            {g.items.filter((t) => !t.done).map((t, i) => (
              <TodoRow key={i} group={g} todo={t} pending={pending} submit={submit} remove={remove} />
            ))}
            {g.items.some((t) => t.done) && (
              <div className="small muted">{g.items.filter((t) => t.done).length} completed hidden</div>
            )}
          </div>
        ))}
    </Panel>
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
  const h = Math.floor(t), m = Math.round((t - h) * 60);
  const hh = ((h + 11) % 12) + 1, ap = h < 12 ? 'AM' : 'PM';
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

function DayTimeline({ day }) {
  const items = day.entries.filter((e) => e.range);
  if (!items.length) return null;
  const d0 = Math.min(7, Math.floor(Math.min(...items.map((e) => e.range.start))));
  const d1 = Math.max(18, Math.ceil(Math.max(...items.map((e) => e.range.end))));
  const span = d1 - d0;
  const pct = (t) => `${((t - d0) / span) * 100}%`;
  const sorted = [...items].sort((a, b) => a.range.start - b.range.start);
  const laneEnds = [];
  sorted.forEach((e) => {
    let lane = laneEnds.findIndex((end) => end <= e.range.start + 1e-9);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = e.range.end; e.lane = lane;
  });
  const gaps = [];
  let cur = sorted[0].range.start;
  sorted.forEach((e) => {
    if (e.range.start > cur + 1e-9) gaps.push([cur, e.range.start]);
    cur = Math.max(cur, e.range.end);
  });
  return (
    <div className="tl">
      <div className="tl-ticks">
        {Array.from({ length: d1 - d0 + 1 }, (_, i) => d0 + i).map((h) => (
          <span key={h} className="tl-tick" style={{ left: pct(h) }}>
            {((h + 11) % 12) + 1}{h < 12 ? 'a' : 'p'}
          </span>
        ))}
      </div>
      <div className="tl-lanes" style={{ height: laneEnds.length * 32 + 6 }}>
        {sorted.map((e) => (
          <div key={e.heading} className={`tl-blk ${e.is_meeting ? 'meet' : ''}`}
            style={{ left: pct(e.range.start), width: `${((e.range.end - e.range.start) / span) * 100}%`, top: e.lane * 32 + 6 }}
            title={`${e.letter} — ${e.time} — ${e.title}`}>
            <span className="lbl">{e.letter}</span>{e.title}
          </div>
        ))}
      </div>
      <div className="tl-cover">
        {gaps.map(([a, b], i) => (
          <div key={i} className="tl-gap" style={{ left: pct(a), width: `${((b - a) / span) * 100}%` }} />
        ))}
      </div>
      {gaps.length > 0 && (
        <div className="tl-gaplbl">Unscheduled gaps: {gaps.map(([a, b]) => `${fmtClock(a)}–${fmtClock(b)}`).join(', ')}</div>
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

function Entry({ day, entry, pending, submit, remove }) {
  const [open, setOpen] = useState(false);
  const fb = pending.filter((p) => p.date === day.date && p.heading === entry.heading && !p.resolved);
  return (
    <div className="entry">
      <div className={`entry-badge ${entry.is_meeting ? 'meet' : ''}`}>{entry.letter || '·'}</div>
      <div className="entry-main">
        <div className="entry-head">
          <span className="time">{entry.time}</span>
          <span className="title">{entry.title}</span>
          {entry.is_meeting && <span className="mtag">MEETING</span>}
          <ClientChip client={entry.client} />
          {entry.hours != null && <span className="hours">{entry.hours}h</span>}
        </div>
        {!entry.is_meeting && <p className="entry-body">{entry.body}</p>}
        <div>
          {entry.tickets.map((t) => <TicketLink key={t} id={t} className="chip" />)}
        </div>
        {fb.map((f) => <FbItem key={f.id} f={f} remove={remove} />)}
        {open
          ? <CommentBox context={{ type: 'time_entry_comment', date: day.date, heading: entry.heading }} submit={submit} onDone={() => setOpen(false)} />
          : <button className="comment-btn" onClick={() => setOpen(true)}><Icon name="comment" />Comment</button>}
      </div>
    </div>
  );
}

function TimeEntriesPage({ section, uploads, pending, submit, remove }) {
  const days = section?.data?.days || [];
  const [sel, setSel] = useState(0);
  const day = days[sel];
  const unresolved = pending.filter((p) => !p.resolved && p.type === 'time_entry_comment');
  const countFor = (date) => unresolved.filter((p) => p.date === date).length;
  const uploadedDates = new Set(uploads?.data?.dates || []);
  const uploadsKnown = uploads?.status === 'ok';
  const { reviewed, toggle } = useReviewed();
  const reviewedDates = new Set(reviewed);
  const [revBusy, setRevBusy] = useState(false);
  const toggleReviewed = async (date) => {
    setRevBusy(true);
    try { await toggle(date, !reviewedDates.has(date)); } finally { setRevBusy(false); }
  };

  return (
    <div className="te-layout">
      <aside className="day-list">
        <div className="panel">
          <div className="panel-head"><h2>Days</h2><span className="spacer" /><Badge section={section} /></div>
          {days.map((d, i) => (
            <button key={d.date} className={`day-item ${i === sel ? 'active' : ''}`} onClick={() => setSel(i)}>
              <span className="day-name">{fmtDay(d.date)}</span>
              <span className="spacer" />
              {reviewedDates.has(d.date) && <span className="rev-chip" title="Reviewed"><Icon name="check" /></span>}
              {countFor(d.date) > 0 && <span className="fb-count"><Icon name="comment" />{countFor(d.date)}</span>}
              {uploadsKnown && (
                uploadedDates.has(d.date)
                  ? <span className="up-chip done" title="Uploaded to notes API"><Icon name="send" /></span>
                  : <span className="up-chip todo" title="Not uploaded yet">·</span>
              )}
              <span className="muted">{d.hours}</span>
            </button>
          ))}
          {unresolved.length > 0 && (
            <p className="small pending-note" style={{ marginTop: 10 }}>
              <Icon name="alert" /> {unresolved.length} comment{unresolved.length > 1 ? 's' : ''} queued — run
              {' '}<code>/time-logger feedback</code> to apply.
            </p>
          )}
        </div>
      </aside>
      <div className="te-main">
        {!day ? <div className="panel"><p className="muted">No time entries rendered yet.</p></div> : (
          <>
            <div className="panel day-meta">
              <div className="panel-head">
                <h2>{new Date(`${day.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
                {uploadsKnown && (
                  uploadedDates.has(day.date)
                    ? <span className="badge fresh"><Icon name="send" />uploaded</span>
                    : <span className="badge stale"><Icon name="alert" />not uploaded</span>
                )}
                <button
                  className={`rev-btn ${reviewedDates.has(day.date) ? 'on' : ''}`}
                  onClick={() => toggleReviewed(day.date)} disabled={revBusy}
                  title={reviewedDates.has(day.date) ? 'Unmark reviewed' : 'Mark this day as reviewed'}>
                  {reviewedDates.has(day.date) ? <><Icon name="check" />Reviewed</> : 'Mark reviewed'}
                </button>
                <span className="spacer" />
                {day.updated_at && <span className="small dim" title={new Date(day.updated_at).toLocaleString()}>drafted {ageLabel(day.updated_at)} ·</span>}
                <span className="small dim">{day.hours}</span>
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
            <div className="panel">
              <DayTimeline day={day} />
              {day.entries.map((e) => (
                <Entry key={`${day.date}|${e.heading}`} day={day} entry={e} pending={pending} submit={submit} remove={remove} />
              ))}
            </div>
          </>
        )}
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

  const tiles = useMemo(() => {
    const days = store.time_entries?.data?.days || [];
    const latest = days[0];
    const todoGroups = store.todos?.data?.groups || [];
    const openTodos = todoGroups.filter((g) => g.state.toLowerCase() !== 'done')
      .reduce((n, g) => n + g.items.filter((t) => !t.done).length, 0);
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
          <button className="act" disabled={jobs.refresh?.running} onClick={() => trigger('refresh')}
            title="Refetch today's sources, redraft today's entries, re-render (same script as the scheduled refresh)">
            <Icon name="refresh" /><span>{jobs.refresh?.running ? 'Refreshing…' : 'Refresh'}</span>
            {jobs.refresh?.finished_at && !jobs.refresh?.running && <span className="sub">{ageLabel(jobs.refresh.finished_at)}</span>}
          </button>
          <button className="act" disabled={jobs.morning?.running} onClick={() => trigger('morning')}
            title="Run the full headless morning flow (same script as the 6:45 job)">
            <Icon name="sun" /><span>{jobs.morning?.running ? 'Running…' : 'Morning run'}</span>
            {jobs.morning?.finished_at && !jobs.morning?.running && <span className="sub">{ageLabel(jobs.morning.finished_at)}</span>}
          </button>
          <button className="act" disabled={jobs.feedback?.running || applicable === 0} onClick={() => trigger('feedback')}
            title={applicable === 0
              ? 'No time-entry or todo comments queued'
              : `Apply ${applicable} queued comment${applicable === 1 ? '' : 's'} to the markdown (same as /time-logger feedback, minus PR actions)`}>
            <Icon name="comment" /><span>{jobs.feedback?.running ? 'Applying…' : 'Apply comments'}</span>
            {applicable > 0 && !jobs.feedback?.running && <span className="sub attention">{applicable}</span>}
            {applicable === 0 && jobs.feedback?.finished_at && <span className="sub">{ageLabel(jobs.feedback.finished_at)}</span>}
          </button>
          {tiles.unresolvedPr > 0 && (
            <p className="side-note">{tiles.unresolvedPr} PR comment{tiles.unresolvedPr === 1 ? '' : 's'} need an interactive <code>/time-logger feedback</code>.</p>
          )}
        </div>
      </aside>

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
                  <span className="stat">
                    <span className="k">Open todos</span>
                    <span className="v">{tiles.openTodos}</span>
                  </span>
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
                  {store.todos?.status === 'ok' && <Todos section={store.todos} pending={pending} submit={submit} remove={remove} />}
                </div>
              </div>
            </>
          )}

          {tab === 'time' && (
            <TimeEntriesPage section={store.time_entries} uploads={store.uploads} pending={pending} submit={submit} remove={remove} />
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
