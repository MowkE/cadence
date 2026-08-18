<p align="center">
  <img src="assets/icon.png" width="128" alt="Cadence">
</p>

<h1 align="center">Cadence</h1>

<p align="center">A floating, click-through desktop overlay for Spotify — synced karaoke lyrics, an audio-reactive visualizer, album-adaptive theming, a 3D tilt with holographic frames, and a pile of toggleable effects. Now with <b>listen along</b>: share a link and your friends see your lyrics live. Mac + Windows.</p>

<p align="center">
  <a href="https://github.com/MowkE/cadence/releases/latest/download/Cadence-mac-arm64.dmg"><img alt="Download for Mac (Apple Silicon)" src="https://img.shields.io/badge/Download-Mac%20%28Apple%20Silicon%29-1ed760?style=for-the-badge&logo=apple&logoColor=white"></a>
  &nbsp;
  <a href="https://github.com/MowkE/cadence/releases/latest/download/Cadence-mac-x64.dmg"><img alt="Download for Mac (Intel)" src="https://img.shields.io/badge/Download-Mac%20%28Intel%29-1ed760?style=for-the-badge&logo=apple&logoColor=white"></a>
  &nbsp;
  <a href="https://github.com/MowkE/cadence/releases/latest/download/Cadence-win-x64-Setup.exe"><img alt="Download for Windows" src="https://img.shields.io/badge/Download-Windows-1ed760?style=for-the-badge&logo=windows&logoColor=white"></a>
</p>

<p align="center">
  <img src="assets/screenshots/cyberpunk.png" alt="Cyberpunk style with neon billboard frame">
  <em align="center">Cyberpunk — neon billboard with thrusters</em>
</p>

<p align="center">
  <img src="assets/screenshots/retro.png" alt="Retro terminal style floating over the desktop">
  <em align="center">Retro — CRT terminal with typewriter lyrics</em>
</p>

<p align="center">
  <img src="assets/screenshots/ethereal.png" alt="Ethereal style with aurora glass frame">
  <em align="center">Ethereal — aurora glass, album-adaptive fonts and colors</em>
</p>

<p align="center">
  <img src="assets/screenshots/hologram.png" alt="Hologram projector mode">
  <em align="center">Hologram projector — the overlay beams out of a lens at the bottom of the screen</em>
</p>

## Download

No terminal, no Python, no editor. Grab the installer for your machine:

