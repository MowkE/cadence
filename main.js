/**
 * Floating Lyrics Overlay - Main Process
 * 
 * This is the Electron main process that handles:
 * - Window creation and configuration (transparent, frameless, always-on-top)
 * - Click-through behavior with settings area exception
 * - Python-Electron communication for Spotify data
 * - Genius lyrics scraping fallback
 */

const { app, BrowserWindow, ipcMain, screen, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { PythonShell } = require('python-shell');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

// .env is a development convenience only — user credentials live in a
// per-user config file (see loadCredentials)
const dotenv = require('dotenv');
if (!app.isPackaged) {
    dotenv.config();
}

// ============================================================================
// PYTHON PATH RESOLUTION (Development vs Packaged)
// ============================================================================
function getPythonPath() {
    if (app.isPackaged) {
        // In packaged app, try bundled venv first, fallback to system python
        const bundledPython = path.join(process.resourcesPath, 'python', 'venv', 'bin', 'python3');
        if (fs.existsSync(bundledPython)) {
            return bundledPython;
        }
        // Fallback to system Python
        return 'python3';
    }
    // Development mode - use local venv
    return path.join(__dirname, 'python', 'venv', 'bin', 'python3');
}

function getScriptPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'python');
    }
    return path.join(__dirname, 'python');
}

// ============================================================================
// SPOTIFY CREDENTIALS (per-user config file, set via the in-app setup UI)
// ============================================================================
let SPOTIFY_CLIENT_ID = '';
let SPOTIFY_CLIENT_SECRET = '';

const credentialsPath = () => path.join(app.getPath('userData'), 'spotify-credentials.json');

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
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(credentialsPath(), JSON.stringify({ clientId, clientSecret }));
    } catch (e) {
        console.error('Could not save credentials:', e.message);
    }
}

function credentialsConfigured() {
    return Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
}

ipcMain.handle('get-credentials-status', () => ({ configured: credentialsConfigured() }));

ipcMain.handle('save-credentials', async (event, { clientId, clientSecret }) => {
    SPOTIFY_CLIENT_ID = String(clientId || '').trim();
    SPOTIFY_CLIENT_SECRET = String(clientSecret || '').trim();

    if (!credentialsConfigured()) {
        return { success: false, error: 'Both fields are required' };
    }

    writeCredentials(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET);

    // Drop any auth cache from previous credentials, then kick off OAuth
    // (opens the user's browser for Spotify approval)
    return new Promise((resolve) => {
        const options = {
            mode: 'json',
            pythonPath: getPythonPath(),
            pythonOptions: ['-u'],
            scriptPath: getScriptPath(),
            args: ['--action', 'clear_cache']
        };

        PythonShell.run('spotify_client.py', options)
            .catch(err => console.error('Cache clear error:', err.message))
            .finally(() => {
                startTokenRefreshInterval();
                resolve({ success: true });
            });
    });
});

// Window configuration (includes headroom margin so the 3D-tilted card
// never clips against the window bounds)
const WINDOW_WIDTH = 960;
const WINDOW_HEIGHT = 520;
const SETTINGS_BUTTON_SIZE = 50; // Size of the settings button hitbox

// Token refresh interval (45 minutes = 2700000 ms)
const TOKEN_REFRESH_INTERVAL = 45 * 60 * 1000;

let mainWindow;
let pythonProcess = null;
let tokenRefreshInterval = null;
let lastPlayingAt = 0;
let windowScale = 1;
let ambientActive = false;
let ambientSavedBounds = null;

// ============================================================================
// SPOTIFY TOKEN MANAGEMENT
// ============================================================================
async function refreshSpotifyToken() {
    return new Promise((resolve) => {
        const options = {
            mode: 'json',
            pythonPath: getPythonPath(),
            pythonOptions: ['-u'],
            scriptPath: getScriptPath(),
            args: ['--action', 'refresh_token'],
            env: {
                ...process.env,
                SPOTIFY_CLIENT_ID,
                SPOTIFY_CLIENT_SECRET
            }
        };

        console.log('Refreshing Spotify token...');

        PythonShell.run('spotify_client.py', options)
            .then(results => {
                if (results && results.length > 0) {
                    const result = results[0];
                    if (result.success) {
                        console.log('Spotify token refreshed successfully');
                    } else if (result.needs_auth) {
                        console.log('Full Spotify authentication required, triggering...');
                        // Trigger full auth by calling get_track which will open browser
                        triggerFullAuth();
                    } else {
                        console.error('Token refresh failed:', result.error);
                    }
                    resolve(result);
                } else {
                    resolve({ success: false, error: 'No result from Python' });
                }
            })
            .catch(err => {
                console.error('Token refresh error:', err);
                resolve({ success: false, error: err.message });
            });
    });
}

