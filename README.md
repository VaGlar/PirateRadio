# 🏴‍☠️ PirateRadio

Live radio from the browser. One or two broadcasters open a page, hit "On
Air", and listeners tune in from a plain link — no install on their end.

## How it works

```
[broadcaster browser] --WebSocket--> [bridge: Fly.io, ffmpeg] --HTTPS--> [Icecast: Fly.io, MP3] <--HTTPS-- [listener <audio>]
```

- **Icecast** (`icecast/`) — the streaming server, runs on **Fly.io** (raw
  TCP passthrough, not an HTTP-aware proxy — see "Why the whole backend is
  on Fly.io" below). Takes the live audio (MP3) and relays it to whoever
  opens the mount URL.
- **bridge** (`bridge/`) — a small Node server, also on **Fly.io**. Takes
  the mixed audio (webm/opus) from the broadcaster over WebSocket and pipes
  it into an `ffmpeg` process that transcodes it to MP3 and sends it to
  Icecast over Icecast's public HTTPS URL (routing it over Fly's internal
  network, `*.internal`, was tried and abandoned — it refused the
  connection even with a single running machine, for no obvious reason).
  The same WebSocket endpoint also serves listeners: chat to the
  broadcaster, a live roster of names, live listener stats.
- **docs/** — the two web pages, served by **GitHub Pages**:
  - `docs/index.html` — listener page.
  - `docs/broadcast/index.html` — broadcast page.

Only one broadcaster (one connection) can be on-air at a time, but it can
send audio from **two microphones at once** (two people, same laptop) —
see "Features" below.

### Why the whole backend is on Fly.io

Tried in order:
1. Bridge + Icecast on **Render** (free tier): the bridge→Icecast
   connection hung silently, the mount never activated.
2. Icecast on **Fly.io** (HTTP-aware proxy), bridge on Render: the
   connection kept breaking at ~30-32 seconds.
3. Icecast on Fly.io with **raw TCP passthrough** (not an HTTP proxy),
   bridge still on Render: the mount worked correctly, but the connection
   *still* broke at ~30-32s. The common denominator across every failure
   was Render (the side making the outbound connection) — likely a
   duration limit on long-lived outbound connections on the free tier.
4. Moved the bridge to Fly.io too, same org as Icecast — this fixed it for
   good (verified live, clean audio with no drops).
5. Tried Fly's internal network (`*.internal`) between bridge and Icecast,
   so it wouldn't even go over the public internet — it refused the
   connection ("Connection refused") even with a single running Icecast
   machine. Abandoned; the bridge talks to Icecast over its public
   `https://<icecast-app>.fly.dev` URL, which had already proven to work
   correctly.

## Features

**Broadcast page** (`docs/broadcast/`):
- Two separate microphones (two co-hosts, same laptop) — each with its own
  name, test button, level meter, and indicator light; testing one
  automatically mutes the other so they don't pick each other up.
- Mixing with system audio (e.g. Spotify) via `getDisplayMedia` tab-audio
  capture — no OS-level audio driver install. Mix settings tucked into a
  collapsible panel ("⚙️ Mix settings"), with live mic level meters.
  Auto-ducking **on by default**: independent mic/music volume sliders
  (0-100%, smooth/ramped transition), and music automatically lowers while
  a mic is talking (adjustable sensitivity/depth/hold), so you don't have
  to manage the live mix yourself. Turning auto-ducking off brings back the
  classic crossfader (one mic↔music slider, equal-power blend) for manual
  mixing. A limiter so audio doesn't clip, a de-esser on voice "s" sounds,
  automatic mic/music level balancing.
- Master ON AIR / mute (neon sign, same style as the listener page) + an
  independent per-person mute (Marshall-amp-style rocker switch) that stays
  in sync with the master whenever it changes.
- Self-monitor ("hear yourself") via a Web Audio graph for minimal latency;
  with two headsets, each person picks their own output device
  (`setSinkId`).
- Live stats (duration, listeners, peak) from Icecast's
  `/status-json.xsl`, a live roster of listener names from the bridge.
- An inbox of listener messages, visible to the broadcaster.
- View/change the shared listener passphrase live, with no redeploy (see
  "Listener passphrase" below).
- Warns if the laptop isn't charging (Battery Status API) — Windows/Chrome
  power-saving on battery is a common cause of audio crackling.
- Optional local recording: "Off Air" shows a pop-up asking if you want to
  download the recording (`.webm`) to your computer — no storage on the
  server, zero cost, but it's lost if you close the tab without answering.

**Listener page** (`docs/`):
- Login gate: name + shared passphrase before anything else shows.
- Custom player bar (play/pause, reload, volume, mute, AirPlay on Safari)
  instead of the browser's native controls.
- Auto-reconnect if the stream drops, a live listener count, a neon "ON
  AIR" sign that lights up while audio is playing.
- Shared chat: every message is visible to everyone (broadcaster + all
  listeners), not just the broadcaster. Rate-limited on the bridge (token
  bucket: burst of 5 messages, then 1 per 5s).

### Listener passphrase

The shared login passphrase lives **on the bridge** (in-memory, not
hardcoded into the page) — so it's the same for everyone regardless of
device, and the broadcaster can change it live from the "🔑 Listener
passphrase" button on the broadcast page (needs the broadcast password to
view/change it). How the new passphrase reaches listeners is up to you
(Slack, telling them in person) — it isn't automated.

With no persistent storage (cost), the passphrase resets to the env var
default (`LISTENER_PASSPHRASE`, fallback `yohoho`) on every bridge restart
(e.g. a redeploy). This is a courtesy lock for the group, **not real
security** — the raw stream URL remains technically accessible to anyone
who finds it.

## Deploy (no Docker/CLI on your own machine needed)

The whole backend deploys via **GitHub Actions** (flyctl), secrets live in
one place (GitHub repo secrets), the pages via **GitHub Pages**.

### 1. Fly.io account + secrets

1. Create an account at https://fly.io (needs a card for identity
   verification; these two small servers, with no persistent volumes,
   stay at a very low monthly cost).
2. **Account → Access Tokens** → create a token.
3. GitHub repo → **Settings → Secrets and variables → Actions → New
   repository secret**, add:
   - `FLY_API_TOKEN` = the token from step 2
   - `ICECAST_SOURCE_PASSWORD` = a random password of your choosing
   - `ICECAST_ADMIN_PASSWORD` = a random password of your choosing
   - `BROADCAST_PASSWORD` = the password you'll type on the broadcast page
   - `LISTENER_PASSPHRASE` (optional) = the initial listener passphrase; if
     missing, it falls back to the default `yohoho` until you change it
     from the broadcast page

### 2. Deploy

The `.github/workflows/deploy-icecast.yml` and `deploy-bridge.yml`
workflows run automatically on every push to `main` that touches the
corresponding folder — they create the Fly app, set the secrets, deploy,
and make sure exactly 1 machine stays running (`flyctl scale count 1`).
You can also run them manually from the repo's **Actions** tab (**Run
workflow**).

Deploy Icecast first, then the bridge.

If the names `pirateradio-icecast` / `pirateradio-bridge` are already
taken on Fly (global namespace), change them in **both** `fly.toml` files
**and** the workflows **and** `bridge/fly.toml`'s `ICECAST_HOST` **and**
`docs/*.html`, so they all match.

### 3. Frontend on GitHub Pages

1. Confirm `docs/index.html` points at the right Icecast hostname
   (`src="https://<icecast-app>.fly.dev/radio.mp3"`) and `ICECAST_STATUS_URL`
   in `docs/app.js`.
2. Confirm `docs/broadcast/app.js` and `docs/app.js` point at the right
   bridge hostname (`BRIDGE_URL = 'wss://<bridge-app>.fly.dev'`).
3. Commit & push.
4. GitHub repo: **Settings → Pages → Source: Deploy from a branch → Branch:
   main, folder: /docs**.
5. Links:
   - https://vaglar.github.io/PirateRadio/ — listening (send this out).
   - https://vaglar.github.io/PirateRadio/broadcast/ — broadcasting.

**Cache-busting**: the `<script>` tags in both `docs/*.html` have `?v=N`
on `app.js`. Bump `N` every time you change the corresponding `app.js`,
otherwise some browsers (especially iOS Safari) may hold onto an old
cached version for hours.

### Local test (before deploying)

```
docker compose up --build
```
Opens Icecast on `:8000` and the bridge on `:3001` — locally, without Fly.
Open `docs/index.html` and `docs/broadcast/index.html` in a browser, with
bridge URL `ws://localhost:3001`.

## Known limitations

- **iPhone/iPad as broadcaster**: Safari doesn't reliably support
  webm/opus recording via `MediaRecorder` — the broadcast page will show a
  clear error message on iOS instead of silently breaking. Listening from
  an iPhone/iPad works normally.
- Icecast's listener counter counts **open connections**, not unique
  people — multiple tabs/devices from the same person, or connections that
  hung without a proper TCP close, can make it show slightly more than the
  actual count. The live roster of names (via login) is more accurate
  about "who's actually in", but it measures a different thing (page open,
  not necessarily audio playing).
- The listener passphrase (see above) isn't real security — that would
  require listener authentication in Icecast itself, which hasn't been
  done.
- Recording: local only, in the broadcaster's browser tab (downloaded on
  Off Air) — no storage/backup on the server.

## Next steps (optional)

- Reactions/emoji from listeners — only worth it if they show up
  aggregated to everyone, not just the broadcaster (otherwise there's no
  point for whoever sends them).
- Live poll broadcaster→listeners — needs the bridge to keep a list of
  listeners (partly exists already via the roster) and a new
  broadcast-to-everyone mechanism instead of one-to-one.
- Real listener authentication in Icecast, if something beyond today's
  courtesy lock is ever needed.
- "Add to home screen" (PWA-lite) for the listener page — `manifest.json`
  + an icon, opening with one tap like an app instead of hunting for the
  link every time. Not requested yet — for now listeners only get in when
  sent the link.
