/**
 * Local player — what the music app on this computer is playing, read
 * straight from the app. No Web API, no developer app, no Premium.
 *
 *   Spotify         macOS: AppleScript (read, control, play-this-track).
 *                   Windows: the system media session (SMTC).
 *   YouTube Music   macOS: AppleScript into the browser tab (Chrome-family or
 *                   Safari) running a little JavaScript against the player —
 *                   the browser's "Allow JavaScript from Apple Events" has to
 *                   be on, once. Windows: SMTC, for the browser or the YouTube
 *                   Music desktop app.
 *   Auto            whichever of the two is playing (Spotify first).
 *
 * Everything returns the same shapes as lib/spotify.js so the renderer and
 * listen-along can't tell the sources apart.
 */

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEP = '\u001f';
const OSA_TIMEOUT_MS = 8000;
const WIN_STALE_MS = 8000;
const ART_LOOKUP_TIMEOUT_MS = 2500;
const ART_CACHE_MAX = 200;

const PERMISSION_HINT = 'Allow Cadence to control Spotify: System Settings → Privacy & Security → Automation';

const notRunning = (app) => ({
    success: true, track: null, not_running: true,
    message: app === 'ytmusic' ? 'Open YouTube Music in your browser and play something'
        : app === 'auto' ? 'Open Spotify or YouTube Music and play something'
            : 'Open Spotify and play something'
});
const notInstalled = () => ({ success: true, track: null, message: 'Install the Spotify app to get started', not_installed: true });
const nothingPlaying = (app) => ({ success: true, track: null, message: app === 'ytmusic' ? 'Play something in YouTube Music' : 'Play something in Spotify' });

function splitArtists(artist) {
    return String(artist || '').split(/,\s*|\s*[&;]\s*|\s+x\s+/i).map(s => s.trim()).filter(Boolean);
}

