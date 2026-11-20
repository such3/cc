'use strict';
/**
 * Global traffic manager + control plane (stands in for Route 53 / Azure Traffic Manager).
 *
 *  - Probes every region's /health on an interval
 *  - Hysteresis: N consecutive failures => unhealthy, M consecutive passes => healthy again
 *  - Routes /gw/* to the active region. Like DNS failover it does NOT retry: requests sent
 *    during the detection window really fail, so the outage is measurable.
 *  - Control API (/control/*) injects faults using the Docker socket (real `docker kill`),
 *    falling back to a software fault if the socket is not mounted.
 *  - /events streams state + log lines to the dashboard over Server-Sent Events.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 80;
const REGIONS = {
  primary: { id: 'primary', name: process.env.PRIMARY_NAME || 'us-east-1', role: 'Primary', url: process.env.PRIMARY_URL || 'http://primary:80', container: process.env.PRIMARY_CONTAINER || 'dr_primary' },
  secondary: { id: 'secondary', name: process.env.SECONDARY_NAME || 'us-west-2', role: 'Secondary', url: process.env.SECONDARY_URL || 'http://secondary:80', container: process.env.SECONDARY_CONTAINER || 'dr_secondary' },
};
const IDS = ['primary', 'secondary'];
const cfg = { probeInterval: 1000, probeTimeout: 800, failThreshold: 3, recoverThreshold: 3, autoFailback: true, replDelay: 1500, failoverDelay: 0, strategy: 'warm' };

const st = {};
IDS.forEach((id) => (st[id] = { checked: false, healthy: false, fails: 0, oks: 0, latency: null, info: null, syncing: false, fault: null, lastOkAt: null, lastPending: 0, unhealthySince: null }));
let active = 'none';
let booted = false;
let incident = null;
const acked = new Map(); // order id -> region that acknowledged the write (for exact RPO)
let metrics = freshMetrics();
const events = [];
const clients = new Set();

function freshMetrics() {
  return { total: 0, ok: 0, failovers: 0, lastDetect: null, lastRTO: null, lastFailback: null, lostWrites: null, lastFailed: null };
}
const nm = (id) => REGIONS[id].name;
const secs = (ms) => (ms / 1000).toFixed(1) + 's';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));

// ------------------------------------------------------------------ events / state
function emit(ev, data) {
  const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((c) => c.write(msg));
}
function log(level, msg) {
  const e = { t: Date.now(), level, msg };
  events.push(e);
  if (events.length > 150) events.shift();
  emit('log', e);
  console.log(`[${level}] ${msg}`);
}
function snapshot() {
  const p = st.primary;
  let phase = 'booting';
  if (booted) {
    if (active === 'none') phase = 'outage';
    else if (active === 'primary') phase = p.fault || !p.healthy || p.fails > 0 ? 'disaster' : 'normal';
    else phase = p.healthy || p.oks > 0 ? 'recovery' : 'failover';
  }
  const regions = {};
  IDS.forEach((id) => {
    const s = st[id];
    regions[id] = {
      id, name: nm(id), role: REGIONS[id].role, checked: s.checked, healthy: s.healthy, fails: s.fails, oks: s.oks,
      latency: s.latency, syncing: s.syncing, fault: s.fault,
      info: s.info ? { records: s.info.records, pending: s.info.pending, uptimeSec: s.info.uptimeSec } : null,
    };
  });
  return {
    now: Date.now(), cfg, active, phase, regions,
    failbackReady: active === 'secondary' && p.healthy && !cfg.autoFailback,
    metrics: { ...metrics, failed: incident ? incident.failedReqs : metrics.lastFailed },
  };
}
const push = () => emit('state', snapshot());

// ------------------------------------------------------------------ incident tracking
function openIncident(faultAt) {
  incident = { faultAt, lostWrites: st.primary.lastPending || 0, failedReqs: 0, failoverAt: null, recoveredAt: null, restoreAt: null };
}
function closeIncident() {
  if (incident) metrics.lastFailed = incident.failedReqs;
  incident = null;
}

// ------------------------------------------------------------------ health checks
async function probe(id) {
  const s = st[id];
  const t0 = Date.now();
  let ok = false;
  let info = null;
  try {
    const r = await fetch(REGIONS[id].url + '/health', { signal: AbortSignal.timeout(cfg.probeTimeout) });
    info = await r.json().catch(() => null);
    ok = r.ok;
    s.latency = Date.now() - t0;
  } catch {
    s.latency = null;
  }
  s.info = info && info.records !== undefined ? info : null;
  s.syncing = !!(info && info.status === 'syncing');
  if (ok && info) s.lastPending = info.pending || 0;
  if (ok) s.lastOkAt = Date.now();

  if (!s.checked) { // first verdict is taken at face value
    s.checked = true;
    s.healthy = ok;
    s.fails = ok ? 0 : 1;
    s.oks = ok ? 1 : 0;
    log(ok ? 'ok' : 'warn', `${nm(id)} is ${ok ? 'healthy' : 'not answering yet'}`);
    return;
  }
  if (ok) {
    s.oks++;
    s.fails = 0;
    if (!s.healthy && s.oks >= cfg.recoverThreshold) {
      s.healthy = true;
      s.unhealthySince = null;
      log('ok', `${nm(id)} passed ${s.oks} health checks in a row - marked healthy`);
      admin(id, '/admin/config', { replDelay: cfg.replDelay }).catch(() => {});
    }
  } else {
    if (s.syncing) log('info', `${nm(id)} is up but still syncing data - not ready for traffic`);
    s.fails++;
    s.oks = 0;
    if (s.healthy) {
      if (id === 'primary' && active === 'primary' && !incident) openIncident(s.lastOkAt || Date.now());
      if (s.fails >= cfg.failThreshold) {
        s.healthy = false;
        s.unhealthySince = Date.now();
        log('error', `${nm(id)} failed ${s.fails} health checks in a row - marked unhealthy`);
        if (id === 'primary' && cfg.failoverDelay > 0) log('warn', `Standby needs ${secs(cfg.failoverDelay)} to warm up before it can take traffic`);
      } else {
        log('warn', `Health check failed for ${nm(id)} (${s.fails}/${cfg.failThreshold})`);
      }
    }
  }
}

function route() {
  const p = st.primary, s = st.secondary, prev = active;
  let next = prev;
  if (prev === 'primary') {
    if (!p.healthy) {
      if (!s.healthy) next = 'none';
      else if (Date.now() - (p.unhealthySince || 0) >= cfg.failoverDelay) next = 'secondary'; // standby warm-up time
    }
  }
  else if (prev === 'secondary') {
    if (!s.healthy) next = p.healthy ? 'primary' : 'none';
    else if (p.healthy && cfg.autoFailback) next = 'primary';
  } else next = p.healthy ? 'primary' : s.healthy ? 'secondary' : 'none';
  if (next !== prev) switchTo(next, prev);
  if (incident && !incident.failoverAt && active === 'primary' && !p.fault && p.fails === 0 && p.healthy) closeIncident();
}

function switchTo(next, prev) {
  const now = Date.now();
  active = next;
  if (next === 'none') return log('error', 'No healthy region left - total outage');
  if (prev === 'none') return log('ok', `Routing traffic to ${nm(next)}`);
  if (next === 'secondary') {
    if (!incident) openIncident(st.primary.lastOkAt || now);
    incident.failoverAt = now;
    metrics.failovers++;
    metrics.lastDetect = now - incident.faultAt;
    metrics.lastRTO = metrics.lastDetect;
    log('error', `FAILOVER: routing switched ${nm('primary')} to ${nm('secondary')} (detected after ${secs(metrics.lastDetect)})`);
    computeLostWrites(incident.lostWrites);
  } else {
    metrics.lastFailback = incident && incident.restoreAt ? now - incident.restoreAt : null;
    log('ok', `FAILBACK: traffic returned to ${nm('primary')}`);
    closeIncident();
  }
}

// Exact RPO: orders the primary acknowledged to users that the secondary never received.
async function computeLostWrites(fallback) {
  let lost = fallback;
  try {
    const r = await fetch(REGIONS.secondary.url + '/internal/snapshot', { signal: AbortSignal.timeout(1500) });
    const have = new Set((await r.json()).orders.map((o) => o.id));
    lost = [...acked].filter(([id, region]) => region === 'primary' && !have.has(id)).length;
  } catch { /* secondary unreachable - use the last health-check estimate */ }
  acked.clear();
  metrics.lostWrites = lost;
  if (lost > 0) log('warn', `${lost} order(s) were acknowledged by ${nm('primary')} but never replicated - they are lost (RPO above zero)`);
  else log('info', 'Every acknowledged order had replicated before the failure (RPO = 0)');
  push();
}

