/**
 * In-browser DR engine. A port of region/server.js + traffic-manager/server.js so the dashboard
 * can run with NO backend (GitHub Pages, or just opening index.html).
 *
 * It activates itself on github.io, file:// or when the URL has ?sim, then replaces
 * window.fetch (for /gw, /control, /state) and window.EventSource (for /events) with in-memory
 * versions, so the dashboard code is identical in Docker mode and in browser mode.
 * Also exports { Engine } for Node so CI can test it.
 */
(function () {
  'use strict';
  const IDS = ['primary', 'secondary'];
  const other = (id) => (id === 'primary' ? 'secondary' : 'primary');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const secs = (ms) => (ms / 1000).toFixed(1) + 's';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
  const uid = () => Math.random().toString(16).slice(2, 10);
  const ITEMS = [['Espresso beans', 18], ['Standing desk', 420], ['Mechanical keyboard', 139], ['USB-C dock', 89],
    ['Noise-cancelling headphones', 249], ['Webcam', 64], ['Monitor arm', 55], ['Desk lamp', 38]];

  class Engine {
    constructor() {
      this.names = { primary: 'us-east-1', secondary: 'us-west-2' };
      this.cfg = { probeInterval: 1000, probeTimeout: 800, failThreshold: 3, recoverThreshold: 3, autoFailback: true, replDelay: 1500, failoverDelay: 0, strategy: 'warm' };
      this.handlers = { state: [], log: [] };
      this.events = [];
      this.active = 'none';
      this.booted = false;
      this.incident = null;
      this.acked = new Map();
      this.metrics = this.freshMetrics();
      this.reg = {};
      this.st = {};
      this.dead = false;
      IDS.forEach((id) => {
        this.reg[id] = this.newRegion();
        this.st[id] = { checked: false, healthy: false, fails: 0, oks: 0, latency: null, info: null, syncing: false, fault: null, lastOkAt: null, lastPending: 0, unhealthySince: null };
      });
      this.log('info', 'Traffic manager started - running first health checks');
      IDS.forEach((id) => this.boot(id));
      this.replTimer = setInterval(() => this.replicate(), 250);
      this.first = true;
      this.loop();
    }

    // ---------------------------------------------------------------- plumbing
    on(ev, fn) { this.handlers[ev].push(fn); }
    emit(ev, d) { this.handlers[ev].forEach((f) => f(d)); }
    stop() { this.dead = true; clearInterval(this.replTimer); clearTimeout(this.loopTimer); }
    freshMetrics() { return { total: 0, ok: 0, failovers: 0, lastDetect: null, lastRTO: null, lastFailback: null, lostWrites: null, lastFailed: null }; }
    nm(id) { return this.names[id]; }
    log(level, msg) {
      const e = { t: Date.now(), level, msg };
      this.events.push(e);
      if (this.events.length > 150) this.events.shift();
      this.emit('log', e);
    }
    snapshot() {
      const p = this.st.primary;
      let phase = 'booting';
      if (this.booted) {
        if (this.active === 'none') phase = 'outage';
        else if (this.active === 'primary') phase = p.fault || !p.healthy || p.fails > 0 ? 'disaster' : 'normal';
        else phase = p.healthy || p.oks > 0 ? 'recovery' : 'failover';
      }
      const regions = {};
      IDS.forEach((id) => {
        const s = this.st[id], r = this.reg[id];
        regions[id] = {
          id, name: this.nm(id), role: id === 'primary' ? 'Primary' : 'Secondary', checked: s.checked, healthy: s.healthy, fails: s.fails, oks: s.oks,
          latency: s.latency, syncing: s.syncing, fault: s.fault,
          info: s.info ? { records: s.info.records, pending: s.info.pending, uptimeSec: Math.round((Date.now() - r.bootAt) / 1000) } : null,
        };
      });
      return {
        now: Date.now(), cfg: this.cfg, active: this.active, phase, regions,
        failbackReady: this.active === 'secondary' && p.healthy && !this.cfg.autoFailback,
        metrics: { ...this.metrics, failed: this.incident ? this.incident.failedReqs : this.metrics.lastFailed },
      };
    }
    push() { this.emit('state', this.snapshot()); }

    // ---------------------------------------------------------------- simulated regions
    newRegion() { return { up: true, chaos: 'none', ready: false, orders: new Map(), queue: [], bootAt: Date.now(), resynced: null }; }

    async boot(id) { // resync from the peer before taking traffic
      const r = this.reg[id], peer = this.reg[other(id)];
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && this.reg[id] === r && !this.dead) {
        if (peer.up && peer.chaos !== 'down') {
          peer.orders.forEach((o, k) => r.orders.set(k, o));
          await sleep(1500);
          if (this.reg[id] !== r) return;
          r.resynced = { count: r.orders.size, at: Date.now() };
          r.ready = true;
          return;
        }
        await sleep(1000);
      }
      if (this.reg[id] === r) { r.resynced = { count: 0, at: Date.now(), cold: true }; r.ready = true; }
    }

    replicate() { // async replication: push due writes to the peer
      IDS.forEach((id) => {
        const r = this.reg[id], peer = this.reg[other(id)];
        if (!r.up || r.chaos === 'down' || !r.queue.length) return;
        const due = r.queue.filter((q) => q.due <= Date.now());
        if (!due.length || !peer.up || peer.chaos === 'down') return;
        due.forEach((q) => peer.orders.set(q.order.id, q.order));
        const done = new Set(due.map((q) => q.order.id));
        r.queue = r.queue.filter((q) => !done.has(q.order.id));
      });
    }

    health(id) { // what GET /health would return, or null if unreachable / timed out
      const r = this.reg[id];
      if (!r.up) return null;
      if (r.chaos === 'down') return { ok: false, info: null, latency: 3 };
      if (r.chaos === 'flaky' && Math.random() < 0.5) return { ok: false, info: null, latency: 3 };
      if (r.chaos === 'slow') return null; // 1200 ms > probe timeout
      const info = { records: r.orders.size, pending: r.queue.length };
      const latency = 2 + Math.round(Math.random() * 4);
      return r.ready ? { ok: true, info, latency } : { ok: false, syncing: true, info, latency };
    }

    // ---------------------------------------------------------------- traffic manager
    openIncident(faultAt) { this.incident = { faultAt, lostWrites: this.st.primary.lastPending || 0, failedReqs: 0, failoverAt: null, recoveredAt: null, restoreAt: null }; }
    closeIncident() { if (this.incident) this.metrics.lastFailed = this.incident.failedReqs; this.incident = null; }

    probe(id) {
      const s = this.st[id], cfg = this.cfg, h = this.health(id);
      const ok = !!(h && h.ok);
      s.latency = h && h.latency != null ? h.latency : null;
      s.info = h && h.info ? h.info : null;
      s.syncing = !!(h && h.syncing);
      if (ok) { s.lastPending = h.info.pending || 0; s.lastOkAt = Date.now(); }
      if (!s.checked) {
        s.checked = true; s.healthy = ok; s.fails = ok ? 0 : 1; s.oks = ok ? 1 : 0;
        this.log(ok ? 'ok' : 'warn', `${this.nm(id)} is ${ok ? 'healthy' : 'not answering yet'}`);
        return;
      }
      if (ok) {
        s.oks++; s.fails = 0;
        if (!s.healthy && s.oks >= cfg.recoverThreshold) {
          s.healthy = true; s.unhealthySince = null;
          this.log('ok', `${this.nm(id)} passed ${s.oks} health checks in a row - marked healthy`);
        }
      } else {
        if (s.syncing) this.log('info', `${this.nm(id)} is up but still syncing data - not ready for traffic`);
        s.fails++; s.oks = 0;
        if (s.healthy) {
          if (id === 'primary' && this.active === 'primary' && !this.incident) this.openIncident(s.lastOkAt || Date.now());
          if (s.fails >= cfg.failThreshold) {
            s.healthy = false; s.unhealthySince = Date.now();
            this.log('error', `${this.nm(id)} failed ${s.fails} health checks in a row - marked unhealthy`);
            if (id === 'primary' && cfg.failoverDelay > 0) this.log('warn', `Standby needs ${secs(cfg.failoverDelay)} to warm up before it can take traffic`);
          } else this.log('warn', `Health check failed for ${this.nm(id)} (${s.fails}/${cfg.failThreshold})`);
        }
      }
    }

    route() {
      const p = this.st.primary, s = this.st.secondary, prev = this.active;
      let next = prev;
      if (prev === 'primary') {
        if (!p.healthy) {
          if (!s.healthy) next = 'none';
          else if (Date.now() - (p.unhealthySince || 0) >= this.cfg.failoverDelay) next = 'secondary';
        }
      } else if (prev === 'secondary') {
        if (!s.healthy) next = p.healthy ? 'primary' : 'none';
        else if (p.healthy && this.cfg.autoFailback) next = 'primary';
      } else next = p.healthy ? 'primary' : s.healthy ? 'secondary' : 'none';
      if (next !== prev) this.switchTo(next, prev);
      if (this.incident && !this.incident.failoverAt && this.active === 'primary' && !p.fault && p.fails === 0 && p.healthy) this.closeIncident();
    }

    switchTo(next, prev) {
      const now = Date.now(), m = this.metrics;
      this.active = next;
      if (next === 'none') return this.log('error', 'No healthy region left - total outage');
      if (prev === 'none') return this.log('ok', `Routing traffic to ${this.nm(next)}`);
      if (next === 'secondary') {
        if (!this.incident) this.openIncident(this.st.primary.lastOkAt || now);
        this.incident.failoverAt = now;
        m.failovers++;
        m.lastDetect = now - this.incident.faultAt;
        m.lastRTO = m.lastDetect;
        this.log('error', `FAILOVER: routing switched ${this.nm('primary')} to ${this.nm('secondary')} (detected after ${secs(m.lastDetect)})`);
        this.computeLostWrites(this.incident.lostWrites);
      } else {
        m.lastFailback = this.incident && this.incident.restoreAt ? now - this.incident.restoreAt : null;
        this.log('ok', `FAILBACK: traffic returned to ${this.nm('primary')}`);
        this.closeIncident();
      }
    }

    computeLostWrites(fallback) { // exact RPO: acknowledged by the primary but missing on the secondary
      const have = this.reg.secondary.orders;
      let lost = fallback;
      if (this.reg.secondary.up) lost = [...this.acked].filter(([id, region]) => region === 'primary' && !have.has(id)).length;
      this.acked.clear();
      this.metrics.lostWrites = lost;
      if (lost > 0) this.log('warn', `${lost} order(s) were acknowledged by ${this.nm('primary')} but never replicated - they are lost (RPO above zero)`);
      else this.log('info', 'Every acknowledged order had replicated before the failure (RPO = 0)');
    }

    loop() {
      if (this.dead) return;
      IDS.forEach((id) => this.probe(id));
      this.route();
      if (this.first) { this.first = false; this.booted = true; }
      this.push();
      this.loopTimer = setTimeout(() => this.loop(), this.cfg.probeInterval);
    }

    // ---------------------------------------------------------------- user traffic (what /gw/* does)
    count(ok) {
      this.metrics.total++;
      if (ok) this.metrics.ok++;
      else if (this.incident && !this.incident.recoveredAt) this.incident.failedReqs++;
    }

    async request(method, path) {
      const t = this.active;
      if (t === 'none') { this.count(false); return { status: 503, body: { error: 'no healthy region' } }; }
      const r = this.reg[t];
      if (!r.up) { this.count(false); return { status: 502, body: { error: 'region unreachable', region: t }, region: t }; }
      if (r.chaos === 'down' || (r.chaos === 'flaky' && Math.random() < 0.5)) { this.count(false); return { status: 503, body: { error: 'region unavailable' }, region: t }; }
      if (r.chaos === 'slow') await sleep(1200);
      let status = 200, body;
      if (path === '/api/ping') body = { region: t, name: this.nm(t), ts: Date.now() };
      else if (path === '/api/orders' && method === 'GET') {
        body = { region: t, name: this.nm(t), total: r.orders.size, orders: [...r.orders.values()].sort((a, b) => b.ts - a.ts).slice(0, 8) };
      } else if (path === '/api/orders' && method === 'POST') {
        const [item, amount] = ITEMS[Math.floor(Math.random() * ITEMS.length)];
        const order = { id: uid(), item, amount, origin: t, originName: this.nm(t), ts: Date.now() };
        r.orders.set(order.id, order);
        r.queue.push({ order, due: Date.now() + this.cfg.replDelay });
        this.acked.set(order.id, t);
        if (this.acked.size > 500) this.acked.delete(this.acked.keys().next().value);
        status = 201; body = order;
      } else { status = 404; body = { error: 'not found' }; }
      this.count(true);
      const inc = this.incident;
      if (t === 'secondary' && inc && inc.failoverAt && !inc.recoveredAt) {
        inc.recoveredAt = Date.now();
        this.metrics.lastRTO = inc.recoveredAt - inc.faultAt;
        this.log('ok', `Service restored on ${this.nm('secondary')}: first successful request ${secs(this.metrics.lastRTO)} after the failure`);
      }
      return { status, body, region: t };
    }

    // ---------------------------------------------------------------- control plane (what /control/* does)
    control(action, b) {
      const id = b.region;
      switch (action) {
        case 'fail': if (!this.st[id]) return { error: 'unknown region' }; this.fail(id, b.mode); return { ok: true };
        case 'restore': if (!this.st[id]) return { error: 'unknown region' }; this.restore(id); return { ok: true };
        case 'failback':
          if (this.active === 'secondary' && this.st.primary.healthy) { this.switchTo('primary', 'secondary'); this.push(); return { ok: true }; }
          return { error: 'primary is not healthy yet' };
        case 'config': this.configure(b); return { cfg: this.cfg };
        case 'reset': IDS.forEach((r) => this.restore(r)); this.metrics = this.freshMetrics(); this.incident = null; this.log('info', 'Simulation reset'); this.push(); return { ok: true };
      }
      return { error: 'unknown control action' };
    }

    fail(id, mode) {
      const s = this.st[id], r = this.reg[id];
      if (id === 'primary' && this.active === 'primary' && !this.incident) {
        this.st.primary.lastPending = r.queue.length;
        this.openIncident(Date.now());
      }
      if (mode === 'kill') { r.up = false; s.fault = 'crash'; }
      else { r.chaos = mode === 'slow' ? 'slow' : 'flaky'; s.fault = mode; }
      const label = { kill: 'a crash (container killed)', slow: 'slow responses', flaky: 'intermittent errors' }[mode];
      this.log('error', `Injected ${label} at ${this.nm(id)}`);
      this.push();
    }

    restore(id) {
      this.st[id].fault = null;
      if (!this.reg[id].up) { this.reg[id] = this.newRegion(); this.boot(id); } // a restart: memory is empty
      else this.reg[id].chaos = 'none';
      if (id === 'primary' && this.incident) this.incident.restoreAt = Date.now();
      this.log('info', `Restoring ${this.nm(id)} - starting it back up`);
      this.push();
    }

    configure(b) {
      const c = this.cfg;
      if (b.probeInterval !== undefined) c.probeInterval = clamp(b.probeInterval, 250, 5000);
      if (b.failThreshold !== undefined) c.failThreshold = clamp(b.failThreshold, 1, 10);
      if (b.autoFailback !== undefined) c.autoFailback = !!b.autoFailback;
      if (b.failoverDelay !== undefined) c.failoverDelay = clamp(b.failoverDelay, 0, 20000);
      if (b.strategy !== undefined) c.strategy = String(b.strategy).slice(0, 20);
      if (b.replDelay !== undefined) c.replDelay = clamp(b.replDelay, 0, 10000);
      this.log('info', `Settings updated: check every ${c.probeInterval} ms, ${c.failThreshold} failures to fail over, replication lag ${c.replDelay} ms, standby warm-up ${c.failoverDelay} ms, auto-failback ${c.autoFailback ? 'on' : 'off'}`);
      this.push();
    }
  }

  // -------------------------------------------------------------------- Node export (tests)
  if (typeof module !== 'undefined' && module.exports) module.exports = { Engine };

  // -------------------------------------------------------------------- browser shim
  if (typeof window === 'undefined') return;
  const wanted = location.protocol === 'file:' || /github\.io$/.test(location.hostname) || new URLSearchParams(location.search).has('sim');
  if (!wanted) return;

  const eng = new Engine();
  window.DR_ENGINE_ACTIVE = true;
  const realFetch = window.fetch.bind(window);
  const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  window.fetch = async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    if (u.startsWith('/gw/')) {
      const r = await eng.request(method, u.slice(3).split('?')[0]);
      return reply(r.status, r.body, r.region ? { 'x-served-by': r.region, 'x-region-name': eng.nm(r.region) } : {});
    }
    if (u.startsWith('/control/')) {
      let b = {};
      try { b = JSON.parse(opts.body || '{}'); } catch { /* ignore */ }
      return reply(200, eng.control(u.slice(9), b));
    }
    if (u === '/state') return reply(200, eng.snapshot());
    return realFetch(url, opts);
  };

  window.EventSource = class {
    constructor() {
      this.h = {};
      setTimeout(() => { this.fire('history', eng.events); this.fire('state', eng.snapshot()); }, 0);
      eng.on('state', (d) => this.fire('state', d));
      eng.on('log', (d) => this.fire('log', d));
    }
    addEventListener(t, f) { (this.h[t] = this.h[t] || []).push(f); }
    fire(t, d) { (this.h[t] || []).forEach((f) => f({ data: JSON.stringify(d) })); }
    close() {}
  };
})();
