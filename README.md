# Multi-Region Disaster Recovery Simulator

A local, free demo of **active-passive disaster recovery**. Two "cloud regions" run in Docker,
a traffic manager health-checks them, and a live dashboard lets you crash a region and watch
failover, data loss and failback happen, with real measurements.

```
                    ┌────────────────────────┐
  Browser  ───────► │  traffic-manager :8080 │  dashboard + health checks + routing
                    │  (Route 53 stand-in)   │  + fault injector (Docker socket)
                    └───────┬────────┬───────┘
              active path   │        │  standby path
                  ┌─────────▼──┐  ┌──▼─────────┐
                  │ primary    │◄►│ secondary  │   async replication (+ resync on boot)
                  │ us-east-1  │  │ us-west-2  │
                  │ :8081      │  │ :8082      │   (direct ports, bypass the manager)
                  └────────────┘  └────────────┘
```

## Two ways to run it

| | Docker version | Live demo (GitHub Pages) |
|---|---|---|
| Where | Your machine | Any browser, shareable link |
| Regions | Real containers, `docker kill` | Simulated in the page (`engine.js`) |
| Needs | Docker Desktop | Nothing |
| Best for | Showing the real thing | Presenting and sharing |

The dashboard is the same in both. In browser mode `engine.js` replaces `fetch` and `EventSource`
with an in-memory port of the region and traffic-manager logic, so the code path you see is identical.

## Put the live demo on GitHub Pages

1. Create a GitHub repository and push this project to the `main` branch.
2. In the repository, open **Settings > Pages** and set **Source** to **GitHub Actions**.
3. The **Deploy live demo** workflow runs on every push (or run it by hand from the **Actions** tab).
   It tests the engine, then publishes the dashboard.
4. Your demo is live at `https://<your-username>.github.io/<repository-name>/`.

You can also open `traffic-manager/public/index.html` straight from disk, or add `?sim` to any
dashboard URL, to get the browser mode.

## Run it with Docker

Requires only [Docker Desktop](https://www.docker.com/products/docker-desktop/).

```bash
docker compose up --build -d
open http://localhost:8080        # or just visit it in a browser
```

Stop and clean up: `docker compose down`

## Try it

1. **Press "Play full demo"** on the dashboard. It runs the whole story for you:
   normal traffic, crash of the primary, failover, restore, resync, failback.
2. Or go manually: **Trigger disaster**, watch the red bars in the traffic chart, then **Restore**.
3. Open **Tune the failover** and change the numbers to see how they trade off:
   - fewer failed checks / faster interval = quicker failover (lower RTO) but more false alarms
   - more replication lag = more orders lost in a crash (higher RPO)
4. Pick **Intermittent errors** to see why the manager needs several failed checks in a row
   (hysteresis) instead of failing over on the first blip.
5. Use the terminal like the original guide; the dashboard notices on its own:
   ```bash
   docker stop dr_primary      # or: docker kill dr_primary
   docker start dr_primary
   ```
   (Crashes started from the dashboard use `docker kill`, an abrupt power-loss style failure.)

## DR strategies

Pick a strategy in the dashboard and it sets the health-check speed, replication lag, standby
warm-up time and failback policy. Real-world times are hours or minutes; the demo scales them to
seconds so you can watch the difference.

| Strategy | How it works | Real RTO | Real RPO | Cost |
|---|---|---|---|---|
| Backup and restore | Scheduled backups, standby rebuilt after a disaster | Hours | Hours | $ |
| Pilot light | Data replicated, minimal core running, rest started on demand | Tens of minutes | Minutes | $$ |
| Warm standby | Scaled-down working copy, scaled up on failover | Minutes | Seconds | $$$ |
| Active-active | Both regions serve users all the time | Near zero | Near zero | $$$$ |

Active-active is approximated with very fast detection and near-zero replication lag; the demo
still has one active region at a time.

After any incident, press **Download incident report** to get a Markdown post-mortem with the
timeline, the scorecard, the configuration and discussion questions.

## What it demonstrates

| Concept | Where to see it |
|---|---|
| Active-passive topology | Standby region receives no user traffic until failover |
| Active health checks | Traffic manager probes `/health` every interval (default 1 s, 800 ms timeout) |
| Hysteresis | 3 failures to mark unhealthy, 3 passes to mark healthy again |
| Detection time and RTO | Recovery scorecard, measured from the real failure moment |
| RPO / data loss | Orders are replicated asynchronously; orders not yet copied when the primary dies are counted as lost |
| Replication | Per-region "waiting to replicate" counter, tunable lag |
| Resync before failback | A restarted region has empty memory, pulls a snapshot from its peer, and only takes traffic once synced |
| Failback policy | Automatic or manual (toggle in settings) |
| Brownouts | Slow responses and intermittent errors, not just clean crashes |
| Standby warm-up | Time the standby needs before it can take traffic (pilot light, backup and restore) |
| Post-mortem | One-click incident report |
| Availability | Success rate across all proxied requests |

## How it works

- `region/server.js` - one image run twice. Health endpoint, an in-memory "orders" database,
  async replication queue, boot-time resync, chaos hooks. No dependencies.
- `traffic-manager/server.js` - probes both regions, applies failover/failback rules, proxies
  `/gw/*` to the active region, exposes `/control/*` and streams state to the browser over SSE.
  Like real DNS failover it **does not retry**: requests sent before detection completes fail.
  Those failures are the honest cost of detection.
- `traffic-manager/public/index.html` - the dashboard (plain HTML/CSS/JS, works offline).
- `traffic-manager/public/engine.js` - the in-browser version of both services, used on GitHub Pages and tested in CI.

## Tests and CI

```bash
npm test        # in-browser engine test + real-server smoke test (no Docker needed, ~40 s)
```

GitHub Actions (`.github/workflows`):

- `ci.yml` runs the tests on every push, then a **real Docker end-to-end test**: it builds the stack,
  runs `docker kill` on the primary through the control API, and asserts failover and failback.
- `pages.yml` tests the engine and deploys the live demo to GitHub Pages.

## Simplifications (worth saying out loud in a demo)

- Real DNS failover also waits for resolver caches to expire (the record's TTL); this simulator
  switches routing instantly once the manager decides.
- "Database" is in-memory so a crash really loses unreplicated data. There is no conflict
  resolution beyond "union of records" when a region resyncs.
- Mounting `/var/run/docker.sock` gives the traffic manager control over Docker. That is fine on
  your own machine for a demo; never do it in anything exposed to a network. Without the socket
  (for example, some Windows setups) crashes fall back to a software fault and everything else still works.

## Troubleshooting

- **Port 8080 in use:** change `"8080:80"` in `docker-compose.yml`.
- **"Docker socket not available" in the timeline:** the demo still works with simulated crashes.
  On Docker Desktop for Windows, make sure Linux containers are enabled.
- **Dashboard says "Control plane offline":** `docker compose logs traffic-manager`.
