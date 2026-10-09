"""
Regression tests for the session scanner: Claude Code + Codex adapters, cross-provider
deduplication, local-day windows, exclusions, caching, and stale-block cleanup.

Run from the repo root:  python3 -m unittest discover -s skills/time-logger/tests -v

Every fixture is synthesized here — no real transcript content, paths, or config. Each test
gets its own temporary HOME / data home / CODEX_HOME, so nothing touches the real machine.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import apply_session_blocks  # noqa: E402
import scan_sessions as sc  # noqa: E402
import session_sources as ss  # noqa: E402

TZ = "America/Los_Angeles"
DAY = "2026-10-08"


def utc(local: str) -> str:
    """'2026-10-08 09:00:00' in Pacific -> ISO UTC string with Z, as both agents write it."""
    from zoneinfo import ZoneInfo
    dt = datetime.strptime(local, "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZoneInfo(TZ))
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def shift(iso: str, **kw) -> str:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")) + timedelta(**kw)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# Conversation used across tests: (role, text, local time).
CONVO = [
    ("user", "Please refactor the billing export so it streams rows instead of buffering.", "2026-10-08 09:00:00"),
    ("assistant", "I'll switch the exporter to a generator and write rows as they arrive.", "2026-10-08 09:01:00"),
    ("user", "Also add a regression test that covers an empty result set please.", "2026-10-08 09:05:00"),
    ("assistant", "Added test_export_empty and confirmed the streaming path handles zero rows.", "2026-10-08 09:07:00"),
]


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="tl-test-"))
        self.home = self.tmp / "home"
        self.data = self.tmp / "data"
        self.home.mkdir()
        self.data.mkdir()
        self._env = {k: os.environ.get(k) for k in ("HOME", "TIME_LOGGER_DATA_HOME", "TIME_LOGGER_TZ", "CODEX_HOME")}
        os.environ["HOME"] = str(self.home)
        os.environ["TIME_LOGGER_DATA_HOME"] = str(self.data)
        os.environ["TIME_LOGGER_TZ"] = TZ
        os.environ.pop("CODEX_HOME", None)
        self.write_caps(claude=True, codex=True)

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- fixture builders ----
    def write_caps(self, claude=True, codex=None):
        lines = ["settings:", "  data_home: x", "integrations:",
                 "  claude_sessions:", f"    enabled: {str(claude).lower()}"]
        if codex is not None:
            lines += ["  codex_sessions:", f"    enabled: {str(codex).lower()}"]
        lines += ["  slack:", "    enabled: true"]
        (self.data / "capabilities.yml").write_text("\n".join(lines) + "\n")

    def claude_file(self, name, convo, cwd="/work/billing-service", session_id=None, uuids=None,
                    project="-work-billing-service", extra_lines=()):
        p = self.home / ".claude" / "projects" / project / f"{name}.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        lines = []
        for i, (role, text, local) in enumerate(convo):
            content = text if role == "user" else [{"type": "text", "text": text}]
            lines.append({"type": role, "timestamp": utc(local), "cwd": cwd,
                          "sessionId": session_id or name,
                          "uuid": (uuids[i] if uuids else f"{name}-u{i}"),
                          "message": {"role": role, "content": content}})
        lines.extend(extra_lines)
        p.write_text("".join(json.dumps(x) + "\n" for x in lines))
        return str(p)

    def codex_file(self, name, convo, cwd="/work/billing-service", root="sessions", ts_override=None,
                   with_noise=True, raw_tail=""):
        sub = Path("2026/10/08") if root == "sessions" else Path()
        p = self.home / ".codex" / root / sub / f"rollout-{name}.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        first_ts = utc(convo[0][2]) if convo else utc(f"{DAY} 08:00:00")
        lines = [{"timestamp": first_ts, "type": "session_meta",
                  "payload": {"id": name, "timestamp": first_ts, "cwd": cwd, "originator": "codex_cli_rs",
                              "cli_version": "0.0.0", "instructions": "SYSTEM", "source": "cli"}}]
        if with_noise:
            lines.append({"timestamp": first_ts, "type": "response_item", "payload": {
                "type": "message", "role": "user",
                "content": [{"type": "input_text", "text": "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>"}]}})
            lines.append({"timestamp": first_ts, "type": "response_item", "payload": {
                "type": "message", "role": "developer", "content": [{"type": "input_text", "text": "dev rules"}]}})
        for role, text, local in convo:
            ts = ts_override(local) if ts_override else utc(local)
            block = "input_text" if role == "user" else "output_text"
            lines.append({"timestamp": ts, "type": "response_item",
                          "payload": {"type": "message", "role": role, "content": [{"type": block, "text": text}]}})
            if with_noise:
                ev = "user_message" if role == "user" else "agent_message"
                lines.append({"timestamp": ts, "type": "event_msg", "payload": {"type": ev, "message": text}})
                lines.append({"timestamp": ts, "type": "response_item", "payload": {
                    "type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}]}})
                lines.append({"timestamp": ts, "type": "response_item", "payload": {
                    "type": "function_call", "name": "shell", "arguments": "{}", "call_id": "c"}})
                lines.append({"timestamp": ts, "type": "response_item", "payload": {
                    "type": "function_call_output", "call_id": "c", "output": "ok"}})
                lines.append({"timestamp": ts, "type": "event_msg", "payload": {"type": "token_count", "info": {}}})
                lines.append({"timestamp": ts, "type": "turn_context", "payload": {"cwd": cwd}})
                lines.append({"timestamp": ts, "type": "world_state", "payload": {"anything": 1}})
        p.write_text("".join(json.dumps(x) + "\n" for x in lines) + raw_tail)
        return str(p)

    def touch_future(self):
        """Fixtures are written "now"; a test scanning a later date needs a later mtime, since
        the scanner (correctly) skips files not written since the target day began."""
        future = time.time() + 120 * 86400
        for p in self.home.rglob("*.jsonl"):
            os.utime(p, (future, future))

    def scan(self, day=DAY, providers=None):
        return sc.Scan(day, providers)

    def by_provider(self, scan):
        out = {}
        for s in scan.sessions:
            out.setdefault(s.transcript.provider, []).append(s)
        return out


class ConfigTests(Env):
    def test_missing_codex_key_preserves_claude_only(self):
        self.write_caps(claude=True, codex=None)
        self.assertEqual(ss.enabled_providers(), ["claude"])
        self.claude_file("c1", CONVO)
        self.codex_file("x1", CONVO[:2])
        s = self.scan()
        self.assertEqual([x.transcript.provider for x in s.sessions], ["claude"])
        self.assertEqual(s.sessions[0].turns, 4)

    def test_codex_only_without_claude_dir(self):
        self.write_caps(claude=False, codex=True)
        self.codex_file("x1", CONVO)
        s = self.scan()
        self.assertFalse((self.home / ".claude").exists())
        self.assertEqual(len(s.sessions), 1)
        self.assertEqual(s.sessions[0].transcript.provider, "codex")

    def test_codex_home_env_respected(self):
        alt = self.tmp / "alt-codex"
        os.environ["CODEX_HOME"] = str(alt)
        (alt / "sessions").mkdir(parents=True)
        self.assertEqual(ss.codex_roots()[0], alt / "sessions")

    def test_missing_roots_are_not_errors(self):
        s = self.scan()
        self.assertEqual(s.sessions, [])
        self.assertTrue(any(".claude" in r for r in s.discovery.missing_roots))


class ParsingTests(Env):
    def test_native_claude_session(self):
        self.claude_file("c1", CONVO)
        (s,) = self.scan().sessions
        self.assertEqual((s.turns, s.transcript.repo), (4, "billing-service"))
        self.assertEqual(s.first.strftime("%H:%M"), "09:00")
        self.assertEqual(s.last.strftime("%H:%M"), "09:07")
        self.assertTrue(s.excerpts[0].startswith("[user] Please refactor"))
        self.assertTrue(s.excerpts[1].startswith("[assistant] I'll switch"))

    def test_native_codex_session_ignores_noise_records(self):
        self.codex_file("x1", CONVO, with_noise=True)
        (s,) = self.scan().sessions
        # 4 conversation messages; environment_context, developer, reasoning, tool calls,
        # token counts, turn_context, world_state, and event_msg duplicates add nothing.
        self.assertEqual(s.turns, 4)
        self.assertEqual(len(s.excerpts), 4)
        self.assertEqual(s.transcript.repo, "billing-service")
        self.assertEqual((s.first.strftime("%H:%M"), s.last.strftime("%H:%M")), ("09:00", "09:07"))
        self.assertFalse(any("environment_context" in e or "dev rules" in e for e in s.excerpts))

    def test_codex_event_msgs_used_only_when_no_response_items(self):
        p = self.home / ".codex" / "sessions" / "2026/10/08" / "rollout-ev.jsonl"
        p.parent.mkdir(parents=True)
        ts = utc(f"{DAY} 10:00:00")
        p.write_text("\n".join(json.dumps(x) for x in [
            {"timestamp": ts, "type": "session_meta", "payload": {"id": "ev", "cwd": "/w/r"}},
            {"timestamp": ts, "type": "event_msg", "payload": {"type": "user_message", "message": "Investigate the flaky login test today"}},
            {"timestamp": ts, "type": "event_msg", "payload": {"type": "agent_message", "message": "Found a race in the session fixture setup."}},
        ]) + "\n")
        (s,) = self.scan().sessions
        self.assertEqual(s.turns, 2)

    def test_codex_ide_wrapper_keeps_real_request(self):
        convo = [("user", "# Context from my IDE setup:\n## Open tabs: a.py\n## My request for Codex:\nRename the helper to load_rows everywhere", "2026-10-08 11:00:00")]
        self.codex_file("x1", convo)
        (s,) = self.scan().sessions
        self.assertEqual(s.excerpts, ["[user] Rename the helper to load_rows everywhere"])

    def test_malformed_and_truncated_lines_keep_valid_activity(self):
        good = self.claude_file("c1", CONVO, extra_lines=[])
        with open(good, "a") as f:
            f.write("{not json}\n")
            f.write(json.dumps({"type": "user", "timestamp": utc(f"{DAY} 09:30:00"), "uuid": "late",
                                "message": {"content": "One more valid message after the bad line."}}) + "\n")
            f.write('{"type": "assistant", "timestamp": "2026-10-08T')  # write in progress
        s = self.scan()
        (sess,) = s.sessions
        self.assertEqual(sess.turns, 5)
        self.assertEqual(sess.transcript.parse_errors, 1)
        self.assertTrue(sess.transcript.truncated_tail)

    def test_unknown_record_types_ignored(self):
        self.codex_file("x1", CONVO[:2], raw_tail=json.dumps({"timestamp": utc(f"{DAY} 12:00:00"),
                                                             "type": "brand_new_record", "payload": {}}) + "\n")
        (s,) = self.scan().sessions
        self.assertEqual(s.turns, 2)


class DayWindowTests(Env):
    def test_midnight_boundary(self):
        convo = [("user", "Late night debugging of the queue consumer backlog.", "2026-10-08 23:58:00"),
                 ("assistant", "The consumer's prefetch was set to one; raising it clears the backlog.", "2026-10-09 00:02:00")]
        self.claude_file("c1", convo)
        self.touch_future()
        (a,) = self.scan("2026-10-08").sessions
        (b,) = self.scan("2026-10-09").sessions
        self.assertEqual((a.turns, b.turns), (1, 1))

    def test_dst_fall_back_day_is_25_hours(self):
        start, end = ss.day_window("2026-11-01", ss.resolve_tz())
        self.assertEqual(end - start, timedelta(hours=25))
        convo = [("user", "Early morning work on the fall-back DST day itself.", "2026-11-01 00:30:00"),
                 ("assistant", "Late evening reply on the same DST day before midnight.", "2026-11-01 23:30:00"),
                 ("user", "This one is after midnight and belongs to the next day.", "2026-11-02 00:10:00")]
        self.claude_file("c1", convo)
        self.touch_future()
        (s,) = self.scan("2026-11-01").sessions
        self.assertEqual(s.turns, 2)
        self.assertEqual(s.first.strftime("%H:%M %Z"), "00:30 PDT")
        self.assertEqual(s.last.strftime("%H:%M %Z"), "23:30 PST")

    def test_spring_forward_day_is_23_hours(self):
        start, end = ss.day_window("2026-03-08", ss.resolve_tz())
        self.assertEqual(end - start, timedelta(hours=23))


class DedupTests(Env):
    def test_exact_import_contributes_once(self):
        c = self.claude_file("c1", CONVO)
        x = self.codex_file("x1", CONVO)
        s = self.scan()
        self.assertEqual([t.transcript.path for t in s.sessions], [c])
        self.assertEqual(s.sessions[0].turns, 4)
        self.assertIn(x, s.sessions[0].transcript.also_in)
        self.assertEqual(s.duplicate_messages_today, 4)
        self.assertEqual(s.unresolved_today(), [])

    def test_import_millisecond_drift_still_exact(self):
        self.claude_file("c1", CONVO)
        self.codex_file("x1", CONVO, ts_override=lambda local: shift(utc(local), milliseconds=700))
        s = self.scan()
        self.assertEqual(len(s.sessions), 1)

    def test_import_plus_codex_continuation(self):
        self.claude_file("c1", CONVO)
        cont = [("user", "Now wire the streaming exporter into the nightly job runner.", "2026-10-08 13:00:00"),
                ("assistant", "Hooked it into nightly.py and verified with a dry run.", "2026-10-08 13:10:00")]
        x = self.codex_file("x1", CONVO + cont)
        p = self.by_provider(self.scan())
        self.assertEqual(p["claude"][0].turns, 4)
        (cx,) = p["codex"]
        self.assertEqual(cx.transcript.path, x)
        self.assertEqual(cx.turns, 2)
        self.assertEqual(cx.first.strftime("%H:%M"), "13:00")
        self.assertEqual(cx.duplicate_messages_today, 4)
        self.assertTrue(cx.transcript.duplicates_from)

    def test_import_written_today_with_historical_timestamps(self):
        old = [(r, t, l.replace("2026-10-08", "2026-09-15")) for r, t, l in CONVO]
        self.claude_file("c1", old)
        self.codex_file("x1", old)   # file written now (mtime today), messages dated Sep 15
        self.assertEqual(self.scan(DAY).sessions, [])
        hist = self.scan("2026-09-15")
        self.assertEqual(len(hist.sessions), 1)
        self.assertEqual(hist.sessions[0].transcript.provider, "claude")

    def test_disabling_claude_changes_codex_digest(self):
        self.claude_file("c1", CONVO)
        self.codex_file("x1", CONVO + [("user", "A new continuation turn added in Codex.", "2026-10-08 13:00:00")])
        both = {s.transcript.provider: s for s in self.scan().sessions}
        self.write_caps(claude=False, codex=True)
        (only,) = self.scan().sessions
        self.assertEqual((both["codex"].turns, only.turns), (1, 5))
        self.assertNotEqual(both["codex"].digest, only.digest)

    def test_codex_only_keeps_imported_history_on_original_dates(self):
        self.write_caps(claude=False, codex=True)
        old = [(r, t, l.replace("2026-10-08", "2026-09-15")) for r, t, l in CONVO]
        self.claude_file("c1", old)   # present on disk but disabled
        self.codex_file("x1", old)
        self.assertEqual(self.scan(DAY).sessions, [])
        (s,) = self.scan("2026-09-15").sessions
        self.assertEqual((s.transcript.provider, s.turns), ("codex", 4))

    def test_same_repo_distinct_sessions_not_merged(self):
        other = [("user", "Draft the migration that adds an index on invoices.customer_id.", "2026-10-08 10:00:00"),
                 ("assistant", "Wrote 0042_invoice_customer_idx.py with a concurrent index build.", "2026-10-08 10:04:00")]
        self.claude_file("c1", CONVO)
        self.claude_file("c2", other)
        s = self.scan()
        self.assertEqual(len(s.sessions), 2)
        self.assertEqual(s.duplicate_messages_today, 0)

    def test_repeated_short_prompt_not_merged_or_flagged(self):
        a = [("user", "Start on the reporting dashboard filters task now.", "2026-10-08 09:00:00"),
             ("user", "continue", "2026-10-08 09:10:00")]
        b = [("user", "Investigate why the webhook retries never back off.", "2026-10-08 14:00:00"),
             ("user", "continue", "2026-10-08 14:10:00")]
        self.claude_file("c1", a)
        self.codex_file("x1", b)
        s = self.scan()
        self.assertEqual(sorted(x.turns for x in s.sessions), [2, 2])
        self.assertEqual([o for o in s.overlaps if o.verdict != "none"], [])

    def test_fork_shared_history_once_both_branches_kept(self):
        shared = CONVO[:2]
        a = shared + [("user", "Branch A: switch the exporter output to parquet files.", "2026-10-08 10:00:00")]
        b = shared + [("user", "Branch B: keep CSV output but gzip-compress each chunk.", "2026-10-08 10:30:00")]
        uu = ["s0", "s1"]
        self.claude_file("fa", a, uuids=uu + ["a2"])
        self.claude_file("fb", b, uuids=uu + ["b2"])
        s = self.scan()
        turns = sorted(x.turns for x in s.sessions)
        self.assertEqual(turns, [1, 3])   # shared 2 + A's 1; B keeps only its own 1
        self.assertEqual(s.duplicate_messages_today, 2)

    def test_codex_fork_without_ids_uses_exact_timestamps(self):
        shared = CONVO[:2] + CONVO[2:3]
        self.codex_file("xa", shared + [("assistant", "Branch A finished: parquet writer added.", "2026-10-08 10:00:00")])
        self.codex_file("xb", shared + [("assistant", "Branch B finished: gzip chunks added.", "2026-10-08 10:30:00")])
        s = self.scan()
        self.assertEqual(sorted(x.turns for x in s.sessions), [1, 4])

    def test_archive_copy_one_history_full_provenance(self):
        a = self.codex_file("x1", CONVO, root="sessions")
        b = self.codex_file("x1", CONVO, root="archived_sessions")
        s = self.scan()
        (sess,) = s.sessions
        self.assertEqual({sess.transcript.path} | sess.transcript.also_in, {a, b})
        self.assertEqual(sess.turns, 4)

    def test_timestamp_rewritten_import_needs_strong_ordered_run(self):
        self.claude_file("c1", CONVO)
        rewritten = lambda local: shift(utc(local), hours=2)  # noqa: E731
        self.codex_file("x1", CONVO, ts_override=rewritten)
        s = self.scan()
        self.assertEqual(len(s.sessions), 1)
        (o,) = [o for o in s.overlaps if o.verdict == "confirmed"]
        self.assertEqual(o.tier, "content")

    def test_weak_timestamp_free_overlap_is_unresolved_not_merged(self):
        self.claude_file("c1", CONVO)
        self.codex_file("x1", CONVO[:2], ts_override=lambda local: shift(utc(local), hours=2))
        s = self.scan()
        p = self.by_provider(s)
        self.assertEqual(p["codex"][0].turns, 2)            # kept
        self.assertEqual(p["codex"][0].unresolved_messages_today, 2)
        self.assertEqual(len(s.unresolved_today()), 1)       # and reported

    def test_single_identical_message_same_second_is_reported_not_dropped(self):
        msg = "Your response above was cut off; please resend the final section in full."
        self.claude_file("w1", [("user", msg, "2026-10-08 09:00:00"), ("assistant", "Resent section one.", "2026-10-08 09:01:00")])
        self.claude_file("w2", [("user", msg, "2026-10-08 09:00:00"), ("assistant", "Resent section two.", "2026-10-08 09:02:00")])
        s = self.scan()
        self.assertEqual(sorted(x.turns for x in s.sessions), [2, 2])
        self.assertEqual(len(s.unresolved_today()), 1)


class ExclusionTests(Env):
    def test_worker_and_automation_excluded_logger_dev_kept(self):
        worker = [("user", "<time-logger-fanout-worker> Read the file /tmp/x and summarize it.", "2026-10-08 09:00:00"),
                  ("assistant", "Effort: light. Summary text here for the session.", "2026-10-08 09:01:00")]
        self.claude_file("w", worker)
        self.codex_file("xw", worker)
        auto = str((self.data / "app" / "dashboard").resolve())
        (self.data / "app" / "dashboard").mkdir(parents=True)
        self.codex_file("xa", CONVO, cwd=auto)
        self.claude_file("auto", CONVO, project=auto.replace("/", "-").replace(".", "-"))
        dev = self.claude_file("dev", CONVO[2:], cwd="/home/me/repos/time_logs", project="-home-me-repos-time-logs")
        s = self.scan()
        self.assertEqual([x.transcript.path for x in s.sessions], [dev])
        self.assertEqual((s.filtered_worker, s.filtered_automation), (2, 2))

    def test_background_notification_not_a_turn(self):
        convo = CONVO[:2] + [("user", "[SYSTEM NOTIFICATION - NOT USER INPUT] monitor fired", "2026-10-08 03:00:00"),
                             ("assistant", "Acknowledged the monitor notification.", "2026-10-08 03:00:05")]
        self.claude_file("c1", convo)
        (s,) = self.scan().sessions
        self.assertEqual((s.turns, s.first.strftime("%H:%M")), (2, "09:00"))


class CacheAndOutputTests(Env):
    def split(self, out):
        buf = io.StringIO()
        with redirect_stdout(buf):
            sc.run_split(self.scan(), str(out))
        return json.loads((Path(out) / "manifest.json").read_text())

    def record(self, manifest_dir, fresh):
        sf = self.tmp / "summaries.json"
        sf.write_text(json.dumps(fresh))
        with redirect_stdout(io.StringIO()):
            sc.record_cache(DAY, str(Path(manifest_dir) / "manifest.json"), str(sf))

    def test_unchanged_refresh_hits_cache_and_continuation_misses(self):
        self.claude_file("c1", CONVO)
        x = self.codex_file("x1", CONVO)
        m1 = self.split(self.tmp / "r1")
        self.assertEqual((m1["total_sessions"], m1["fresh_sessions"]), (1, 1))
        key = m1["sessions"][0]["cache_key"]
        self.record(self.tmp / "r1", {key: {"effort": "light", "summary": "Streamed the billing export."}})

        m2 = self.split(self.tmp / "r2")
        self.assertEqual((m2["cached_sessions"], m2["fresh_sessions"]), (1, 0))
        self.assertEqual(m2["sessions"][0]["digest"], m1["sessions"][0]["digest"])

        # Continue the imported session in Codex: Claude's block stays cached, Codex gets one new.
        cont = [("user", "Next, add a progress log line every ten thousand rows exported.", "2026-10-08 15:00:00")]
        self.codex_file("x1", CONVO + cont)
        m3 = self.split(self.tmp / "r3")
        fresh = [e for e in m3["sessions"] if not e["cached"]]
        self.assertEqual([e["file"] for e in fresh], [x])
        self.assertEqual(fresh[0]["turns"], 1)
        self.assertEqual(m3["cached_sessions"], 1)

    def test_legacy_path_keyed_cache_still_hits(self):
        c = self.claude_file("c1", CONVO)
        cache = self.data / "raw" / "claude" / ".cache"
        cache.mkdir(parents=True)
        (cache / f"{DAY}.json").write_text(json.dumps({"sessions": {c: {
            "turns": 4, "last_iso": "2026-10-08T09:07:00-07:00", "effort": "light", "summary": "old"}}}))
        m = self.split(self.tmp / "r")
        self.assertTrue(m["sessions"][0]["cached"])

    def test_toggling_provider_marks_stale_blocks(self):
        self.claude_file("c1", CONVO[:2])
        x = self.codex_file("x9", [("user", "Codex-only work on the deploy script retries.", "2026-10-08 16:00:00")])
        m1 = self.split(self.tmp / "r1")
        md = self.data / "raw" / "claude" / f"{DAY}.md"
        md.parent.mkdir(parents=True, exist_ok=True)
        blocks = "".join(f"## Session: r\n**File**: {e['file']}\n**Turns on this date**: {e['turns']}\n\nS.\n\n---\n\n"
                         for e in m1["sessions"])
        md.write_text("# Coding Agent Sessions — test\n\n" + blocks)
        self.write_caps(claude=True, codex=False)
        m2 = self.split(self.tmp / "r2")
        self.assertEqual([b["file"] for b in m2["stale_blocks"]], [x])
        self.assertIn("codex sessions disabled", m2["stale_blocks"][0]["reason"])
        # The unaffected Claude session keeps its digest, so a cached summary would stay valid.
        self.assertEqual(m2["sessions"][0]["digest"],
                         next(e["digest"] for e in m1["sessions"] if e["provider"] == "claude"))
        ops = self.tmp / "ops.json"
        ops.write_text(json.dumps({"operations": [{"type": "remove", "anchor_file": x}]}))
        sys.argv = ["apply", str(md), str(ops)]
        with redirect_stdout(io.StringIO()):
            apply_session_blocks.main()
        self.assertNotIn(x, md.read_text())
        self.assertEqual(md.read_text().count("## Session:"), 1)

    def test_import_appearing_later_marks_old_codex_block_stale(self):
        # Codex alone first, then Claude gets enabled: the Codex copy is now a duplicate.
        self.write_caps(claude=False, codex=True)
        self.claude_file("c1", CONVO)
        x = self.codex_file("x1", CONVO)
        m1 = self.split(self.tmp / "r1")
        md = self.data / "raw" / "claude" / f"{DAY}.md"
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(f"# h\n\n## Session: r\n**File**: {m1['sessions'][0]['file']}\n\nS.\n\n---\n")
        self.write_caps(claude=True, codex=True)
        m2 = self.split(self.tmp / "r2")
        self.assertEqual([b["file"] for b in m2["stale_blocks"]], [x])
        self.assertIn("duplicate of", m2["stale_blocks"][0]["reason"])

    def test_manifest_contract_fields(self):
        self.codex_file("x1", CONVO)
        m = self.split(self.tmp / "r")
        e = m["sessions"][0]
        for k in ("file", "repo", "turns", "first", "last", "last_iso", "cached", "excerpt_file",
                  "provider", "source", "cache_key", "digest"):
            self.assertIn(k, e)
        self.assertEqual(e["source"], "Codex")

    def test_record_cache_drops_sessions_not_in_manifest(self):
        self.claude_file("c1", CONVO)
        cache = self.data / "raw" / "claude" / ".cache"
        cache.mkdir(parents=True)
        (cache / f"{DAY}.json").write_text(json.dumps({"sessions": {"codex:gone:x": {"summary": "s"}}}))
        m = self.split(self.tmp / "r")
        self.record(self.tmp / "r", {m["sessions"][0]["cache_key"]: {"effort": "light", "summary": "s"}})
        saved = json.loads((cache / f"{DAY}.json").read_text())["sessions"]
        self.assertEqual(list(saved), [m["sessions"][0]["cache_key"]])


if __name__ == "__main__":
    unittest.main()
