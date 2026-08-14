<p align="center">
  <img src="assets/icon.png" width="128" alt="Cadence">
</p>

<h1 align="center">Cadence</h1>

<p align="center">A floating, click-through desktop overlay for Spotify — synced karaoke lyrics, an audio-reactive visualizer, album-adaptive theming, a 3D tilt with holographic frames, and a pile of toggleable effects. Built with Electron + Python.</p>

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

## Features

- **Synced lyrics** from LRCLIB (karaoke-style line highlighting), with Genius as an automatic fallback
- **Three lyric styles** — Cyberpunk, Ethereal, Retro (terminal + typewriter) — plus an **Auto** mode that picks a style and one of 30 fonts per track based on the album art
- **Album-adaptive theming**: colors extracted from the cover tint the lyrics, visualizer, and UI
- **3D parallax tilt** with per-style hover frames: neon billboard (with thrusters), CRT terminal, aurora glass
- **Hologram projector** mode — a lens at the bottom of the screen projects the overlay; click it to power the hologram down/up
- **Playback controls** on hover, plus **ring scrubbing**: drag the progress arc around the album art to seek
- **Layouts**: full, focus (3-line), and mini ticker bar
- **Extras**: lyric translation, chorus fireworks, portal transitions between songs, star field, vinyl spin, night shift, daily listening recap, ambient screensaver mode when idle

## Requirements
- oh also i think you need spotify premium for the api keys
- macOS (Apple Silicon or Intel)
- [Node.js](https://nodejs.org) 18 or newer
- Python 3.10 or newer
- A Spotify account. Playback controls and scrubbing need **Premium**; lyrics, visualizer, and everything else work on free accounts.

## Setup

### 1. Get the code running

```bash
git clone https://github.com/MowkE/cadence.git
cd cadence

# JavaScript dependencies
npm install

# Python environment (used to talk to Spotify)
python3 -m venv venv
venv/bin/pip install -r python/requirements.txt

# Launch
npm start
```

### 2. Create your Spotify API app (~2 minutes, free)

Cadence talks to Spotify with *your own* API keys — nothing is shared.

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and log in with your Spotify account
2. Click **Create app** — name and description can be anything (e.g. "Cadence")
3. Under **Redirect URIs**, add exactly:
   ```
   http://127.0.0.1:8888/callback
   ```
4. Save, then open the app's **Settings** to find your **Client ID** and **Client Secret**

### 3. Connect

On first launch, Cadence shows a **Connect your Spotify** card. Paste your Client ID and Client Secret into it and hit Connect. Your browser opens once for Spotify's approval — accept, and lyrics start flowing.

Your keys are stored locally in your user data folder and never leave your machine. To change them later, open settings (the gear) and press 🔑.

## Usage

- **Drag the gear** to move the overlay; **click it** for settings
- The window is click-through everywhere except its controls, so it floats harmlessly over games and full-screen apps
- Hover the album art for playback controls; with Progress arc enabled, drag the ring around the art to scrub through the song
- Play music and go idle for a minute — Cadence becomes a full-screen ambient lyric display until you touch the mouse or keyboard

## Packaging a Mac app

```bash
npm run pack
```

`Cadence.app` lands in `dist/mac-arm64/`. Credentials are never bundled — every user configures their own on first run.

## License

MIT
