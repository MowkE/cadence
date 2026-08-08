# Lyrics Overlay

A floating, click-through desktop overlay for Spotify — synced karaoke lyrics, an audio-reactive visualizer, album-adaptive theming, a 3D tilt with themed holographic frames, and a pile of toggleable effects. Built with Electron + Python.

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

- macOS (Apple Silicon or Intel), Node.js 18+, Python 3.10+
- A free [Spotify Developer](https://developer.spotify.com/dashboard) app (takes ~2 minutes)
- Spotify Premium is needed for the playback controls and scrubbing; everything else works on free accounts

## Setup

```bash
git clone <this repo>
cd spotify-overlay

# JavaScript dependencies
npm install

# Python environment (used to talk to Spotify)
python3 -m venv venv
venv/bin/pip install -r python/requirements.txt

# Run it
npm start
```

On first launch the overlay shows a **Connect your Spotify** card:

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create an app
2. Add `http://127.0.0.1:8888/callback` as a Redirect URI in the app's settings
3. Paste your Client ID and Client Secret into the card

Your keys are stored locally (in Electron's user data folder) and never leave your machine. A browser window opens once for Spotify's approval, and you're in.

## Usage

- **Drag the gear** to move the overlay; **click it** for settings
- The window is click-through everywhere except its controls, so it can float over games and full-screen apps
- Hover the album art for playback controls; with Progress arc enabled, drag the ring to scrub
- Go idle for a minute while music plays and the overlay becomes a full-screen ambient lyric display; any input brings it back

## Packaging a Mac app

```bash
npm run pack
```

The `.app` lands in `dist/mac-arm64/`. Credentials are never bundled — each user configures their own on first run.

## License

MIT
