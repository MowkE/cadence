/**
 * Local player — what the Spotify desktop app is playing, read straight from
 * the app on this computer. No Web API, no developer app, no Client ID, and
 * no Premium (Spotify started requiring Premium for developer apps in
 * February 2026, which locked most people out of the API path).
 *
 *   macOS    AppleScript through `osascript`. Full read + control, including
 *            "play this track here" for listen-along guests.
 *   Windows  The system media session (Windows.Media.Control, "SMTC") through
 *            a small PowerShell helper that stays running and prints one JSON
 *            line per second. Read + play/pause/skip/seek. Windows exposes no
 *            track URIs, so guests can't play along through this path.
 *
 * Everything returns the same shapes as lib/spotify.js so the renderer and
 * listen-along can't tell the two apart.
 */

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEP = '\u001f';
const OSA_TIMEOUT_MS = 8000;
const WIN_STALE_MS = 8000;              // no helper output for this long = restart it
const ART_LOOKUP_TIMEOUT_MS = 2500;
const ART_CACHE_MAX = 200;

const PERMISSION_HINT = 'Allow Cadence to control Spotify: System Settings → Privacy & Security → Automation';

const notRunning = () => ({ success: true, track: null, message: 'Open Spotify and play something', not_running: true });
const notInstalled = () => ({ success: true, track: null, message: 'Install the Spotify app to get started', not_installed: true });
const nothingPlaying = () => ({ success: true, track: null, message: 'Play something in Spotify' });

