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

    // Scale the window for the Size dial
    resizeWindow: (factor) => ipcRenderer.send('resize-window', factor),

    // Ambient mode notifications from the main process
    onAmbientMode: (callback) => {
        ipcRenderer.on('ambient-mode', (event, on) => callback(on));
    },

    // Spotify token refresh
    refreshSpotifyToken: () => ipcRenderer.invoke('refresh-spotify-token'),

    // Spotify API credentials (first-run setup)
    getCredentialsStatus: () => ipcRenderer.invoke('get-credentials-status'),
    saveCredentials: (clientId, clientSecret) => ipcRenderer.invoke('save-credentials', { clientId, clientSecret }),

    // Mouse event control for click-through
    setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),

    // Window movement for drag
    moveWindow: (deltaX, deltaY) => ipcRenderer.send('move-window', { deltaX, deltaY }),

    // Preferences
    savePreferences: (prefs) => ipcRenderer.invoke('save-preferences', prefs),

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
