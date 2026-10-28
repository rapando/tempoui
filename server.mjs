#!/usr/bin/env node
// Tempo UI server: serves the console and proxies /api/v1/* to a Temporal HTTP API.
// Auto mode finds the local Temporal server (dev server, Docker, or Web UI) and
// re-discovers it if it restarts on a new port. Custom mode targets any URL.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8299);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const PROBE_MS = 1200;
const APP_VERSION = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")).version;
const COMMON_PORTS = [7243, 8233, 8080, 8088];

// Current target. apiKey/headers never leave this process.
const conn = {
  mode: "auto", url: null, kind: null, version: null, apiKey: "", headers: {},
  ok: false, error: null, checkedAt: 0, csrf: null,
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function normUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) throw new Error("Enter a server URL.");
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  const u = new URL(s);
  let p = u.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return u.origin + p;
}

function authHeaders(t) {
  const h = { ...(t.headers || {}) };
  if (t.apiKey) h.authorization = "Bearer " + t.apiKey;
  return h;
}

async function timedFetch(url, opts = {}, ms = PROBE_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

// Probe a base URL. Resolves to {url, kind, version} or throws with a helpful message.
async function probe(base, t = {}) {
  const h = { accept: "application/json", ...authHeaders(t) };
  let res;
  try { res = await timedFetch(base + "/api/v1/system-info", { headers: h }); }
  catch (e) {
    const port = new URL(base).port;
    if (port === "7233") throw new Error("Port 7233 is Temporal's gRPC port. Use the HTTP API port (often 7243) or the Web UI port (8233).");
    throw new Error(e.name === "AbortError" ? "Timed out reaching " + base : "Can't reach " + base + " (" + (e.cause?.code || e.message) + ")");
  }
  if (res.status === 401 || res.status === 403) throw new Error("Server refused the request (" + res.status + "). Check the API key.");
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(base + " answered, but it isn't a Temporal HTTP API."); }
  if (!res.ok || !j.serverVersion) throw new Error(j.message || "Unexpected response from " + base);
  // The Temporal Web UI proxies the same API and exposes /api/v1/settings; the frontend doesn't.
  let kind = "frontend";
  try {
    const s = await timedFetch(base + "/api/v1/settings", { headers: h });
    if (s.ok) { const sj = await s.json().catch(() => null); if (sj && "Auth" in sj) kind = "webui"; }
  } catch {}
  return { url: base, kind, version: j.serverVersion };
}

function temporalPorts() {
  return new Promise(resolve => {
    execFile("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-c", "temporal"], { timeout: 2000 }, (err, out) => {
      if (err && !out) return resolve([]);
      const ports = new Set();
      for (const line of String(out).split("\n")) {
        const m = line.match(/(?:127\.0\.0\.1|localhost|\*|\[::1?\]):(\d+) \(LISTEN\)/);
        if (m && m[1] !== "7233") ports.add(Number(m[1]));
      }
      resolve([...ports]);
    });
  });
}

// Find local Temporal HTTP endpoints. A direct frontend beats the Web UI proxy.
async function discover() {
  const fromEnv = process.env.TEMPORAL_HTTP_URL ? [normUrl(process.env.TEMPORAL_HTTP_URL)] : [];
  const ports = [...new Set([...COMMON_PORTS, ...(await temporalPorts())])];
  const bases = [...fromEnv, ...ports.map(p => "http://127.0.0.1:" + p)];
  const found = (await Promise.allSettled(bases.map(b => probe(b)))).filter(r => r.status === "fulfilled").map(r => r.value);
  const rank = f => (fromEnv.includes(f.url) ? 0 : f.kind === "frontend" ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b));
}

async function autoConnect() {
  const found = await discover();
  conn.checkedAt = Date.now();
  if (conn.mode !== "auto") return found;
  if (found.length) {
    const f = found[0];
    if (f.url !== conn.url || !conn.ok) log("auto: connected to", f.url, `(${f.kind}, server ${f.version})`);
    Object.assign(conn, { url: f.url, kind: f.kind, version: f.version, ok: true, error: null, apiKey: "", headers: {}, csrf: null });
  } else {
    if (conn.ok || conn.error == null) log("auto: no local Temporal server found");
    Object.assign(conn, { ok: false, error: "No local Temporal server found. Start one with `temporal server start-dev`." });
  }
  return found;
}

let rediscovering = null;
const rediscover = () => (rediscovering ||= autoConnect().finally(() => { rediscovering = null; }));

// The Web UI requires a CSRF token cookie + header on mutations.
async function csrfFor(t) {
  if (t.kind !== "webui") return null;
  if (t.csrf) return t.csrf;
  const r = await timedFetch(t.url + "/api/v1/settings", { headers: authHeaders(t) });
  const m = (r.headers.getSetCookie?.() || []).join(";").match(/_csrf=([^;]+)/);
  return (t.csrf = m ? m[1] : null);
}

