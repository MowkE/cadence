/**
 * Preload Script - Secure Bridge between Main and Renderer
 * 
 * This script runs in a sandboxed context and exposes safe APIs
 * to the renderer process via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    // Track management
    getCurrentTrack: () => ipcRenderer.invoke('get-current-track'),
    getAudioAnalysis: (trackId) => ipcRenderer.invoke('get-audio-analysis', trackId),

    // Lyrics from LRCLIB (synced)
    getSyncedLyrics: (trackName, artistName, albumName, durationMs) =>
        ipcRenderer.invoke('get-synced-lyrics', { trackName, artistName, albumName, durationMs }),

    // Lyrics from Genius (unsynced fallback)
    getLyrics: (artist, title) => ipcRenderer.invoke('get-lyrics', { artist, title }),

    // Translate lyric lines to English (returns null for untranslated lines)
    translateLyrics: (lines) => ipcRenderer.invoke('translate-lyrics', { lines }),

    // Daily listening recap
    getDailyRecap: () => ipcRenderer.invoke('get-daily-recap'),

    // Playback control: 'play' | 'pause' | 'next' | 'previous' | 'seek'
    controlPlayback: (command, positionMs) => ipcRenderer.invoke('playback-control', command, positionMs),

    // Scale the window (Size slider / corner drag); resolves to the factor
    // actually applied after clamping to the screen
    resizeWindow: (factor) => ipcRenderer.invoke('resize-window', factor),

    // Fill the screen (karaoke / duet); resolves to the new state
    setOverlayFullscreen: (on) => ipcRenderer.invoke('overlay-fullscreen', on),

    // Notch bar layout: pin a slim strip to the top-centre of the screen
    setNotchLayout: (on) => ipcRenderer.invoke('notch-layout', on),

    // Ambient mode notifications from the main process
    onAmbientMode: (callback) => {
        ipcRenderer.on('ambient-mode', (event, on) => callback(on));
    },

    // Spotify token refresh
    refreshSpotifyToken: () => ipcRenderer.invoke('refresh-spotify-token'),

    // Spotify API credentials (optional) + where "now playing" comes from
    getCredentialsStatus: () => ipcRenderer.invoke('get-credentials-status'),
    saveCredentials: (clientId, clientSecret) => ipcRenderer.invoke('save-credentials', { clientId, clientSecret }),
    setPlayerSource: (source) => ipcRenderer.invoke('set-player-source', source),
    setClickThroughLock: (on) => ipcRenderer.invoke('set-click-through-lock', on),
    setDisplayName: (name) => ipcRenderer.invoke('set-display-name', name),
    setHotkeys: (keys) => ipcRenderer.invoke('set-hotkeys', keys),
    onPlayerInfo: (callback) => {
        ipcRenderer.on('player-info', (event, info) => callback(info));
    },

    // Mouse event control for click-through
    setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
    // Whether a panel (settings / setup / recap) is open — the click-through
    // lock only lets the overlay capture the mouse while one is
    setPanelOpen: (open) => ipcRenderer.send('panel-open', open),

    // Window movement for drag
    moveWindow: (deltaX, deltaY) => ipcRenderer.send('move-window', { deltaX, deltaY }),

    // Preferences
    savePreferences: (prefs) => ipcRenderer.invoke('save-preferences', prefs),

    // Fired when the browser sign-in finishes ({ success, error })
    onSpotifyAuth: (callback) => {
        ipcRenderer.on('spotify-auth', (event, result) => callback(result));
    },

    // The tray menu / a cadence:// link asked for the settings panel
    onOpenSettings: (callback) => {
        ipcRenderer.on('open-settings', () => callback());
    },
    // Ctrl/Cmd+Shift+L
    onToggleSettings: (callback) => {
        ipcRenderer.on('toggle-settings', () => callback());
    },

    // Listen along (share a code, follow a friend's lyrics)
    listenAlong: {
        getStatus: () => ipcRenderer.invoke('listen-along-status'),
        host: () => ipcRenderer.invoke('listen-along-host'),
        join: (code) => ipcRenderer.invoke('listen-along-join', code),
        leave: () => ipcRenderer.invoke('listen-along-leave'),
        setMirror: (on) => ipcRenderer.invoke('listen-along-mirror', on),
        // Guest: { link } or { current: true }. Host: reqId + 'play' | 'queue' | 'dismiss'
        request: (payload) => ipcRenderer.invoke('listen-along-request', payload),
        requestAction: (reqId, action) => ipcRenderer.invoke('listen-along-request-action', reqId, action),
        // Host: pass the session to a listener
        handoff: (toId) => ipcRenderer.invoke('listen-along-handoff', toId),
        // Karaoke & games traffic (any JSON; { game, action, ... })
        sendGame: (payload) => ipcRenderer.invoke('listen-along-game', payload),
        onGame: (callback) => {
            ipcRenderer.on('listen-along-game', (event, msg) => callback(msg));
        },
        onStatus: (callback) => {
            ipcRenderer.on('listen-along-status', (event, status) => callback(status));
        }
    },

    // Clipboard + browser
    copyText: (text) => ipcRenderer.invoke('copy-text', text),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),

    // Event listeners for updates from main process
    onTrackUpdate: (callback) => {
        ipcRenderer.on('track-update', (event, data) => callback(data));
    },

    // Remove listeners
    removeTrackUpdateListener: () => {
        ipcRenderer.removeAllListeners('track-update');
    }
});

// Log when preload is complete
console.log('Preload script loaded successfully');
