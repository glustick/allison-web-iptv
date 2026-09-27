# scripts/ — the test harness

Rebuilt 2026-09-26 from the ROADMAP's documented contracts after the originals
were lost in the move to the AGENT share (they were never tracked in git, and
were already absent from the repo before the only Time Machine backup — restore
was impossible; this is a rebuild, not the original code).

| Script | What it does | Status |
| --- | --- | --- |
| `cdp-drive.mjs` | CDP driver: launches/attaches Chrome, real mouse + keyboard input (`Input.dispatchMouseEvent`/`KeyEvent`), drag, polling waits, console capture, screenshots. Zero deps, Node 22+. | **Tested**: navigation, real click + drag, console capture. |
| `verify-csp-worker.mjs` | Loads the app, creates a `blob:` worker, asserts it answers; on failure quotes the browser's own CSP line. Guards the `worker-src` regression that used to hang every stream silently. | **Tested both ways** (pass on plain page; fail with `worker-src 'none'`, quoting the violation). |
| `cdp-verify-live.mjs` | Sign in → guide → click a channel → assert the playhead advances at realtime, reporting resolution/buffered. | Written to contract; **selectors need one tuning pass** against a running deployment (`SEL` block). |
| `verify-catchup.mjs` | Catch-up end-to-end: finished programme → preparing → player advancing → now-playing bar. | Written to contract; **selectors need one tuning pass** (`SEL` block). |
| `dockhand-update.sh` | Deploy + image prune. | **Not rebuilt** — the original spoke to Dockhand directly and its API shape is not documented in the repo. Deploy v0.53.1 via the Dockhand UI (`ghcr.io/glustick/allison-web-iptv:v0.53.1`, CI green) until re-created. |

Conventions: all scripts exit non-zero on failure and print what a human needs
without reading code. The two verify-live/catchup scripts read `BASE_URL`,
`IPTV_USER`, `IPTV_PASS` from the environment and never store credentials.