| | Download | Then |
|---|---|---|
| **Mac — Apple Silicon** (M1/M2/M3/M4) | [Cadence-mac-arm64.dmg](https://github.com/MowkE/cadence/releases/latest/download/Cadence-mac-arm64.dmg) | Open the DMG, drag Cadence to Applications |
| **Mac — Intel** | [Cadence-mac-x64.dmg](https://github.com/MowkE/cadence/releases/latest/download/Cadence-mac-x64.dmg) | Open the DMG, drag Cadence to Applications |
| **Windows** (64-bit) | [Cadence-win-x64-Setup.exe](https://github.com/MowkE/cadence/releases/latest/download/Cadence-win-x64-Setup.exe) | Run it — installs in a few seconds, no admin needed |

All versions live on the [Releases page](https://github.com/MowkE/cadence/releases).

> **First launch, because the app isn't signed with a paid developer certificate:**
>
> - **Mac:** the first open says Apple can't verify it. Click **Done**, then go to **System Settings → Privacy & Security**, scroll down and press **Open Anyway** (once). If you'd rather use Terminal: `xattr -cr /Applications/Cadence.app`.
> - **Windows:** SmartScreen shows "Windows protected your PC". Click **More info → Run anyway** (once).

Cadence lives in your **menu bar (Mac)** / **system tray (Windows)** — that's where *Show / Hide / Settings / Quit* are.

## Features

- **Synced lyrics** from LRCLIB (karaoke-style line highlighting), with Genius as an automatic fallback
- **Listen along** — start a session, share the code or `cadence://` link, and friends follow your lyrics live in their own overlay; if they have Spotify Premium, Cadence can also play the same song on their speakers, in sync
- **Three lyric styles** — Cyberpunk, Ethereal, Retro (terminal + typewriter) — plus an **Auto** mode that picks a style and one of 30 fonts per track based on the album art
- **Album-adaptive theming**: colors extracted from the cover tint the lyrics, visualizer, and UI
- **3D parallax tilt** with per-style hover frames: neon billboard (with thrusters), CRT terminal, aurora glass
- **Hologram projector** mode — a lens at the bottom of the screen projects the overlay; click it to power the hologram down/up
- **Playback controls** on hover, plus **ring scrubbing**: drag the progress arc around the album art to seek
- **Layouts**: full, focus (3-line), and mini ticker bar
- **Extras**: lyric translation, chorus fireworks, portal transitions between songs, star field, vinyl spin, night shift, daily listening recap, ambient screensaver mode when idle
- **Mac and Windows**, one codebase, no Python or extra installs

## Connect your Spotify (~2 minutes, free)

Cadence reads what you're playing through Spotify's API using *your own* API keys — nothing is shared, and the keys stay on your computer. A free Spotify account is fine for lyrics and everything visual; **Premium** is only needed for the playback controls, scrubbing, and playing along in a friend's session.

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and log in with your Spotify account
2. Click **Create app** — name and description can be anything (e.g. "Cadence")
3. Under **Redirect URIs**, add exactly:
   ```
   http://127.0.0.1:8888/callback
   ```
4. Save, then open the app's **Settings** to find your **Client ID** and **Client Secret**
5. In Cadence's **Connect your Spotify** card, paste both and press **Connect**. Your browser opens once for Spotify's approval — accept, and lyrics start flowing.

To change the keys later, open settings (the gear) and press 🔑. Just want to watch a friend's session? Press **Skip for now** — following a session needs no Spotify setup at all.

## Listen along

Share your music with a friend who also has Cadence:

**Host:** gear → **Listen along** → **Start a session**. Cadence generates a code like `K7PM-3QXZ` and copies an invite (`cadence://join/K7PM-3QXZ`) to your clipboard. Paste it to a friend. The panel shows how many people are listening; **End** stops the session.

**Friend:** click the link (it opens Cadence) or paste the code into gear → **Listen along** → **Join**. Their overlay switches to your track and lyrics, in sync with where you are in the song — even if they haven't connected Spotify. With **Play on my Spotify too** on (default), Cadence also starts the same song on their Spotify at the same position, follows your skips, pauses and seeks, and pauses when they leave. That part needs Spotify Premium and the Spotify app open on their side.

How it works: your overlay publishes tiny "state" messages (track, position, playing) to a private, randomly named topic on [ntfy.sh](https://ntfy.sh) — only when something changes, never your audio or account. Guests subscribe to that topic. Anyone with the code can follow, so share it like a party invite. Self-hosting? Point Cadence at your own ntfy server by adding `{ "relay": "https://ntfy.example.com" }` to `settings.json` in the app's data folder (Mac: `~/Library/Application Support/spotify-overlay/`, Windows: `%APPDATA%\spotify-overlay\`) or setting `CADENCE_RELAY`.

## Usage

- **Drag the gear** to move the overlay; **click it** for settings
- The window is click-through everywhere except its controls, so it floats harmlessly over games and full-screen apps
- Hover the album art for playback controls; with Progress arc enabled, drag the ring around the art to scrub through the song
- Play music and go idle for a minute — Cadence becomes a full-screen ambient lyric display until you touch the mouse or keyboard
- Menu bar / tray icon: show, hide, open settings, copy the invite link while hosting, quit

## Run from source

Requirements: [Node.js](https://nodejs.org) 18 or newer. That's it — no Python.

```bash
git clone https://github.com/MowkE/cadence.git
cd cadence
npm install
npm start
```

Build installers locally with `npm run dist:mac` or `npm run dist:win` (output in `dist/`). Releases are built by [GitHub Actions](.github/workflows/release.yml) for Mac (Apple Silicon + Intel) and Windows whenever a `v*` tag is pushed:

```bash
git tag v2.1.0 && git push origin v2.1.0
```

## License

MIT
