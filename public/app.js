"use strict";
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = n => String(n).padStart(2, "0");
const store = {
  get(k, d) { try { const v = localStorage.getItem("tempoui:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tempoui:" + k, JSON.stringify(v)); } catch {} },
};

function fmtDur(ms) {
  if (ms < 1000) return Math.max(0, Math.round(ms)) + " ms";
  const s = ms / 1000; if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m " + pad(Math.round(s % 60)) + "s";
  const h = Math.floor(m / 60); if (h < 48) return h + "h " + pad(m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}
function rel(ms, now) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 10) return "just now"; if (s < 60) return Math.floor(s) + "s ago"; if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago";
}
const clock = ms => { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); };
const parseDur = s => { const m = /^(-?[\d.]+)s$/.exec(String(s || "")); return m ? Number(m[1]) : 0; };
const ts = v => (v ? Date.parse(v) : null);
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 2800); }
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || "GET",
    headers: { "x-tempoui": "1", ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : {}; } catch { j = { message: text }; }
  if (!r.ok) { const e = new Error((j && j.message) || r.status + " " + r.statusText); e.status = r.status; throw e; }
  return j;
}
const nsPath = p => "/api/v1/namespaces/" + encodeURIComponent(S.ns) + p;
const qs = o => Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

// Payloads arrive either in shorthand (plain JSON) or as {metadata:{encoding}, data:base64}.
function b64(s) { try { return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))); } catch { return null; } }
function decodePayload(p) {
  if (!p || typeof p !== "object" || !("metadata" in p) || typeof p.metadata !== "object") return p;
  const enc = b64(p.metadata.encoding || "") || "";
  if (enc === "binary/null") return null;
  if (p.data == null) return null;
  const raw = b64(p.data);
  if (/^json\//.test(enc)) { try { return JSON.parse(raw); } catch { return raw; } }
  if (enc === "binary/plain" || !enc) return raw;
  return { encoding: enc, data: p.data };
}
const decodePayloads = ps => { const arr = (ps && ps.payloads) || (Array.isArray(ps) ? ps : null); if (!arr) return undefined; const d = arr.map(decodePayload); return d.length === 1 ? d[0] : d; };
// Recursively decode any payload-shaped objects (event attributes, memo, heartbeat details).
function deepDecode(v) {
  if (Array.isArray(v)) return v.map(deepDecode);
  if (!v || typeof v !== "object") return v;
  if ("metadata" in v && "data" in v && typeof v.metadata === "object" && v.metadata.encoding) return decodePayload(v);
  if (Array.isArray(v.payloads) && Object.keys(v).length === 1) return decodePayloads(v);
  const o = {}; for (const k in v) o[k] = deepDecode(v[k]); return o;
}

/* ---------- status ---------- */
const ORDER = ["Running", "Failed", "TimedOut", "Completed", "Canceled", "Terminated", "ContinuedAsNew"];
const ST = { Running: ["st-run", "Running"], Completed: ["st-ok", "Completed"], Failed: ["st-fail", "Failed"], TimedOut: ["st-to", "Timed out"], Canceled: ["st-cancel", "Canceled"], Terminated: ["st-term", "Terminated"], ContinuedAsNew: ["st-can", "Continued"] };
const VAR = { Running: "--s-run", Completed: "--s-ok", Failed: "--s-fail", TimedOut: "--s-to", Canceled: "--s-cancel", Terminated: "--s-term", ContinuedAsNew: "--s-can" };
function normStatus(s) {
  s = String(s || "").replace(/^WORKFLOW_EXECUTION_STATUS_/, "").replace(/[^A-Za-z]/g, "").toLowerCase();
  return ({ running: "Running", completed: "Completed", failed: "Failed", timedout: "TimedOut", canceled: "Canceled", cancelled: "Canceled", terminated: "Terminated", continuedasnew: "ContinuedAsNew" })[s] || "Running";
}
const pill = st => '<span class="pill ' + ST[st][0] + '">' + ST[st][1] + "</span>";

/* ---------- state ---------- */
const S = {
  conn: null, connKey: null, ns: null, namespaces: [],
  execs: [], next: null, loading: false, listErr: null, counts: null, countsExact: true,
  seenTypes: new Set(), seenQueues: new Set(),
  sel: null, detail: null, detailErr: null, detailLoading: false,
  status: null, q: "", type: "", queue: "", tab: "timeline", hist: "all",
  view: "workflows", live: store.get("live", true),
  schedules: null, schedErr: null, queues: {}, tqExtra: new Set(),
};
const keyOf = w => w.runId + " " + w.id;
const sel = () => S.execs.find(w => keyOf(w) === S.sel) || (S.detail && keyOf(S.detail.w) === S.sel ? S.detail.w : null);

function fromList(e) {
  const st = normStatus(e.status);
  return {
    id: e.execution.workflowId, runId: e.execution.runId, type: (e.type && e.type.name) || "Unknown",
    queue: e.taskQueue || "", status: st, startMs: ts(e.startTime) || Date.now(),
    closeMs: st === "Running" ? null : ts(e.closeTime), historyLength: Number(e.historyLength || 0), raw: e,
  };
}
const durOf = w => fmtDur((w.closeMs || Date.now()) - w.startMs);

/* ---------- query building ---------- */
const qv = s => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const isRawQuery = q => /[=<>]|\b(STARTS_WITH|BETWEEN|IS\s+(NOT\s+)?NULL|IN\s*\(|ORDER\s+BY)\b/i.test(q);
function buildQuery(withStatus) {
  const parts = [], q = S.q.trim();
  if (S.type) parts.push('WorkflowType="' + qv(S.type) + '"');
  if (S.queue) parts.push('TaskQueue="' + qv(S.queue) + '"');
  if (q) parts.push(isRawQuery(q) ? "(" + q + ")" : '(WorkflowId STARTS_WITH "' + qv(q) + '" OR WorkflowType STARTS_WITH "' + qv(q) + '")');
  if (withStatus && S.status) parts.push('ExecutionStatus="' + S.status + '"');
  return parts.join(" AND ");
}

/* ---------- data loading ---------- */
let listSeq = 0;
async function loadList(append) {
  if (!S.ns || !S.conn || !S.conn.ok) return;
  const seq = ++listSeq; S.loading = true;
  if (!append) renderList();
  try {
    const query = buildQuery(true);
    const [list, counts] = await Promise.all([
      api(nsPath("/workflows?" + qs({ pageSize: 100, query, nextPageToken: append ? S.next : "" }))),
      append ? Promise.resolve(null) : loadCounts(),
    ]);
    if (seq !== listSeq) return;
    const rows = (list.executions || []).map(fromList);
    rows.forEach(w => { S.seenTypes.add(w.type); if (w.queue) S.seenQueues.add(w.queue); });
    S.execs = append ? S.execs.concat(rows) : rows;
    S.next = list.nextPageToken || null;
    S.listErr = null;
    if (!append) { S.counts = counts; }
    $("#q").classList.remove("bad");
  } catch (e) {
    if (seq !== listSeq) return;
    S.listErr = e.message;
    if (S.q.trim() && e.status === 400) $("#q").classList.add("bad");
  } finally {
    if (seq === listSeq) { S.loading = false; renderFilters(); renderBand(); renderList(); }
  }
}
async function loadCounts() {
  const base = buildQuery(false);
  try {
    const r = await api(nsPath("/workflow-count?" + qs({ query: (base ? base + " " : "") + "GROUP BY ExecutionStatus" })));
    const c = {}; ORDER.forEach(k => { c[k] = 0; });
    (r.groups || []).forEach(g => { const v = decodePayload((g.groupValues || [])[0]); c[normStatus(v)] = Number(g.count || 0); });
    S.countsExact = true;
    return c;
  } catch {
    try {
      const r = await api(nsPath("/workflow-count?" + qs({ query: base })));
      S.countsExact = false; return { __total: Number(r.count || 0) };
    } catch { S.countsExact = false; return null; }
  }
}

async function fetchHistory(w) {
  let events = [], token = "";
  for (let i = 0; i < 50; i++) {
    const r = await api(nsPath("/workflows/" + encodeURIComponent(w.id) + "/history?" + qs({ "execution.runId": w.runId, maximumPageSize: 1000, nextPageToken: token })));
    events = events.concat((r.history && r.history.events) || []);
    token = r.nextPageToken; if (!token) break;
  }
  return events;
}
let detailSeq = 0;
async function loadDetail(quiet) {
  const w = sel(); if (!w) return;
  const seq = ++detailSeq, key = keyOf(w);
  if (!quiet) { S.detailLoading = true; S.detailErr = null; if (!S.detail || keyOf(S.detail.w) !== key) S.detail = null; renderDock(); }
  try {
    const [desc, events] = await Promise.all([
      api(nsPath("/workflows/" + encodeURIComponent(w.id) + "?" + qs({ "execution.runId": w.runId }))),
      fetchHistory(w),
    ]);
    if (seq !== detailSeq || S.sel !== key) return;
    const info = desc.workflowExecutionInfo || {};
    // Keep the list row in sync with the freshest status.
    if (info.status) { w.status = normStatus(info.status); w.closeMs = w.status === "Running" ? null : ts(info.closeTime); w.historyLength = Number(info.historyLength || events.length); }
    S.detail = { w, desc, ...buildFromHistory(events, w) };
    S.detailErr = null;
  } catch (e) {
    if (seq !== detailSeq) return;
    S.detailErr = e.message;
  } finally {
    if (seq === detailSeq) { S.detailLoading = false; if (quiet) { renderList(); renderPane(); renderDockHead(); } else { renderList(); renderDock(); } }
  }
}

/* ---------- history → timeline ---------- */
const evName = t => String(t || "").replace(/^EVENT_TYPE_/, "").toLowerCase().replace(/(^|_)([a-z])/g, (_, a, b) => b.toUpperCase());
const attrsOf = e => { for (const k in e) if (k.endsWith("EventAttributes")) return e[k]; return {}; };
function catOf(t) {
  if (/^Activity/.test(t)) return "act";
  if (/^Timer/.test(t)) return "timer";
  if (/Signal/.test(t)) return "sig";
  if (/^WorkflowTask/.test(t)) return "wft";
  if (/Child|ExternalWorkflow/.test(t)) return "child";
  if (/Update/.test(t)) return "upd";
  return "wf";
}
function failMsg(f) { if (!f) return ""; let m = f.message || ""; let c = f.cause, n = 0; while (c && n++ < 4) { if (c.message && c.message !== m) m += " ← " + c.message; c = c.cause; } return m; }

function failType(f) {
  for (let c = f, n = 0; c && n < 6; c = c.cause, n++) { const ai = c.applicationFailureInfo; if (ai && ai.type) return ai.type; if (c.timeoutFailureInfo) return "Timeout"; }
  return (f && f.source) || "Failure";
}
function buildFromHistory(raw, w) {
  if (!raw.length) return { events: [], steps: [], t0: w.startMs, endT: 0, input: undefined, result: undefined, failure: null };
  const t0 = ts(raw[0].eventTime) || w.startMs;
  const relT = e => Math.max(0, ((ts(e.eventTime) || t0) - t0) / 1000);
  const steps = [], byId = {}, timers = {}, events = [];
  let input, result, failure = null, endT = null;
  for (const e of raw) {
    const type = evName(e.eventType), a = attrsOf(e), t = relT(e), id = Number(e.eventId), cat = catOf(type);
    let sum = "";
    switch (type) {
      case "WorkflowExecutionStarted": sum = (a.workflowType && a.workflowType.name) || ""; input = decodePayloads(a.input); break;
      case "ActivityTaskScheduled": {
        const s = { kind: "activity", n: (a.activityType && a.activityType.name) || "activity", start: t, st: "run", attempts: 1, waiting: true };
        byId[id] = s; steps.push(s); sum = s.n; break;
      }
      case "ActivityTaskStarted": { const s = byId[a.scheduledEventId]; if (s) { s.attempts = Number(a.attempt || 1); s.waiting = false; if (a.lastFailure) s.err = failMsg(a.lastFailure); sum = s.n + (s.attempts > 1 ? " · attempt " + s.attempts : ""); } break; }
      case "ActivityTaskCompleted": { const s = byId[a.scheduledEventId]; if (s) { s.st = "ok"; s.dur = t - s.start; sum = s.n; } break; }
      case "ActivityTaskFailed": { const s = byId[a.scheduledEventId]; if (s) { s.st = "fail"; s.dur = t - s.start; s.err = failMsg(a.failure); sum = s.n + " · " + s.err; } break; }
      case "ActivityTaskTimedOut": { const s = byId[a.scheduledEventId]; if (s) { s.st = "to"; s.dur = t - s.start; s.err = failMsg(a.failure); sum = s.n + " · " + (s.err || "timed out"); } break; }
      case "ActivityTaskCanceled": { const s = byId[a.scheduledEventId]; if (s) { s.st = "cancel"; s.dur = t - s.start; sum = s.n; } break; }
      case "TimerStarted": {
        const plan = parseDur(a.startToFireTimeout);
        const s = { kind: "timer", n: (e.userMetadata && decodePayload(e.userMetadata.summary)) || "timer " + a.timerId, start: t, plan, st: "run" };
        if (typeof s.n !== "string") s.n = "timer " + a.timerId;
        timers[a.timerId] = s; steps.push(s); sum = s.n + " · " + fmtDur(plan * 1000); break;
      }
      case "TimerFired": { const s = timers[a.timerId]; if (s) { s.st = "ok"; s.dur = t - s.start; sum = s.n; } break; }
      case "TimerCanceled": { const s = timers[a.timerId]; if (s) { s.st = "cancel"; s.dur = t - s.start; sum = s.n; } break; }
      case "WorkflowExecutionSignaled": steps.push({ kind: "signal", n: a.signalName, start: t, dur: 0, st: "ok" }); sum = a.signalName; break;
      case "WorkflowExecutionUpdateAccepted": { const n = a.acceptedRequest && a.acceptedRequest.input && a.acceptedRequest.input.name; steps.push({ kind: "signal", n: "update " + (n || ""), start: t, dur: 0, st: "ok" }); sum = n || ""; break; }
      case "StartChildWorkflowExecutionInitiated": {
        const s = { kind: "child", n: (a.workflowType && a.workflowType.name) || "child", start: t, st: "run", attempts: 1, wid: a.workflowId };
        byId[id] = s; steps.push(s); sum = s.n + " · " + (a.workflowId || ""); break;
      }
      case "ChildWorkflowExecutionCompleted": case "ChildWorkflowExecutionFailed": case "ChildWorkflowExecutionTimedOut":
      case "ChildWorkflowExecutionCanceled": case "ChildWorkflowExecutionTerminated": case "StartChildWorkflowExecutionFailed": {
        const s = byId[a.initiatedEventId]; if (s) {
          s.dur = t - s.start;
          s.st = /Completed/.test(type) ? "ok" : /TimedOut/.test(type) ? "to" : /Canceled|Terminated/.test(type) ? "cancel" : "fail";
          if (a.failure) s.err = failMsg(a.failure); sum = s.n + (s.err ? " · " + s.err : "");
        } break;
      }
      case "ChildWorkflowExecutionStarted": { const s = byId[a.initiatedEventId]; if (s) sum = s.n; break; }
      case "MarkerRecorded": sum = a.markerName || ""; break;
      case "WorkflowExecutionCompleted": endT = t; result = decodePayloads(a.result); break;
      case "WorkflowExecutionFailed": endT = t; failure = { message: failMsg(a.failure), type: failType(a.failure), stack: a.failure && a.failure.stackTrace, raw: a.failure }; sum = failure.message; break;
      case "WorkflowExecutionTimedOut": endT = t; failure = { message: "Workflow execution timed out", type: "TimeoutError" }; break;
      case "WorkflowExecutionCanceled": endT = t; break;
      case "WorkflowExecutionTerminated": endT = t; sum = a.reason || ""; failure = a.reason ? { message: a.reason, type: "Terminated" + (a.identity ? " by " + a.identity : "") } : null; break;
      case "WorkflowExecutionContinuedAsNew": endT = t; sum = a.newExecutionRunId ? "→ " + a.newExecutionRunId : ""; break;
      case "WorkflowExecutionCancelRequested": sum = a.cause || a.identity || ""; break;
    }
    events.push({ id, t, type, cat, sum, data: deepDecode(a) });
  }
  if (endT == null && w.status !== "Running") endT = events.length ? events[events.length - 1].t : 0;
  return { events, steps, t0, endT, input, result, failure };
}

/* ---------- rendering: workflows ---------- */
function fillSelect(el, label, vals, cur) {
  el.innerHTML = '<option value="">' + label + "</option>" + vals.map(v => "<option" + (v === cur ? " selected" : "") + ">" + esc(v) + "</option>").join("");
}
function renderFilters() {
  fillSelect($("#fType"), "All workflow types", [...S.seenTypes].sort(), S.type);
  fillSelect($("#fQueue"), "All task queues", [...S.seenQueues].sort(), S.queue);
}
function renderBand() {
  let cnt = S.counts, approx = false;
  if (!cnt || cnt.__total != null) {
    // No grouped counts from this server: fall back to what's loaded.
    approx = true; cnt = {}; ORDER.forEach(k => { cnt[k] = 0; });
    if (!S.status) S.execs.forEach(w => { cnt[w.status]++; });
  }
  const total = ORDER.reduce((n, k) => n + (cnt[k] || 0), 0);
  const on = ORDER.filter(k => cnt[k] || S.status === k);
  $("#dist").innerHTML = on.filter(k => cnt[k]).map(k => '<i data-st="' + k + '" style="flex:' + cnt[k] + ";--c:var(" + VAR[k] + ')" title="' + ST[k][1] + ": " + cnt[k] + '"></i>').join("");
  const allN = S.counts && S.counts.__total != null ? S.counts.__total : total;
  $("#legend").innerHTML = '<button data-st="" aria-pressed="' + !S.status + '"><b>' + allN.toLocaleString() + "</b> All</button>" +
    on.map(k => '<button data-st="' + k + '" style="--c:var(' + VAR[k] + ')" aria-pressed="' + (S.status === k) + '"><b>' + (approx && S.status ? "" : (cnt[k] || 0).toLocaleString()) + "</b> " + ST[k][1] + "</button>").join("") +
    (!S.status && approx && S.execs.length ? '<span class="chip">' + (S.next ? "counts from loaded rows" : "") + "</span>" : "") +
    (S.loading ? '<span class="chip">loading…</span>' : "");
}
function notConnectedHTML() {
  const c = S.conn;
  return '<div class="none"><b>' + (c && c.mode === "custom" ? "Can't reach " + esc(c.url) : "No Temporal server connected") + "</b>" +
    "<span>" + esc((c && c.error) || "Looking for a local Temporal server…") + "</span>" +
    (c && c.mode === "custom" ? "" : "<span>Start one with <code>temporal server start-dev</code> and this page connects on its own.</span>") +
    '<button class="btn" data-act="openconn">Connect to a server</button></div>';
}
function renderList() {
  const el = $("#strips"), now = Date.now();
  if (!S.conn || !S.conn.ok) { el.innerHTML = notConnectedHTML(); return; }
  if (S.listErr) { el.innerHTML = '<div class="none"><b>Couldn\'t list workflows</b><span class="err">' + esc(S.listErr) + "</span>" + (S.q.trim() ? "<span>Check the search. Plain text matches the start of a workflow ID or type; anything with = or an operator is sent as a visibility query.</span>" : "") + "</div>"; return; }
  if (!S.execs.length) { el.innerHTML = S.loading ? '<div class="none">Loading…</div>' : '<div class="none"><b>No workflow executions' + (buildQuery(true) ? " match these filters" : " in " + esc(S.ns)) + "</b>" + (buildQuery(true) ? "" : "<span>Start a workflow and it shows up here within a few seconds.</span>") + "</div>"; return; }
  el.innerHTML = S.execs.map(w => {
    const k = keyOf(w);
    return '<button class="strip" role="option" aria-selected="' + (k === S.sel) + '" data-k="' + esc(k) + '">' +
      '<div class="main"><div class="t"><strong>' + esc(w.type) + "</strong>" + pill(w.status) + '</div><div class="sub"><span>' + esc(w.id) + "</span><span>" + esc(w.queue) + "</span></div></div>" +
      '<div class="meta"><span title="' + esc(new Date(w.startMs).toLocaleString()) + '">' + rel(w.startMs, now) + "</span><span>" + durOf(w) + (w.status === "Running" ? " so far" : "") + "</span><span>" + (w.historyLength ? w.historyLength + " events" : "") + "</span></div></button>";
  }).join("") + (S.next ? '<div class="more"><button class="btn" data-act="more"' + (S.loading ? " disabled" : "") + ">Load more</button></div>" : "");
}

/* ---------- rendering: dock ---------- */
const STEPVAR = { ok: "--s-ok", fail: "--s-fail", to: "--s-to", run: "--s-run", cancel: "--s-cancel" };
const stepColor = s => s.kind === "signal" ? "var(--s-can)" : s.kind === "timer" && s.st !== "cancel" ? "var(--ink-3)" : "var(" + STEPVAR[s.st] + ")";
function evColor(e) {
  const t = e.type;
  if (/Failed/.test(t)) return "var(--s-fail)"; if (/TimedOut/.test(t)) return "var(--s-to)";
  if (/Cancel/.test(t)) return "var(--s-cancel)"; if (/Terminated/.test(t)) return "var(--s-term)";
  if (e.cat === "wft") return "var(--ink-3)"; if (e.cat === "timer" || e.cat === "sig" || e.cat === "upd" || /ContinuedAsNew/.test(t)) return "var(--s-can)";
  if (/Completed/.test(t)) return "var(--s-ok)"; return "var(--s-run)";
}
const MAX_LANES = 200;
function tlHTML(d) {
  const w = d.w;
  if (!d.steps.length) return '<div class="empty">' + (w.status === "Running" ? "This execution has not scheduled any activities, timers or child workflows yet." : "This execution ran without activities, timers or child workflows. The event history has the details.") + "</div>";
  const now = Date.now(), run = w.status === "Running", el = run ? Math.max(0, (now - d.t0) / 1000) : null;
  let max = run ? el : d.endT || 0;
  d.steps.forEach(s => { max = Math.max(max, s.start + (s.dur || 0)); if (s.st === "run" && s.kind === "timer") max = Math.max(max, s.start + s.plan); });
  max = Math.max(1, max) * 1.03;
  const L = x => (x / max * 100).toFixed(2) + "%", W = x => Math.max(.4, x / max * 100).toFixed(2) + "%", F = x => "calc(var(--lab) + (100% - var(--lab)) * " + (x / max).toFixed(4) + ")";
  const ticks = [0, 1, 2, 3].map(i => '<div class="tick" style="left:' + i * 25 + '%">' + (i ? fmtDur(max * i / 4 * 1000) : "0s") + "</div>").join("");
  const bar = s => {
    const c = stepColor(s);
    if (s.kind === "signal") return '<div class="seg dot" style="left:' + L(s.start) + ";--c:" + c + '" title="' + esc(s.n) + " at +" + fmtDur(s.start * 1000) + '"></div>';
    if (s.kind === "timer") {
      const dd = s.st === "run" ? Math.max(0, el - s.start) : s.dur;
      return (s.st === "run" ? '<div class="seg wait tm" style="left:' + L(s.start) + ";width:" + W(s.plan) + ";--c:" + c + '"></div>' : "") + '<div class="seg tm" style="left:' + L(s.start) + ";width:" + W(dd) + ";--c:" + c + '" title="' + esc(s.n) + " · " + fmtDur(s.plan * 1000) + '"></div>';
    }
    const dd = s.st === "run" ? Math.max(0, el - s.start) : s.dur;
    return '<div class="seg' + (s.st === "run" ? (s.waiting ? " wait" : " run") : "") + '" style="left:' + L(s.start) + ";width:" + W(dd) + ";--c:" + c + '" title="' + esc(s.n) + " · " + fmtDur(dd * 1000) + (s.attempts > 1 ? " · " + s.attempts + " attempts" : "") + (s.waiting ? " · scheduled, not started" : "") + (s.err ? " · " + esc(s.err) : "") + '"></div>';
  };
  const lane = (lab, body, t) => '<div class="lane"><div class="lab" title="' + esc(t || "") + '">' + lab + '</div><div class="track">' + body + "</div></div>";
  const shown = d.steps.slice(0, MAX_LANES);
  const rows = lane("<b>workflow</b>", '<div class="seg' + (run ? " run" : "") + '" style="left:0;width:' + W(run ? el : d.endT) + ";--c:var(" + VAR[w.status] + ')"></div>', w.type) +
    shown.map(s => lane(esc(s.kind === "child" ? "↳ " + s.n : s.n) + (s.attempts > 1 ? " <small>×" + s.attempts + "</small>" : ""), bar(s), s.n + (s.wid ? " (" + s.wid + ")" : ""))).join("");
  const gl = [.25, .5, .75].map(f => '<div style="position:absolute;top:0;bottom:0;left:' + F(max * f) + ';border-left:1px solid var(--line);opacity:.5"></div>').join("");
  return '<div class="tl"><div class="mono" style="font-size:12px;color:var(--ink-2);margin-bottom:10px">Started ' + clock(d.t0) + " · " + (run ? "running " : "ran ") + durOf(w) + "</div>" +
    '<div class="axis">' + ticks + '</div><div style="position:relative">' + gl + rows + (run ? '<div class="now" style="left:' + F(el) + '" title="now"></div>' : "") + "</div>" +
    (d.steps.length > MAX_LANES ? '<div class="tlnote">Showing the first ' + MAX_LANES + " of " + d.steps.length + " steps.</div>" : "") +
    '<div class="key"><span style="--c:var(--s-ok)">Completed</span><span style="--c:var(--s-fail)">Failed</span><span style="--c:var(--s-to)">Timed out</span><span style="--c:var(--s-run)">In flight</span><span style="--c:var(--s-cancel)">Canceled</span><span style="--c:var(--ink-3)">Timer</span><span style="--c:var(--s-can)">Signal / update</span></div></div>';
}
const HF = [["all", "All"], ["act", "Activities"], ["timer", "Timers"], ["sig", "Signals"], ["child", "Children"], ["wft", "Workflow tasks"], ["wf", "Workflow"]];
function histHTML(d) {
  if (!d.events.length) return '<div class="empty">No events.</div>';
  const chips = '<div class="hf">' + HF.filter(f => f[0] === "all" || d.events.some(e => e.cat === f[0])).map(f => '<button data-h="' + f[0] + '" aria-pressed="' + (S.hist === f[0]) + '">' + f[1] + "</button>").join("") + "</div>";
  return chips + d.events.map((e, i) => S.hist === "all" || e.cat === S.hist ? '<button class="ev" data-i="' + i + '" style="--c:' + evColor(e) + '"><span class="n">' + e.id + '</span><span class="d">+' + (e.t < 10 ? e.t.toFixed(2) : e.t < 1000 ? e.t.toFixed(1) : fmtDur(e.t * 1000)) + (e.t < 1000 ? "s" : "") + '</span><span><span class="k">' + e.type + "</span>" + (e.sum ? ' <span class="s">' + esc(e.sum) + "</span>" : "") + "</span></button>" : "").join("");
}
const json = o => esc(JSON.stringify(o === undefined ? null : o, null, 2));
function payHTML(d) {
  const w = d.w, info = d.desc.workflowExecutionInfo || {}, cfg = d.desc.executionConfig || {};
  const kv = [["Workflow ID", w.id], ["Run ID", w.runId], ["Type", w.type], ["Task queue", w.queue], ["Started", new Date(w.startMs).toLocaleString()],
    ["Closed", w.closeMs ? new Date(w.closeMs).toLocaleString() : "still running"], ["Duration", durOf(w)], ["History", (w.historyLength || d.events.length) + " events"]];
  if (info.parentExecution) kv.push(["Parent", info.parentExecution.workflowId]);
  if (cfg.workflowExecutionTimeout) kv.push(["Execution timeout", cfg.workflowExecutionTimeout]);
  if (cfg.workflowRunTimeout) kv.push(["Run timeout", cfg.workflowRunTimeout]);
  const cp = k => '<button class="btn" data-act="copyjson" data-k="' + k + '">Copy</button>';
  let h = '<div class="pay"><section><h3>Execution</h3><dl class="kv">' + kv.map(r => "<dt>" + r[0] + "</dt><dd>" + esc(r[1]) + "</dd>").join("") + "</dl></section>";
  h += "<section><h3>Input " + cp("input") + "</h3><pre>" + json(d.input) + "</pre></section>";
  if (d.failure) h += '<section><h3>Failure</h3><div class="fail"><b>' + esc(d.failure.type) + "</b><br>" + esc(d.failure.message) + (d.failure.stack ? "\n\n" + esc(d.failure.stack) : "") + "</div></section>";
  if (d.result !== undefined) h += "<section><h3>Result " + cp("result") + "</h3><pre>" + json(d.result) + "</pre></section>";
  const memo = info.memo && info.memo.fields ? deepDecode(info.memo.fields) : null;
  if (memo && Object.keys(memo).length) h += "<section><h3>Memo</h3><pre>" + json(memo) + "</pre></section>";
  const sa = info.searchAttributes && info.searchAttributes.indexedFields ? deepDecode(info.searchAttributes.indexedFields) : null;
  if (sa && Object.keys(sa).length) h += "<section><h3>Search attributes</h3><pre>" + json(sa) + "</pre></section>";
  return h + "</div>";
}
function pendHTML(d) {
  const acts = d.desc.pendingActivities || [], kids = d.desc.pendingChildren || [], wft = d.desc.pendingWorkflowTask;
  const timers = d.steps.filter(s => s.kind === "timer" && s.st === "run");
  if (!acts.length && !kids.length && !timers.length && !wft) return '<div class="empty">' + (d.w.status === "Running" ? "Nothing is pending right now. The workflow is waiting on a signal, update or condition." : "Closed executions have no pending work.") + "</div>";
  const now = Date.now();
  const row = (k, v) => v == null || v === "" ? "" : "<dt>" + k + "</dt><dd>" + esc(v) + "</dd>";
  let h = '<div class="pay">';
  for (const p of acts) {
    const det = p.heartbeatDetails ? deepDecode(p.heartbeatDetails) : null;
    h += "<section><h3>Activity · " + esc((p.activityType && p.activityType.name) || p.activityId) + '</h3><dl class="kv">' +
      row("State", String(p.state || "").replace(/^PENDING_ACTIVITY_STATE_/, "").toLowerCase()) +
      row("Attempt", (p.attempt || 1) + (p.maximumAttempts && p.maximumAttempts !== 0 ? " of " + p.maximumAttempts : " (unlimited retries)")) +
      row("Activity ID", p.activityId) +
      row("Running for", p.lastStartedTime ? fmtDur(now - ts(p.lastStartedTime)) : null) +
      row("Scheduled", p.scheduledTime ? new Date(ts(p.scheduledTime)).toLocaleString() : null) +
      row("Last heartbeat", p.lastHeartbeatTime ? rel(ts(p.lastHeartbeatTime), now) : null) +
      row("Worker", p.lastWorkerIdentity) +
      row("Next attempt", p.nextAttemptScheduleTime ? "in " + fmtDur(Math.max(0, ts(p.nextAttemptScheduleTime) - now)) : null) +
      (p.lastFailure ? "<dt>Last failure</dt><dd><span style=\"color:var(--s-fail)\">" + esc(failMsg(p.lastFailure)) + "</span></dd>" : "") +
      "</dl>" + (det ? "<pre style=\"margin-top:8px\">" + json(det) + "</pre>" : "") + "</section>";
  }
  for (const c of kids) h += "<section><h3>Child workflow · " + esc(c.workflowTypeName || c.workflowId) + '</h3><dl class="kv">' + row("Workflow ID", c.workflowId) + row("Run ID", c.runId) + "</dl></section>";
  for (const t of timers) { const fires = d.t0 + (t.start + t.plan) * 1000; h += "<section><h3>Timer · " + esc(t.n) + '</h3><dl class="kv">' + row("Fires", clock(fires) + " (in " + fmtDur(Math.max(0, fires - now)) + ")") + "</dl></section>"; }
  if (wft) h += '<section><h3>Workflow task</h3><dl class="kv">' + row("State", String(wft.state || "").replace(/^PENDING_WORKFLOW_TASK_STATE_/, "").toLowerCase()) + row("Attempt", wft.attempt) + row("Scheduled", wft.scheduledTime ? rel(ts(wft.scheduledTime), now) : null) + "</dl></section>";
  return h + "</div>";
}
function pendCount(d) { return d ? (d.desc.pendingActivities || []).length + (d.desc.pendingChildren || []).length + d.steps.filter(s => s.kind === "timer" && s.st === "run").length : 0; }
function renderPane() {
  const p = $("#pane"), d = S.detail; if (!p) return;
  $$("#dock .tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === S.tab));
  if (S.detailErr) { p.innerHTML = '<div class="empty"><span class="err">' + esc(S.detailErr) + "</span></div>"; return; }
  if (!d) { p.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const top = p.scrollTop, open = $$(".evj", p).map(x => x.previousElementSibling && x.previousElementSibling.dataset.i);
  p.innerHTML = S.tab === "timeline" ? tlHTML(d) : S.tab === "history" ? histHTML(d) : S.tab === "payloads" ? payHTML(d) : pendHTML(d);
  if (S.tab === "history") open.forEach(i => { const ev = $('.ev[data-i="' + i + '"]', p); if (ev) ev.insertAdjacentHTML("afterend", '<div class="evj"><pre>' + json(d.events[+i].data) + "</pre></div>"); });
  p.scrollTop = top;
}
function dockHeadHTML(w) {
  const d = S.detail && keyOf(S.detail.w) === keyOf(w) ? S.detail : null, run = w.status === "Running", pc = pendCount(d);
  return '<button class="btn back" data-act="back">← Executions</button><h2>' + esc(w.type) + "</h2><div>" + pill(w.status) + "</div>" +
    '<div class="ids"><span>' + esc(w.id) + "</span><span>run " + esc(w.runId) + "</span><span>" + esc(w.queue) + "</span></div>" +
    '<div class="acts"><button class="btn" data-act="copy" data-v="' + esc(w.id) + '">Copy ID</button><button class="btn" data-act="copy" data-v="' + esc(w.runId) + '">Copy run ID</button>' +
    '<button class="btn" data-act="cancel"' + (run ? "" : " disabled") + '>Request cancel</button><button class="btn danger" data-act="terminate"' + (run ? "" : " disabled") + ">Terminate</button></div>" +
    "\u0000" + '<button role="tab" data-tab="timeline">Timeline</button><button role="tab" data-tab="history">History' + (d ? " (" + d.events.length + ")" : "") + '</button><button role="tab" data-tab="payloads">Payloads</button><button role="tab" data-tab="pending">Pending' + (pc ? " (" + pc + ")" : "") + "</button>";
}
function renderDockHead() {
  const w = sel(), h = $("#dock .dock-h"), t = $("#dock .tabs"); if (!w || !h || !t) return;
  const [head, tabs] = dockHeadHTML(w).split("\u0000");
  h.innerHTML = head; t.innerHTML = tabs;
  $$("#dock .tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === S.tab));
}
function renderDock() {
  const dk = $("#dock"), w = sel(); dk.classList.toggle("closed", !w);
  if (!w) { dk.innerHTML = '<div class="empty">' + (S.conn && S.conn.ok ? "Select an execution to see its timeline, event history and payloads." : "") + "</div>"; return; }
  const [head, tabs] = dockHeadHTML(w).split("\u0000");
  dk.innerHTML = '<div class="dock-h">' + head + '</div><div class="tabs" role="tablist">' + tabs + '</div><div class="pane" id="pane"></div>';
  renderPane();
}

/* ---------- schedules ---------- */
function specText(sp) {
  if (!sp) return "";
  const out = [];
  (sp.interval || []).forEach(i => out.push("every " + fmtDur(parseDur(i.interval) * 1000).replace(/ 00?[ms]$/, "").replace(/ 0h$/, "")));
  (sp.cronString || []).forEach(c => out.push(c));
  (sp.calendar || []).forEach(c => out.push(c.comment || [c.second, c.minute, c.hour, c.dayOfMonth, c.month, c.dayOfWeek].map(x => x || "*").join(" ")));
  if (!out.length && sp.structuredCalendar && sp.structuredCalendar.length) out.push(sp.structuredCalendar.length + " calendar rule" + (sp.structuredCalendar.length > 1 ? "s" : ""));
  return out.join(" · ") + (sp.timezoneName ? "  (" + sp.timezoneName + ")" : "");
}
async function loadSchedules() {
  if (!S.ns || !S.conn || !S.conn.ok) { renderSchedules(); return; }
  try {
    const r = await api(nsPath("/schedules?" + qs({ maximumPageSize: 200 })));
    S.schedules = r.schedules || []; S.schedErr = null;
  } catch (e) { S.schedErr = e.message; }
  renderSchedules();
}
function renderSchedules() {
  const g = $("#schedGrid"), now = Date.now();
  if (!S.conn || !S.conn.ok) { g.innerHTML = '<div style="grid-column:1/-1">' + notConnectedHTML() + "</div>"; return; }
  if (S.schedErr) { g.innerHTML = '<div class="none" style="grid-column:1/-1"><b>Couldn\'t list schedules</b><span class="err">' + esc(S.schedErr) + "</span></div>"; return; }
  if (!S.schedules) { g.innerHTML = '<div class="none" style="grid-column:1/-1">Loading…</div>'; return; }
  if (!S.schedules.length) { g.innerHTML = '<div class="none" style="grid-column:1/-1"><b>No schedules in ' + esc(S.ns) + "</b><span>Create one with <code>temporal schedule create</code>.</span></div>"; return; }
  g.innerHTML = S.schedules.map(s => {
    const i = s.info || {}, last = (i.recentActions || []).slice(-1)[0], next = (i.futureActionTimes || [])[0];
    return '<div class="card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h3 class="mono">' + esc(s.scheduleId) + "</h3>" + (i.paused ? '<span class="chip">paused</span>' : "") + "</div>" +
      '<div class="mono" style="font-size:12px;color:var(--ink-2)">' + esc(specText(i.spec) || "no spec") + " → " + esc((i.workflowType && i.workflowType.name) || "?") + "</div>" +
      '<div class="mono" style="font-size:12px">' + (i.paused ? "not scheduled" + (i.notes ? " · " + esc(i.notes) : "") : next ? "next in " + fmtDur(Math.max(0, ts(next) - now)) + " · " + clock(ts(next)) : "no upcoming runs") + "</div>" +
      '<div class="mono" style="font-size:12px;color:var(--ink-3)">' + (last ? "last run " + rel(ts(last.actualTime || last.scheduleTime), now) + (last.startWorkflowResult ? " · " + esc(last.startWorkflowResult.workflowId) : "") : "never run") + "</div>" +
      '<div class="acts"><button class="btn" data-sched="' + esc(s.scheduleId) + '" data-op="' + (i.paused ? "unpause" : "pause") + '">' + (i.paused ? "Unpause" : "Pause") + '</button><button class="btn" data-sched="' + esc(s.scheduleId) + '" data-op="trigger">Run now</button><button class="btn" data-sched="' + esc(s.scheduleId) + '" data-op="runs">View runs</button></div></div>';
  }).join("");
}
async function schedOp(id, op) {
  if (op === "runs") { S.q = 'TemporalScheduledById="' + qv(id) + '"'; $("#q").value = S.q; S.status = null; setView("workflows"); loadList(); return; }
  const patch = op === "pause" ? { pause: "Paused from Tempo Deck" } : op === "unpause" ? { unpause: "Unpaused from Tempo Deck" } : { triggerImmediately: {} };
  try {
    await api(nsPath("/schedules/" + encodeURIComponent(id) + "/patch"), { method: "POST", body: { namespace: S.ns, scheduleId: id, patch, identity: "tempo-deck", requestId: uuid() } });
    toast(op === "trigger" ? "Triggered " + id : (op === "pause" ? "Paused " : "Unpaused ") + id);
    setTimeout(loadSchedules, op === "trigger" ? 800 : 0);
  } catch (e) { toast("Failed: " + e.message); }
}

/* ---------- task queues ---------- */
async function describeTQ(name) {
  const one = type => api(nsPath("/task-queues/" + encodeURIComponent(name) + "?" + qs({ "taskQueue.kind": "TASK_QUEUE_KIND_NORMAL", taskQueueType: type }))).then(r => r.pollers || [], e => { throw e; });
  try {
    const [wf, act] = await Promise.all([one("TASK_QUEUE_TYPE_WORKFLOW"), one("TASK_QUEUE_TYPE_ACTIVITY")]);
    S.queues[name] = { wf, act, err: null, at: Date.now() };
  } catch (e) { S.queues[name] = { wf: [], act: [], err: e.message, at: Date.now() }; }
}
async function loadQueues() {
  if (!S.ns || !S.conn || !S.conn.ok) { renderQueues(); return; }
  const names = [...new Set([...S.seenQueues, ...S.tqExtra])];
  await Promise.all(names.map(describeTQ));
  renderQueues();
}
function renderQueues() {
  const el = $("#queueTbl"), now = Date.now();
  if (!S.conn || !S.conn.ok) { el.innerHTML = notConnectedHTML(); return; }
  const names = [...new Set([...S.seenQueues, ...S.tqExtra])].sort();
  if (!names.length) { el.innerHTML = '<div class="none"><b>No task queues seen yet</b><span>Task queues appear once workflows use them. You can also look one up by name above.</span></div>'; return; }
  const m = {}; names.forEach(n => { m[n] = { run: 0, ok: 0, bad: 0 }; });
  S.execs.forEach(w => { const q = m[w.queue]; if (!q) return; if (w.status === "Running") q.run++; else if (w.status === "Failed" || w.status === "TimedOut") q.bad++; else q.ok++; });
  const lastPoll = ps => ps.reduce((mx, p) => Math.max(mx, ts(p.lastAccessTime) || 0), 0);
  el.innerHTML = '<table><thead><tr><th>Task queue</th><th class="n">Workflow pollers</th><th class="n">Activity pollers</th><th>Last poll</th><th class="n">Running</th><th class="n">Closed ok</th><th class="n">Failed</th></tr></thead><tbody>' +
    names.map(n => {
      const d = S.queues[n], r = m[n];
      const lp = d ? Math.max(lastPoll(d.wf), lastPoll(d.act)) : 0, stale = lp && now - lp > 75000;
      const ids = d ? [...new Set(d.wf.concat(d.act).map(p => p.identity).filter(Boolean))] : [];
      return '<tr><td class="mono">' + esc(n) + (ids.length ? "<small>" + esc(ids.join(", ")) + "</small>" : "") + (d && d.err ? '<small class="err">' + esc(d.err) + "</small>" : "") + "</td>" +
        '<td class="n">' + (d ? d.wf.length : "…") + '</td><td class="n">' + (d ? d.act.length : "…") + "</td>" +
        "<td>" + (!d ? "…" : !lp ? '<span class="pill st-fail">no workers</span>' : stale ? '<span class="pill st-to">' + rel(lp, now) + "</span>" : rel(lp, now)) + "</td>" +
        '<td class="n">' + r.run + '</td><td class="n">' + r.ok + '</td><td class="n" style="' + (r.bad ? "color:var(--s-fail)" : "") + '">' + r.bad + "</td></tr>";
    }).join("") + "</tbody></table>";
}

/* ---------- connection ---------- */
function connLabel(c) {
  if (!c) return "Connecting…";
  if (!c.url) return c.mode === "auto" ? "local · not found" : "not connected";
  let host = c.url; try { host = new URL(c.url).host; } catch {}
  return (c.mode === "auto" ? "local · " : "") + host + (c.version ? " · v" + c.version : "");
}
function renderConn() {
  const c = S.conn;
  $("#connDot").className = "dot " + (!c ? "wait" : c.ok ? "ok" : "bad");
  $("#connText").textContent = connLabel(c);
  $("#btnConn").title = c && c.error ? c.error : c && c.url ? "Connected to " + c.url : "Connection";
  const now = $("#connNow");
  if (!c) { now.innerHTML = ""; return; }
  now.innerHTML = '<span class="dot ' + (c.ok ? "ok" : "bad") + '"></span><div>' +
    (c.url ? "<b>" + esc(c.url) + "</b><br>" : "") +
    (c.ok ? (c.mode === "auto" ? "Auto-detected local server" : "Custom server") + " · " + (c.kind === "webui" ? "via Temporal Web UI" : "Temporal HTTP API") + (c.version ? " · server " + esc(c.version) : "") + (c.hasApiKey ? " · API key set" : "")
      : esc(c.error || "Not connected")) + "</div>";
}
async function refreshConn() {
  try { S.conn = await api("/_tempoui/connection"); }
  catch (e) { S.conn = { ok: false, error: "Tempo Deck server isn't responding: " + e.message }; }
  if (S.conn.appVersion) $("#appVer").textContent = "v" + S.conn.appVersion;
  renderConn();
  const key = S.conn.ok ? S.conn.url : null;
  if (key !== S.connKey) {
    S.connKey = key;
    if (key) await onConnected(); else { renderAll(); }
  }
}
async function onConnected() {
  try {
    const r = await api("/api/v1/namespaces?pageSize=200");
    S.namespaces = (r.namespaces || []).map(n => n.namespaceInfo.name).filter(n => n !== "temporal-system").sort();
  } catch { S.namespaces = []; }
  const saved = store.get("ns:" + S.conn.url, null);
  S.ns = S.namespaces.includes(saved) ? saved : S.namespaces.includes("default") ? "default" : S.namespaces[0] || "default";
  const sel = $("#nsSel");
  sel.innerHTML = (S.namespaces.length ? S.namespaces : [S.ns]).map(n => "<option" + (n === S.ns ? " selected" : "") + ">" + esc(n) + "</option>").join("");
  resetData();
  const recent = store.get("recent", []);
  if (S.conn.mode === "custom" && !recent.includes(S.conn.url)) store.set("recent", [S.conn.url, ...recent].slice(0, 6));
  await refreshView();
}
function resetData() {
  S.execs = []; S.next = null; S.counts = null; S.sel = null; S.detail = null; S.listErr = null;
  S.seenTypes = new Set(); S.seenQueues = new Set(); S.schedules = null; S.queues = {};
  if (S.type || S.queue) { S.type = ""; S.queue = ""; }
  renderAll();
}
async function scan() {
  const f = $("#connFound"); f.innerHTML = '<span class="muted">Scanning…</span>';
  try {
    const r = await api("/_tempoui/discover");
    f.innerHTML = r.found.length ? r.found.map(x => '<button data-url="' + esc(x.url) + '" title="Connect to this one only">' + esc(new URL(x.url).host) + " · " + (x.kind === "webui" ? "Web UI" : "HTTP API") + " · v" + esc(x.version) + "</button>").join("")
      : '<span class="muted">No local Temporal server found. Run temporal server start-dev.</span>';
  } catch (e) { f.innerHTML = '<span class="muted">' + esc(e.message) + "</span>"; }
}
function openConn() {
  $("#connErr").hidden = true; $("#connOk").hidden = true;
  const c = S.conn;
  if (c && c.mode === "custom" && c.url) $("#cUrl").value = c.url;
  $("#cKey").value = "";
  $("#cKey").placeholder = c && c.hasApiKey ? "(unchanged)" : "";
  const recent = store.get("recent", []);
  $("#connRecent").innerHTML = recent.map(u => '<button data-fill="' + esc(u) + '">' + esc(u) + "</button>").join("");
  renderConn();
  $("#connModal").hidden = false;
  scan();
}
async function connectTo(url, apiKey) {
  const err = $("#connErr"), ok = $("#connOk"); err.hidden = true; ok.hidden = true;
  const body = { mode: "custom", url };
  if (apiKey) body.apiKey = apiKey; else if (!(S.conn && S.conn.url === url && S.conn.hasApiKey)) body.apiKey = "";
  $("#connGo").disabled = true;
  try {
    S.conn = await api("/_tempoui/connect", { method: "POST", body });
    renderConn(); $("#connModal").hidden = true; toast("Connected to " + S.conn.url);
    S.connKey = null; await refreshConn();
  } catch (e) { err.textContent = e.message; err.hidden = false; }
  finally { $("#connGo").disabled = false; }
}

/* ---------- views + refresh ---------- */
function renderAll() { renderConn(); renderFilters(); renderBand(); renderList(); renderDock(); renderSchedules(); renderQueues(); }
function setView(v) {
  if (!["workflows", "schedules", "queues"].includes(v)) v = "workflows";
  const changed = S.view !== v; S.view = v;
  ["workflows", "schedules", "queues"].forEach(k => { $("#v-" + k).hidden = k !== v; });
  $$("#nav button").forEach(b => { if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  if (changed) refreshView();
}
async function refreshView(quiet) {
  if (!S.conn || !S.conn.ok) return renderAll();
  if (S.view === "workflows") {
    // Don't clobber a list the user paged through; still refresh the open execution.
    if (!quiet || !S.next || S.execs.length <= 100) await loadList();
    const w = sel(); if (w && (!quiet || w.status === "Running" || (S.detail && S.detail.w.status !== w.status))) await loadDetail(quiet);
  } else if (S.view === "schedules") await loadSchedules();
  else { if (!S.seenQueues.size) await loadList(); await loadQueues(); }
}
let tickBusy = false;
setInterval(async () => {
  if (tickBusy || document.hidden) return; tickBusy = true;
  try {
    await refreshConn();
    if (S.live && S.conn && S.conn.ok && $("#connModal").hidden && $("#confirmModal").hidden) await refreshView(true);
  } finally { tickBusy = false; }
}, 5000);
// Keep "so far" durations and timelines of running work moving between fetches.
setInterval(() => {
  if (document.hidden || S.view !== "workflows") return;
  if (S.execs.some(w => w.status === "Running")) renderList();
  const w = sel(); if (w && w.status === "Running" && S.tab === "timeline" && S.detail) renderPane();
}, 1000);

/* ---------- confirm (cancel / terminate) ---------- */
let pendingAct = null;
function confirmAct(kind, w) {
  pendingAct = { kind, w };
  $("#cfT").textContent = kind === "cancel" ? "Request cancellation?" : "Terminate this workflow?";
  $("#cfP").innerHTML = (kind === "cancel" ? "The workflow receives a cancellation request and can clean up before it closes. " : "The workflow stops immediately. No cleanup code runs. ") + "<br><span class=\"mono\">" + esc(w.id) + "</span>";
  $("#cfGo").textContent = kind === "cancel" ? "Request cancel" : "Terminate";
  $("#cfReason").value = ""; $("#cfErr").hidden = true;
  $("#confirmModal").hidden = false; $("#cfReason").focus();
}
async function runAct() {
  const { kind, w } = pendingAct || {}; if (!w) return;
  const reason = $("#cfReason").value.trim() || (kind === "cancel" ? "Canceled from Tempo Deck" : "Terminated from Tempo Deck");
  $("#cfGo").disabled = true;
  try {
    await api(nsPath("/workflows/" + encodeURIComponent(w.id) + "/" + kind), { method: "POST", body: { namespace: S.ns, workflowExecution: { workflowId: w.id, runId: w.runId }, reason, identity: "tempo-deck", ...(kind === "cancel" ? { requestId: uuid() } : {}) } });
    $("#confirmModal").hidden = true;
    toast(kind === "cancel" ? "Cancellation requested" : "Terminated");
    setTimeout(() => { loadList(); loadDetail(true); }, 400);
  } catch (e) { $("#cfErr").textContent = e.message; $("#cfErr").hidden = false; }
  finally { $("#cfGo").disabled = false; }
}

/* ---------- events ---------- */
$("#nav").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; setView(b.dataset.view); try { history.replaceState(null, "", "#" + b.dataset.view); } catch {} });
addEventListener("hashchange", () => setView(location.hash.slice(1)));
let qTimer;
$("#q").addEventListener("input", e => { S.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(() => loadList(), 350); });
$("#fType").addEventListener("change", e => { S.type = e.target.value; loadList(); });
$("#fQueue").addEventListener("change", e => { S.queue = e.target.value; loadList(); });
function statusClick(e) { const b = e.target.closest("[data-st]"); if (!b) return; const v = b.dataset.st; S.status = (!v || S.status === v) ? null : v; renderBand(); loadList(); }
$("#dist").addEventListener("click", statusClick); $("#legend").addEventListener("click", statusClick);
document.addEventListener("click", e => { if (e.target.closest('[data-act="openconn"]')) openConn(); });
$("#strips").addEventListener("click", e => {
  if (e.target.closest('[data-act="more"]')) { loadList(true); return; }
  const b = e.target.closest(".strip"); if (!b) return;
  if (S.sel === b.dataset.k) return;
  S.sel = b.dataset.k; S.detail = null; S.hist = "all";
  renderList(); loadDetail();
  const f = $('.strip[aria-selected="true"]'); if (f && matchMedia("(min-width:901px)").matches) f.focus({ preventScroll: true });
});
$("#strips").addEventListener("keydown", e => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const all = $$(".strip"), i = all.indexOf(document.activeElement); if (i < 0) return;
  e.preventDefault(); const n = all[i + (e.key === "ArrowDown" ? 1 : -1)]; if (n) { n.focus(); n.click(); }
});
$("#dock").addEventListener("click", e => {
  const w = sel(); if (!w) return;
  const tab = e.target.closest("[data-tab]"); if (tab) { S.tab = tab.dataset.tab; $("#pane").scrollTop = 0; renderPane(); return; }
  const h = e.target.closest("[data-h]"); if (h) { S.hist = h.dataset.h; renderPane(); return; }
  const ev = e.target.closest(".ev");
  if (ev) { const nx = ev.nextElementSibling; if (nx && nx.classList.contains("evj")) nx.remove(); else ev.insertAdjacentHTML("afterend", '<div class="evj"><pre>' + json(S.detail.events[+ev.dataset.i].data) + "</pre></div>"); return; }
  const a = e.target.closest("[data-act]"); if (!a) return; const act = a.dataset.act;
  if (act === "back") { S.sel = null; S.detail = null; renderList(); renderDock(); }
  else if (act === "cancel" || act === "terminate") confirmAct(act, w);
  else {
    const txt = act === "copy" ? a.dataset.v : JSON.stringify(S.detail && S.detail[a.dataset.k], null, 2);
    try { navigator.clipboard.writeText(txt).then(() => toast("Copied"), () => toast("Copy is blocked here. Select the text instead.")); } catch { toast("Copy is blocked here. Select the text instead."); }
  }
});
$("#schedGrid").addEventListener("click", e => { const b = e.target.closest("[data-sched]"); if (b) schedOp(b.dataset.sched, b.dataset.op); });
$("#tqLookup").addEventListener("keydown", async e => {
  if (e.key !== "Enter") return; const n = e.target.value.trim(); if (!n) return;
  S.tqExtra.add(n); e.target.value = ""; renderQueues(); await describeTQ(n); renderQueues();
});
$("#nsSel").addEventListener("change", e => { S.ns = e.target.value; if (S.conn && S.conn.url) store.set("ns:" + S.conn.url, S.ns); resetData(); refreshView(); });
$("#btnLive").addEventListener("click", () => { S.live = !S.live; store.set("live", S.live); $("#btnLive").setAttribute("aria-pressed", S.live); if (S.live) refreshView(true); });
$("#btnConn").addEventListener("click", openConn);
$("#connClose").addEventListener("click", () => { $("#connModal").hidden = true; });
$("#connModal").addEventListener("click", e => {
  if (e.target.id === "connModal") { $("#connModal").hidden = true; return; }
  const f = e.target.closest("[data-fill]"); if (f) { $("#cUrl").value = f.dataset.fill; $("#cUrl").focus(); return; }
  const u = e.target.closest("[data-url]"); if (u) connectTo(u.dataset.url);
});
$("#connScan").addEventListener("click", scan);
$("#connAuto").addEventListener("click", async () => {
  try { S.conn = await api("/_tempoui/connect", { method: "POST", body: { mode: "auto" } }); }
  catch (e) { toast(e.message); return; }
  renderConn(); $("#connModal").hidden = true;
  toast(S.conn.ok ? "Connected to local server " + S.conn.url : "No local server found yet. Tempo Deck keeps looking.");
  S.connKey = null; await refreshConn();
});
$("#connTest").addEventListener("click", async () => {
  const err = $("#connErr"), ok = $("#connOk"); err.hidden = true; ok.hidden = true;
  try {
    const r = await api("/_tempoui/test", { method: "POST", body: { url: $("#cUrl").value, apiKey: $("#cKey").value } });
    if (r.ok) { ok.textContent = "Reachable · " + (r.kind === "webui" ? "Temporal Web UI" : "Temporal HTTP API") + " · server " + r.version; ok.hidden = false; }
    else { err.textContent = r.error; err.hidden = false; }
  } catch (e) { err.textContent = e.message; err.hidden = false; }
});
$("#connGo").addEventListener("click", () => connectTo($("#cUrl").value, $("#cKey").value));
$("#cUrl").addEventListener("keydown", e => { if (e.key === "Enter") connectTo($("#cUrl").value, $("#cKey").value); });
$("#cfCancel").addEventListener("click", () => { $("#confirmModal").hidden = true; });
$("#cfGo").addEventListener("click", runAct);
$("#cfReason").addEventListener("keydown", e => { if (e.key === "Enter") runAct(); });
$("#confirmModal").addEventListener("click", e => { if (e.target.id === "confirmModal") $("#confirmModal").hidden = true; });
addEventListener("keydown", e => { if (e.key === "Escape") { $("#connModal").hidden = true; $("#confirmModal").hidden = true; } });

/* ---------- start ---------- */
$("#btnLive").setAttribute("aria-pressed", S.live);
setView(location.hash.slice(1));
renderAll();
refreshConn();