async function triggerFullAuth() {
    // This will open the browser for Spotify authentication
    return new Promise((resolve) => {
        const options = {
            mode: 'json',
            pythonPath: getPythonPath(),
            pythonOptions: ['-u'],
            scriptPath: getScriptPath(),
            args: ['--action', 'get_track'],
            env: {
                ...process.env,
                SPOTIFY_CLIENT_ID,
                SPOTIFY_CLIENT_SECRET
            }
        };

        PythonShell.run('spotify_client.py', options)
            .then(results => {
                console.log('Full auth triggered');
                resolve(results && results[0]);
            })
            .catch(err => {
                console.error('Full auth error:', err);
                resolve(null);
            });
    });
}

function startTokenRefreshInterval() {
    // Clear any existing interval
    if (tokenRefreshInterval) {
        clearInterval(tokenRefreshInterval);
    }

    // Refresh token immediately on startup
    refreshSpotifyToken();

    // Set up periodic refresh every 45 minutes
    tokenRefreshInterval = setInterval(() => {
        refreshSpotifyToken();
    }, TOKEN_REFRESH_INTERVAL);

    console.log(`Token refresh scheduled every ${TOKEN_REFRESH_INTERVAL / 60000} minutes`);
}

// ============================================================================
// WINDOW CREATION
// ============================================================================
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
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Enable click-through by default
    mainWindow.setIgnoreMouseEvents(true, { forward: true });

    // Float above fullscreen apps and follow across Spaces
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Load the renderer
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    // Open DevTools in development (uncomment for debugging)
    // mainWindow.webContents.openDevTools({ mode: 'detach' });

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (pythonProcess) {
            pythonProcess.terminate();
        }
    });
}

// ============================================================================
// IPC HANDLERS - Communication between Main and Renderer
// ============================================================================

// Toggle click-through based on mouse position (for settings button)
ipcMain.on('set-ignore-mouse', (event, ignore) => {
    if (mainWindow) {
        mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
    }
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
    const args = ['--action', 'control', '--command', command];
    if (positionMs !== undefined && positionMs !== null) {
        args.push('--position', String(positionMs));
    }
    return new Promise((resolve) => {
        const options = {
            mode: 'json',
            pythonPath: getPythonPath(),
            pythonOptions: ['-u'],
            scriptPath: getScriptPath(),
            args,
            env: {
                ...process.env,
                SPOTIFY_CLIENT_ID,
                SPOTIFY_CLIENT_SECRET
            }
        };

        PythonShell.run('spotify_client.py', options)
            .then(results => resolve(results && results[0]))
            .catch(err => {
                console.error('Playback control error:', err);
                resolve({ success: false, error: err.message });
            });
    });
});

// Scale the window (Size dial)
ipcMain.on('resize-window', (event, factor) => {
    windowScale = factor;
    if (mainWindow && !ambientActive) {
        const [x, y] = mainWindow.getPosition();
        mainWindow.setBounds({
            x, y,
            width: Math.round(WINDOW_WIDTH * factor),
            height: Math.round(WINDOW_HEIGHT * factor)
        });
    }
});

// Manual Spotify token refresh (triggered by UI button)
ipcMain.handle('refresh-spotify-token', async () => {
    console.log('Manual Spotify token refresh requested...');
    return await refreshSpotifyToken();
});

// Get current track from Spotify via Python
ipcMain.handle('get-current-track', async () => {
    return new Promise((resolve, reject) => {
        const options = {
            mode: 'json',
            pythonPath: getPythonPath(),
            pythonOptions: ['-u'],
            scriptPath: getScriptPath(),
            args: ['--action', 'get_track'],
            env: {
                ...process.env,
                SPOTIFY_CLIENT_ID,
                SPOTIFY_CLIENT_SECRET
            }
        };

        PythonShell.run('spotify_client.py', options)
            .then(results => {
                if (results && results.length > 0) {
                    const result = results[0];
                    recordPlayback(result);
                    // Check for auth errors and trigger refresh
                    if (!result.success && result.error_code === 401) {
                        console.log('Received 401 error, refreshing token...');
                        refreshSpotifyToken().then(() => {
                            resolve(result); // Return original error, next poll will work
                        });
                    } else {
                        resolve(result);
                    }
                } else {
                    resolve(null);
                }
            })
            .catch(err => {
                console.error('Python error:', err);
                // Check if error message indicates auth issue
                if (err.message && (err.message.includes('401') || err.message.includes('token'))) {
                    console.log('Auth error detected, refreshing token...');
                    refreshSpotifyToken();
                }
                resolve(null);
            });
    });
});

