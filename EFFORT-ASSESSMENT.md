# Effort Assessment: AllisonIPTV as a personal, self-hosted web service

## Context

Chris asked what it would take to convert AllisonIPTV from an Electron desktop app into a web service, so it's reachable from a browser on any device instead of only the desktop app. Scope was confirmed as **personal/self-hosted** — Chris's own account(s) (maybe a couple of household users), not a public multi-tenant service with open signup. That distinction matters enormously: multi-tenant would mean real user accounts, per-tenant secrets storage at scale, and the operator's infrastructure relaying and paying for strangers' streaming bandwidth (a materially bigger, riskier project). Personal scope sidesteps almost all of that.

This is a fact-finding deliverable, not a build — the codebase was explored in depth (three parallel passes over the main process, the renderer's Electron coupling, and the streaming/proxy/transcode architecture specifically) to ground the estimate in what's actually there, not assumptions.

## Bottom line

**Moderate effort — a real multi-day project, not a weekend hack, but well short of a rewrite.** The two most technically risky subsystems (the local proxy and the ffmpeg transcode fallback) are *already* Electron-free, dependency-injected, and unit-tested — they become the new server's backbone almost unchanged. The single largest current subsystem (the VPN split-tunnel feature, roughly half of `src/main/index.ts`) doesn't fit a shared-server model at all and gets **cut**, not ported — which also shrinks the total porting surface rather than adding to it.

## Keep almost as-is

- **`src/main/proxyServer.ts`** — confirmed by direct read: zero imports from `'electron'`, only `http`/`url`. Already built via constructor-injected deps (`ProxyServerDeps`) specifically so it could be unit-tested against a real Node `http.Server` (see `proxyServer.test.ts` and the 0.7.11 history in ROADMAP.md). `createProxyServer(deps)` returns a plain `http.Server` today. Swap two deps for a personal server: `createUpstreamRequest` (currently Electron's `net.request`, chosen for Chromium's OS-trust-store TLS handling) → Node's `https`/`fetch`; VPN-aware off-tunnel-redirect detection deps → stub/drop (no VPN feature in the web version). The `/__fetch/<url>` route, the Xtream-base relay, and the `.m3u8` rewriting (`rewriteM3u8ForProxy`) all carry over unchanged.
- **`src/main/transcodeService.ts`** — no Electron dependency of any kind (pure `child_process`/`fs`/`path`, explicitly documented as decoupled for testability). Runs on a personal server essentially as-is; for a household-scale audience the "1 ffmpeg process per concurrent viewer" cost (flagged as a real scaling concern for multi-tenant) is a non-issue.
- **Most of `src/renderer/src`** — `EpgGrid`, `Player.tsx`'s hls.js wiring, the store's UI logic, etc. are already a web app in spirit. Fullscreen (`Element.requestFullscreen()`) and PiP (`requestPictureInPicture()`) already have direct standard browser equivalents.
- **`src/renderer/src/lib/storage.ts`'s plain JSON get/set** — already gated behind `hasElectronApi()` with a working `localStorage` fallback (confirmed at `storage.ts:12-31`). For a server-backed version, pointing this at small server-side JSON files/a lightweight DB instead is a nicer target than `localStorage` anyway — it's an actual improvement (favorites/history sync across devices, which the desktop app can't do today), not just a port.

## Real work: port with meaningful changes

- **Translate the IPC surface into a real API.** `src/preload/index.ts` exposes `window.api` across ~7 namespaces (`store`, `vpn`, `updater`, `backup`, `proxy`, `app`, `transcode`) backing ~20 `ipcMain.handle` registrations in `index.ts` and ~48 call sites across the renderer (heaviest in `useAppStore.ts`'s `init()`/`connect()`, `useTranscodeFallback.ts`, `SettingsPage.tsx`). Mechanical in shape (request/response → REST, `webContents.send` push events → WebSocket/SSE) but broad-touching — this is the single biggest chunk of *volume*, even though none of it is conceptually hard.
- **Fix the one real correctness gap for a browser: `getStreamUrl()`/`getTimeshiftUrl()`** (`xtream.ts:120-133`). Confirmed these return the **raw upstream provider URL** directly, unproxied — unlike the JSON API calls (`player_api.php`/`xmltv.php`), which already route through the local proxy. This works in Electron today; in a real browser, hls.js's own `fetch()`/XHR-based segment and playlist retrieval (not a bare `<video src>`, which browsers exempt from CORS as an opaque media load) would be blocked by CORS against a provider that sends no CORS headers (confirmed — `proxyServer.ts` says so directly). Fix is contained: route these through the same `/__fetch/`-style proxying the app already uses elsewhere, not a new pattern.
- **De-globalize per-connection state.** `proxyTargetBase` (`index.ts:680`) and the transcode session map are currently single module-level globals — correct for "one desktop, one active profile" but wrong the moment more than one browser session might connect (even just Chris on two devices, or a second household user). Needs to become session-scoped, standard Express/session-middleware territory, not a hard problem.
- **Replace `safeStorage` (OS keychain) with server-side encryption at rest** for the parental PIN and any stored Xtream/M3U credentials. Actually simpler server-side than the desktop version — one encryption key from an env var/secret file, no per-OS keychain abstraction to maintain.
- **Add a real login gate.** Even purely personal use, reachable outside the LAN, needs *something* (a shared password, or a couple of named logins) — right now there's no concept of this at all since the desktop app has an implicit single local user.
- **Strip native chrome** — the application `Menu`, Dock icon, and native save/open `dialog`s (backup export/import, VPN config/zip import) become ordinary browser UI (`<input type=file>` + downloads). Small and mechanical.

## Cut entirely — doesn't fit a web/server model

- **The VPN split-tunnel feature** — confirmed as roughly half of `index.ts` (~550 of ~1100 lines): spawns `openvpn` via `sudo-prompt` (one-shot OS-elevated privilege escalation), controls it over a local management socket, and rewrites the *machine's own* OS routing table. There is no way to do this per-browser-session on a shared server — it assumes one machine, one routing table, one human present for the OS admin/Touch ID prompt. If Chris still wants the streaming traffic tunneled, that becomes an **operator-level** decision (run the whole server on a VPS behind a VPN, or route that box's own default route through one at the OS level) rather than an in-app, per-connection feature. This is the single biggest deletion — and it *reduces* total porting work rather than adding to it.
- **electron-updater / GitHub Releases auto-update** — meaningless for a web app; replaced by however Chris redeploys (git pull + restart, or a Docker rebuild). A net simplification, not work to redo.
- **Native window management, single-instance lock, app.getPath('userData') migration concerns** — no web equivalent needed at all.

## New work with no existing counterpart

- A real Node server process (Express/Fastify are both fine fits) hosting: the ported proxy routes, the transcode service, the new small API, and the built React app as static files.
- Basic session/login handling (see above).
- Deployment packaging: a Dockerfile, a reverse proxy (Caddy or nginx) for TLS if it's reachable outside the LAN. This is standard self-hosted-app territory — comparable to how Jellyfin/Sonarr/Radarr-style personal servers are packaged — not a research problem.

## Worth flagging (not engineering, but real)

Even at personal scale: the server now **relays** the provider's stream to whatever device is watching, rather than each device pulling directly from the provider the way the desktop app's own connection did. Worth keeping the server itself behind your own network or a VPN rather than wide open on the public internet — both for credential safety (the Xtream username/password now lives on a server, not just a local desktop keychain) and because operating a relay is a meaningfully different posture than running a pure client, even for a household of one.

## Suggested verification once built

- Typecheck/lint/the existing vitest suite continue to pass for the largely-unchanged `proxyServer.ts`/`transcodeService.ts` logic.
- Extend `proxyServer.test.ts`'s existing pattern (spin up a real `http.Server`, hit it with real requests) to cover the new upstream-request implementation (Node `https`/`fetch` in place of Electron's `net.request`).
- A real, live, browser-based (not Electron) end-to-end check: log in, connect a real Xtream profile, browse Live TV, and play a channel with browser dev tools open specifically watching the Network tab for CORS errors on hls.js's segment/playlist requests — this is the single highest-risk unknown in the whole port (the `getStreamUrl()` proxying fix above) and deserves direct confirmation before calling the port done, the same "verify live, don't just reason about it" discipline this project's own ROADMAP has followed throughout its history.
