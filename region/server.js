'use strict';
/**
 * Region service - one image, started twice (primary + secondary).
 * Zero dependencies. Simulates a regional app + database with:
 *   - /health            health endpoint probed by the traffic manager
 *   - /api/orders        a tiny "database" held in memory (lost when the region crashes)
 *   - async replication  writes are queued, then pushed to the peer after REPL_DELAY_MS
 *   - boot-time resync   a restarted region pulls a snapshot from its peer before taking traffic
 *   - /admin/chaos       fault injection: down | slow | flaky | none
 */
const http = require('http');
const crypto = require('crypto');

const ID = process.env.REGION_ID || 'primary';
const NAME = process.env.REGION_NAME || 'us-east-1';
const PEER = process.env.PEER_URL || '';
const PORT = Number(process.env.PORT) || 80;
const ROLE = ID === 'primary' ? 'Primary' : 'Secondary';
const COLOR = ID === 'primary' ? '#1E4FD8' : '#D9650F';
const BOOT = Date.now();

let replDelay = Number(process.env.REPL_DELAY_MS) || 1500;
let chaos = 'none';
let ready = !PEER;
let resynced = null;
let busy = false;
let queue = []; // writes waiting to be replicated: { order, due }
const orders = new Map();

const ITEMS = [
  ['Espresso beans', 18], ['Standing desk', 420], ['Mechanical keyboard', 139],
  ['USB-C dock', 89], ['Noise-cancelling headphones', 249], ['Webcam', 64],
  ['Monitor arm', 55], ['Desk lamp', 38],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });

function page() {
  const up = Math.round((Date.now() - BOOT) / 1000);
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${NAME}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:${COLOR}14;color:#101828">
<main style="text-align:center;padding:24px"><p style="color:${COLOR};margin:0">${ROLE} region</p>
<h1 style="font-size:clamp(40px,10vw,72px);margin:8px 0;color:${COLOR}">${NAME}</h1>
<p>${orders.size} orders stored &middot; ${queue.length} waiting to replicate &middot; up ${up}s</p>
<p style="color:#5B6677">You are connected straight to this region, bypassing the traffic manager.</p></main>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const admin = p.startsWith('/admin');

  // ---- fault injection (never applied to /admin so we can always heal) ----
  if (!admin) {
    if (chaos === 'down') return send(res, 503, { error: 'region down', region: ID });
    if (chaos === 'flaky' && Math.random() < 0.5) return send(res, 503, { error: 'intermittent failure', region: ID });
    if (chaos === 'slow') await sleep(1200);
  }

  if (p === '/health') {
    const info = {
      region: ID, name: NAME, records: orders.size, pending: queue.length,
      uptimeSec: Math.round((Date.now() - BOOT) / 1000), chaos, resynced,
    };
    return ready ? send(res, 200, { status: 'ok', ...info }) : send(res, 503, { status: 'syncing', ...info });
  }

  if (p === '/api/ping') return send(res, 200, { region: ID, name: NAME, ts: Date.now() });

  if (p === '/api/orders' && req.method === 'GET') {
    const list = [...orders.values()].sort((a, b) => b.ts - a.ts).slice(0, 8);
    return send(res, 200, { region: ID, name: NAME, total: orders.size, orders: list });
  }

  if (p === '/api/orders' && req.method === 'POST') {
    const [item, amount] = ITEMS[Math.floor(Math.random() * ITEMS.length)];
    const order = { id: crypto.randomUUID().slice(0, 8), item, amount, origin: ID, originName: NAME, ts: Date.now() };
    orders.set(order.id, order);
    queue.push({ order, due: Date.now() + replDelay }); // acknowledged to the user *before* it is replicated => async replication
    return send(res, 201, order);
  }

  if (p === '/internal/replicate' && req.method === 'POST') {
    const b = await readBody(req);
    (b.orders || []).forEach((o) => orders.set(o.id, o));
    return send(res, 200, { applied: (b.orders || []).length });
  }

  if (p === '/internal/snapshot') return send(res, 200, { orders: [...orders.values()] });

  if (p === '/admin/chaos' && req.method === 'POST') {
    const b = await readBody(req);
    chaos = ['down', 'slow', 'flaky'].includes(b.mode) ? b.mode : 'none';
    console.log(`[${ID}] chaos mode -> ${chaos}`);
    return send(res, 200, { chaos });
  }

  if (p === '/admin/config' && req.method === 'POST') {
    const b = await readBody(req);
    if (Number.isFinite(b.replDelay)) replDelay = Math.max(0, Math.min(15000, b.replDelay));
    return send(res, 200, { replDelay });
  }

  if (p === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page());
  }
  send(res, 404, { error: 'not found' });
});

// ---- async replication loop: push due writes to the peer, retry until it accepts ----
setInterval(async () => {
  if (!PEER || busy || chaos === 'down' || !queue.length) return;
  const due = queue.filter((q) => q.due <= Date.now());
  if (!due.length) return;
  busy = true;
  try {
    const r = await fetch(PEER + '/internal/replicate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orders: due.map((q) => q.order) }),
      signal: AbortSignal.timeout(1000),
    });
    if (r.ok) {
      const done = new Set(due.map((q) => q.order.id));
      queue = queue.filter((q) => !done.has(q.order.id));
    }
  } catch { /* peer unreachable - keep the queue and retry */ }
  busy = false;
}, 250);

// ---- boot-time resync: a (re)started region first catches up from its peer ----
async function bootSync() {
  if (!PEER) return;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(PEER + '/internal/snapshot', { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        const { orders: list } = await r.json();
        list.forEach((o) => orders.set(o.id, o));
        await sleep(1500); // simulate replaying the change log
        resynced = { count: list.length, at: Date.now() };
        ready = true;
        console.log(`[${ID}] resynced ${list.length} records from peer`);
        return;
      }
    } catch { /* peer not up yet */ }
    await sleep(1000);
  }
  resynced = { count: 0, at: Date.now(), cold: true };
  ready = true;
  console.log(`[${ID}] peer unreachable - cold start`);
}

server.listen(PORT, () => {
  console.log(`[${ID}] ${NAME} listening on :${PORT}`);
  bootSync();
});