let first = true;
async function loop() {
  await Promise.all(IDS.map(probe));
  route();
  if (first) { first = false; booted = true; }
  push();
  setTimeout(loop, cfg.probeInterval);
}

// ------------------------------------------------------------------ proxy
function count(ok) {
  metrics.total++;
  if (ok) metrics.ok++;
  else if (incident && !incident.recoveredAt) incident.failedReqs++;
}

function proxy(req, res) {
  const t = active;
  if (t === 'none') {
    count(false);
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'no healthy region' }));
  }
  const target = new URL(REGIONS[t].url);
  const upstream = http.request({
    hostname: target.hostname, port: target.port || 80, method: req.method,
    path: req.url.replace(/^\/gw/, '') || '/', headers: { ...req.headers, host: target.host }, timeout: 3000,
  }, (ures) => {
    const good = ures.statusCode < 500;
    count(good);
    if (good && t === 'secondary' && incident && incident.failoverAt && !incident.recoveredAt) {
      incident.recoveredAt = Date.now();
      metrics.lastRTO = incident.recoveredAt - incident.faultAt;
      log('ok', `Service restored on ${nm('secondary')}: first successful request ${secs(metrics.lastRTO)} after the failure`);
    }
    res.writeHead(ures.statusCode, { ...ures.headers, 'x-served-by': t, 'x-region-name': nm(t) });
    if (req.method === 'POST' && req.url.endsWith('/api/orders') && ures.statusCode === 201) {
      let raw = '';
      ures.on('data', (c) => (raw += c));
      ures.on('end', () => {
        try { acked.set(JSON.parse(raw).id, t); if (acked.size > 500) acked.delete(acked.keys().next().value); } catch { /* ignore */ }
      });
    }
    ures.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => {
    count(false);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json', 'x-served-by': t });
    res.end(JSON.stringify({ error: 'region unreachable', region: t }));
  });
  req.pipe(upstream);
}