function prettyName(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    return s.split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function withTimeout(promise, ms, fallback) {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const hashId = key => crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// Album art without the music service (Windows): iTunes Search first, Deezer
// as a backup; both free, no keys. Cached per song.
// ---------------------------------------------------------------------------
function normalize(s) {
    return String(s || '').toLowerCase()
        .replace(/\(.*?\)|\[.*?\]/g, ' ')
        .replace(/\bfeat\.?\b.*$/, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

async function fetchJson(url) {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(ART_LOOKUP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function lookupArtItunes(artist, title) {
    const data = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`.trim())}&media=music&entity=song&limit=6`);
    const wantTitle = normalize(title);
    const wantArtist = normalize(artist).split(' ')[0] || '';
    const results = Array.isArray(data.results) ? data.results : [];
    const pick = results.find(r => normalize(r.trackName).includes(wantTitle) && normalize(r.artistName).includes(wantArtist))
        || results.find(r => normalize(r.trackName) === wantTitle) || null;
    if (!pick || !pick.artworkUrl100) return null;
    return pick.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.');
}

async function lookupArtDeezer(artist, title) {
    const clean = s => String(s || '').replace(/"/g, '');
    const data = await fetchJson(`https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${clean(artist)}" track:"${clean(title)}"`)}&limit=3`);
    const hit = Array.isArray(data.data) && data.data[0];
    if (!hit || !hit.album) return null;
    return hit.album.cover_xl || hit.album.cover_big || hit.album.cover_medium || null;
}

function createArtResolver() {
    const cache = new Map();
    function remember(key, entry) {
        if (cache.size >= ART_CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, entry);
    }
    async function resolve(artist, title, fallback) {
        const key = `${normalize(artist)}|${normalize(title)}`;
        let entry = cache.get(key);
        if (!entry) {
            entry = { url: undefined, promise: null, waited: false };
            entry.promise = (async () => {
                let url = null;
                try { url = await lookupArtItunes(artist, title); } catch (e) { /* next */ }
                if (!url) { try { url = await lookupArtDeezer(artist, title); } catch (e) { /* none */ } }
                entry.url = url;
                entry.promise = null;
                return url;
            })();
            remember(key, entry);
        }
        if (entry.url !== undefined) return entry.url || fallback || null;
        if (entry.waited) return fallback || null;
        entry.waited = true;
        const url = await withTimeout(entry.promise, ART_LOOKUP_TIMEOUT_MS + 200, undefined);
        return url || fallback || null;
    }
    return { resolve };
}

// ---------------------------------------------------------------------------
// macOS: AppleScript
// ---------------------------------------------------------------------------
function osascript(lines) {
    return new Promise((resolve, reject) => {
        const args = [];
        for (const line of lines) args.push('-e', line);
        execFile('osascript', args, { timeout: OSA_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                const text = `${stderr || ''} ${err.message || ''}`.replace(/\s+/g, ' ').trim();
                const e = new Error(text);
                if (err.killed || err.signal) e.timeout = true;
                if (/-1743|not authorized|not permitted/i.test(text)) e.permission = true;
                if (/-600\b|isn't running|is not running/i.test(text)) e.notRunning = true;
                if (/-1728|can't get current track|can’t get current track/i.test(text)) e.noTrack = true;
                if (/javascript/i.test(text) && /apple ?events|turned off|not allowed|allow/i.test(text)) e.jsBlocked = true;
                return reject(e);
            }
            resolve(String(stdout || '').replace(/\r?\n$/, ''));
        });
    });
}

// AppleScript formats reals with the system decimal separator ("13,26")
const parseReal = s => Number(String(s || '').trim().replace(',', '.')) || 0;
// AppleScript source always uses "." for decimals
const seconds = ms => (Math.max(0, Number(ms) || 0) / 1000).toFixed(3);

// ---- Spotify (macOS) ------------------------------------------------------
const SPOTIFY_STATE_SCRIPT = [
    'if application "Spotify" is not running then return "not-running"',
    'set sep to character id 31',
    'tell application "Spotify"',
    'set playerState to (player state as text)',
    'if playerState is "stopped" then return "stopped"',
    'set t to current track',
    'return playerState & sep & (id of t) & sep & (name of t) & sep & (artist of t) & sep & (album of t) & sep & (duration of t) & sep & (player position) & sep & (artwork url of t)',
    'end tell'
];
const SPOTIFY_ACTIONS = { play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' };

function createSpotifyMac(log) {
    let installed = true;
    let installedCheckedAt = 0;

    function isInstalled() {
        const now = Date.now();
        if (now - installedCheckedAt > 60000) {
            installedCheckedAt = now;
            installed = ['/Applications/Spotify.app', path.join(os.homedir(), 'Applications', 'Spotify.app')].some(p => fs.existsSync(p));
        }
        return installed;
    }

    function parseState(out) {
        if (out === 'not-running') return isInstalled() ? notRunning('spotify') : notInstalled();
        if (out === 'stopped' || !out) return nothingPlaying('spotify');
        const parts = out.split(SEP);
        if (parts.length < 8) return { success: false, error: `Unexpected reply from Spotify: ${out.slice(0, 80)}` };
        const [playerState, uri, name, artist, album, duration, position, art] = parts;
        const isSpotifyUri = /^spotify:/.test(uri);
        return {
            success: true,
            app: 'spotify',
            track: {
                id: isSpotifyUri ? uri.split(':').pop() : `local-${hashId(`${name}|${artist}|${album}`)}`,
                uri: isSpotifyUri ? uri : null,
                name, artist, artists: splitArtists(artist), album,
                album_art: /^https?:\/\//i.test(art) ? art.replace(/^http:/i, 'https:') : null,
                duration_ms: Math.max(0, Math.round(parseReal(duration))),
                progress_ms: Math.max(0, Math.round(parseReal(position) * 1000)),
                is_playing: playerState === 'playing'
            }
        };
    }

    async function read() {
        try {
            return parseState(await osascript(SPOTIFY_STATE_SCRIPT));
        } catch (err) {
            if (err.noTrack) return nothingPlaying('spotify');
            if (err.notRunning) return notRunning('spotify');
            if (err.permission) return { success: false, error: err.message, needs_permission: true, message: PERMISSION_HINT };
            if (err.timeout) return { success: false, error: 'Spotify did not respond', message: 'Spotify is not responding…' };
            log.error('local player (spotify/mac):', err.message);
            return { success: false, error: err.message, message: 'Could not read Spotify' };
        }
    }

    async function run(command, lines) {
        try {
            const out = await osascript(lines);
            if (out === 'not-running') return { success: false, command, error: 'Open Spotify first', reason: 'NOT_RUNNING' };
            return { success: true, command };
        } catch (err) {
            if (err.permission) return { success: false, command, error: PERMISSION_HINT, needs_permission: true };
            return { success: false, command, error: err.message.slice(0, 200) };
        }
    }

    function control(command, positionMs) {
        const action = command === 'seek' ? `set player position to ${seconds(positionMs)}` : SPOTIFY_ACTIONS[command];
        if (!action) return Promise.resolve({ success: false, command, error: `Unknown command: ${command}` });
        return run(command, [
            'if application "Spotify" is not running then return "not-running"',
            `tell application "Spotify" to ${action}`,
            'return "ok"'
        ]);
    }

    function playTrack(uri, positionMs) {
        if (!/^spotify:(track|episode):[A-Za-z0-9]+$/.test(String(uri || ''))) {
            return Promise.resolve({ success: false, command: 'play', error: 'That track has no Spotify link', reason: 'NO_URI' });
        }
        return run('play', [
            'if application "Spotify" is not running then return "not-running"',
            'tell application "Spotify"',
            `play track "${uri}"`,
            `set player position to ${seconds(positionMs)}`,
            'end tell',
            'return "ok"'
        ]);
    }

    return { read, control, playTrack, canPlayTrack: true };
}

// ---- YouTube Music in a browser (macOS) -----------------------------------
const YTM_BROWSERS = [
    { name: 'Google Chrome', kind: 'chrome' },
    { name: 'Brave Browser', kind: 'chrome' },
    { name: 'Microsoft Edge', kind: 'chrome' },
    { name: 'Arc', kind: 'chrome' },
    { name: 'Vivaldi', kind: 'chrome' },
    { name: 'Chromium', kind: 'chrome' },
    { name: 'Safari', kind: 'safari' }
];

// Runs inside the YouTube Music tab. Media Session metadata is what the tab
// already publishes to the OS; the <video> element carries the timing.
const YTM_READ_JS = `(() => {
  const v = document.querySelector('video');
  const m = navigator.mediaSession && navigator.mediaSession.metadata;
  if (!v) return 'no-video';
  const art = m && m.artwork && m.artwork.length ? m.artwork[m.artwork.length - 1].src : '';
  const id = new URL(location.href).searchParams.get('v') || '';
  const title = m && m.title ? m.title : document.title.replace(/ - YouTube Music$/, '');
  const dur = isFinite(v.duration) ? Math.round(v.duration * 1000) : 0;
  return ['ok', id, title, m ? (m.artist || '') : '', m ? (m.album || '') : '', dur, Math.round((v.currentTime || 0) * 1000), v.paused ? 'paused' : 'playing', art].join(String.fromCharCode(31));
})()`;

const YTM_CONTROL_JS = {
    play: "(() => { const v = document.querySelector('video'); if (!v) return 'no-video'; v.play(); return 'ok'; })()",
    pause: "(() => { const v = document.querySelector('video'); if (!v) return 'no-video'; v.pause(); return 'ok'; })()",
    next: "(() => { const b = document.querySelector('ytmusic-player-bar .next-button, .next-button'); if (!b) return 'no-button'; b.click(); return 'ok'; })()",
    previous: "(() => { const b = document.querySelector('ytmusic-player-bar .previous-button, .previous-button'); if (!b) return 'no-button'; b.click(); return 'ok'; })()",
    seek: ms => `(() => { const v = document.querySelector('video'); if (!v) return 'no-video'; v.currentTime = ${seconds(ms)}; return 'ok'; })()`
};

function ytmScript(browser, js) {
    // Base64 keeps the JavaScript out of AppleScript's quoting rules
    const b64 = Buffer.from(js, 'utf8').toString('base64');
    const call = browser.kind === 'safari'
        ? `do JavaScript "eval(atob('${b64}'))" in t`
        : `execute t javascript "eval(atob('${b64}'))"`;
    return [
        `if application "${browser.name}" is not running then return "not-running"`,
        `tell application "${browser.name}"`,
        'repeat with w in windows',
        'repeat with t in tabs of w',
        `if URL of t contains "music.youtube.com" then return ${call}`,
        'end repeat',
        'end repeat',
        'end tell',
        'return "no-tab"'
    ];
}

function jsBlockedHint(browser) {
    return browser.kind === 'safari'
        ? 'In Safari turn on Develop → Allow JavaScript from Apple Events (enable the Develop menu in Settings → Advanced)'
        : `In ${browser.name} turn on View → Developer → Allow JavaScript from Apple Events`;
}

// AppleScript can't even compile a `tell application` block for a browser
// that isn't installed (no dictionary), so only ask the ones that are
let installedBrowsers = null;
let installedBrowsersAt = 0;
function ytmBrowsersInstalled() {
    const now = Date.now();
    if (!installedBrowsers || now - installedBrowsersAt > 60000) {
        installedBrowsersAt = now;
        const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
        installedBrowsers = YTM_BROWSERS.filter(b => roots.some(r => fs.existsSync(path.join(r, `${b.name}.app`))));
    }
    return installedBrowsers;
}

function createYtmMac(log) {
    let lastBrowser = null;   // the browser that had the tab last time

    function parse(out) {
        const parts = out.split(SEP);
        if (parts[0] !== 'ok' || parts.length < 9) return null;
        const [, videoId, title, artist, album, duration, position, state, art] = parts;
        if (!title) return null;
        return {
            success: true,
            app: 'ytmusic',
            track: {
                id: videoId ? `yt-${videoId}` : `local-${hashId(`${title}|${artist}|${album}`)}`,
                uri: null,
                name: title,
                artist: artist || '',
                artists: splitArtists(artist),
                album: album || '',
                album_art: /^https:\/\//i.test(art) ? art : null,
                duration_ms: Math.max(0, Number(duration) || 0),
                progress_ms: Math.max(0, Number(position) || 0),
                is_playing: state === 'playing'
            }
        };
    }

    function browsersInOrder() {
        const installed = ytmBrowsersInstalled();
        return lastBrowser && installed.includes(lastBrowser) ? [lastBrowser, ...installed.filter(b => b !== lastBrowser)] : installed;
    }

    async function read() {
        let blocked = null;
        for (const browser of browsersInOrder()) {
            try {
                const out = await osascript(ytmScript(browser, YTM_READ_JS));
                if (out === 'not-running' || out === 'no-tab') continue;
                if (out === 'no-video') { lastBrowser = browser; return nothingPlaying('ytmusic'); }
                const parsed = parse(out);
                if (parsed) { lastBrowser = browser; return parsed; }
            } catch (err) {
                if (err.permission) return { success: false, error: err.message, needs_permission: true, message: `Allow Cadence to control ${browser.name}: System Settings → Privacy & Security → Automation` };
                if (err.jsBlocked) { blocked = browser; continue; }
                if (!err.timeout) log.error(`local player (ytmusic/${browser.name}):`, err.message.slice(0, 160));
            }
        }
        if (blocked) {
            return { success: false, error: 'JavaScript from Apple Events is off', needs_permission: true, app: 'ytmusic', message: jsBlockedHint(blocked) };
        }
        lastBrowser = null;
        return notRunning('ytmusic');
    }

    async function control(command, positionMs) {
        const js = command === 'seek' ? YTM_CONTROL_JS.seek(positionMs) : YTM_CONTROL_JS[command];
        if (!js) return { success: false, command, error: `Unknown command: ${command}` };
        for (const browser of browsersInOrder()) {
            try {
                const out = await osascript(ytmScript(browser, js));
                if (out === 'not-running' || out === 'no-tab') continue;
                if (out === 'ok') { lastBrowser = browser; return { success: true, command }; }
                return { success: false, command, error: out === 'no-button' ? 'YouTube Music has no player bar right now' : 'Nothing is playing in YouTube Music' };
            } catch (err) {
                if (err.jsBlocked) return { success: false, command, error: jsBlockedHint(browser), needs_permission: true };
                if (err.permission) return { success: false, command, error: err.message, needs_permission: true };
            }
        }
        return { success: false, command, error: 'Open YouTube Music in your browser first', reason: 'NOT_RUNNING' };
    }

    function playTrack() {
        return Promise.resolve({ success: false, command: 'play', error: 'Playing a specific song needs Spotify — following the lyrics only', reason: 'UNSUPPORTED' });
    }

    return { read, control, playTrack, canPlayTrack: false, describe: () => lastBrowser ? `YouTube Music in ${lastBrowser.name}` : 'YouTube Music in your browser' };
}

function createMacBackend(log, getApp) {
    const spotify = createSpotifyMac(log);
    const ytm = createYtmMac(log);
    let inflight = null;
    let lastApp = 'spotify';   // where the last track came from (controls go there in Auto)

    async function readAuto() {
        const s = await spotify.read();
        if (s.track && s.track.is_playing) return s;
        const y = await ytm.read();
        if (y.track && y.track.is_playing) return y;
        if (s.track) return s;
        if (y.track || y.needs_permission) return y;
        if (s.needs_permission) return s;
        return notRunning('auto');
    }

    function getCurrentTrack() {
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const app = getApp();
                const result = app === 'ytmusic' ? await ytm.read() : app === 'spotify' ? await spotify.read() : await readAuto();
                if (result && result.app) lastApp = result.app;
                return result;
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    const backendFor = () => {
        const app = getApp();
        return app === 'ytmusic' ? ytm : app === 'spotify' ? spotify : (lastApp === 'ytmusic' ? ytm : spotify);
    };

    return {
        getCurrentTrack,
        control: (command, positionMs) => backendFor().control(command, positionMs),
        playTrack: (uri, positionMs) => backendFor().playTrack(uri, positionMs),
        canPlayTrack: () => backendFor().canPlayTrack,
        describe: () => {
            const app = getApp();
            if (app === 'ytmusic') return ytm.describe();
            if (app === 'spotify') return 'the Spotify app on this Mac';
            return lastApp === 'ytmusic' ? ytm.describe() : 'Spotify or YouTube Music on this Mac';
        },
        displayName: () => new Promise(resolve => {
            execFile('id', ['-F'], { timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
                const full = !err && String(stdout || '').trim();
                resolve(full || prettyName(os.userInfo().username));
            });
        }),
        shutdown() {}
    };
}

// ---------------------------------------------------------------------------
// Windows: every system media session through a PowerShell helper; Node
// picks the one that matters (Spotify, a browser with YouTube Music, the
// YouTube Music desktop app)
// ---------------------------------------------------------------------------
const PS_PREAMBLE = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$stdout = [Console]::Out',
    'function Emit($obj) { $stdout.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 5)); $stdout.Flush() }',
    'try {',
    '  Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]',
    '  $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]',
    '  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]',
    '} catch { Emit @{ fatal = "Windows media controls are not available: $($_.Exception.Message)" }; exit 1 }',
    "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    'function Await($op, $type) {',
    '  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))',
    '  $null = $task.Wait(-1)',
    '  return $task.Result',
    '}',
    '$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]',
    '$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]',
    '$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]',
    'try { $mgr = Await ($mgrType::RequestAsync()) $mgrType } catch { Emit @{ fatal = "No media session manager: $($_.Exception.Message)" }; exit 1 }'
];

const PS_POLL = [
    '$parentPid = __PARENT_PID__',
    '$thumbs = @{}',
    'while ($true) {',
    '  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { exit 0 }',
    '  $o = @{ sessions = @() }',
    '  try {',
    '    foreach ($s in $mgr.GetSessions()) {',
    '      try {',
    '        $aumid = [string]$s.SourceAppUserModelId',
    '        $props = Await ($s.TryGetMediaPropertiesAsync()) $propsType',
    '        $tl = $s.GetTimelineProperties()',
    '        $pb = $s.GetPlaybackInfo()',
    '        $item = @{ aumid = $aumid; title = [string]$props.Title; artist = [string]$props.Artist; album = [string]$props.AlbumTitle; status = [string]$pb.PlaybackStatus }',
    '        $item.position_ms = [long]$tl.Position.TotalMilliseconds',
    '        $item.duration_ms = [long]($tl.EndTime.TotalMilliseconds - $tl.StartTime.TotalMilliseconds)',
    '        $item.updated_ms = [long]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()',
    '        $item.now_ms = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '        $key = "$($item.title)|$($item.artist)|$($item.album)"',
    '        if (-not $thumbs.ContainsKey($aumid) -or $thumbs[$aumid].key -ne $key) {',
    '          $data = $null',
    '          try {',
    '            if ($props.Thumbnail) {',
    '              $stream = Await ($props.Thumbnail.OpenReadAsync()) $streamType',
    '              $size = [uint32]$stream.Size',
    '              if ($size -gt 0 -and $size -lt 4000000) {',
    '                $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))',
    '                $null = Await ($reader.LoadAsync($size)) ([uint32])',
    '                $bytes = New-Object byte[] $size',
    '                $reader.ReadBytes($bytes)',
    "                $data = 'data:' + [string]$stream.ContentType + ';base64,' + [Convert]::ToBase64String($bytes)",
    '                $reader.Dispose()',
    '              }',
    '              $stream.Dispose()',
    '            }',
    '          } catch {}',
    '          $thumbs[$aumid] = @{ key = $key; data = $data }',
    '        }',
    '        $item.thumbnail = $thumbs[$aumid].data',
    '        $o.sessions += $item',
    '      } catch { $o.error = $_.Exception.Message }',
    '    }',
    '  } catch { $o.error = $_.Exception.Message }',
    '  Emit $o',
    '  Start-Sleep -Milliseconds 1000',
    '}'
];

const PS_CONTROL = [
    '$spot = $null',
    "foreach ($s in $mgr.GetSessions()) { if ([string]$s.SourceAppUserModelId -match '__PATTERN__') { $spot = $s; break } }",
    "if (-not $spot) { $stdout.WriteLine('NO_SESSION'); exit 0 }",
    '$r = $false',
    "switch ('__CMD__') {",
    "  'play' { $r = Await ($spot.TryPlayAsync()) ([bool]) }",
    "  'pause' { $r = Await ($spot.TryPauseAsync()) ([bool]) }",
    "  'next' { $r = Await ($spot.TrySkipNextAsync()) ([bool]) }",
    "  'previous' { $r = Await ($spot.TrySkipPreviousAsync()) ([bool]) }",
    "  'seek' { $r = Await ($spot.TryChangePlaybackPositionAsync([long]__TICKS__)) ([bool]) }",
    '}',
    "if ($r) { $stdout.WriteLine('OK') } else { $stdout.WriteLine('REFUSED') }"
];

const SPOTIFY_AUMID = /spotify/i;
const YTM_AUMID = /youtube|ytmusic|chrome|msedge|brave|firefox|opera|vivaldi|\barc\b/i;

function createWindowsBackend(log, getApp) {
    const art = createArtResolver();
    let proc = null;
    let latest = null;
    let latestAt = 0;
    let fatal = null;
    let stopped = false;
    let restartTimer = null;
    let restarts = 0;
    let lastAumid = null;

    const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden'];
    const powershellPath = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encode = lines => Buffer.from(lines.join('\r\n'), 'utf16le').toString('base64');

    function kill() {
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        if (proc) { const p = proc; proc = null; try { p.kill(); } catch (e) { /* gone */ } }
        latest = null;
    }

    function start() {
        if (proc || stopped) return;
        const script = [...PS_PREAMBLE, ...PS_POLL.map(l => l.replace('__PARENT_PID__', String(process.pid)))];
        let child;
        try {
            child = spawn(powershellPath(), [...PS_FLAGS, '-EncodedCommand', encode(script)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            fatal = `Could not start PowerShell: ${err.message}`;
            log.error('local player (windows):', fatal);
            return;
        }
        proc = child;
        latestAt = Date.now();
        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            buffer += chunk;
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                let obj;
                try { obj = JSON.parse(line); } catch (e) { continue; }
                if (obj && obj.fatal) { fatal = obj.fatal; log.error('local player (windows):', obj.fatal); continue; }
                if (obj && obj.error) log.error('local player (windows):', obj.error);
                latest = obj;
                latestAt = Date.now();
                restarts = 0;
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', d => log.error('local player (windows) stderr:', String(d).trim().slice(0, 300)));
        child.on('error', err => { fatal = err.message; log.error('local player (windows):', err.message); });
        child.on('exit', code => {
            if (proc === child) proc = null;
            if (stopped) return;
            const delay = Math.min(30000, 1500 * Math.pow(2, Math.min(restarts++, 4)));
            log.log(`local player (windows): helper exited (${code}), restarting in ${delay}ms`);
            restartTimer = setTimeout(start, delay);
        });
    }

    // Which session is "the" player right now
    function pick(sessions, app) {
        const list = Array.isArray(sessions) ? sessions.filter(s => s && s.title) : [];
        const playing = s => s.status === 'Playing';
        let cands;
        if (app === 'spotify') cands = list.filter(s => SPOTIFY_AUMID.test(s.aumid));
        else if (app === 'ytmusic') cands = list.filter(s => YTM_AUMID.test(s.aumid));
        else cands = [...list.filter(s => SPOTIFY_AUMID.test(s.aumid)), ...list.filter(s => YTM_AUMID.test(s.aumid) && !SPOTIFY_AUMID.test(s.aumid)), ...list];
        return cands.find(playing) || cands[0] || null;
    }

    async function getCurrentTrack() {
        const app = getApp();
        if (fatal && !proc) return { success: false, error: fatal, message: 'Windows media controls are unavailable' };
        start();
        if (!latest) {
            if (proc && Date.now() - latestAt > WIN_STALE_MS * 2) { kill(); start(); }
            return { success: true, track: null, message: 'Looking for your music app…' };
        }
        if (Date.now() - latestAt > WIN_STALE_MS) {
            log.log('local player (windows): helper went quiet, restarting');
            kill();
            start();
            return notRunning(app);
        }
        const d = pick(latest.sessions, app);
        if (!d) return notRunning(app);
        lastAumid = d.aumid;
        const isSpot = SPOTIFY_AUMID.test(d.aumid);
        const status = String(d.status || '');
        if (status === 'Closed' || status === 'Stopped') return nothingPlaying(isSpot ? 'spotify' : 'ytmusic');
        const playing = status === 'Playing';
        const duration = Math.max(0, Math.round(Number(d.duration_ms) || 0));
        let progress = Math.round(Number(d.position_ms) || 0);
        if (playing) {
            progress += Math.max(0, (Number(d.now_ms) || 0) - (Number(d.updated_ms) || 0));
            progress += Date.now() - latestAt;
        }
        if (duration) progress = Math.min(progress, duration);
        const key = `${d.title}|${d.artist}|${d.album}`;
        const albumArt = await art.resolve(d.artist, d.title, d.thumbnail || null);
        return {
            success: true,
            app: isSpot ? 'spotify' : 'ytmusic',
            track: {
                id: `local-${hashId(key)}`, uri: null,
                name: d.title, artist: d.artist || '', artists: splitArtists(d.artist), album: d.album || '',
                album_art: albumArt, duration_ms: duration, progress_ms: Math.max(0, progress), is_playing: playing
            }
        };
    }

    function control(command, positionMs) {
        if (!['play', 'pause', 'next', 'previous', 'seek'].includes(command)) return Promise.resolve({ success: false, command, error: `Unknown command: ${command}` });
        const app = getApp();
        const pattern = lastAumid ? lastAumid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : (app === 'ytmusic' ? YTM_AUMID.source : 'spotify');
        const ticks = Math.round(Math.max(0, Number(positionMs) || 0) * 10000);
        const script = [...PS_PREAMBLE, ...PS_CONTROL.map(l => l.replace('__PATTERN__', pattern.replace(/'/g, "''")).replace('__CMD__', command).replace('__TICKS__', String(ticks)))];
        return new Promise(resolve => {
            execFile(powershellPath(), [...PS_FLAGS, '-EncodedCommand', encode(script)], { timeout: 15000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
                const out = String(stdout || '').trim();
                if (out.includes('NO_SESSION')) return resolve({ success: false, command, error: 'Open your music app and play something first', reason: 'NOT_RUNNING' });
                if (out.includes('OK')) return resolve({ success: true, command });
                if (err && !out) return resolve({ success: false, command, error: `PowerShell failed: ${String(err.message).slice(0, 120)}` });
                resolve({ success: false, command, error: `The player refused the ${command} command` });
            });
        });
    }

    return {
        getCurrentTrack,
        control,
        playTrack: () => Promise.resolve({ success: false, command: 'play', error: 'Playing along on Windows needs Spotify API keys (gear → 🔑) — following the lyrics only', reason: 'UNSUPPORTED' }),
        canPlayTrack: () => false,
        describe: () => {
            const app = getApp();
            if (app === 'ytmusic') return 'YouTube Music on this PC';
            if (app === 'spotify') return 'the Spotify app on this PC';
            return lastAumid && !SPOTIFY_AUMID.test(lastAumid) ? 'YouTube Music on this PC' : 'Spotify or YouTube Music on this PC';
        },
        displayName: () => Promise.resolve(prettyName(process.env.USERNAME || os.userInfo().username)),
        shutdown() { stopped = true; kill(); }
    };
}

// ---------------------------------------------------------------------------
// Public factory. `app`: 'auto' | 'spotify' | 'ytmusic'
// ---------------------------------------------------------------------------
function createLocalPlayer({ log = console, app = 'auto' } = {}) {
    const platform = process.platform;
    let currentApp = ['auto', 'spotify', 'ytmusic'].includes(app) ? app : 'auto';
    const getApp = () => currentApp;
    const backend = platform === 'darwin' ? createMacBackend(log, getApp)
        : platform === 'win32' ? createWindowsBackend(log, getApp)
            : null;
    let profile = null;

    async function getProfile() {
        if (profile) return profile;
        const name = backend ? await backend.displayName() : null;
        profile = { id: 'local', display_name: name || 'A friend' };
        return profile;
    }

    const unsupported = { success: false, error: 'Reading the music app is not supported on this platform' };

    return {
        available: Boolean(backend),
        platform,
        get app() { return currentApp; },
        setApp(next) { if (['auto', 'spotify', 'ytmusic'].includes(next)) currentApp = next; },
        get canPlayTrack() { return Boolean(backend && backend.canPlayTrack()); },
        get description() { return backend ? backend.describe() : null; },
        canQueue: false,
        queueTrack: () => Promise.resolve({ success: false, command: 'queue', error: 'Queueing needs the Web API (gear → 🔑) — press ▶ to play it now instead', reason: 'UNSUPPORTED' }),
        getCurrentTrack: () => backend ? backend.getCurrentTrack() : Promise.resolve({ ...unsupported }),
        control: (command, positionMs) => backend ? backend.control(command, positionMs) : Promise.resolve({ ...unsupported, command }),
        playTrack: (uri, positionMs) => backend ? backend.playTrack(uri, positionMs) : Promise.resolve({ ...unsupported, command: 'play' }),
        getProfile,
        shutdown: () => { if (backend) backend.shutdown(); }
    };
}

module.exports = { createLocalPlayer, PERMISSION_HINT };
