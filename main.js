/**
 * Cadence — Electron main process
 *
 * - Transparent, frameless, always-on-top, click-through overlay window
 * - Now playing from the Spotify app on this computer (lib/local-player.js) —
 *   no developer app or Premium needed — or from the Web API (lib/spotify.js)
 * - Synced lyrics from LRCLIB (lib/lyrics.js), Genius as fallback
 * - Listen along: share a code/link, friends follow your lyrics (lib/listen-along.js)
 * - Tray icon (the only way to quit on Windows), cadence:// deep links
 */

const { app, BrowserWindow, ipcMain, screen, powerMonitor, shell, Tray, Menu, nativeImage, clipboard, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cheerio = require('cheerio');

const { createSpotifyClient } = require('./lib/spotify');
const { getSyncedLyrics } = require('./lib/lyrics');
const { createListenAlong } = require('./lib/listen-along');
const { createLocalPlayer } = require('./lib/local-player');
const { parseSpotifyLink, isShortLink, resolveShortLink, resolveTrackMeta } = require('./lib/spotify-link');

// .env is a development convenience only — user credentials live in a
// per-user config file (see loadCredentials)
if (!app.isPackaged) {
    try { require('dotenv').config(); } catch (e) { /* optional */ }
}

// Isolated data folder (settings, tokens, stats, single-instance lock) so a
// dev copy can run next to the installed app without touching its data
if (process.env.CADENCE_USER_DATA) {
    app.setPath('userData', process.env.CADENCE_USER_DATA);
    app.setPath('sessionData', process.env.CADENCE_USER_DATA);
}

// ============================================================================
// SINGLE INSTANCE + cadence:// PROTOCOL
// ============================================================================
const PROTOCOL = 'cadence';
let pendingDeepLink = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, argv) => {
        // Windows/Linux: a second launch (e.g. clicking a cadence:// link) hands us its argv
        const link = argv.find(a => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`));
        if (link) handleDeepLink(link);
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
        }
    });
}

if (process.defaultApp) {
    // Running from source (`electron .`): register with the script path so the
    // OS can hand links back to this exact app
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient(PROTOCOL);
}

// macOS delivers links through open-url (also before ready)
app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
});

function handleDeepLink(url) {
    if (!url) return;
    if (!listenAlong || !mainWindow) {
        pendingDeepLink = url;
        return;
    }
    const code = listenAlong.parseCode(url);
    if (!code) return;
    console.log('Joining listen-along session from link');
    listenAlong.join(code).then(() => {
        if (mainWindow) mainWindow.webContents.send('open-settings');
    });
}

// ============================================================================
// PATHS + SMALL SETTINGS FILE
// ============================================================================
const userDataPath = () => app.getPath('userData');
const credentialsPath = () => path.join(userDataPath(), 'spotify-credentials.json');
const tokenPath = () => path.join(userDataPath(), 'spotify-tokens.json');
const settingsPath = () => path.join(userDataPath(), 'settings.json');
const statsPath = () => path.join(userDataPath(), 'daily-stats.json');

// Where the old Python helper (spotipy) cached tokens — imported once so
// nobody has to re-approve the app after the upgrade
function legacyTokenCaches() {
    const home = os.homedir();
    return [
        path.join(home, 'Library', 'Caches', 'LyricsOverlay', '.spotify_cache'),
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'LyricsOverlay', 'LyricsOverlay', 'Cache', '.spotify_cache'),
        path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'LyricsOverlay', '.spotify_cache')
    ];
}

// source: where "now playing" comes from — 'auto' (the Web API while it's
// connected, otherwise the Spotify app on this computer), 'local' or 'api'.
// clickThroughLock: the overlay never captures the mouse unless a panel is
// open (Settings then comes from the tray icon or Ctrl/Cmd+Shift+L).
// displayName: what listen-along friends see (blank = Spotify / account name).
// hotkeyToggle / hotkeySettings: global shortcuts (Electron accelerators).
let settings = {
    relay: null,
    source: 'auto',
    clickThroughLock: false,
    roomVote: false,
    displayName: '',
    hotkeyToggle: 'CommandOrControl+Shift+H',
    hotkeySettings: 'CommandOrControl+Shift+L'
};
function loadSettings() {
    try {
        settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
    } catch (e) { /* defaults */ }
    delete settings.share; // webhook sharing was removed in 2.3.1
    if (process.env.CADENCE_RELAY) settings.relay = process.env.CADENCE_RELAY;
    if (process.env.CADENCE_SOURCE) settings.source = process.env.CADENCE_SOURCE;
}

function saveSettings() {
    try {
        fs.mkdirSync(userDataPath(), { recursive: true });
        fs.writeFileSync(settingsPath(), JSON.stringify(settings), { mode: 0o600 });
    } catch (e) {
        console.error('Could not save settings:', e.message);
    }
}

// ============================================================================
// SPOTIFY CREDENTIALS (per-user config file, set via the in-app setup UI)
// ============================================================================
let SPOTIFY_CLIENT_ID = '';
let SPOTIFY_CLIENT_SECRET = '';

function loadCredentials() {
    try {
        const saved = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
        if (saved.clientId && saved.clientSecret) {
            SPOTIFY_CLIENT_ID = saved.clientId;
            SPOTIFY_CLIENT_SECRET = saved.clientSecret;
            return;
        }
    } catch (e) {
        // No saved credentials yet
    }

    // Development fallback: migrate .env credentials into the config file
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
        SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
        SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
        writeCredentials(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET);
    }
}

function writeCredentials(clientId, clientSecret) {
    try {
        fs.mkdirSync(userDataPath(), { recursive: true });
        fs.writeFileSync(credentialsPath(), JSON.stringify({ clientId, clientSecret }), { mode: 0o600 });
    } catch (e) {
        console.error('Could not save credentials:', e.message);
    }
}

function credentialsConfigured() {
    return Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
}

// ============================================================================
// SPOTIFY + LISTEN ALONG CLIENTS
// ============================================================================
let spotify = null;
let localPlayer = null;
let listenAlong = null;

function createClients() {
    localPlayer = createLocalPlayer();

    spotify = createSpotifyClient({
        tokenFile: tokenPath(),
        getCredentials: () => ({ clientId: SPOTIFY_CLIENT_ID, clientSecret: SPOTIFY_CLIENT_SECRET }),
        openExternal: (url) => shell.openExternal(url),
        legacyCacheFiles: legacyTokenCaches()
    });

    spotify.onAuth((result) => {
        console.log('Spotify auth finished:', result.success ? 'connected' : result.error);
        if (mainWindow) mainWindow.webContents.send('spotify-auth', result);
        if (mainWindow && !mainWindow.isDestroyed()) {
            // Bring the overlay back to the front after the browser dance
            mainWindow.show();
        }
    });

    listenAlong = createListenAlong({
        getRelayBase: () => settings.relay,
        player,
        getDisplayName,
        onStatus: (status) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('listen-along-status', status);
            updateTrayMenu();
        },
        // Karaoke & games traffic goes straight to the renderer, which owns the rules
        onGame: (msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('listen-along-game', msg);
        }
    });
    listenAlong.setRoomVote(Boolean(settings.roomVote));
}

// ============================================================================
// PLAYER: which source feeds "now playing" and playback control
// ============================================================================
const SOURCES = ['auto', 'local', 'ytmusic', 'api'];

function sourcePreference() {
    return SOURCES.includes(settings.source) ? settings.source : 'auto';
}

function apiReady() {
    return credentialsConfigured() && Boolean(spotify && spotify.isConnected());
}

// 'auto' keeps the API for people who already connected it and reads the
// Spotify app on this computer for everyone else
function resolveSource() {
    const pref = sourcePreference();
    const localOk = Boolean(localPlayer && localPlayer.available);
    // Which app the local player reads: Spotify, YouTube Music, or whichever is playing
    if (localPlayer) localPlayer.setApp(pref === 'ytmusic' ? 'ytmusic' : pref === 'local' ? 'spotify' : 'auto');
    if (pref === 'api') return 'api';
    if (pref === 'local' || pref === 'ytmusic') return localOk ? 'local' : 'api';
    if (apiReady()) return 'api';
    return localOk ? 'local' : 'api';
}

// One object for everything downstream (IPC, listen along) — each call goes
// to the API client or the local player depending on the current source
const player = {
    source: resolveSource,
    isConnected: () => resolveSource() === 'local' || spotify.isConnected(),
    getCurrentTrack: () => resolveSource() === 'local' ? localPlayer.getCurrentTrack() : spotify.getCurrentTrack(),
    control: (command, positionMs) => resolveSource() === 'local'
        ? localPlayer.control(command, positionMs)
        : spotify.control(command, positionMs),
    playTrack: (uri, positionMs) => resolveSource() === 'local'
        ? localPlayer.playTrack(uri, positionMs)
        : spotify.playTrack(uri, positionMs),
    getProfile: () => resolveSource() === 'local' ? localPlayer.getProfile() : spotify.getProfile(),
    queueTrack: (uri) => resolveSource() === 'local' ? localPlayer.queueTrack(uri) : spotify.queueTrack(uri),
    // Only the Web API can add to the queue
    canQueue: () => resolveSource() === 'api' && Boolean(spotify && spotify.isConnected())
};

// What friends see in listen along: the name from settings, else the Spotify
// display name (API) or the account name on this computer (local)
let lastKnownName = null;
async function getDisplayName() {
    const custom = String(settings.displayName || '').trim();
    if (custom) return custom.slice(0, 40);
    try {
        const profile = await player.getProfile();
        lastKnownName = profile && profile.display_name ? profile.display_name : null;
    } catch (e) {
        lastKnownName = null;
    }
    return lastKnownName;
}

function playerInfo() {
    return {
        configured: credentialsConfigured(),
        connected: spotify ? spotify.isConnected() : false,
        source: sourcePreference(),
        active: resolveSource(),
        localAvailable: Boolean(localPlayer && localPlayer.available),
        localDescription: localPlayer ? localPlayer.description : null,
        localCanPlayTrack: Boolean(localPlayer && localPlayer.canPlayTrack),
        localApp: localPlayer ? localPlayer.app : null,
        canQueue: player.canQueue(),
        platform: process.platform,
        clickThroughLock: Boolean(settings.clickThroughLock),
        displayName: settings.displayName || '',
        nameHint: lastKnownName,
        hotkeys: { toggle: settings.hotkeyToggle || '', settings: settings.hotkeySettings || '', errors: hotkeyErrors }
    };
}

ipcMain.handle('set-display-name', (event, name) => {
    settings.displayName = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
    saveSettings();
    return playerInfo();
});

// ============================================================================
// GLOBAL SHORTCUTS (show/hide overlay, open settings) — user-configurable
// ============================================================================
function toggleOverlay() {
    if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
    if (mainWindow.isVisible()) mainWindow.hide();
    else mainWindow.show();
}

function openSettingsPanel() {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    mainWindow.show();
    mainWindow.webContents.send('toggle-settings');
}

let hotkeyErrors = {};
function registerHotkeys() {
    globalShortcut.unregisterAll();
    hotkeyErrors = {};
    const tryRegister = (key, accelerator, handler) => {
        const accel = String(accelerator || '').trim();
        if (!accel) return;
        try {
            if (!globalShortcut.register(accel, handler)) hotkeyErrors[key] = 'already taken by another app';
        } catch (e) {
            hotkeyErrors[key] = 'not a valid shortcut';
        }
    };
    tryRegister('toggle', settings.hotkeyToggle, toggleOverlay);
    tryRegister('settings', settings.hotkeySettings, openSettingsPanel);
    for (const [key, err] of Object.entries(hotkeyErrors)) console.error(`Shortcut "${key}": ${err}`);
    return hotkeyErrors;
}

ipcMain.handle('set-hotkeys', (event, { toggle, settings: settingsKey } = {}) => {
    settings.hotkeyToggle = String(toggle || '').trim().slice(0, 60);
    settings.hotkeySettings = String(settingsKey || '').trim().slice(0, 60);
    saveSettings();
    registerHotkeys();
    return playerInfo();
});


ipcMain.handle('get-credentials-status', () => playerInfo());

ipcMain.handle('set-player-source', (event, source) => {
    settings.source = SOURCES.includes(source) ? source : 'auto';
    saveSettings();
    console.log('Now-playing source:', settings.source, '→', resolveSource());
    return playerInfo();
});

ipcMain.handle('set-click-through-lock', (event, on) => {
    setClickThroughLock(Boolean(on));
    return playerInfo();
});

ipcMain.handle('save-credentials', async (event, { clientId, clientSecret }) => {
    SPOTIFY_CLIENT_ID = String(clientId || '').trim();
    SPOTIFY_CLIENT_SECRET = String(clientSecret || '').trim();

    if (!credentialsConfigured()) {
        return { success: false, error: 'Both fields are required' };
    }

    writeCredentials(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET);

    // Drop any tokens from previous credentials, then kick off OAuth
    // (opens the user's browser for Spotify approval)
    spotify.clearTokens();
    const auth = await spotify.startAuth();
    return auth.success ? { success: true } : { success: false, error: auth.error };
});

// ============================================================================
// WINDOW
// ============================================================================
// Includes headroom margin so the 3D-tilted card never clips against the
// window bounds
const WINDOW_WIDTH = 960;
const WINDOW_HEIGHT = 520;

let mainWindow = null;
let tray = null;
let lastPlayingAt = 0;
let windowScale = 1;
let ambientActive = false;
let ambientSavedBounds = null;
let shuttingDown = false;

// Windows won't resize a non-resizable window programmatically in some
// configurations, so briefly lift the flag around every bounds change
function setWindowBounds(bounds) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wasResizable = mainWindow.isResizable();
    if (!wasResizable) mainWindow.setResizable(true);
    mainWindow.setBounds(bounds);
    if (!wasResizable) mainWindow.setResizable(false);
}

// Karaoke / duet fill the screen the same way ambient mode does; the two
// never overlap (ambient waits while this is on)
let fullscreenActive = false;
let fullscreenSavedBounds = null;

function setOverlayFullscreen(on) {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    on = Boolean(on);
    if (on && !fullscreenActive) {
        fullscreenActive = true;
        if (ambientActive) {
            // Already expanded for ambient mode: take over its saved bounds
            fullscreenSavedBounds = ambientSavedBounds;
            ambientActive = false;
            ambientSavedBounds = null;
            mainWindow.webContents.send('ambient-mode', false);
        } else {
            fullscreenSavedBounds = mainWindow.getBounds();
            setWindowBounds(screen.getDisplayMatching(mainWindow.getBounds()).bounds);
        }
    } else if (!on && fullscreenActive) {
        fullscreenActive = false;
        if (fullscreenSavedBounds) setWindowBounds(fullscreenSavedBounds);
        fullscreenSavedBounds = null;
    }
    return fullscreenActive;
}

ipcMain.handle('overlay-fullscreen', (event, on) => setOverlayFullscreen(on));

// Notch bar: a slim strip pinned to the top-centre of the screen — around
// the camera notch on MacBooks — Dynamic Island style. Fixed size (the Size
// dial doesn't apply); grows downward while a panel is open so settings fit.
const NOTCH_WIDTH = 600;
const NOTCH_LYRIC_ROW = 46;
const NOTCH_PANEL_HEIGHT = 620;
let notchActive = false;
let notchSavedBounds = null;

function notchTopBar(display) {
    if (process.platform !== 'darwin') return 30;
    // The work area starts below the menu bar; notch Macs have a taller one
    return Math.max(24, display.workArea.y - display.bounds.y);
}

function setNotchLayout(on) {
    if (!mainWindow || mainWindow.isDestroyed()) return { active: notchActive };
    on = Boolean(on);
    const display = screen.getDisplayMatching(mainWindow.getBounds());
    const topBar = notchTopBar(display);
    const hasNotch = process.platform === 'darwin' && topBar >= 32;
    let spacer = topBar;
    if (on) {
        if (!notchActive) {
            notchActive = true;
            notchSavedBounds = mainWindow.getBounds();
        }
        if (!fullscreenActive) {
            const x = Math.round(display.bounds.x + (display.bounds.width - NOTCH_WIDTH) / 2);
            setWindowBounds({ x, y: display.bounds.y, width: NOTCH_WIDTH, height: panelOpen ? NOTCH_PANEL_HEIGHT : topBar + NOTCH_LYRIC_ROW });
            // macOS keeps windows below the menu bar. If we were pushed down,
            // the strip already starts under the notch — drop the spacer.
            if (mainWindow.getBounds().y > display.bounds.y) {
                spacer = 0;
                setWindowBounds({ x, y: mainWindow.getBounds().y, width: NOTCH_WIDTH, height: panelOpen ? NOTCH_PANEL_HEIGHT : NOTCH_LYRIC_ROW });
            }
        }
    } else if (notchActive) {
        notchActive = false;
        if (notchSavedBounds && !fullscreenActive) {
            // Back where it was, sized by the current Size setting
            setWindowBounds(notchSavedBounds);
            applyWindowScale(windowScale);
        }
        notchSavedBounds = null;
    }
    return { active: notchActive, topBar: spacer, hasNotch, width: NOTCH_WIDTH, lyricRow: NOTCH_LYRIC_ROW };
}

ipcMain.handle('notch-layout', (event, on) => setNotchLayout(on));

function createWindow() {
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        x: screenWidth - WINDOW_WIDTH - 20, // Position near right edge
        y: screenHeight - WINDOW_HEIGHT - 20, // Position near bottom
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        resizable: false,
        skipTaskbar: true,
        focusable: true,
        show: false,
        title: 'Cadence',
        icon: appIconPath(),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Enable click-through by default
    mainWindow.setIgnoreMouseEvents(true, { forward: true });

    // Float above fullscreen apps and follow across Spaces (the workspace
    // call is a no-op outside macOS)
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
    mainWindow.once('ready-to-show', () => mainWindow.show());

    // Open DevTools in development (uncomment for debugging)
    // mainWindow.webContents.openDevTools({ mode: 'detach' });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ============================================================================
// TRAY (menu bar on macOS, notification area on Windows)
// ============================================================================
function appIconPath() {
    return path.join(__dirname, 'assets', 'icon.png');
}

function trayIcon() {
    const file = path.join(__dirname, 'assets', process.platform === 'darwin' ? 'tray.png' : 'icon.png');
    let image = nativeImage.createFromPath(file);
    if (image.isEmpty()) image = nativeImage.createFromPath(appIconPath());
    if (process.platform === 'win32') image = image.resize({ width: 16, height: 16 });
    return image;
}

function createTray() {
    try {
        tray = new Tray(trayIcon());
        tray.setToolTip('Cadence');
        updateTrayMenu();
        tray.on('click', () => {
            if (process.platform === 'win32' && mainWindow) {
                mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
            }
        });
    } catch (e) {
        console.error('Could not create tray icon:', e.message);
    }
}

function updateTrayMenu() {
    if (!tray) return;
    const la = listenAlong ? listenAlong.status() : { mode: 'off' };
    const sessionLabel = la.mode === 'host'
        ? `Hosting ${la.code} · ${la.listeners} listening`
        : la.mode === 'guest'
            ? `Listening with ${la.hostName || 'a friend'}`
            : null;

    const menu = Menu.buildFromTemplate([
        { label: 'Cadence', enabled: false },
        { type: 'separator' },
        {
            label: 'Show overlay',
            click: () => { if (mainWindow) mainWindow.show(); else createWindow(); }
        },
        {
            label: 'Hide overlay',
            click: () => { if (mainWindow) mainWindow.hide(); }
        },
        {
            label: 'Settings',
            click: () => {
                if (!mainWindow) createWindow();
                mainWindow.show();
                mainWindow.webContents.send('open-settings');
            }
        },
        {
            label: 'Click-through lock',
            type: 'checkbox',
            checked: Boolean(settings.clickThroughLock),
            click: (item) => setClickThroughLock(item.checked)
        },
        { type: 'separator' },
        ...(sessionLabel ? [
            { label: sessionLabel, enabled: false },
            ...(la.mode === 'host' ? [{ label: 'Copy invite link', click: () => clipboard.writeText(la.link) }] : []),
            {
                label: la.mode === 'host' ? 'End session' : 'Leave session',
                click: () => listenAlong.leave()
            },
            { type: 'separator' }
        ] : []),
        { label: 'Quit Cadence', click: () => app.quit() }
    ]);
    tray.setContextMenu(menu);
}

// ============================================================================
// IPC HANDLERS - Communication between Main and Renderer
// ============================================================================

// Click-through. The renderer asks to capture the mouse while the cursor is
// over something interactive; with the click-through lock on, that's only
// honoured while a panel (settings / setup / recap) is open, so the lyrics
// can never sit in the way of whatever is underneath.
let rendererWantsIgnore = true;
let panelOpen = false;

function applyMouseIgnore() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const ignore = settings.clickThroughLock && !panelOpen ? true : rendererWantsIgnore;
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
}

function setClickThroughLock(on) {
    settings.clickThroughLock = Boolean(on);
    saveSettings();
    applyMouseIgnore();
    updateTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('player-info', playerInfo());
}

ipcMain.on('set-ignore-mouse', (event, ignore) => {
    rendererWantsIgnore = Boolean(ignore);
    applyMouseIgnore();
});

ipcMain.on('panel-open', (event, open) => {
    panelOpen = Boolean(open);
    applyMouseIgnore();
    // The notch strip is too short for a panel: grow while one is open
    if (notchActive) setNotchLayout(true);
});

// Move window by delta (for drag-to-move feature)
ipcMain.on('move-window', (event, { deltaX, deltaY }) => {
    if (mainWindow) {
        const [x, y] = mainWindow.getPosition();
        mainWindow.setPosition(x + deltaX, y + deltaY);
    }
});

// Playback control (play / pause / next / previous / seek)
ipcMain.handle('playback-control', async (event, command, positionMs) => {
    return player.control(command, positionMs);
});

// Scale the window (Size slider / presets / corner drag). Clamped so the
// overlay always fits the screen; returns the factor actually applied so the
// renderer's zoom stays in step with the window.
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;

function applyWindowScale(factor) {
    let f = Number(factor);
    if (!Number.isFinite(f)) f = 1;
    const display = mainWindow && !mainWindow.isDestroyed()
        ? screen.getDisplayMatching(mainWindow.getBounds())
        : screen.getPrimaryDisplay();
    const area = display.workArea;
    const fit = Math.min((area.width - 16) / WINDOW_WIDTH, (area.height - 16) / WINDOW_HEIGHT);
    windowScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fit, f));

    if (mainWindow && !mainWindow.isDestroyed() && !ambientActive && !fullscreenActive && !notchActive) {
        const [x, y] = mainWindow.getPosition();
        const width = Math.round(WINDOW_WIDTH * windowScale);
        const height = Math.round(WINDOW_HEIGHT * windowScale);
        // Keep the whole overlay on screen as it grows
        const nx = Math.max(area.x, Math.min(x, area.x + area.width - width));
        const ny = Math.max(area.y, Math.min(y, area.y + area.height - height));
        setWindowBounds({ x: nx, y: ny, width, height });
    }
    return windowScale;
}

ipcMain.handle('resize-window', (event, factor) => applyWindowScale(factor));

// Manual Spotify token refresh (triggered by UI button)
ipcMain.handle('refresh-spotify-token', async () => {
    console.log('Manual Spotify token refresh requested...');
    if (!credentialsConfigured()) {
        return { success: false, error: 'Add your Spotify API keys first (🔑)' };
    }
    return spotify.forceRefresh();
});

// Current track: the host's when we're a listen-along guest, otherwise our own
ipcMain.handle('get-current-track', async () => {
    if (listenAlong.isGuest()) {
        return listenAlong.guestTrackResult();
    }
    const source = resolveSource();
    let result;
    if (source === 'local') {
        result = await localPlayer.getCurrentTrack();
    } else {
        if (!credentialsConfigured()) {
            return { success: false, error: 'Spotify API keys not set', needs_setup: true, source };
        }
        result = await spotify.getCurrentTrack();
    }
    result.source = source;
    recordPlayback(result);
    listenAlong.onHostPoll(result);
    return result;
});

// Audio analysis (Spotify retired this for most apps; degrades to null)
ipcMain.handle('get-audio-analysis', async (event, trackId) => {
    if (!trackId || !credentialsConfigured() || !spotify.isConnected()) return null;
    return spotify.getAudioAnalysis(trackId);
});

// Synced lyrics from LRCLIB (free, no auth required)
ipcMain.handle('get-synced-lyrics', async (event, { trackName, artistName, albumName, durationMs }) => {
    console.log(`Fetching lyrics for: ${trackName} by ${artistName}`);
    const result = await getSyncedLyrics({ trackName, artistName, albumName, durationMs });
    if (result.success) {
        console.log(`Loaded ${result.lines.length} lyrics (${result.syncType})`);
    } else {
        console.log('Lyrics error:', result.error);
    }
    return result;
});

// ============================================================================
// LISTEN ALONG IPC
// ============================================================================
ipcMain.handle('listen-along-status', () => listenAlong.status());
ipcMain.handle('listen-along-host', () => listenAlong.startHost());
ipcMain.handle('listen-along-join', (event, code) => listenAlong.join(code));
ipcMain.handle('listen-along-leave', () => listenAlong.leave().then(() => listenAlong.status()));
ipcMain.handle('listen-along-mirror', (event, on) => listenAlong.setMirror(on));

// Guest: request a song — a pasted Spotify link, or whatever I'm playing
ipcMain.handle('listen-along-request', async (event, { link, current } = {}) => {
    let track;
    if (current) {
        const r = await player.getCurrentTrack();
        if (!r || !r.success || !r.track) return { success: false, error: 'Nothing is playing on your Spotify' };
        if (!r.track.uri) return { success: false, error: "Your Spotify doesn't expose track links here — paste a Spotify link instead" };
        track = r.track;
    } else {
        let parsed = parseSpotifyLink(link);
        if (!parsed && isShortLink(link)) parsed = await resolveShortLink(link);
        if (!parsed) return { success: false, error: 'Paste a Spotify song link (Share → Copy Song Link)' };
        const meta = await resolveTrackMeta(parsed);
        track = {
            uri: parsed.uri,
            id: parsed.id,
            ...(meta || { name: parsed.type === 'episode' ? 'Podcast episode' : 'Spotify track', artist: '', album: '', album_art: null, duration_ms: 0 })
        };
    }
    return listenAlong.request(track);
});

// Host: play / queue / dismiss a request
ipcMain.handle('listen-along-request-action', (event, reqId, action) => listenAlong.requestAction(String(reqId || ''), String(action || '')));

// Host: hand the session to a listener (and stay on as one)
ipcMain.handle('listen-along-handoff', (event, toId) => listenAlong.handoff(String(toId || '')));

// Room vote: the host lets the room pick the next song; everyone casts
ipcMain.handle('listen-along-room-vote', (event, on) => {
    settings.roomVote = Boolean(on);
    saveSettings();
    return listenAlong.setRoomVote(settings.roomVote);
});
ipcMain.handle('listen-along-cast-vote', (event, pick) => listenAlong.castVote(String(pick || '')));

// Karaoke & games: renderer-defined messages to everyone in the session
ipcMain.handle('listen-along-game', (event, payload) => {
    if (!payload || typeof payload !== 'object') return { success: false, error: 'Bad payload' };
    return listenAlong.sendGame(payload);
});
ipcMain.handle('copy-text', (event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
});
ipcMain.handle('open-external', (event, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
    return true;
});

// ============================================================================
// GENIUS LYRICS SCRAPER (unsynced fallback)
// ============================================================================
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function scrapeGeniusLyrics(artist, title) {
    try {
        // Normalize the search terms
        const normalizedArtist = artist
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '-');
        const normalizedTitle = title
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');

        const url = `https://genius.com/${normalizedArtist}-${normalizedTitle}-lyrics`;
        console.log('Fetching lyrics from:', url);

        const response = await fetch(url, {
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            console.log('Genius returned status:', response.status);
            return null;
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        // Genius stores lyrics in containers with data-lyrics-container attribute
        const lyricsContainers = $('[data-lyrics-container="true"]');

        if (lyricsContainers.length === 0) {
            console.log('No lyrics containers found');
            return null;
        }

        let lyrics = [];
        lyricsContainers.each((i, container) => {
            // Genius embeds a contributor/description header inside the first container
            $(container).find('div[class*="LyricsHeader"]').remove();
            // Preserve line breaks, then let cheerio strip tags and decode entities
            $(container).find('br').replaceWith('\n');
            const text = $(container).text().trim();
            if (text) {
                lyrics.push(text);
            }
        });

        const fullLyrics = lyrics.join('\n\n');

        // Split into lines for karaoke display
        const lines = fullLyrics
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('['));

        return {
            lines,
            source: 'genius',
            fullText: fullLyrics
        };

    } catch (error) {
        console.error('Genius scraping error:', error.message);
        return null;
    }
}

// IPC handler for lyrics
ipcMain.handle('get-lyrics', async (event, { artist, title }) => {
    // First try Genius
    const geniusLyrics = await scrapeGeniusLyrics(artist, title);
    if (geniusLyrics) {
        return geniusLyrics;
    }

    // Return placeholder if no lyrics found
    return {
        lines: [
            '♪ No lyrics found ♪',
            '',
            `Now playing: ${title}`,
            `by ${artist}`
        ],
        source: 'none',
        fullText: ''
    };
});

// ============================================================================
// LYRICS TRANSLATION (Google translate gtx endpoint, batched by newline)
// ============================================================================
ipcMain.handle('translate-lyrics', async (event, { lines }) => {
    try {
        const CHUNK = 35;
        const out = new Array(lines.length).fill(null);
        let detectedLang = null;

        for (let i = 0; i < lines.length; i += CHUNK) {
            const chunk = lines.slice(i, i + CHUNK);
            const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q='
                + encodeURIComponent(chunk.join('\n'));

            const response = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(10000) });
            if (!response.ok) {
                throw new Error(`Translate returned status ${response.status}`);
            }

            const data = await response.json();
            detectedLang = data[2] || detectedLang;

            // Segments concatenated form the full text; newlines map back to lines
            const joined = (data[0] || []).map(seg => seg[0]).join('');
            const parts = joined.split('\n');
            if (parts.length === chunk.length) {
                parts.forEach((part, j) => {
                    const translated = part.trim();
                    // Skip lines the translator left unchanged
                    if (translated && translated.toLowerCase() !== chunk[j].trim().toLowerCase()) {
                        out[i + j] = translated;
                    }
                });
            }
        }

        return { success: true, detectedLang, lines: out };
    } catch (error) {
        console.error('Translation error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================================================
// DAILY LISTENING STATS (for the recap card)
// ============================================================================
let dailyStats = null;
let statsDirty = false;

function todayKey() {
    return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
}

function loadDailyStats() {
    if (dailyStats) return dailyStats;
    try {
        dailyStats = JSON.parse(fs.readFileSync(statsPath(), 'utf8'));
    } catch (e) {
        dailyStats = null;
    }
    return dailyStats;
}

function recordPlayback(result) {
    if (!result || !result.success || !result.track || !result.track.is_playing) return;

    const track = result.track;
    loadDailyStats();

    if (!dailyStats || dailyStats.date !== todayKey()) {
        dailyStats = { date: todayKey(), listenMs: 0, lastTrackId: null, tracks: {} };
    }

    lastPlayingAt = Date.now();

    // Each playing poll response represents ~2s of listening
    dailyStats.listenMs += 2000;

    if (dailyStats.lastTrackId !== track.id) {
        dailyStats.lastTrackId = track.id;
        if (!dailyStats.tracks[track.id]) {
            dailyStats.tracks[track.id] = { name: track.name, artist: track.artist, plays: 0 };
        }
        dailyStats.tracks[track.id].plays++;
    }

    statsDirty = true;
}

function saveDailyStats() {
    if (!statsDirty || !dailyStats) return;
    try {
        fs.writeFileSync(statsPath(), JSON.stringify(dailyStats));
        statsDirty = false;
    } catch (e) {
        console.error('Could not save daily stats:', e.message);
    }
}

setInterval(saveDailyStats, 15000);

ipcMain.handle('get-daily-recap', async () => {
    loadDailyStats();

    if (!dailyStats || dailyStats.date !== todayKey()) {
        return { success: true, empty: true };
    }

    const tracks = Object.values(dailyStats.tracks);
    const artistPlays = {};
    let topTrack = null;

    for (const t of tracks) {
        artistPlays[t.artist] = (artistPlays[t.artist] || 0) + t.plays;
        if (!topTrack || t.plays > topTrack.plays) topTrack = t;
    }

    const topArtist = Object.entries(artistPlays).sort((a, b) => b[1] - a[1])[0];

    return {
        success: true,
        empty: tracks.length === 0,
        listenMs: dailyStats.listenMs,
        totalPlays: tracks.reduce((sum, t) => sum + t.plays, 0),
        uniqueTracks: tracks.length,
        topArtist: topArtist ? topArtist[0] : null,
        topTrack: topTrack ? `${topTrack.name} — ${topTrack.artist}` : null
    };
});

// Save user preferences (the renderer keeps them in localStorage; this is a
// hook for anything the main process cares about)
ipcMain.handle('save-preferences', async (event, preferences) => {
    return true;
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================
app.whenReady().then(() => {
    if (!gotTheLock) return; // another Cadence is already running; we're quitting

    // Frameless window: no menu bar needed anywhere but macOS (where the
    // default menu supplies Cmd+Q / Cmd+C / Cmd+V)
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

    loadSettings();
    loadCredentials();
    createClients();
    createWindow();
    createTray();
    console.log('Now-playing source:', sourcePreference(), '→', resolveSource());

    // Windows: a fullscreen app (game, video) can end up above the overlay and
    // it never comes back on its own — re-assert the topmost flag so it stays
    // visible over borderless-fullscreen apps
    if (process.platform === 'win32') {
        setInterval(() => {
            if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
        }, 1500);
    }

    // Global shortcuts: show/hide the overlay, open settings (the way in when
    // the click-through lock makes the gear button unclickable)
    registerHotkeys();

    // First launch after the upgrade with keys but no tokens: start sign-in
    // (existing users get their tokens imported from the old Python cache)
    if (credentialsConfigured() && !spotify.isConnected()) {
        spotify.startAuth();
    }

    // A cadence:// link that arrived before we were ready
    if (pendingDeepLink) {
        const link = pendingDeepLink;
        pendingDeepLink = null;
        mainWindow.webContents.once('did-finish-load', () => handleDeepLink(link));
    }
    // Windows: first launch via a link passes it in argv
    const argvLink = process.argv.find(a => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`));
    if (argvLink) mainWindow.webContents.once('did-finish-load', () => handleDeepLink(argvLink));

    // Ambient mode: when the user goes idle while music plays, expand the
    // overlay to fill the screen; any input shrinks it back
    setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const idle = powerMonitor.getSystemIdleTime();
        const playingRecently = Date.now() - lastPlayingAt < 10000;

        if (!ambientActive && !fullscreenActive && !notchActive && idle >= 60 && playingRecently) {
            ambientActive = true;
            ambientSavedBounds = mainWindow.getBounds();
            setWindowBounds(screen.getPrimaryDisplay().bounds);
            mainWindow.webContents.send('ambient-mode', true);
        } else if (ambientActive && idle < 3) {
            ambientActive = false;
            if (ambientSavedBounds) setWindowBounds(ambientSavedBounds);
            mainWindow.webContents.send('ambient-mode', false);
        }
    }, 2000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else if (mainWindow) {
            mainWindow.show();
        }
    });
});

app.on('window-all-closed', () => {
    // The tray keeps the app alive on every platform; Quit lives in its menu
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('before-quit', (event) => {
    saveDailyStats();
    if (spotify) spotify.shutdown();
    if (localPlayer) localPlayer.shutdown();
    // Tell listeners we're leaving — or hand the session to one of them —
    // before the process dies (best effort, 2.5s cap)
    if (listenAlong && !shuttingDown && (listenAlong.isHost() || listenAlong.isGuest())) {
        event.preventDefault();
        shuttingDown = true;
        Promise.race([listenAlong.shutdown(), new Promise(r => setTimeout(r, 2500))])
            .finally(() => app.quit());
    }
});

// Handle any uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});