// ------------------------------------------------------------------ fault injection
function docker(action, container) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: '/var/run/docker.sock', path: `/containers/${container}/${action}`, method: 'POST', timeout: 4000 }, (res) => {
      res.resume();
      res.on('end', () => ([204, 304, 409].includes(res.statusCode) ? resolve() : reject(new Error('docker ' + res.statusCode))));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('docker timeout')));
    r.end();
  });
}
function admin(id, p, body) {
  return fetch(REGIONS[id].url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(1500) });
}
async function refreshPending(id) {
  try {
    const r = await fetch(REGIONS[id].url + '/health', { signal: AbortSignal.timeout(600) });
    const i = await r.json();
    st[id].lastPending = i.pending || 0;
  } catch { /* keep last known value */ }
}

async function injectFault(id, mode) {
  const s = st[id];
  if (id === 'primary' && active === 'primary' && !incident) {
    await refreshPending('primary');
    openIncident(Date.now());
  }
  const label = { kill: 'a crash (docker kill)', slow: 'slow responses', flaky: 'intermittent errors' }[mode];
  if (mode === 'kill') {
    try { await docker('kill', REGIONS[id].container); }
    catch {
      await admin(id, '/admin/chaos', { mode: 'down' }).catch(() => {});
      log('warn', 'Docker socket not available - simulating the crash in software instead');
    }
    s.fault = 'crash';
  } else {
    await admin(id, '/admin/chaos', { mode: mode === 'slow' ? 'slow' : 'flaky' }).catch(() => {});
    s.fault = mode;
  }
  log('error', `Injected ${label} at ${nm(id)}`);
  push();
}

async function restoreRegion(id) {
  st[id].fault = null;
  await docker('start', REGIONS[id].container).catch(() => {});
  await admin(id, '/admin/chaos', { mode: 'none' }).catch(() => {});
  if (id === 'primary' && incident) incident.restoreAt = Date.now();
  log('info', `Restoring ${nm(id)} - starting it back up`);
  push();
}

// ------------------------------------------------------------------ http server
const readBody = (req) => new Promise((resolve) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
});
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];

  if (p.startsWith('/gw/')) return proxy(req, res);

  if (p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: history\ndata: ${JSON.stringify(events)}\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/state') return json(res, 200, snapshot());

  if (req.method === 'POST' && p.startsWith('/control/')) {
    const b = await readBody(req);
    const id = b.region;
    switch (p) {
      case '/control/fail':
        if (!st[id]) return json(res, 400, { error: 'unknown region' });
        await injectFault(id, b.mode);
        return json(res, 200, { ok: true });
      case '/control/restore':
        if (!st[id]) return json(res, 400, { error: 'unknown region' });
        await restoreRegion(id);
        return json(res, 200, { ok: true });
      case '/control/failback':
        if (active === 'secondary' && st.primary.healthy) { switchTo('primary', 'secondary'); push(); return json(res, 200, { ok: true }); }
        return json(res, 409, { error: 'primary is not healthy yet' });
      case '/control/config':
        if (b.probeInterval !== undefined) cfg.probeInterval = clamp(b.probeInterval, 250, 5000);
        if (b.failThreshold !== undefined) cfg.failThreshold = clamp(b.failThreshold, 1, 10);
        if (b.autoFailback !== undefined) cfg.autoFailback = !!b.autoFailback;
        if (b.failoverDelay !== undefined) cfg.failoverDelay = clamp(b.failoverDelay, 0, 20000);
        if (b.strategy !== undefined) cfg.strategy = String(b.strategy).slice(0, 20);
        if (b.replDelay !== undefined) {
          cfg.replDelay = clamp(b.replDelay, 0, 10000);
          await Promise.all(IDS.map((r) => admin(r, '/admin/config', { replDelay: cfg.replDelay }).catch(() => {})));
        }
        log('info', `Settings updated: check every ${cfg.probeInterval} ms, ${cfg.failThreshold} failures to fail over, replication lag ${cfg.replDelay} ms, standby warm-up ${cfg.failoverDelay} ms, auto-failback ${cfg.autoFailback ? 'on' : 'off'}`);
        push();
        return json(res, 200, { cfg });
      case '/control/reset':
        await Promise.all(IDS.map(restoreRegion));
        metrics = freshMetrics();
        incident = null;
        log('info', 'Simulation reset');
        push();
        return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'unknown control action' });
  }

  if (p === '/engine.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'public', 'engine.js')).pipe(res);
  }
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`traffic manager on :${PORT}`);
  log('info', 'Traffic manager started - running first health checks');
  loop();
});