function splitArtists(artist) {
    return String(artist || '').split(/,\s*|\s*[&;]\s*/).map(s => s.trim()).filter(Boolean);
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

// ---------------------------------------------------------------------------
// Album art without Spotify (Windows only — macOS hands us Spotify's own
// artwork URL). iTunes Search first, Deezer as a backup; both are free and
// need no keys. Results are cached per song.
// ---------------------------------------------------------------------------
function normalize(s) {
    return String(s || '').toLowerCase()
        .replace(/\(.*?\)|\[.*?\]/g, ' ')
        .replace(/\bfeat\.?\b.*$/, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(ART_LOOKUP_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function lookupArtItunes(artist, title) {
    const term = `${artist} ${title}`.trim();
    const data = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=6`);
    const wantTitle = normalize(title);
    const wantArtist = normalize(artist).split(' ')[0] || '';
    const results = Array.isArray(data.results) ? data.results : [];
    const pick = results.find(r => normalize(r.trackName).includes(wantTitle) && normalize(r.artistName).includes(wantArtist))
        || results.find(r => normalize(r.trackName) === wantTitle)
        || null;
    if (!pick || !pick.artworkUrl100) return null;
    return pick.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.');
}

async function lookupArtDeezer(artist, title) {
    const clean = s => String(s || '').replace(/"/g, '');
    const q = `artist:"${clean(artist)}" track:"${clean(title)}"`;
    const data = await fetchJson(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=3`);
    const hit = Array.isArray(data.data) && data.data[0];
    if (!hit || !hit.album) return null;
    return hit.album.cover_xl || hit.album.cover_big || hit.album.cover_medium || null;
}

function createArtResolver() {
    const cache = new Map(); // key -> { url: string|null|undefined, promise, waited }

    function remember(key, entry) {
        if (cache.size >= ART_CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(key, entry);
    }

    // Returns quickly: a cached URL, or whatever the lookup finds within the
    // timeout (the first call for a song waits; later ones don't block)
    async function resolve(artist, title, fallback) {
        const key = `${normalize(artist)}|${normalize(title)}`;
        let entry = cache.get(key);
        if (!entry) {
            entry = { url: undefined, promise: null, waited: false };
            entry.promise = (async () => {
                let url = null;
                try { url = await lookupArtItunes(artist, title); } catch (e) { /* try the next one */ }
                if (!url) { try { url = await lookupArtDeezer(artist, title); } catch (e) { /* no art */ } }
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
function createMacBackend(log) {
    let inflight = null;
    let installed = true;
    let installedCheckedAt = 0;

    function isInstalled() {
        const now = Date.now();
        if (now - installedCheckedAt > 60000) {
            installedCheckedAt = now;
            installed = ['/Applications/Spotify.app', path.join(os.homedir(), 'Applications', 'Spotify.app')]
                .some(p => fs.existsSync(p));
        }
        return installed;
    }

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
                    return reject(e);
                }
                resolve(String(stdout || '').replace(/\r?\n$/, ''));
            });
        });
    }

    // One line per -e argument. "is running" never launches Spotify, and
    // resolves to false without a dialog when Spotify isn't installed.
    const STATE_SCRIPT = [
        'if application "Spotify" is not running then return "not-running"',
        'set sep to character id 31',
        'tell application "Spotify"',
        'set playerState to (player state as text)',
        'if playerState is "stopped" then return "stopped"',
        'set t to current track',
        'return playerState & sep & (id of t) & sep & (name of t) & sep & (artist of t) & sep & (album of t) & sep & (duration of t) & sep & (player position) & sep & (artwork url of t)',
        'end tell'
    ];

    // AppleScript formats reals with the system decimal separator ("13,26" in
    // many locales) and may use scientific notation for big values
    function parseReal(s) {
        return Number(String(s || '').trim().replace(',', '.')) || 0;
    }

    function parseState(out) {
        if (out === 'not-running') return isInstalled() ? notRunning() : notInstalled();
        if (out === 'stopped' || !out) return nothingPlaying();
        const parts = out.split(SEP);
        if (parts.length < 8) return { success: false, error: `Unexpected reply from Spotify: ${out.slice(0, 80)}` };
        const [playerState, uri, name, artist, album, duration, position, art] = parts;
        const isSpotifyUri = /^spotify:/.test(uri);
        const albumArt = /^https?:\/\//i.test(art) ? art.replace(/^http:/i, 'https:') : null;
        return {
            success: true,
            track: {
                id: isSpotifyUri ? uri.split(':').pop() : `local-${crypto.createHash('sha1').update(`${name}|${artist}|${album}`).digest('hex').slice(0, 16)}`,
                uri: isSpotifyUri ? uri : null,
                name,
                artist,
                artists: splitArtists(artist),
                album,
                album_art: albumArt,
                duration_ms: Math.max(0, Math.round(parseReal(duration))),
                progress_ms: Math.max(0, Math.round(parseReal(position) * 1000)),
                is_playing: playerState === 'playing'
            }
        };
    }

    function getCurrentTrack() {
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                return parseState(await osascript(STATE_SCRIPT));
            } catch (err) {
                if (err.noTrack) return nothingPlaying();
                if (err.notRunning) return notRunning();
                if (err.permission) return { success: false, error: err.message, needs_permission: true, message: PERMISSION_HINT };
                if (err.timeout) return { success: false, error: 'Spotify did not respond', message: 'Spotify is not responding…' };
                log.error('local player (mac):', err.message);
                return { success: false, error: err.message, message: 'Could not read Spotify' };
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    // AppleScript source always uses "." for decimals, whatever the locale
    const seconds = ms => (Math.max(0, Number(ms) || 0) / 1000).toFixed(3);

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

    const ACTIONS = { play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' };

    function control(command, positionMs) {
        const action = command === 'seek' ? `set player position to ${seconds(positionMs)}` : ACTIONS[command];
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

    function displayName() {
        return new Promise(resolve => {
            execFile('id', ['-F'], { timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
                const full = !err && String(stdout || '').trim();
                resolve(full || prettyName(os.userInfo().username));
            });
        });
    }

    return { getCurrentTrack, control, playTrack, displayName, canPlayTrack: true, shutdown() {} };
}

// ---------------------------------------------------------------------------
// Windows: system media session through a PowerShell helper
// ---------------------------------------------------------------------------
// Windows PowerShell 5.1 can project WinRT types directly; PowerShell 7 can't,
// so the helper is always started from System32. The WinRT async calls are
// awaited through the AsTask extension, the usual trick for scripts.
const PS_PREAMBLE = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$stdout = [Console]::Out',
    'function Emit($obj) { $stdout.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 4)); $stdout.Flush() }',
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
    'try { $mgr = Await ($mgrType::RequestAsync()) $mgrType } catch { Emit @{ fatal = "No media session manager: $($_.Exception.Message)" }; exit 1 }',
    'function FindSpotify() {',
    "  foreach ($s in $mgr.GetSessions()) { if ($s.SourceAppUserModelId -match 'spotify') { return $s } }",
    '  return $null',
    '}'
];

const PS_POLL = [
    '$parentPid = __PARENT_PID__',
    "$lastKey = ''",
    '$lastThumb = $null',
    'while ($true) {',
    '  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { exit 0 }',
    '  $o = @{ running = $false }',
    '  try {',
    '    $spot = FindSpotify',
    '    if ($spot) {',
    '      $o.running = $true',
    '      $props = Await ($spot.TryGetMediaPropertiesAsync()) $propsType',
    '      $tl = $spot.GetTimelineProperties()',
    '      $pb = $spot.GetPlaybackInfo()',
    '      $o.title = [string]$props.Title',
    '      $o.artist = [string]$props.Artist',
    '      $o.album = [string]$props.AlbumTitle',
    '      $o.status = [string]$pb.PlaybackStatus',
    '      $o.position_ms = [long]$tl.Position.TotalMilliseconds',
    '      $o.duration_ms = [long]($tl.EndTime.TotalMilliseconds - $tl.StartTime.TotalMilliseconds)',
    '      $o.updated_ms = [long]$tl.LastUpdatedTime.ToUnixTimeMilliseconds()',
    '      $o.now_ms = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '      $key = "$($o.title)|$($o.artist)|$($o.album)"',
    '      if ($key -ne $lastKey) {',
    '        $lastKey = $key',
    '        $lastThumb = $null',
    '        try {',
    '          if ($props.Thumbnail) {',
    '            $stream = Await ($props.Thumbnail.OpenReadAsync()) $streamType',
    '            $size = [uint32]$stream.Size',
    '            if ($size -gt 0 -and $size -lt 4000000) {',
    '              $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))',
    '              $null = Await ($reader.LoadAsync($size)) ([uint32])',
    '              $bytes = New-Object byte[] $size',
    '              $reader.ReadBytes($bytes)',
    "              $lastThumb = 'data:' + [string]$stream.ContentType + ';base64,' + [Convert]::ToBase64String($bytes)",
    '              $reader.Dispose()',
    '            }',
    '            $stream.Dispose()',
    '          }',
    '        } catch { $o.thumb_error = $_.Exception.Message }',
    '      }',
    '      $o.thumbnail = $lastThumb',
    '    }',
    '  } catch { $o.error = $_.Exception.Message }',
    '  Emit $o',
    '  Start-Sleep -Milliseconds 1000',
    '}'
];

const PS_CONTROL = [
    '$spot = FindSpotify',
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

function createWindowsBackend(log) {
    const art = createArtResolver();
    let proc = null;
    let latest = null;
    let latestAt = 0;
    let fatal = null;
    let stopped = false;
    let restartTimer = null;
    let restarts = 0;

    const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden'];

    function powershellPath() {
        const root = process.env.SystemRoot || 'C:\\Windows';
        return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    }

    function encode(lines) {
        return Buffer.from(lines.join('\r\n'), 'utf16le').toString('base64');
    }

    function kill() {
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        if (proc) {
            const p = proc;
            proc = null;
            try { p.kill(); } catch (e) { /* already gone */ }
        }
        latest = null;
    }

    function start() {
        if (proc || stopped) return;
        const script = [...PS_PREAMBLE, ...PS_POLL.map(l => l.replace('__PARENT_PID__', String(process.pid)))];
        let child;
        try {
            child = spawn(powershellPath(), [...PS_FLAGS, '-EncodedCommand', encode(script)], {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (err) {
            fatal = `Could not start PowerShell: ${err.message}`;
            log.error('local player (windows):', fatal);
            return;
        }
        proc = child;
        latestAt = Date.now(); // give it time to boot before we call it stale

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
                if (obj && obj.fatal) {
                    fatal = obj.fatal;
                    log.error('local player (windows):', obj.fatal);
                    continue;
                }
                if (obj && obj.error) log.error('local player (windows):', obj.error);
                latest = obj;
                latestAt = Date.now();
                restarts = 0;
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', d => log.error('local player (windows) stderr:', String(d).trim().slice(0, 300)));
        child.on('error', err => {
            fatal = err.message;
            log.error('local player (windows):', err.message);
        });
        child.on('exit', code => {
            if (proc === child) proc = null;
            if (stopped) return;
            const delay = Math.min(30000, 1500 * Math.pow(2, Math.min(restarts++, 4)));
            log.log(`local player (windows): helper exited (${code}), restarting in ${delay}ms`);
            restartTimer = setTimeout(start, delay);
        });
    }

    async function getCurrentTrack() {
        if (fatal && !proc) return { success: false, error: fatal, message: 'Windows media controls are unavailable' };
        start();
        if (!latest) {
            if (proc && Date.now() - latestAt > WIN_STALE_MS * 2) { kill(); start(); }
            return { success: true, track: null, message: 'Looking for Spotify…' };
        }
        if (Date.now() - latestAt > WIN_STALE_MS) {
            log.log('local player (windows): helper went quiet, restarting');
            kill();
            start();
            return notRunning();
        }

        const d = latest;
        if (!d.running || !d.title) return notRunning();
        const status = String(d.status || '');
        if (status === 'Closed' || status === 'Stopped') return nothingPlaying();

        const playing = status === 'Playing';
        const duration = Math.max(0, Math.round(Number(d.duration_ms) || 0));
        let progress = Math.round(Number(d.position_ms) || 0);
        if (playing) {
            // Windows stamps LastUpdatedTime on every timeline update, so this
            // is exactly how the system's own media flyout extrapolates
            progress += Math.max(0, (Number(d.now_ms) || 0) - (Number(d.updated_ms) || 0));
            progress += Date.now() - latestAt;
        }
        if (duration) progress = Math.min(progress, duration);

        const key = `${d.title}|${d.artist}|${d.album}`;
        const albumArt = await art.resolve(d.artist, d.title, d.thumbnail || null);
        return {
            success: true,
            track: {
                id: `local-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}`,
                uri: null,
                name: d.title,
                artist: d.artist || '',
                artists: splitArtists(d.artist),
                album: d.album || '',
                album_art: albumArt,
                duration_ms: duration,
                progress_ms: Math.max(0, progress),
                is_playing: playing
            }
        };
    }

    function control(command, positionMs) {
        if (!['play', 'pause', 'next', 'previous', 'seek'].includes(command)) {
            return Promise.resolve({ success: false, command, error: `Unknown command: ${command}` });
        }
        const ticks = Math.round(Math.max(0, Number(positionMs) || 0) * 10000);
        const script = [...PS_PREAMBLE, ...PS_CONTROL.map(l => l.replace('__CMD__', command).replace('__TICKS__', String(ticks)))];
        return new Promise(resolve => {
            execFile(powershellPath(), [...PS_FLAGS, '-EncodedCommand', encode(script)],
                { timeout: 15000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
                    const out = String(stdout || '').trim();
                    if (out.includes('NO_SESSION')) return resolve({ success: false, command, error: 'Open Spotify and play something first', reason: 'NOT_RUNNING' });
                    if (out.includes('OK')) return resolve({ success: true, command });
                    if (err && !out) return resolve({ success: false, command, error: `PowerShell failed: ${String(err.message).slice(0, 120)}` });
                    resolve({ success: false, command, error: `Spotify refused the ${command} command` });
                });
        });
    }

    function playTrack() {
        return Promise.resolve({
            success: false,
            command: 'play',
            error: 'Playing along on Windows needs Spotify API keys (gear → 🔑) — following the lyrics only',
            reason: 'UNSUPPORTED'
        });
    }

    function displayName() {
        return Promise.resolve(prettyName(process.env.USERNAME || os.userInfo().username));
    }

    function shutdown() {
        stopped = true;
        kill();
    }

    return { getCurrentTrack, control, playTrack, displayName, canPlayTrack: false, shutdown };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------
function createLocalPlayer({ log = console } = {}) {
    const platform = process.platform;
    const backend = platform === 'darwin' ? createMacBackend(log)
        : platform === 'win32' ? createWindowsBackend(log)
            : null;
    let profile = null;

    async function getProfile() {
        if (profile) return profile;
        const name = backend ? await backend.displayName() : null;
        profile = { id: 'local', display_name: name || 'A friend' };
        return profile;
    }

    const unsupported = { success: false, error: 'Reading the Spotify app is not supported on this platform' };

    return {
        available: Boolean(backend),
        platform,
        canPlayTrack: Boolean(backend && backend.canPlayTrack),
        description: platform === 'darwin' ? 'the Spotify app on this Mac'
            : platform === 'win32' ? 'the Spotify app on this PC'
                : null,
        getCurrentTrack: () => backend ? backend.getCurrentTrack() : Promise.resolve({ ...unsupported }),
        control: (command, positionMs) => backend ? backend.control(command, positionMs) : Promise.resolve({ ...unsupported, command }),
        playTrack: (uri, positionMs) => backend ? backend.playTrack(uri, positionMs) : Promise.resolve({ ...unsupported, command: 'play' }),
        getProfile,
        shutdown: () => { if (backend) backend.shutdown(); }
    };
}

module.exports = { createLocalPlayer, PERMISSION_HINT };