function publicConn() {
  return { appVersion: APP_VERSION, mode: conn.mode, url: conn.url, kind: conn.kind, version: conn.version, ok: conn.ok, error: conn.error,
    hasApiKey: !!conn.apiKey, headerNames: Object.keys(conn.headers || {}) };
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function proxy(req, res, url, body, retried = false) {
  if (!conn.url) {
    if (conn.mode === "auto" && !retried) { await rediscover(); return proxy(req, res, url, body, true); }
    return send(res, 503, { message: conn.error || "Not connected to a Temporal server." });
  }
  const t = conn;
  const headers = { accept: "application/json", ...authHeaders(t) };
  if (body.length) headers["content-type"] = "application/json";
  if (req.method !== "GET") {
    const tok = await csrfFor(t).catch(() => null);
    if (tok) { headers["x-csrf-token"] = tok; headers.cookie = "_csrf=" + tok; }
  }
  let r;
  try {
    r = await timedFetch(t.url + url.pathname + url.search, { method: req.method, headers, body: body.length ? body : undefined }, 15000);
  } catch (e) {
    conn.ok = false;
    conn.error = "Lost connection to " + t.url;
    if (conn.mode === "auto" && !retried) { await rediscover(); if (conn.ok) return proxy(req, res, url, body, true); }
    return send(res, 502, { message: conn.error });
  }
  if (!conn.ok) { conn.ok = true; conn.error = null; }
  const buf = Buffer.from(await r.arrayBuffer());
  send(res, r.status, buf, r.headers.get("content-type") || "application/json");
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

async function serveStatic(res, pathname) {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 404, "Not found", "text/plain");
  try { send(res, 200, await readFile(file), MIME[extname(file)] || "application/octet-stream"); }
  catch { send(res, 404, "Not found", "text/plain"); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const isApi = url.pathname.startsWith("/api/v1/") || url.pathname.startsWith("/_tempoui/");
    if (isApi) {
      // Block cross-site requests and DNS rebinding: require a local Host and our custom header
      // (a custom header forces a CORS preflight, which this server never approves).
      const host = String(req.headers.host || "").replace(/:\d+$/, "");
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host) && HOST === "127.0.0.1") return send(res, 403, { message: "Forbidden host" });
      if (req.headers["x-tempoui"] !== "1") return send(res, 403, { message: "Missing X-TempoUI header" });
    }
    if (url.pathname === "/_tempoui/connection" && req.method === "GET") {
      if (conn.mode === "auto" && !conn.ok && Date.now() - conn.checkedAt > 3000) await rediscover();
      return send(res, 200, publicConn());
    }
    if (url.pathname === "/_tempoui/discover" && req.method === "GET") {
      return send(res, 200, { found: await discover() });
    }
    if (url.pathname === "/_tempoui/test" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      try { return send(res, 200, { ok: true, ...(await probe(normUrl(b.url), { apiKey: b.apiKey, headers: b.headers })) }); }
      catch (e) { return send(res, 200, { ok: false, error: e.message }); }
    }
    if (url.pathname === "/_tempoui/connect" && req.method === "POST") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      if (b.mode === "auto") {
        conn.mode = "auto"; conn.url = null; conn.ok = false; conn.error = null;
        await autoConnect();
        return send(res, 200, publicConn());
      }
      let base;
      try { base = normUrl(b.url); } catch (e) { return send(res, 400, { message: e.message }); }
      // Reuse the stored key when reconnecting to the same server without re-entering it.
      const apiKey = b.apiKey != null ? String(b.apiKey) : (base === conn.url ? conn.apiKey : "");
      const headers = b.headers && typeof b.headers === "object" ? b.headers : {};
      try {
        const p = await probe(base, { apiKey, headers });
        Object.assign(conn, { mode: "custom", url: p.url, kind: p.kind, version: p.version, apiKey, headers, ok: true, error: null, csrf: null });
        log("custom: connected to", p.url, `(${p.kind}, server ${p.version})`);
        return send(res, 200, publicConn());
      } catch (e) { return send(res, 400, { message: e.message }); }
    }
    if (url.pathname.startsWith("/api/v1/")) return proxy(req, res, url, await readBody(req));
    if (req.method === "GET") return serveStatic(res, url.pathname);
    send(res, 405, { message: "Method not allowed" });
  } catch (e) {
    send(res, 500, { message: e.message });
  }
});

// Keep auto mode honest: if the local server goes away or moves ports, find it again.
setInterval(() => {
  if (conn.mode !== "auto") return;
  if (!conn.ok) return rediscover();
  probe(conn.url).catch(() => { conn.ok = false; rediscover(); });
}, 10000).unref();

server.listen(PORT, HOST, async () => {
  log(`Tempo UI v${APP_VERSION} on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  if (process.env.TEMPORAL_HTTP_URL && process.env.TEMPORAL_AUTO !== "1") {
    try {
      const p = await probe(normUrl(process.env.TEMPORAL_HTTP_URL), { apiKey: process.env.TEMPORAL_API_KEY || "" });
      Object.assign(conn, { mode: "custom", ...p, apiKey: process.env.TEMPORAL_API_KEY || "", ok: true });
      return log("custom: connected to", p.url);
    } catch (e) { log("TEMPORAL_HTTP_URL unreachable:", e.message, "- falling back to auto"); }
  }
  await autoConnect();
});