// Get audio analysis from Spotify
ipcMain.handle('get-audio-analysis', async (event, trackId) => {
    return new Promise((resolve, reject) => {
        const options = {
            mode: 'json',
            pythonPath: getPythonPath(),
            pythonOptions: ['-u'],
            scriptPath: getScriptPath(),
            args: ['--action', 'get_analysis', '--track_id', trackId],
            env: {
                ...process.env,
                SPOTIFY_CLIENT_ID,
                SPOTIFY_CLIENT_SECRET
            }
        };

        PythonShell.run('spotify_client.py', options)
            .then(results => {
                if (results && results.length > 0) {
                    resolve(results[0]);
                } else {
                    resolve(null);
                }
            })
            .catch(err => {
                console.error('Audio analysis error:', err);
                resolve(null);
            });
    });
});

// Get synced lyrics from LRCLIB (free, no auth required)
ipcMain.handle('get-synced-lyrics', async (event, { trackName, artistName, albumName, durationMs }) => {
    return new Promise((resolve, reject) => {
        const durationSeconds = Math.round(durationMs / 1000);
        const options = {
            mode: 'json',
            pythonPath: getPythonPath(),
            pythonOptions: ['-u'],
            scriptPath: getScriptPath(),
            args: [
                '--action', 'get_lyrics',
                '--track_name', trackName,
                '--artist_name', artistName,
                '--album_name', albumName || '',
                '--duration', durationSeconds.toString()
            ],
            env: {
                ...process.env
            }
        };

        console.log(`Fetching lyrics for: ${trackName} by ${artistName}`);

        PythonShell.run('spotify_client.py', options)
            .then(results => {
                if (results && results.length > 0) {
                    const result = results[0];
                    if (result.success) {
                        console.log(`Loaded ${result.lines?.length || 0} lyrics (${result.syncType})`);
                    } else {
                        console.log('Lyrics error:', result.error);
                    }
                    resolve(result);
                } else {
                    resolve({ success: false, error: 'No result from Python', lines: [] });
                }
            })
            .catch(err => {
                console.error('Synced lyrics error:', err);
                resolve({ success: false, error: err.message, lines: [] });
            });
    });
});

// ============================================================================
// GENIUS LYRICS SCRAPER
// ============================================================================
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
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            },
            timeout: 10000
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
const TRANSLATE_UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

ipcMain.handle('translate-lyrics', async (event, { lines }) => {
    try {
        const CHUNK = 35;
        const out = new Array(lines.length).fill(null);
        let detectedLang = null;

        for (let i = 0; i < lines.length; i += CHUNK) {
            const chunk = lines.slice(i, i + CHUNK);
            const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q='
                + encodeURIComponent(chunk.join('\n'));

            const response = await fetch(url, { headers: TRANSLATE_UA, timeout: 10000 });
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
const statsPath = () => path.join(app.getPath('userData'), 'daily-stats.json');
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
app.on('before-quit', saveDailyStats);

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

// Save user preferences
ipcMain.handle('save-preferences', async (event, preferences) => {
    // In a production app, you'd save to a file or database
    // For now, we just acknowledge the save
    console.log('Saving preferences:', preferences);
    return true;
});

// ============================================================================
// APP LIFECYCLE
// ============================================================================
app.whenReady().then(() => {
    loadCredentials();
    createWindow();

    // Start automatic Spotify token refresh (once credentials exist)
    if (credentialsConfigured()) {
        startTokenRefreshInterval();
    }

    // Ambient mode: when the user goes idle while music plays, expand the
    // overlay to fill the screen; any input shrinks it back
    setInterval(() => {
        if (!mainWindow) return;
        const idle = powerMonitor.getSystemIdleTime();
        const playingRecently = Date.now() - lastPlayingAt < 10000;

        if (!ambientActive && idle >= 60 && playingRecently) {
            ambientActive = true;
            ambientSavedBounds = mainWindow.getBounds();
            mainWindow.setBounds(screen.getPrimaryDisplay().bounds);
            mainWindow.webContents.send('ambient-mode', true);
        } else if (ambientActive && idle < 3) {
            ambientActive = false;
            if (ambientSavedBounds) mainWindow.setBounds(ambientSavedBounds);
            mainWindow.webContents.send('ambient-mode', false);
        }
    }, 2000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // Clean up token refresh interval
    if (tokenRefreshInterval) {
        clearInterval(tokenRefreshInterval);
        tokenRefreshInterval = null;
    }

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Handle any uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});
