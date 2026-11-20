// Smoke test of the real servers (no Docker needed): boots two regions + the traffic manager as processes.
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const run = (file, env) => procs.push(spawn('node', [file], { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' }));
const TM = 'http://127.0.0.1:9000';
const get = async (p) => (await fetch(TM + p)).json();
const post = async (p, body = {}) => fetch(TM + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  try {
    run('region/server.js', { REGION_ID: 'primary', REGION_NAME: 'us-east-1', PORT: 9001, PEER_URL: 'http://127.0.0.1:9002' });
    run('region/server.js', { REGION_ID: 'secondary', REGION_NAME: 'us-west-2', PORT: 9002, PEER_URL: 'http://127.0.0.1:9001' });
    run('traffic-manager/server.js', { PORT: 9000, PRIMARY_URL: 'http://127.0.0.1:9001', SECONDARY_URL: 'http://127.0.0.1:9002' });
    await sleep(5000);
    let s = await get('/state');
    assert.strictEqual(s.active, 'primary');
    assert.ok(s.regions.secondary.healthy, 'standby healthy');

    for (let i = 0; i < 3; i++) await post('/gw/api/orders');
    await sleep(3000);
    for (let i = 0; i < 2; i++) await post('/gw/api/orders');
    await post('/control/fail', { region: 'primary', mode: 'kill' }); // no docker socket here -> software fault
    await sleep(5500);
    s = await get('/state');
    assert.strictEqual(s.active, 'secondary', 'failed over');
    assert.strictEqual(s.metrics.lostWrites, 2, 'exact RPO');
    assert.ok((await fetch(TM + '/gw/api/ping')).ok, 'secondary serves users');

    await post('/control/restore', { region: 'primary' });
    await sleep(9000);
    s = await get('/state');
    assert.strictEqual(s.active, 'primary', 'failed back');
    console.log('smoke tests passed');
  } finally { procs.forEach((p) => p.kill()); }
})().catch((err) => { console.error(err); procs.forEach((p) => p.kill()); process.exit(1); });
