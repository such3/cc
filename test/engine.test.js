// Tests the in-browser engine (the one GitHub Pages runs): failover, exact RPO, warm-up delay, resync, failback.
const assert = require('assert');
const { Engine } = require('../traffic-manager/public/engine.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const e = new Engine();
  try {
    await sleep(4500);
    assert.strictEqual(e.active, 'primary', 'primary should serve traffic after boot');
    assert.strictEqual(e.snapshot().phase, 'normal');

    e.control('config', { failoverDelay: 2000, strategy: 'custom' });
    for (let i = 0; i < 3; i++) await e.request('POST', '/api/orders');
    await sleep(3000); // let those replicate
    for (let i = 0; i < 2; i++) await e.request('POST', '/api/orders'); // not yet replicated
    e.control('fail', { region: 'primary', mode: 'kill' });
    await sleep(8000);

    const m = e.snapshot().metrics;
    assert.strictEqual(e.active, 'secondary', 'traffic should have failed over');
    assert.strictEqual(m.lostWrites, 2, 'exactly the 2 unreplicated orders are lost');
    assert.ok(m.lastDetect >= 4500 && m.lastDetect <= 8000, `detection + warm-up ~5 s, got ${m.lastDetect}`);
    assert.ok(m.lastRTO >= m.lastDetect, 'RTO is at least the detection time');

    e.control('restore', { region: 'primary' });
    await sleep(10000);
    assert.strictEqual(e.active, 'primary', 'traffic should fail back');
    assert.strictEqual(e.reg.primary.orders.size, e.reg.secondary.orders.size, 'primary resynced from secondary');
    assert.ok(e.snapshot().metrics.lastFailback > 0, 'failback time recorded');
    console.log('engine tests passed');
  } finally { e.stop(); }
})().catch((err) => { console.error(err); process.exit(1); });
