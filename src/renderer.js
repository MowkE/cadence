/**
 * Floating Lyrics Overlay - Renderer Process
 * 
 * Handles:
 * - State management for styles and current track
 * - Spotify track polling and lyrics display
 * - Audio visualization using system audio capture
 * - Karaoke-style lyrics scrolling
 * - Settings menu interaction
 */

// ============================================================================
// STATE MANAGER
// ============================================================================
const state = {
    // Style settings
    lyricStyle: 'cyberpunk',      // 'auto' | 'cyberpunk' | 'ethereal' | 'retro'
    autoStyle: 'cyberpunk',       // style resolved from album art when lyricStyle is 'auto'
    visualizerStyle: 'solid',     // 'solid' | 'fuzzy' | 'particles'
    layoutMode: 'full',           // 'full' | 'focus' | 'ticker'
    adaptiveTheme: false,
    translationOn: false,
    fireworksOn: true,
    dailyRecap: false,
    tiltOn: true,
    vinylOn: false,
    lineAnimOn: false,
    gradientOn: false,
    starsOn: false,
    nightShiftOn: false,
    arcOn: false,
    portalOn: true,
    hologramOn: false,
    holoCollapsed: false,

    // Listen along
    laStatus: null,               // last status object from the main process
    laMirror: true,               // guest: also play the host's track on my Spotify

    // Ring scrubbing
    scrubbing: false,
    scrubMs: 0,
    scaleMode: 'medium',          // 'small' | 'medium' | 'large' | 'custom'
    scaleFactor: 1,               // window + content scale, 0.5–2.5
    resizing: false,              // dragging the corner grip
    lyricBrightness: 100,         // percent, 30–150

    // Now-playing source + click-through lock (both live in the main process)
    playerInfo: null,
    playerSource: 'auto',         // 'auto' | 'local' | 'api'
    clickThroughLock: false,
    roomVote: false,              // host: the room picks the next song (lives in the session)

    // Auto-hide when paused
    autoHideMin: 0,               // 0 = off
    autoHidden: false,
    cursorInside: false,
    panelOpen: false,

    // Beat estimate from synced lyric timing (ms per beat, null = unknown)
    beatMs: null,

    // Translation cache (trackId -> array of translated lines)
    translations: {},

    // Pause tracking (smart hide + auto recap)
    pausedSince: null,
    pauseHandled: false,
    hasPlayedThisSession: false,

    // Current track info
    currentTrack: null,
    previousTrackId: null,

    // Lyrics
    lyrics: [],
    currentLyricIndex: 0,
    lyricsAreSynced: false,

    // Audio analysis
    audioAnalysis: null,
    beats: [],
    currentBeatIndex: 0,

    // Colors
    dominantColor: '#ff00ff',
    dominantColorRgb: { r: 255, g: 0, b: 255 },

    // Polling & Timing
    pollInterval: null,
    pollIntervalMs: 2000,
    lastFetchTime: 0,
    estimatedProgress: 0,
    isPlaying: false,
    trackDuration: 0,

    // Animation frame for sync
    syncAnimationFrame: null
};

// ============================================================================
// DOM ELEMENTS
// ============================================================================
const elements = {
    body: document.body,
    container: document.getElementById('container'),
    albumArt: document.getElementById('album-art'),
    albumArtPlaceholder: document.getElementById('album-art-placeholder'),
    albumArtContainer: document.getElementById('album-art-container'),
    visualizerContainer: document.getElementById('visualizer-container'),
    trackName: document.getElementById('track-name'),
    artistName: document.getElementById('artist-name'),
    lyricsContainer: document.getElementById('lyrics-container'),
    settingsBtn: document.getElementById('settings-btn'),
    settingsMenu: document.getElementById('settings-menu'),
    closeSettings: document.getElementById('close-settings'),
    loadingOverlay: document.getElementById('loading-overlay'),
    styleBtns: document.querySelectorAll('.style-btn'),
    prefToggles: document.querySelectorAll('.pref-toggle'),
    tickerBar: document.getElementById('ticker-bar'),
    tickerArt: document.getElementById('ticker-art'),
    tickerTrack: document.getElementById('ticker-track'),
    tickerLyric: document.getElementById('ticker-lyric'),
    recapCard: document.getElementById('recap-card'),
    showRecapBtn: document.getElementById('show-recap-btn'),
    closeRecapBtn: document.getElementById('close-recap'),
    playbackControls: document.getElementById('playback-controls'),
    pbToggle: document.getElementById('pb-toggle'),
    ambientLayer: document.getElementById('ambient-layer'),
    ambientArt: document.getElementById('ambient-art'),
    ambientLyric: document.getElementById('ambient-lyric'),
    ambientNext: document.getElementById('ambient-next'),
    ambientTrack: document.getElementById('ambient-track')
};

// ============================================================================
// INITIALIZATION
// ============================================================================
async function init() {
    console.log('Initializing Lyrics Overlay...');

    // Setup event listeners
    setupEventListeners();

    // Setup mouse tracking for click-through
    setupMouseTracking();

    // Initialize visualizer (but don't start audio capture yet)
    initVisualizer();

    // Load saved preferences
    loadPreferences();

    // Where "now playing" comes from. On Mac/Windows the Spotify app on this
    // computer is read directly, so there's nothing to set up; the API-keys
    // card only appears on first run where that isn't available
    try {
        const info = await window.electronAPI.getCredentialsStatus();
        applyPlayerInfo(info);
        if (info && !info.configured && !info.localAvailable) {
            document.getElementById('setup-card').classList.remove('hidden');
        }
    } catch (e) {
        console.error('Could not check credentials:', e);
    }
    window.electronAPI.onPlayerInfo(applyPlayerInfo);

    // Listen along: reflect any session the main process already has
    // (e.g. we were launched from a cadence:// link)
    try {
        renderListenAlong(await window.electronAPI.listenAlong.getStatus());
    } catch (e) {
        console.error('Could not read listen-along status:', e);
    }

    // 3D parallax scene (always on)
    initParallax();

    // Ring scrubbing on the progress arc
    initScrubbing();

    // Night shift check now and every minute
    updateNightShift();
    setInterval(updateNightShift, 60000);

    // Keep the star field canvas sized to the window
    window.addEventListener('resize', () => {
        if (state.starsOn) startStars();
    });

    // Start polling for current track
    startPolling();

    // Hide loading overlay
    elements.loadingOverlay.classList.add('hidden');
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================
function setupEventListeners() {
    // Settings button - drag to move, click to toggle menu
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let hasDragged = false;

    elements.settingsBtn.addEventListener('mousedown', (e) => {
        isDragging = true;
        hasDragged = false;
        dragStartX = e.screenX;
        dragStartY = e.screenY;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.screenX - dragStartX;
        const deltaY = e.screenY - dragStartY;

        // Only consider it a drag if moved more than 5 pixels
        if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
            hasDragged = true;
            window.electronAPI.moveWindow(deltaX, deltaY);
            dragStartX = e.screenX;
            dragStartY = e.screenY;
        }
    });

    document.addEventListener('mouseup', (e) => {
        if (isDragging && !hasDragged) {
            // It was a click, not a drag - toggle settings menu
            elements.settingsMenu.classList.toggle('hidden');
        }
        isDragging = false;
    });

    // Close settings
    elements.closeSettings.addEventListener('click', () => {
        elements.settingsMenu.classList.add('hidden');
    });

    // Focusing a toggle can scroll the overflow:hidden menu shell and shove
    // the content out of the clipped box — pin it
    elements.settingsMenu.addEventListener('scroll', () => {
        elements.settingsMenu.scrollTop = 0;
        elements.settingsMenu.scrollLeft = 0;
    });

    // Refresh Spotify token
    const refreshBtn = document.getElementById('refresh-spotify-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.textContent = '⏳ Refreshing...';
            refreshBtn.disabled = true;
            try {
                const result = await window.electronAPI.refreshSpotifyToken();
                if (result && result.success) {
                    refreshBtn.textContent = '✅ Refreshed!';
                    // Re-fetch current track
                    fetchCurrentTrack();
                } else {
                    refreshBtn.textContent = '❌ Failed - Try again';
                }
            } catch (err) {
                console.error('Refresh failed:', err);
                refreshBtn.textContent = '❌ Error';
            }
            setTimeout(() => {
                refreshBtn.textContent = '🔄 Refresh Spotify';
                refreshBtn.disabled = false;
            }, 2000);
        });
    }

    // Style buttons (lyric style, visualizer, font, layout)
    elements.styleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const styleType = btn.dataset.style;
            const styleValue = btn.dataset.value;

            if (styleType === 'lyric') {
                setLyricStyle(styleValue);
            } else if (styleType === 'visualizer') {
                setVisualizerStyle(styleValue);
            } else if (styleType === 'layout') {
                setLayoutMode(styleValue);
            } else if (styleType === 'scale') {
                setScaleMode(styleValue);
            } else if (styleType === 'source') {
                setPlayerSource(styleValue);
            } else if (styleType === 'autohide') {
                setAutoHide(Number(styleValue));
            }

            // Update active state
            updateActiveStyleButtons();
        });
    });

    // Preference toggles (Extras section)
    elements.prefToggles.forEach(toggle => {
        toggle.addEventListener('change', () => {
            setPrefToggle(toggle.dataset.pref, toggle.checked);
        });
    });

    // Lyric brightness slider: live while dragging, saved on release
    const brightnessSlider = document.getElementById('brightness-slider');
    brightnessSlider.addEventListener('input', () => setLyricBrightness(Number(brightnessSlider.value), false));
    brightnessSlider.addEventListener('change', () => setLyricBrightness(Number(brightnessSlider.value), true));

    // Daily recap card
    elements.showRecapBtn.addEventListener('click', () => showRecap(false));
    elements.closeRecapBtn.addEventListener('click', hideRecap);

    // Playback controls
    document.getElementById('pb-prev').addEventListener('click', () => sendPlayback('previous'));
    document.getElementById('pb-next').addEventListener('click', () => sendPlayback('next'));
    elements.pbToggle.addEventListener('click', () => sendPlayback(state.isPlaying ? 'pause' : 'play'));

    // Spotify API setup card
    const setupCard = document.getElementById('setup-card');
    document.getElementById('show-setup-btn').addEventListener('click', () => {
        setupCard.classList.remove('hidden');
        elements.settingsMenu.classList.add('hidden');
    });
    document.getElementById('setup-save').addEventListener('click', async () => {
        const clientId = document.getElementById('setup-client-id').value.trim();
        const clientSecret = document.getElementById('setup-client-secret').value.trim();
        const status = document.getElementById('setup-status');

        if (!clientId || !clientSecret) {
            status.textContent = 'Both fields are required.';
            return;
        }

        status.textContent = 'Saving…';
        const result = await window.electronAPI.saveCredentials(clientId, clientSecret);
        if (result && result.success) {
            status.textContent = 'Connected! Approve access in the browser window that opens.';
            setTimeout(() => {
                setupCard.classList.add('hidden');
                fetchCurrentTrack();
            }, 2500);
        } else {
            status.textContent = (result && result.error) || 'Could not save credentials.';
        }
    });

    // Setup can be skipped: following a friend's session needs no Spotify at all
    document.getElementById('setup-skip').addEventListener('click', () => {
        setupCard.classList.add('hidden');
    });

    // Browser sign-in finished
    window.electronAPI.onSpotifyAuth((result) => {
        const status = document.getElementById('setup-status');
        if (result && result.success) {
            status.textContent = 'Connected! 🎉';
            setTimeout(() => setupCard.classList.add('hidden'), 1200);
            fetchCurrentTrack();
        } else {
            status.textContent = 'Spotify sign-in did not finish: ' + ((result && result.error) || 'try again');
        }
    });

    // Tray menu / cadence:// link wants the settings panel open
    window.electronAPI.onOpenSettings(() => {
        elements.settingsMenu.classList.remove('hidden');
    });
    window.electronAPI.onToggleSettings(() => {
        elements.settingsMenu.classList.toggle('hidden');
    });

    // Tell the main process when a panel is open (the click-through lock only
    // lets the overlay take the mouse while one is)
    const panels = [elements.settingsMenu, elements.recapCard, document.getElementById('setup-card'), document.getElementById('games-panel'), document.getElementById('vote-card')];
    const notifyPanelOpen = () => {
        state.panelOpen = panels.some(p => p && !p.classList.contains('hidden'));
        window.electronAPI.setPanelOpen(state.panelOpen);
        updatePeek();
    };
    const panelObserver = new MutationObserver(notifyPanelOpen);
    panels.forEach(p => p && panelObserver.observe(p, { attributes: true, attributeFilter: ['class'] }));
    notifyPanelOpen();

    // Size slider + corner grip
    setupResize();

    // Listen along controls
    const laInput = document.getElementById('la-code-input');
    const laMsg = document.getElementById('la-msg');
    const laBusy = (btn, on, label) => {
        btn.disabled = on;
        if (label) btn.textContent = label;
    };

    document.getElementById('la-host-btn').addEventListener('click', async () => {
        const btn = document.getElementById('la-host-btn');
        laBusy(btn, true, '⏳ Starting…');
        try {
            const status = await window.electronAPI.listenAlong.host();
            renderListenAlong(status);
            if (status && status.link) {
                await window.electronAPI.copyText(`Listen along with me on Cadence: ${status.link}  (code ${status.code})`);
                laMsg.textContent = 'Invite link copied — paste it to a friend';
            }
        } catch (err) {
            laMsg.textContent = 'Could not start: ' + err.message;
        }
        laBusy(btn, false, '🎧 Start a session');
    });

    const joinSession = async () => {
        const btn = document.getElementById('la-join-btn');
        const code = laInput.value.trim();
        if (!code) {
            laMsg.textContent = 'Paste a code like ABCD-EFGH or a cadence:// link';
            return;
        }
        laBusy(btn, true, '…');
        try {
            const result = await window.electronAPI.listenAlong.join(code);
            if (result && result.success) {
                laInput.value = '';
                laMsg.textContent = '';
                renderListenAlong(result.status);
                fetchCurrentTrack();
            } else {
                laMsg.textContent = (result && result.error) || 'Could not join';
            }
        } catch (err) {
            laMsg.textContent = 'Could not join: ' + err.message;
        }
        laBusy(btn, false, 'Join');
    };
    document.getElementById('la-join-btn').addEventListener('click', joinSession);
    laInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinSession();
    });

    const copyInvite = async () => {
        const st = state.laStatus;
        if (!st || !st.link) return;
        await window.electronAPI.copyText(`Listen along with me on Cadence: ${st.link}  (code ${st.code})`);
        laMsg.textContent = 'Invite link copied';
        setTimeout(() => { if (laMsg.textContent === 'Invite link copied') laMsg.textContent = ''; }, 2500);
    };
    document.getElementById('la-copy-btn').addEventListener('click', copyInvite);
    document.getElementById('la-code').addEventListener('click', copyInvite);

    const leaveSession = async () => {
        const status = await window.electronAPI.listenAlong.leave();
        renderListenAlong(status);
        // Back to our own Spotify right away
        state.previousTrackId = null;
        fetchCurrentTrack();
    };
    document.getElementById('la-end-btn').addEventListener('click', leaveSession);
    document.getElementById('la-leave-btn').addEventListener('click', leaveSession);

    window.electronAPI.listenAlong.onStatus((status) => {
        const prevMode = state.laStatus ? state.laStatus.mode : 'off';
        renderListenAlong(status);
        if (window.Games) Games.onRoom();
        // Role changed under us (host left, or a handoff): re-render from the
        // right source — our own Spotify, or the new host's stream
        if (prevMode !== status.mode) {
            state.previousTrackId = null;
            fetchCurrentTrack();
        }
    });

    // Room vote: pick the next song
    document.getElementById('vote-options').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-pick]');
        if (!btn) return;
        btn.disabled = true;
        const r = await window.electronAPI.listenAlong.castVote(btn.dataset.pick);
        if (r && r.status) renderListenAlong(r.status);
    });

    // Hand the session to a listener
    document.getElementById('la-listener-list').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-handoff]');
        if (!btn) return;
        btn.disabled = true;
        const r = await window.electronAPI.listenAlong.handoff(btn.dataset.handoff);
        if (r && r.status) renderListenAlong(r.status);
        if (r && !r.success && r.error) laMsg.textContent = r.error;
    });

    // Karaoke & games
    if (window.Games) Games.init();
    document.getElementById('games-btn').addEventListener('click', () => {
        elements.settingsMenu.classList.add('hidden');
        Games.open();
    });
    window.electronAPI.listenAlong.onGame((msg) => {
        if (window.Games) Games.onGameMessage(msg);
    });

    // Song requests: guests send them, the host's list acts on them
    const reqInput = document.getElementById('la-req-input');
    const reqNote = document.getElementById('la-req-note');
    const sendRequest = async (payload) => {
        reqNote.textContent = payload.current ? 'Sending what you\'re playing…' : 'Looking up that song…';
        try {
            const r = await window.electronAPI.listenAlong.request(payload);
            if (r && r.success) {
                reqInput.value = '';
                if (r.status) renderListenAlong(r.status);
            } else {
                reqNote.textContent = (r && r.error) || 'Could not send the request';
            }
        } catch (err) {
            reqNote.textContent = 'Could not send the request: ' + err.message;
        }
    };
    document.getElementById('la-req-btn').addEventListener('click', () => {
        const link = reqInput.value.trim();
        if (link) sendRequest({ link });
        else reqNote.textContent = 'Paste a Spotify song link first (Share → Copy Song Link)';
    });
    reqInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('la-req-btn').click();
    });
    document.getElementById('la-req-current-btn').addEventListener('click', () => sendRequest({ current: true }));
    document.getElementById('la-requests').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-action]');
        const item = btn && btn.closest('[data-req]');
        if (!btn || !item) return;
        btn.disabled = true;
        const r = await window.electronAPI.listenAlong.requestAction(item.dataset.req, btn.dataset.action);
        if (r && r.status) renderListenAlong(r.status);
        if (r && !r.success && r.error) laMsg.textContent = r.error;
        btn.disabled = false;
    });

    // The name friends see in listen along
    document.getElementById('la-name').addEventListener('change', (e) => {
        window.electronAPI.setDisplayName(e.target.value).then(applyPlayerInfo);
    });

    // Global shortcuts
    const saveHotkeys = () => window.electronAPI.setHotkeys({
        toggle: document.getElementById('hotkey-toggle').value,
        settings: document.getElementById('hotkey-settings').value
    }).then(applyPlayerInfo);
    document.getElementById('hotkey-toggle').addEventListener('change', saveHotkeys);
    document.getElementById('hotkey-settings').addEventListener('change', saveHotkeys);

    // Emitter is the hologram's power button
    document.getElementById('holo-puck').addEventListener('click', () => {
        state.holoCollapsed = !state.holoCollapsed;
        elements.body.classList.toggle('holo-collapsed', state.holoCollapsed);
    });

    // Ambient mode driven by the main process (system idle detection)
    window.electronAPI.onAmbientMode((on) => {
        elements.body.classList.toggle('ambient-mode', on);
        if (on) updateAmbient();
    });

    // Close settings when clicking outside
    document.addEventListener('click', (e) => {
        if (!elements.settingsMenu.contains(e.target) &&
            !elements.settingsBtn.contains(e.target) &&
            !elements.settingsMenu.classList.contains('hidden')) {
            elements.settingsMenu.classList.add('hidden');
        }
    });
}

// ============================================================================
// MOUSE TRACKING (For Click-Through Behavior)
// ============================================================================
function setupMouseTracking() {
    // Track mouse position to determine if we're over interactive elements
    document.addEventListener('mousemove', (e) => {
        const settingsRect = elements.settingsBtn.getBoundingClientRect();
        const menuRect = elements.settingsMenu.getBoundingClientRect();
        const isOverSettings = isPointInRect(e.clientX, e.clientY, settingsRect);
        const isOverMenu = !elements.settingsMenu.classList.contains('hidden') &&
            isPointInRect(e.clientX, e.clientY, menuRect);
        const isOverRecap = !elements.recapCard.classList.contains('hidden') &&
            isPointInRect(e.clientX, e.clientY, elements.recapCard.getBoundingClientRect());
        const isOverControls = state.layoutMode !== 'ticker' &&
            !(state.laStatus && state.laStatus.mode === 'guest') &&
            isPointInRect(e.clientX, e.clientY, elements.playbackControls.getBoundingClientRect());

        // The scrub ring: only the band around the album art
        let isOverArc = false;
        const isGuest = state.laStatus && state.laStatus.mode === 'guest';
        if (state.arcOn && state.layoutMode !== 'ticker' && !isGuest) {
            const arcRect = document.getElementById('progress-arc').getBoundingClientRect();
            const dist = Math.hypot(
                e.clientX - (arcRect.left + arcRect.width / 2),
                e.clientY - (arcRect.top + arcRect.height / 2)
            );
            isOverArc = dist > 55 && dist < 88;
        }

        // The emitter (hologram power button), with a padded hit area
        let isOverPuck = false;
        if (state.hologramOn && state.layoutMode === 'full') {
            const puckRect = document.getElementById('holo-puck').getBoundingClientRect();
            isOverPuck = e.clientX > puckRect.left - 10 && e.clientX < puckRect.right + 10 &&
                e.clientY > puckRect.top - 10 && e.clientY < puckRect.bottom + 10;
        }

        const setupCard = document.getElementById('setup-card');
        const isOverSetup = !setupCard.classList.contains('hidden') &&
            isPointInRect(e.clientX, e.clientY, setupCard.getBoundingClientRect());

        // The corner resize grip (hidden in ambient mode)
        const isOverGrip = !elements.body.classList.contains('ambient-mode') &&
            isPointInRect(e.clientX, e.clientY, document.getElementById('resize-grip').getBoundingClientRect());

        // Karaoke & games panel
        const gamesPanel = document.getElementById('games-panel');
        const isOverGames = !gamesPanel.classList.contains('hidden') &&
            isPointInRect(e.clientX, e.clientY, gamesPanel.getBoundingClientRect());

        // Room vote card
        const voteCard = document.getElementById('vote-card');
        const isOverVote = !voteCard.classList.contains('hidden') &&
            isPointInRect(e.clientX, e.clientY, voteCard.getBoundingClientRect());

        // If over interactive elements, capture mouse events
        if (isOverSettings || isOverMenu || isOverRecap || isOverControls || isOverArc || isOverPuck ||
            isOverSetup || isOverGrip || isOverGames || isOverVote || state.scrubbing || state.resizing) {
            window.electronAPI.setIgnoreMouse(false);
        } else {
            window.electronAPI.setIgnoreMouse(true);
        }

        // Hovering an auto-hidden overlay peeks at it
        if (!state.cursorInside) {
            state.cursorInside = true;
            updatePeek();
        }
    });

    // The cursor left the window: never keep it captured (a stuck capture is
    // what makes the overlay block clicks on whatever is underneath)
    document.addEventListener('mouseleave', () => {
        if (!state.scrubbing && !state.resizing) window.electronAPI.setIgnoreMouse(true);
        state.cursorInside = false;
        updatePeek();
    });
}

// ============================================================================
// AUTO-HIDE WHEN PAUSED
// ============================================================================
function setAutoHide(minutes) {
    state.autoHideMin = Number(minutes) || 0;
    if (!state.autoHideMin) setAutoHidden(false);
    updateActiveStyleButtons();
    savePreferences();
}

function setAutoHidden(on) {
    if (state.autoHidden === on) return;
    state.autoHidden = on;
    elements.body.classList.toggle('auto-hidden', on);
}

// While hidden, the overlay shows itself when the cursor is over it or a
// panel is open (e.g. settings opened from the tray / shortcut)
function updatePeek() {
    elements.body.classList.toggle('peek', state.cursorInside || state.panelOpen);
}

function isPointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// ============================================================================
// STYLE MANAGEMENT
// ============================================================================
function setLyricStyle(style) {
    state.lyricStyle = style;
    applyResolvedLyricStyle();
    savePreferences();
}

// Font wardrobe for Auto style — one bucket per vibe, picked per track
const AUTO_FONTS = {
    cyberpunk: [
        "'Orbitron', sans-serif", "'Audiowide', sans-serif", "'Rajdhani', sans-serif",
        "'Russo One', sans-serif", "'Exo 2', sans-serif", "'Oxanium', sans-serif",
        "'Chakra Petch', sans-serif", "'Michroma', sans-serif", "'Teko', sans-serif",
        "'Saira Condensed', sans-serif"
    ],
    ethereal: [
        "'Playfair Display', serif", "'Cormorant Garamond', serif", "'EB Garamond', serif",
        "'Crimson Text', serif", "'Libre Baskerville', serif", "'Marcellus', serif",
        "'Italiana', serif", "'Great Vibes', cursive", "'Parisienne', cursive",
        "'Dancing Script', cursive"
    ],
    retro: [
        "'Courier Prime', monospace", "'VT323', monospace", "'Press Start 2P', monospace",
        "'Space Mono', monospace", "'IBM Plex Mono', monospace", "'JetBrains Mono', monospace",
        "'Share Tech Mono', monospace", "'Silkscreen', monospace", "'DotGothic16', monospace",
        "'Major Mono Display', monospace"
    ]
};

function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

// The actual body class: 'auto' resolves to the style picked from album art
function applyResolvedLyricStyle() {
    const resolved = state.lyricStyle === 'auto' ? state.autoStyle : state.lyricStyle;
    elements.body.classList.remove('lyric-style-cyberpunk', 'lyric-style-ethereal', 'lyric-style-retro');
    elements.body.classList.add(`lyric-style-${resolved}`);

    const auto = state.lyricStyle === 'auto';
    elements.body.classList.toggle('auto-font', auto);
    if (auto) {
        const pool = AUTO_FONTS[resolved] || AUTO_FONTS.cyberpunk;
        const font = pool[state.currentTrack ? hashString(state.currentTrack.id) % pool.length : 0];
        document.documentElement.style.setProperty('--lyric-font', font);
    }
}

// Map album-art color to a lyric style: muted/pastel art reads ethereal,
// green-leaning art reads terminal, vivid pink/blue/red reads cyberpunk
function pickAutoStyle(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;

    if (saturation < 0.3 || min > 170) return 'ethereal';
    if (g > r && g >= b) return 'retro';
    return 'cyberpunk';
}

function setVisualizerStyle(style) {
    // Remove all visualizer style classes
    elements.body.classList.remove('visualizer-style-solid', 'visualizer-style-fuzzy', 'visualizer-style-particles');

    // Add new style class
    elements.body.classList.add(`visualizer-style-${style}`);
    state.visualizerStyle = style;

    // Update visualizer mode
    updateVisualizerMode();

    // Save preference
    savePreferences();
}

function setLayoutMode(mode) {
    elements.body.classList.remove('layout-full', 'layout-focus', 'layout-ticker', 'layout-notch');
    elements.body.classList.add(`layout-${mode}`);
    state.layoutMode = mode;
    applyNotchLayout(mode === 'notch');

    // Re-apply focus classes and recenter for the new layout
    updateFocusClasses(state.currentLyricIndex);
    if (mode !== 'ticker') {
        scrollToActiveLyric(state.currentLyricIndex);
    }
    updateTicker();

    savePreferences();
}

// Notch bar: the main process pins a fixed-size strip to the top-centre of
// the screen. Page zoom parks at 1 so the strip is always the same size.
function applyNotchLayout(on) {
    if (!window.electronAPI.setNotchLayout) return;
    document.documentElement.style.zoom = on ? 1 : state.scaleFactor;
    window.electronAPI.setNotchLayout(on).then(info => {
        if (!info) return;
        document.documentElement.style.setProperty('--notch-top', `${Number(info.topBar) || 0}px`);
        elements.body.classList.toggle('has-notch', Boolean(info.hasNotch));
    }).catch(() => {});
}

const SCALE_PRESETS = { small: 0.85, medium: 1, large: 1.2 };
const SCALE_MIN = 0.5;
const SCALE_MAX = 2.5;

function setScaleMode(mode) {
    setScaleFactor(SCALE_PRESETS[mode] || 1, true);
}

// Continuous scale (slider / corner drag). The main process clamps it to the
// screen and reports what it applied so the page zoom and the window agree.
let scaleRequestPending = null;
function setScaleFactor(factor, save) {
    const wanted = Math.max(SCALE_MIN, Math.min(SCALE_MAX, Number(factor) || 1));
    state.scaleFactor = wanted;
    const notch = state.layoutMode === 'notch'; // fixed-size strip: remember the size, don't apply it
    if (!notch) document.documentElement.style.zoom = wanted;
    updateSizeControls();

    scaleRequestPending = wanted;
    window.electronAPI.resizeWindow(wanted).then(applied => {
        if (scaleRequestPending !== wanted) return; // a newer value is on its way
        scaleRequestPending = null;
        if (typeof applied === 'number' && Math.abs(applied - wanted) > 0.001) {
            state.scaleFactor = applied;
            if (!notch) document.documentElement.style.zoom = applied;
            updateSizeControls();
        }
        if (save) savePreferences();
    }).catch(() => {
        if (save) savePreferences();
    });
}

function updateSizeControls() {
    const pct = Math.round(state.scaleFactor * 100);
    const slider = document.getElementById('size-slider');
    const label = document.getElementById('size-value');
    if (slider && Number(slider.value) !== pct) slider.value = pct;
    if (label) label.textContent = `${pct}%`;
    state.scaleMode = Object.keys(SCALE_PRESETS)
        .find(k => Math.abs(SCALE_PRESETS[k] - state.scaleFactor) < 0.001) || 'custom';
    updateActiveStyleButtons();
}

function setupResize() {
    const slider = document.getElementById('size-slider');
    const label = document.getElementById('size-value');
    // Live label while dragging; the window follows on release so the panel
    // doesn't move under the cursor mid-drag
    slider.addEventListener('input', () => { label.textContent = `${slider.value}%`; });
    slider.addEventListener('change', () => setScaleFactor(Number(slider.value) / 100, true));

    // Corner grip: the window's bottom-right corner follows the cursor
    const grip = document.getElementById('resize-grip');
    let startX = 0, startY = 0, startW = 1, startH = 1, startFactor = 1, frame = null;

    grip.addEventListener('mousedown', (e) => {
        state.resizing = true;
        startX = e.screenX;
        startY = e.screenY;
        startW = Math.max(1, window.outerWidth);
        startH = Math.max(1, window.outerHeight);
        startFactor = state.scaleFactor;
        elements.body.classList.add('resizing');
        e.preventDefault();
        e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
        if (!state.resizing) return;
        const dx = e.screenX - startX;
        const dy = e.screenY - startY;
        const factor = startFactor * (((startW + dx) / startW) + ((startH + dy) / startH)) / 2;
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = null;
            setScaleFactor(factor, false);
        });
    });

    document.addEventListener('mouseup', () => {
        if (!state.resizing) return;
        state.resizing = false;
        elements.body.classList.remove('resizing');
        savePreferences();
    });
}

function setLyricBrightness(value, save) {
    state.lyricBrightness = value;
    document.documentElement.style.setProperty('--lyric-brightness', value / 100);
    if (save) savePreferences();
}

function setPrefToggle(pref, on) {
    state[pref] = on;

    if (pref === 'laMirror') {
        // Listen-along guest option, lives in the main process (not a saved pref)
        window.electronAPI.listenAlong.setMirror(on).then(renderListenAlong);
        return;
    }

    if (pref === 'roomVote') {
        window.electronAPI.listenAlong.setRoomVote(on).then(renderListenAlong);
        return;
    }

    if (pref === 'clickThroughLock') {
        // About the window, not the page — lives in the main process
        window.electronAPI.setClickThroughLock(on).then(applyPlayerInfo);
        return;
    }

    if (pref === 'adaptiveTheme') {
        elements.body.classList.toggle('adaptive-theme', on);
    } else if (pref === 'translationOn') {
        elements.body.classList.toggle('translation-on', on);
        if (on && state.currentTrack) {
            maybeTranslate(state.currentTrack);
        }
    } else if (pref === 'fireworksOn') {
        elements.body.classList.toggle('fireworks-off', !on);
    } else if (pref === 'tiltOn') {
        elements.body.classList.toggle('tilt-off', !on);
    } else if (pref === 'vinylOn') {
        elements.body.classList.toggle('vinyl-on', on);
    } else if (pref === 'lineAnimOn') {
        elements.body.classList.toggle('line-anim-on', on);
    } else if (pref === 'gradientOn') {
        elements.body.classList.toggle('gradient-on', on);
    } else if (pref === 'starsOn') {
        if (on) startStars();
        else stopStars();
    } else if (pref === 'nightShiftOn') {
        updateNightShift();
    } else if (pref === 'arcOn') {
        elements.body.classList.toggle('arc-on', on);
    } else if (pref === 'hologramOn') {
        elements.body.classList.toggle('holo-on', on);
        if (!on) {
            state.holoCollapsed = false;
            elements.body.classList.remove('holo-collapsed');
        }
    }

    savePreferences();
}

function syncToggleInputs() {
    elements.prefToggles.forEach(toggle => {
        toggle.checked = !!state[toggle.dataset.pref];
    });
}

function updateActiveStyleButtons() {
    const current = {
        lyric: state.lyricStyle,
        visualizer: state.visualizerStyle,
        layout: state.layoutMode,
        scale: state.scaleMode,
        source: state.playerSource,
        autohide: String(state.autoHideMin)
    };

    elements.styleBtns.forEach(btn => {
        btn.classList.toggle('active', current[btn.dataset.style] === btn.dataset.value);
    });
}

function loadPreferences() {
    try {
        const saved = localStorage.getItem('lyricsOverlayPrefs');
        if (saved) {
            const prefs = JSON.parse(saved);
            if (prefs.lyricStyle) setLyricStyle(prefs.lyricStyle);
            if (prefs.visualizerStyle) setVisualizerStyle(prefs.visualizerStyle);
            if (prefs.layoutMode) setLayoutMode(prefs.layoutMode);
            if (typeof prefs.scaleFactor === 'number') setScaleFactor(prefs.scaleFactor, false);
            else if (prefs.scaleMode) setScaleMode(prefs.scaleMode);
            if (typeof prefs.autoHideMin === 'number') state.autoHideMin = prefs.autoHideMin;
            if (prefs.lyricBrightness) {
                setLyricBrightness(prefs.lyricBrightness, false);
                document.getElementById('brightness-slider').value = prefs.lyricBrightness;
            }
            ['adaptiveTheme', 'translationOn', 'fireworksOn', 'dailyRecap', 'tiltOn',
             'vinylOn', 'lineAnimOn', 'gradientOn', 'starsOn', 'nightShiftOn', 'arcOn',
             'portalOn', 'hologramOn'].forEach(pref => {
                if (typeof prefs[pref] === 'boolean') setPrefToggle(pref, prefs[pref]);
            });
        }
        updateActiveStyleButtons();
        syncToggleInputs();
    } catch (e) {
        console.log('No saved preferences found');
    }
}

function savePreferences() {
    const prefs = {
        lyricStyle: state.lyricStyle,
        visualizerStyle: state.visualizerStyle,
        layoutMode: state.layoutMode,
        adaptiveTheme: state.adaptiveTheme,
        translationOn: state.translationOn,
        fireworksOn: state.fireworksOn,
        dailyRecap: state.dailyRecap,
        scaleMode: state.scaleMode,
        scaleFactor: state.scaleFactor,
        autoHideMin: state.autoHideMin,
        lyricBrightness: state.lyricBrightness,
        tiltOn: state.tiltOn,
        vinylOn: state.vinylOn,
        lineAnimOn: state.lineAnimOn,
        gradientOn: state.gradientOn,
        starsOn: state.starsOn,
        nightShiftOn: state.nightShiftOn,
        arcOn: state.arcOn,
        portalOn: state.portalOn,
        hologramOn: state.hologramOn
    };
    localStorage.setItem('lyricsOverlayPrefs', JSON.stringify(prefs));
    window.electronAPI.savePreferences(prefs);
}

// ============================================================================
// LISTEN ALONG UI
// ============================================================================
function renderListenAlong(status) {
    if (!status) return;
    state.laStatus = status;

    const idle = document.getElementById('la-idle');
    const hosting = document.getElementById('la-hosting');
    const guest = document.getElementById('la-guest');
    const msg = document.getElementById('la-msg');

    idle.classList.toggle('hidden', status.mode !== 'off');
    hosting.classList.toggle('hidden', status.mode !== 'host');
    guest.classList.toggle('hidden', status.mode !== 'guest');

    if (status.mode === 'host') {
        document.getElementById('la-code').textContent = status.code;
        const n = status.listeners || 0;
        document.getElementById('la-listeners').textContent = n === 0
            ? 'Share the code or link with friends — they can join from Cadence'
            : `${n === 1 ? '1 friend is' : `${n} friends are`} listening with you. 🎧→ hands them the session.`;
        renderListeners(status.listenersDetail || []);
        renderRequests(status.requests || [], Boolean(status.canQueue));
        state.roomVote = Boolean(status.roomVote);
        syncToggleInputs();
    } else if (status.mode === 'guest') {
        document.getElementById('la-req-note').textContent = status.requestNote || '';
        const dot = `<span class="la-dot${status.connected ? '' : ' off'}"></span>`;
        const who = status.hostName ? `Listening with ${status.hostName}` : 'Listening along';
        document.getElementById('la-with').innerHTML = dot + who + (status.connected ? '' : ' (reconnecting…)');
        document.getElementById('la-guest-track').textContent = status.track
            ? `${status.is_playing ? '▶' : '⏸'} ${status.track.name} — ${status.track.artist}`
            : 'Waiting for the host to play something…';
        state.laMirror = status.mirror !== false;
        syncToggleInputs();
        document.getElementById('la-mirror-note').textContent = status.mirrorNote || '';
    }

    if (status.message) msg.textContent = status.message;
    else if (status.mode !== 'off') msg.textContent = '';

    if (status.mode !== 'host') {
        renderRequests([], false);
        renderListeners([]);
    }

    renderVote(status);

    // Playback controls act on *your* Spotify; hide them while following a host
    elements.body.classList.toggle('listen-along-guest', status.mode === 'guest');
}

// ============================================================================
// ROOM VOTE — the next song, picked by everyone listening
// ============================================================================
let voteTimer = null;
function renderVote(status) {
    const card = document.getElementById('vote-card');
    const inSession = status && status.mode !== 'off';
    const vote = inSession ? status.vote : null;
    const result = inSession ? status.voteResult : null;
    const optionsEl = document.getElementById('vote-options');
    const title = document.getElementById('vote-title');
    const clock = document.getElementById('vote-clock');
    const note = document.getElementById('vote-note');
    clearInterval(voteTimer);
    voteTimer = null;

    const row = (o, extra) => `
        ${o.album_art ? `<img class="vote-art" src="${escapeHtmlText(o.album_art)}" alt="">` : '<span class="vote-art"></span>'}
        <span class="vote-meta">
            <span class="vote-name">${escapeHtmlText(o.name)}</span>
            <span class="vote-sub">${escapeHtmlText(o.artist)} · ${escapeHtmlText(o.by)}${extra || ''}</span>
        </span>`;

    if (vote && vote.options && vote.options.length) {
        title.textContent = 'Next up — pick one';
        optionsEl.innerHTML = vote.options.map(o => `
            <button class="vote-option${vote.myPick === o.uri ? ' picked' : ''}" data-pick="${escapeHtmlText(o.uri)}" ${vote.myPick ? 'disabled' : ''}>${row(o)}</button>`).join('');
        note.textContent = vote.myPick ? `Voted · ${vote.votes || 0} in` : '';
        const tick = () => {
            const left = Math.max(0, Math.ceil((vote.endsAt - Date.now()) / 1000));
            clock.textContent = left;
            if (left <= 0) { clearInterval(voteTimer); voteTimer = null; }
        };
        tick();
        voteTimer = setInterval(tick, 250);
        card.classList.remove('hidden');
    } else if (result && result.winner && Date.now() < result.until) {
        const w = result.winner;
        const n = (result.tally && result.tally[w.uri]) || 0;
        title.textContent = 'Next up';
        clock.textContent = '';
        optionsEl.innerHTML = `<div class="vote-option static">${row(w)}</div>`;
        note.textContent = result.auto
            ? 'The only request — it plays when this song ends'
            : `${n} ${n === 1 ? 'vote' : 'votes'} · plays when this song ends`;
        card.classList.remove('hidden');
        voteTimer = setTimeout(() => card.classList.add('hidden'), Math.max(0, result.until - Date.now()));
    } else {
        card.classList.add('hidden');
    }
}

// Host: who's listening, each with a "hand off the session" button
function renderListeners(listeners) {
    const box = document.getElementById('la-listener-list');
    box.innerHTML = listeners.map(l => `
        <div class="la-listener">
            <span class="la-listener-name">${escapeHtmlText(l.name)}</span>
            <button class="la-req-btn la-handoff" data-handoff="${escapeHtmlText(l.id)}" title="Hand the session to ${escapeHtmlText(l.name)}">🎧→</button>
        </div>`).join('');
}

function escapeHtmlText(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Host: the list of songs guests asked for
function renderRequests(requests, canQueue) {
    const box = document.getElementById('la-requests');
    if (!requests.length) {
        box.innerHTML = '';
        return;
    }
    box.innerHTML = '<div class="la-req-title">Requests</div>' + requests.map(r => `
        <div class="la-req" data-req="${escapeHtmlText(r.reqId)}">
            ${r.track.album_art
                ? `<img class="la-req-art" src="${escapeHtmlText(r.track.album_art)}" alt="">`
                : '<span class="la-req-art"></span>'}
            <div class="la-req-meta">
                <div class="la-req-name">${escapeHtmlText(r.track.name)}</div>
                <div class="la-req-sub">${escapeHtmlText(r.track.artist)} · from ${escapeHtmlText(r.name)}</div>
            </div>
            <button class="la-req-btn" data-action="play" title="Play now">▶</button>
            ${canQueue ? '<button class="la-req-btn" data-action="queue" title="Add to queue">＋</button>' : ''}
            <button class="la-req-btn" data-action="dismiss" title="Dismiss">✕</button>
        </div>`).join('');
}

// ============================================================================
// NOW-PLAYING SOURCE (the Spotify app on this computer vs. the Web API)
// ============================================================================
function applyPlayerInfo(info) {
    if (!info) return;
    state.playerInfo = info;
    state.playerSource = info.source || 'auto';
    state.clickThroughLock = Boolean(info.clickThroughLock);
    updateActiveStyleButtons();
    syncToggleInputs();

    const status = document.getElementById('source-status');
    if (status) {
        let text;
        if (info.active === 'local') {
            text = `Reading ${info.localDescription || 'the Spotify app'} — no API keys or Premium needed.`;
        } else if (info.connected) {
            text = 'Using the Spotify Web API with your keys.';
        } else if (info.configured) {
            text = 'Web API keys saved but not signed in — press 🔄 Spotify.';
        } else {
            text = info.localAvailable
                ? 'No Web API keys (🔑) — pick Auto or Spotify app instead.'
                : 'Add Spotify API keys (🔑) to get started.';
        }
        status.textContent = text;
    }
    const localBtn = document.querySelector('.style-btn[data-style="source"][data-value="local"]');
    if (localBtn) localBtn.disabled = !info.localAvailable;

    // Listen-along name (blank = the Spotify / account name)
    const nameInput = document.getElementById('la-name');
    if (nameInput && document.activeElement !== nameInput) {
        nameInput.value = info.displayName || '';
        nameInput.placeholder = info.nameHint ? `Your name (currently "${info.nameHint}")` : 'Your name (what friends see)';
    }

    // Global shortcuts
    const hk = info.hotkeys || {};
    const hkToggle = document.getElementById('hotkey-toggle');
    const hkSettings = document.getElementById('hotkey-settings');
    if (hkToggle && document.activeElement !== hkToggle) hkToggle.value = hk.toggle || '';
    if (hkSettings && document.activeElement !== hkSettings) hkSettings.value = hk.settings || '';
    const hkErrors = Object.entries(hk.errors || {});
    const hkStatus = document.getElementById('hotkey-status');
    if (hkStatus) {
        hkStatus.textContent = hkErrors.length
            ? hkErrors.map(([k, e]) => `${k === 'toggle' ? 'Show/hide' : 'Settings'}: ${e}`).join(' · ')
            : 'e.g. CommandOrControl+Shift+H — leave blank to disable';
        hkStatus.classList.toggle('la-warn', hkErrors.length > 0);
    }

    // Setup card copy: optional on Mac/Windows, the only way in elsewhere
    document.getElementById('setup-note-local').classList.toggle('hidden', !info.localAvailable);
    document.getElementById('setup-note-api').classList.toggle('hidden', Boolean(info.localAvailable));
    document.getElementById('setup-title').textContent = info.localAvailable
        ? '🔑 Spotify API keys (optional)'
        : '🎧 Connect your Spotify';
    document.getElementById('setup-skip').textContent = info.localAvailable
        ? 'Close — Cadence already works without this'
        : 'Skip for now — I just want to listen along with a friend';
}

async function setPlayerSource(source) {
    try {
        applyPlayerInfo(await window.electronAPI.setPlayerSource(source));
        // Re-render on the next poll so the display flips to the new source
        state.previousTrackId = null;
        fetchCurrentTrack();
    } catch (e) {
        console.error('Could not change source:', e);
    }
}

// ============================================================================
// SPOTIFY POLLING
// ============================================================================
function startPolling() {
    // Initial fetch
    fetchCurrentTrack();

    // Setup interval
    state.pollInterval = setInterval(fetchCurrentTrack, state.pollIntervalMs);
}

async function fetchCurrentTrack() {
    try {
        const result = await window.electronAPI.getCurrentTrack();

        if (result && result.success && result.track) {
            const track = result.track;
            state.emptyPolls = 0;

            // Check if track changed
            if (track.id !== state.previousTrackId) {
                // Portal transition (uses the outgoing track's colors)
                if (state.previousTrackId !== null && state.portalOn &&
                    state.layoutMode !== 'ticker' &&
                    !elements.body.classList.contains('ambient-mode')) {
                    portalBurst();
                }

                state.previousTrackId = track.id;
                state.currentTrack = track;

                // Update UI
                updateTrackDisplay(track);

                // Fetch synced lyrics from LRCLIB
                fetchLyrics(track);

                if (window.Games) Games.onTrackChange(track);

                // Fetch audio analysis
                fetchAudioAnalysis(track.id);

                // Extract dominant color from album art
                if (track.album_art) {
                    extractDominantColor(track.album_art);
                }
            } else if (track.album_art && state.currentTrack && track.album_art !== state.currentTrack.album_art) {
                // Art that arrived after the track did (Windows looks it up separately)
                state.currentTrack = track;
                updateTrackDisplay(track);
                extractDominantColor(track.album_art);
            }

            // Update state for interpolation
            state.lastFetchTime = Date.now();
            state.estimatedProgress = track.progress_ms;
            state.isPlaying = track.is_playing;
            state.trackDuration = track.duration_ms;
            elements.body.classList.toggle('is-playing', track.is_playing);

            // Play/pause button reflects actual state
            elements.pbToggle.textContent = track.is_playing ? '⏸' : '▶';

            // Pause tracking (auto recap)
            if (track.is_playing) {
                handlePlaying();
            } else {
                handlePaused();
            }

            // Start sync loop if not running
            if (!state.syncAnimationFrame) {
                startSyncLoop();
            }

        } else {
            // No track playing. One empty poll can be a Spotify hiccup, so
            // the display only resets after two in a row (~4s) — otherwise
            // lyrics would flicker and re-fetch for nothing.
            state.emptyPolls = (state.emptyPolls || 0) + 1;
            if (state.currentTrack !== null) console.log('Empty poll', state.emptyPolls, JSON.stringify(result).slice(0, 200));
            if (state.currentTrack !== null && state.emptyPolls >= 2) {
                state.currentTrack = null;
                // Forget the last track so the display re-renders when
                // playback resumes with the same song
                state.previousTrackId = null;
                resetDisplay();
                if (window.Games) Games.onTrackChange(null);
            }
            // Why there's nothing: "Open Spotify…", a permission hint, etc.
            if (result && result.listenAlong && result.listenAlong.waitingFor) {
                // Listen-along guest with nothing from the host yet
                elements.trackName.textContent = 'Listening along';
                elements.artistName.textContent = `Waiting for ${result.listenAlong.waitingFor}…`;
            } else if (result && result.message && result.source === 'local') {
                elements.artistName.textContent = result.message;
            } else if (result && result.needs_setup) {
                elements.artistName.textContent = 'Connect to Spotify (gear → 🔑)';
            } else if (result && result.needs_auth) {
                elements.artistName.textContent = 'Sign in to Spotify again (gear → 🔄)';
            }
            state.isPlaying = false;
            elements.body.classList.remove('is-playing');
            handlePaused();
        }
    } catch (error) {
        console.error('Error fetching current track:', error);
    }
}

// ============================================================================
// PAUSE HANDLING (Auto Recap)
// ============================================================================
function handlePlaying() {
    state.hasPlayedThisSession = true;
    state.pausedSince = null;
    state.pauseHandled = false;
    setAutoHidden(false);
}

function handlePaused() {
    if (!state.pausedSince) {
        state.pausedSince = Date.now();
    }

    // Auto-hide: fade out after N minutes without music
    if (state.autoHideMin > 0 && Date.now() - state.pausedSince > state.autoHideMin * 60000) {
        setAutoHidden(true);
    }

    // After 8s of silence, maybe show the recap
    if (!state.pauseHandled && Date.now() - state.pausedSince > 8000) {
        state.pauseHandled = true;

        if (state.dailyRecap && state.hasPlayedThisSession) {
            maybeAutoRecap();
        }
    }
}

// ============================================================================
// TRACK DISPLAY
// ============================================================================
function updateTrackDisplay(track) {
    // Update text
    elements.trackName.textContent = track.name;
    elements.artistName.textContent = track.artist;

    // Update album art
    if (track.album_art) {
        elements.albumArt.src = track.album_art;
        elements.albumArt.onload = () => {
            elements.albumArtPlaceholder.classList.add('hidden');
        };
        elements.albumArt.onerror = () => {
            elements.albumArtPlaceholder.classList.remove('hidden');
        };
    } else {
        elements.albumArtPlaceholder.classList.remove('hidden');
    }

    if (window.Games) Games.applyTitleMask(); // Guess the song hides the title
    updateTicker();
    updateAmbient();
}

// "Song — Artist", unless a game is hiding it
function trackLabel() {
    const t = state.currentTrack;
    if (!t) return '';
    if (window.Games && Games.hidesTitle()) return Games.maskedLabel();
    return `${t.name} — ${t.artist}`;
}

function resetDisplay() {
    elements.trackName.textContent = 'No track playing';
    elements.artistName.textContent = 'Connect to Spotify';
    elements.albumArtPlaceholder.classList.remove('hidden');
    elements.albumArt.src = '';

    // Reset lyrics
    state.lyrics = [];
    state.currentLyricIndex = 0;
    renderLyrics([{ text: '♪ Waiting for music... ♪', placeholder: true }]);
    updateTicker();
}

// ============================================================================
// LYRICS HANDLING
// ============================================================================
async function fetchLyrics(track) {
    try {
        // Show loading state
        state.beatMs = null;
        renderLyrics([{ text: '♪ Loading lyrics... ♪', placeholder: true }]);

        // Get synced lyrics from LRCLIB (using track details)
        const result = await window.electronAPI.getSyncedLyrics(
            track.name,
            track.artist,
            track.album,
            track.duration_ms
        );

        if (result && result.success && result.lines && result.lines.length > 0) {
            console.log(`Loaded ${result.lines.length} synced lyrics (${result.syncType})`);

            // Use Spotify synced lyrics with timestamps
            state.lyrics = result.lines.map((line, index) => ({
                text: line.text,
                index: index,
                startTimeMs: line.startTimeMs,
                endTimeMs: line.endTimeMs
            }));
            state.lyricsAreSynced = result.synced === true;

            markChorusLines();
            computeBeatEstimate();

            // Render initial lyrics
            state.currentLyricIndex = 0;
            renderLyrics(state.lyrics);
            maybeTranslate(track);
        } else {
            // LRCLIB failed or has nothing for this track — fall back to Genius (unsynced)
            const errorMsg = result && result.error ? result.error : 'No lyrics available';
            console.log('Lyrics error:', errorMsg, '- trying Genius fallback');

            const genius = await window.electronAPI.getLyrics(track.artist, track.name);
            if (genius && genius.source === 'genius' && genius.lines && genius.lines.length > 0) {
                console.log(`Loaded ${genius.lines.length} unsynced lyrics (genius)`);
                state.lyrics = genius.lines.map((text, index) => ({
                    text: text,
                    index: index,
                    startTimeMs: null,
                    endTimeMs: null
                }));
                state.lyricsAreSynced = false;
                markChorusLines();
                state.currentLyricIndex = 0;
                renderLyrics(state.lyrics);
                maybeTranslate(track);
            } else {
                state.lyrics = [];
                state.lyricsAreSynced = false;
                renderLyrics([{ text: '♪ No lyrics available ♪', placeholder: true }]);
            }
        }
    } catch (error) {
        console.error('Error fetching lyrics:', error);
        renderLyrics([{ text: '♪ Could not load lyrics ♪', placeholder: true }]);
    }
}

// Chorus detection: lines that repeat 3+ times are the hook
function markChorusLines() {
    const counts = {};
    state.lyrics.forEach(lyric => {
        const key = lyric.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
        if (key.length > 8) counts[key] = (counts[key] || 0) + 1;
    });

    state.lyrics.forEach(lyric => {
        const key = lyric.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
        lyric.chorus = counts[key] >= 3;
    });
}

// Estimate beat length from the spacing of synced lyric lines
// (a line is roughly a musical phrase of ~4 beats)
function computeBeatEstimate() {
    if (!state.lyricsAreSynced) return;

    const gaps = [];
    for (let i = 1; i < state.lyrics.length; i++) {
        const prev = state.lyrics[i - 1].startTimeMs;
        const cur = state.lyrics[i].startTimeMs;
        if (prev !== null && cur !== null) {
            const gap = cur - prev;
            if (gap >= 800 && gap <= 8000) gaps.push(gap);
        }
    }
    if (gaps.length < 4) return;

    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    state.beatMs = Math.min(1000, Math.max(300, median / 4));
}

function renderLyrics(lyrics) {
    cancelTyping();
    elements.lyricsContainer.innerHTML = '';

    lyrics.forEach((lyric, index) => {
        const line = document.createElement('div');
        line.className = 'lyric-line';
        line.dataset.index = index;

        const text = document.createElement('span');
        text.className = 'lyric-text';
        text.textContent = lyric.text;
        line.appendChild(text);

        if (lyric.chorus) {
            line.classList.add('chorus');
        }

        if (lyric.placeholder) {
            line.classList.add('placeholder');
        }

        if (index === 0) {
            line.classList.add('active');
        }

        elements.lyricsContainer.appendChild(line);
    });

    updateFocusClasses(0);
    updateTicker();
    if (window.Games) Games.onLyrics();
}

function startSyncLoop() {
    function loop() {
        if (state.isPlaying && state.trackDuration > 0 && !state.scrubbing) {
            // Interpolate progress
            const now = Date.now();
            const elapsed = now - state.lastFetchTime;
            const currentProgress = Math.min(state.estimatedProgress + elapsed, state.trackDuration);

            updateLyricsProgress(currentProgress, state.trackDuration);
        }

        state.syncAnimationFrame = requestAnimationFrame(loop);
    }
    loop();
}

function updateLyricsProgress(progressMs, durationMs) {
    // Progress arc around the album art
    if (state.arcOn && durationMs > 0) {
        const arc = document.querySelector('#progress-arc .arc-fg');
        if (arc) {
            arc.style.strokeDashoffset = 427.26 * (1 - Math.min(1, progressMs / durationMs));
        }
    }

    if (window.Games) Games.onTick(progressMs);

    // Notch bar: elapsed time on the right, a hairline of progress underneath
    if (state.layoutMode === 'notch' && durationMs > 0) {
        const fill = document.getElementById('notch-progress-fill');
        if (fill) fill.style.width = `${Math.min(100, progressMs / durationMs * 100).toFixed(2)}%`;
        const time = document.getElementById('notch-time');
        if (time) {
            const s = Math.floor(progressMs / 1000);
            const label = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
            if (time.textContent !== label) time.textContent = label;
        }
    }

    if (state.lyrics.length === 0) return;

    let newIndex = state.currentLyricIndex;

    if (state.lyricsAreSynced) {
        // Find the current lyric based on timestamp
        // We look for the LAST lyric that has started
        let foundIndex = -1;

        for (let i = 0; i < state.lyrics.length; i++) {
            const lyric = state.lyrics[i];
            if (lyric.startTimeMs !== null && progressMs >= lyric.startTimeMs) {
                foundIndex = i;
            } else if (lyric.startTimeMs !== null && progressMs < lyric.startTimeMs) {
                // If we found a lyric that starts in the future, stop checking
                break;
            }
        }

        if (foundIndex !== -1) {
            newIndex = foundIndex;
        }
    } else {
        // Estimate current lyric based on progress (fallback for unsynced)
        const progressPercent = progressMs / durationMs;
        newIndex = Math.floor(progressPercent * state.lyrics.length);
        newIndex = Math.min(Math.max(0, newIndex), state.lyrics.length - 1);
    }

    if (newIndex !== state.currentLyricIndex) {
        // console.log(`Lyric changed: ${state.currentLyricIndex} -> ${newIndex} at ${Math.round(progressMs)}ms`);
        state.currentLyricIndex = newIndex;
        updateActiveLyric(newIndex);
        if (window.Games) Games.onLine(newIndex);
    }
}

function updateActiveLyric(activeIndex) {
    const lines = elements.lyricsContainer.querySelectorAll('.lyric-line');

    lines.forEach((line, index) => {
        line.classList.remove('active', 'passed');

        if (index === activeIndex) {
            line.classList.add('active');
        } else if (index < activeIndex) {
            line.classList.add('passed');
        }
    });

    updateFocusClasses(activeIndex);
    updateTicker();
    updateAmbient();

    // Per-style entrance animation on the newly active line
    if (state.lineAnimOn) {
        const enterLine = lines[activeIndex];
        if (enterLine && !enterLine.classList.contains('placeholder')) {
            const resolved = state.lyricStyle === 'auto' ? state.autoStyle : state.lyricStyle;
            if (resolved === 'retro') {
                typeLine(enterLine);
            } else {
                enterLine.classList.remove('line-enter');
                void enterLine.offsetWidth; // restart the animation
                enterLine.classList.add('line-enter');
            }
        }
    }

    // Chorus hits: fireworks + engine flare
    const activeLyric = state.lyrics[activeIndex];
    if (activeLyric && activeLyric.chorus) {
        flareThrusters();
        if (state.fireworksOn) {
            triggerChorusBurst();
        }
    }

    // Scroll to center the active line ("Karaoke Style")
    if (state.layoutMode !== 'ticker') {
        scrollToActiveLyric(activeIndex);
    }
}

// ============================================================================
// RETRO TYPEWRITER
// ============================================================================
let typing = null;

function cancelTyping() {
    if (!typing) return;
    clearTimeout(typing.timer);
    if (typing.span.isConnected) {
        typing.span.textContent = typing.fullText;
        typing.line.style.minHeight = '';
    }
    typing = null;
}

function typeLine(line) {
    cancelTyping();

    const span = line.querySelector('.lyric-text');
    if (!span || !span.textContent) return;

    const fullText = span.textContent;

    // Reserve the line's full height so later lines don't shift while typing
    line.style.minHeight = `${line.offsetHeight}px`;

    // Base speed scales so long lines still land in ~600ms
    const baseMs = Math.max(10, Math.min(28, 550 / fullText.length));
    let i = 0;
    span.textContent = '';

    typing = { span, line, fullText, timer: null };

    function tick() {
        i++;
        if (!span.isConnected || i >= fullText.length) {
            cancelTyping();
            return;
        }
        span.textContent = fullText.slice(0, i);

        // Human rhythm: every keystroke jitters, punctuation hangs a beat,
        // and occasionally the typist just hesitates
        let delay = baseMs * (0.6 + Math.random() * 0.9);
        const ch = fullText[i - 1];
        if (',.;:!?'.includes(ch)) {
            delay += baseMs * 3;
        } else if (ch === ' ' && Math.random() < 0.2) {
            delay += baseMs * 1.5;
        } else if (Math.random() < 0.06) {
            delay += baseMs * 2.5;
        }

        typing.timer = setTimeout(tick, delay);
    }

    typing.timer = setTimeout(tick, baseMs);
}

// ============================================================================
// CHORUS FIREWORKS
// ============================================================================
function flareThrusters() {
    const thrusters = document.getElementById('thrusters');
    thrusters.classList.remove('flare');
    void thrusters.offsetWidth; // restart the animation
    thrusters.classList.add('flare');
}

function triggerChorusBurst() {
    let target;
    if (elements.body.classList.contains('ambient-mode')) {
        target = elements.ambientLyric;
    } else if (state.layoutMode === 'ticker') {
        target = elements.tickerLyric;
    } else {
        target = elements.lyricsContainer.querySelector('.lyric-line.active');
    }
    if (!target) return;

    // Let the scroll animation settle before measuring
    setTimeout(() => spawnBurst(target), 250);
}

function spawnBurst(target) {
    const rect = target.getBoundingClientRect();
    if (!rect.width) return;

    const cx = rect.left + Math.min(rect.width, 300) / 2;
    const cy = rect.top + rect.height / 2;
    const { r, g, b } = state.dominantColorRgb;

    for (let i = 0; i < 14; i++) {
        const p = document.createElement('div');
        p.className = 'burst-particle';
        const angle = Math.random() * Math.PI * 2;
        const dist = 40 + Math.random() * 90;
        p.style.left = `${cx}px`;
        p.style.top = `${cy}px`;
        p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
        p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
        p.style.background = `rgb(${r}, ${g}, ${b})`;
        p.style.boxShadow = `0 0 8px rgb(${r}, ${g}, ${b})`;
        document.body.appendChild(p);
        setTimeout(() => p.remove(), 900);
    }
}

// ============================================================================
// PLAYBACK CONTROLS
// ============================================================================
async function sendPlayback(command) {
    try {
        if (command === 'play') elements.pbToggle.textContent = '⏸';
        if (command === 'pause') elements.pbToggle.textContent = '▶';
        await window.electronAPI.controlPlayback(command);
        setTimeout(fetchCurrentTrack, 600);
    } catch (error) {
        console.error('Playback control failed:', error);
    }
}

// ============================================================================
// RING SCRUBBING (drag the progress arc to seek)
// ============================================================================
function initScrubbing() {
    const arc = document.getElementById('progress-arc');

    const angleToMs = (e) => {
        const rect = arc.getBoundingClientRect();
        const dx = e.clientX - (rect.left + rect.width / 2);
        const dy = e.clientY - (rect.top + rect.height / 2);
        // Arc starts at 12 o'clock and runs clockwise
        let angle = Math.atan2(dy, dx) + Math.PI / 2;
        if (angle < 0) angle += Math.PI * 2;
        return (angle / (Math.PI * 2)) * state.trackDuration;
    };

    arc.addEventListener('mousedown', (e) => {
        if (!state.arcOn || !state.currentTrack || !state.trackDuration) return;
        if (state.laStatus && state.laStatus.mode === 'guest') return;
        state.scrubbing = true;
        elements.body.classList.add('scrubbing');
        state.scrubMs = angleToMs(e);
        updateLyricsProgress(state.scrubMs, state.trackDuration);
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!state.scrubbing) return;
        state.scrubMs = angleToMs(e);
        // Live preview: the arc jumps and the lyrics flip-book past
        updateLyricsProgress(state.scrubMs, state.trackDuration);
    });

    document.addEventListener('mouseup', async () => {
        if (!state.scrubbing) return;
        state.scrubbing = false;
        elements.body.classList.remove('scrubbing');

        const target = Math.round(state.scrubMs);
        state.estimatedProgress = target;
        state.lastFetchTime = Date.now();

        try {
            await window.electronAPI.controlPlayback('seek', target);
        } catch (error) {
            console.error('Seek failed:', error);
        }
        setTimeout(fetchCurrentTrack, 600);
    });
}

// ============================================================================
// PORTAL TRANSITIONS (track-change particle vortex)
// ============================================================================
function portalBurst() {
    const canvas = document.getElementById('portal-canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d');

    const rect = elements.container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const { r, g, b } = state.dominantColorRgb;

    const particles = [];
    for (let i = 0; i < 220; i++) {
        particles.push({
            x: rect.left + Math.random() * rect.width,
            y: rect.top + Math.random() * rect.height,
            size: 1 + Math.random() * 2.5,
            spin: 0.04 + Math.random() * 0.09,
            tinted: Math.random() < 0.7
        });
    }

    const start = performance.now();
    const DURATION = 1100;

    (function animate(now) {
        const t = (now - start) / DURATION;
        if (t >= 1) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        particles.forEach(p => {
            // Spiral inward, then fling outward
            const dx = p.x - cx;
            const dy = p.y - cy;
            const angle = Math.atan2(dy, dx) + p.spin;
            const dist = Math.hypot(dx, dy) * (t < 0.45 ? 0.96 : 1.07);
            p.x = cx + Math.cos(angle) * dist;
            p.y = cy + Math.sin(angle) * dist;

            const alpha = t < 0.45 ? 0.9 : 0.9 * (1 - (t - 0.45) / 0.55);
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fillStyle = p.tinted
                ? `rgba(${r}, ${g}, ${b}, ${alpha})`
                : `rgba(255, 255, 255, ${alpha * 0.8})`;
            ctx.fill();
        });

        requestAnimationFrame(animate);
    })(start);

    // New content fades in beneath the burst
    elements.container.classList.remove('portal-in');
    void elements.container.offsetWidth;
    elements.container.classList.add('portal-in');
}

// ============================================================================
// AMBIENT MODE
// ============================================================================
function updateAmbient() {
    if (!elements.body.classList.contains('ambient-mode')) return;

    const current = state.lyrics[state.currentLyricIndex];
    const next = state.lyrics[state.currentLyricIndex + 1];
    elements.ambientLyric.textContent = current && current.text ? current.text : '♪';
    elements.ambientNext.textContent = next && next.text ? next.text : '';

    if (state.currentTrack) {
        elements.ambientTrack.textContent = trackLabel();
        if (state.currentTrack.album_art && elements.ambientArt.src !== state.currentTrack.album_art) {
            elements.ambientArt.src = state.currentTrack.album_art;
        }
    }
}

// In focus layout only the previous/current/next lines are visible
function updateFocusClasses(activeIndex) {
    const lines = elements.lyricsContainer.querySelectorAll('.lyric-line');
    const focusOn = state.layoutMode === 'focus';

    lines.forEach((line, index) => {
        line.classList.remove('focus-prev', 'focus-next');
        if (!focusOn) return;

        if (index === activeIndex - 1) {
            line.classList.add('focus-prev');
        } else if (index === activeIndex + 1) {
            line.classList.add('focus-next');
        }
    });
}

// ============================================================================
// MINI TICKER
// ============================================================================
function updateTicker() {
    if (state.currentTrack) {
        elements.tickerTrack.textContent = trackLabel();
        if (state.currentTrack.album_art && elements.tickerArt.src !== state.currentTrack.album_art) {
            elements.tickerArt.src = state.currentTrack.album_art;
        }
    } else {
        elements.tickerTrack.textContent = 'Nothing playing';
        elements.tickerArt.removeAttribute('src');
    }

    const current = state.lyrics[state.currentLyricIndex];
    elements.tickerLyric.textContent = current && current.text ? current.text : '♪';

    // The notch bar shows the same thing, one line at a time
    const notchTitle = document.getElementById('notch-title');
    if (notchTitle) {
        const art = document.getElementById('notch-art');
        notchTitle.textContent = state.currentTrack ? trackLabel() : 'Nothing playing';
        if (state.currentTrack && state.currentTrack.album_art) {
            if (art.src !== state.currentTrack.album_art) art.src = state.currentTrack.album_art;
            art.hidden = false;
        } else {
            art.removeAttribute('src');
            art.hidden = true;
        }
        document.getElementById('notch-lyric').textContent = current && current.text ? current.text : '♪';
    }

    positionTickerGear();
}

// In ticker layout the window is invisible except the bar, so the gear
// lives inside the bar itself — it can never end up off screen
function positionTickerGear() {
    const gear = elements.settingsBtn;
    const menu = elements.settingsMenu;

    if (state.layoutMode === 'ticker') {
        if (gear.parentElement !== elements.tickerBar) {
            elements.tickerBar.appendChild(gear);
        }

        // Open the menu just under the bar, aligned to its right edge
        const rect = elements.tickerBar.getBoundingClientRect();
        menu.style.left = `${Math.max(10, Math.min(rect.right - 300, window.innerWidth - 310))}px`;
        menu.style.top = `${rect.bottom + 10}px`;
        menu.style.right = 'auto';
    } else {
        if (gear.parentElement !== document.body) {
            document.body.appendChild(gear);
        }
        menu.style.left = '';
        menu.style.top = '';
        menu.style.right = '';
    }
}

function scrollToActiveLyric(index) {
    const lines = elements.lyricsContainer.querySelectorAll(".lyric-line");
    const activeLine = lines[index];
    if (!activeLine) return;

    // IMPORTANT: use the actual masking viewport element here
    // If you have #lyrics-section, use it. Otherwise fallback.
    const viewport =
        document.querySelector("#lyrics-section") ||
        elements.lyricsContainer.parentElement;

    const viewportRect = viewport.getBoundingClientRect();
    const activeRect = activeLine.getBoundingClientRect();

    // How far (in px) the active line's center is from the anchor point.
    // Focus layout anchors near the top so content stays by the drag handle.
    const activeCenter = activeRect.top + activeRect.height / 2;
    const viewportCenter = state.layoutMode === 'focus'
        ? viewportRect.top + 100
        : viewportRect.top + viewportRect.height / 2;
    const delta = activeCenter - viewportCenter;

    // Read current translateY
    const transform = getComputedStyle(elements.lyricsContainer).transform;
    let currentY = 0;
    if (transform && transform !== "none") {
        const m = new DOMMatrixReadOnly(transform);
        currentY = m.m42; // translateY
    }

    // Optional: if you want the line slightly above center, use a small offset
    const bias = -10; // try 0 first; avoid big magic numbers like -100

    // If delta is positive, the line is below center -> move container up (more negative)
    let nextY = currentY - delta + bias;

    // Don't scroll past the top?
    // User requested centering from the start. 
    // Removing the clamp allows the first lyric to be centered (moving container down).
    // nextY = Math.min(0, nextY); 

    // NOTE: If you prefer the list to start at the top and stay there until the active line 
    // reaches the middle, uncomment the line above. 
    // Currently disabling it to ensure "Karaoke" centering for lines 0-15.

    elements.lyricsContainer.style.transform = `translateY(${nextY}px)`;
}


// ============================================================================
// LYRICS TRANSLATION
// ============================================================================
async function maybeTranslate(track) {
    if (!state.translationOn || !state.lyrics.length) return;

    const trackId = track.id;

    // Already translated this track — just re-attach
    if (state.translations[trackId]) {
        applyTranslations(state.translations[trackId]);
        return;
    }

    try {
        const texts = state.lyrics.map(l => l.text);
        const result = await window.electronAPI.translateLyrics(texts);

        // Ignore stale responses if the track changed mid-request
        if (trackId !== state.previousTrackId) return;

        if (result && result.success && result.detectedLang && result.detectedLang !== 'en' && result.lines) {
            console.log(`Translated lyrics from ${result.detectedLang}`);
            state.translations[trackId] = result.lines;
            applyTranslations(result.lines);
        }
    } catch (error) {
        console.error('Translation error:', error);
    }
}

function applyTranslations(translations) {
    const lines = elements.lyricsContainer.querySelectorAll('.lyric-line');

    lines.forEach((line, index) => {
        const existing = line.querySelector('.lyric-translation');
        if (existing) existing.remove();

        const translated = translations[index];
        if (translated && !line.classList.contains('placeholder')) {
            const sub = document.createElement('div');
            sub.className = 'lyric-translation';
            sub.textContent = translated;
            line.appendChild(sub);
        }
    });
}

// ============================================================================
// DAILY RECAP
// ============================================================================
async function showRecap(autoTriggered) {
    try {
        const recap = await window.electronAPI.getDailyRecap();
        if (!recap || !recap.success || recap.empty) {
            if (!autoTriggered) {
                document.getElementById('recap-time').textContent = '0m';
                document.getElementById('recap-plays').textContent = '0';
                document.getElementById('recap-unique').textContent = '0';
                document.getElementById('recap-top-artist').textContent = 'Nothing played yet today';
                document.getElementById('recap-top-track').textContent = '';
                elements.recapCard.classList.remove('hidden');
            }
            return;
        }

        document.getElementById('recap-time').textContent = formatListenTime(recap.listenMs);
        document.getElementById('recap-plays').textContent = recap.totalPlays;
        document.getElementById('recap-unique').textContent = recap.uniqueTracks;
        document.getElementById('recap-top-artist').innerHTML = '';
        document.getElementById('recap-top-track').innerHTML = '';
        appendRecapLine('recap-top-artist', 'Top artist: ', recap.topArtist);
        appendRecapLine('recap-top-track', 'Top track: ', recap.topTrack);

        elements.recapCard.classList.remove('hidden');

        // Auto-shown cards dismiss themselves
        if (autoTriggered) {
            setTimeout(hideRecap, 15000);
        }
    } catch (error) {
        console.error('Recap error:', error);
    }
}

function appendRecapLine(elementId, label, value) {
    const el = document.getElementById(elementId);
    const dim = document.createElement('span');
    dim.className = 'recap-dim';
    dim.textContent = label;
    el.appendChild(dim);
    el.appendChild(document.createTextNode(value || '–'));
}

function hideRecap() {
    elements.recapCard.classList.add('hidden');
}

function formatListenTime(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Show the recap automatically when a listening session ends (min 15 min
// listened, at most once every 4 hours)
async function maybeAutoRecap() {
    const last = Number(localStorage.getItem('lastAutoRecapAt') || 0);
    if (Date.now() - last < 4 * 60 * 60 * 1000) return;

    try {
        const recap = await window.electronAPI.getDailyRecap();
        if (recap && recap.success && !recap.empty && recap.listenMs >= 15 * 60 * 1000) {
            localStorage.setItem('lastAutoRecapAt', String(Date.now()));
            showRecap(true);
        }
    } catch (error) {
        console.error('Auto recap error:', error);
    }
}

// ============================================================================
// STAR FIELD
// ============================================================================
const starField = { canvas: null, ctx: null, stars: [], raf: null };

function startStars() {
    const canvas = document.getElementById('starfield-canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    starField.canvas = canvas;
    starField.ctx = canvas.getContext('2d');

    if (!starField.stars.length) {
        for (let i = 0; i < 70; i++) {
            starField.stars.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                r: 0.5 + Math.random() * 1.5,
                vx: (Math.random() - 0.5) * 0.15,
                vy: (Math.random() - 0.5) * 0.15,
                tw: Math.random() * Math.PI * 2
            });
        }
    }

    cancelAnimationFrame(starField.raf);
    (function loop() {
        if (!state.starsOn) return;
        const { ctx, canvas } = starField;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const { r, g, b } = state.dominantColorRgb;
        // Faster drift on faster songs
        const speed = state.beatMs ? Math.min(2.5, 600 / state.beatMs) : 1;

        starField.stars.forEach(s => {
            s.x = (s.x + s.vx * speed + canvas.width) % canvas.width;
            s.y = (s.y + s.vy * speed + canvas.height) % canvas.height;
            s.tw += 0.03;
            const alpha = 0.2 + 0.35 * (Math.sin(s.tw) + 1) / 2;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${Math.min(255, r + 130)}, ${Math.min(255, g + 130)}, ${Math.min(255, b + 130)}, ${alpha})`;
            ctx.fill();
        });

        starField.raf = requestAnimationFrame(loop);
    })();
}

function stopStars() {
    cancelAnimationFrame(starField.raf);
    if (starField.ctx) {
        starField.ctx.clearRect(0, 0, starField.canvas.width, starField.canvas.height);
    }
}

// ============================================================================
// NIGHT SHIFT
// ============================================================================
function updateNightShift() {
    const hour = new Date().getHours();
    const night = state.nightShiftOn && (hour >= 20 || hour < 6);
    elements.body.classList.toggle('night-active', night);
}

// ============================================================================
// 3D PARALLAX (always on)
// ============================================================================
const parallax = { tx: 0, ty: 0, cx: 0, cy: 0, pop: 0, collapse: 0, lastMove: 0 };

function initParallax() {
    document.addEventListener('mousemove', (e) => {
        parallax.lastMove = Date.now();
        parallax.tx = (e.clientX / window.innerWidth) * 2 - 1;
        parallax.ty = (e.clientY / window.innerHeight) * 2 - 1;
    });

    document.addEventListener('mouseleave', () => {
        parallax.tx = 0;
        parallax.ty = 0;
    });

    (function loop() {
        let tx = parallax.tx;
        let ty = parallax.ty;

        // With no mouse activity, settle into a slow organic float
        if (Date.now() - parallax.lastMove > 4000) {
            const t = Date.now() / 1000;
            tx = Math.sin(t * 0.4) * 0.12;
            ty = Math.cos(t * 0.3) * 0.10;
        }

        // Inertia: ease toward the target so the card has physical weight
        parallax.cx += (tx - parallax.cx) * 0.06;
        parallax.cy += (ty - parallax.cy) * 0.06;

        // The 3D pose and hover frame are a full-layout experience only,
        // and can be switched off entirely in settings
        const active = state.tiltOn && state.layoutMode === 'full' &&
            !elements.body.classList.contains('ambient-mode');

        // While the cursor is inside, the card lifts toward the viewer
        const hovering = active && elements.body.matches(':hover');
        parallax.pop += ((hovering ? 1 : 0) - parallax.pop) * 0.07;

        // Hologram power: clicking the emitter sucks the card into the lens
        parallax.collapse += ((state.holoCollapsed ? 1 : 0) - parallax.collapse) * 0.12;
        const collapse = (state.hologramOn && state.layoutMode === 'full') ? parallax.collapse : 0;

        let rx = 0;
        let ry = 0;
        let lift = 0;
        let scaleNum = 1;
        let transform = '';

        if (active) {
            // Entering swings the card into a standing 3D pose: left edge
            // toward the viewer, right edge receding. The mouse adds a
            // little deviation around that pose.
            const baseYaw = parallax.pop * 32;
            const maxTilt = 3 + parallax.pop * 4;
            rx = parallax.cy * maxTilt;
            ry = baseYaw - parallax.cx * maxTilt;
            lift = parallax.pop * 45;
            scaleNum = 1 + parallax.pop * 0.015;
            transform =
                `translateZ(${lift.toFixed(1)}px) scale(${scaleNum.toFixed(4)}) rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg)`;

            // Light source follows the cursor: sheen toward it, shadow away
            const root = document.documentElement.style;
            root.setProperty('--sheen-x', `${(50 + parallax.cx * 45).toFixed(1)}%`);
            root.setProperty('--sheen-y', `${(50 + parallax.cy * 45).toFixed(1)}%`);
            root.setProperty('--shadow-x', `${(-parallax.cx * 14).toFixed(1)}px`);
            root.setProperty('--shadow-y', `${(8 - parallax.cy * 10).toFixed(1)}px`);
            // Side faces brighten as they rotate into the light
            root.setProperty('--face-light', (0.85 + (ry / 40) * 0.5).toFixed(3));
        }

        if (collapse > 0.001) {
            const card = elements.container;
            const centerY = card.offsetTop + card.offsetHeight / 2;
            const dy = (document.body.offsetHeight - 8 - centerY) * collapse;
            transform = `translateY(${dy.toFixed(1)}px) scale(${Math.max(0.001, 1 - collapse).toFixed(3)}) ${transform}`;
            card.style.opacity = Math.max(0, 1 - collapse * 1.15).toFixed(3);
        } else if (elements.container.style.opacity) {
            elements.container.style.opacity = '';
        }

        elements.container.style.transform = transform;
        updateHoloBeam(rx, ry, lift, scaleNum, collapse);

        requestAnimationFrame(loop);
    })();
}

// Project the card's bottom corners through the same 3D pipeline the GPU
// uses (rotateY -> rotateX -> scale -> lift -> perspective divide) and pin
// the beam's wide end to them
function updateHoloBeam(rxDeg, ryDeg, lift, scale, collapse = 0) {
    if (!state.hologramOn || state.layoutMode !== 'full' ||
        elements.body.classList.contains('ambient-mode')) return;

    const beam = document.getElementById('holo-beam');
    // Body layout size stays in the same units as offset* regardless of
    // the Size dial's zoom factor
    const W = document.body.offsetWidth;
    const H = document.body.offsetHeight;

    // The card's true layout box (offset* values ignore transforms)
    const card = elements.container;
    const cardLeft = card.offsetLeft;
    const cardTop = card.offsetTop;
    const cardRight = cardLeft + card.offsetWidth;
    const cardBottom = cardTop + card.offsetHeight;
    const cx = (cardLeft + cardRight) / 2;
    const cy = (cardTop + cardBottom) / 2;

    const rx = rxDeg * Math.PI / 180;
    const ry = ryDeg * Math.PI / 180;
    const PERSPECTIVE = 900;
    const Ox = W / 2;
    const Oy = H / 2;

    const project = (x, y) => {
        const lx = x - cx;
        const ly = y - cy;
        // rotateY, then rotateX
        let px = lx * Math.cos(ry);
        let pz = -lx * Math.sin(ry);
        const py = ly * Math.cos(rx) - pz * Math.sin(rx);
        pz = ly * Math.sin(rx) + pz * Math.cos(rx);
        // scale (2D), then lift toward the camera
        px *= scale;
        pz += lift;
        const f = PERSPECTIVE / (PERSPECTIVE - pz);
        return [Ox + (cx + px - Ox) * f, Oy + (cy + py * scale - Oy) * f];
    };

    let [blx, bly] = project(cardLeft, cardBottom);
    let [brx, bry] = project(cardRight, cardBottom);

    // Beam element covers the whole window, so the polygon is drawn in
    // plain screen coordinates: card corners down to the lens slit
    const lensX = cx;
    const lensY = H - 8;
    const lensHalf = 9;

    // Powering down: the cone retracts into the lens
    blx += (lensX - blx) * collapse;
    bly += (lensY - bly) * collapse;
    brx += (lensX - brx) * collapse;
    bry += (lensY - bry) * collapse;

    beam.style.clipPath =
        `polygon(${blx.toFixed(1)}px ${bly.toFixed(1)}px, ` +
        `${brx.toFixed(1)}px ${bry.toFixed(1)}px, ` +
        `${(lensX + lensHalf).toFixed(1)}px ${lensY}px, ` +
        `${(lensX - lensHalf).toFixed(1)}px ${lensY}px)`;
}

// ============================================================================
// AUDIO ANALYSIS
// ============================================================================
async function fetchAudioAnalysis(trackId) {
    try {
        const result = await window.electronAPI.getAudioAnalysis(trackId);

        if (result && result.success && result.analysis) {
            state.audioAnalysis = result.analysis;
            state.beats = result.analysis.beats || [];
            state.currentBeatIndex = 0;

            console.log(`Loaded ${state.beats.length} beats, tempo: ${result.analysis.tempo}`);
        }
    } catch (error) {
        console.error('Error fetching audio analysis:', error);
    }
}

// ============================================================================
// COLOR EXTRACTION
// ============================================================================
function extractDominantColor(imageUrl) {
    const img = new Image();
    img.crossOrigin = 'Anonymous';

    img.onload = () => {
        try {
            // Create a small canvas to sample colors
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 50;
            canvas.height = 50;

            ctx.drawImage(img, 0, 0, 50, 50);
            const imageData = ctx.getImageData(0, 0, 50, 50);
            const data = imageData.data;

            // Simple dominant color extraction (average with saturation boost),
            // plus coarse color buckets to find a distinct secondary color
            let r = 0, g = 0, b = 0, count = 0;
            const buckets = {};

            for (let i = 0; i < data.length; i += 16) { // Sample every 4th pixel
                // Skip very dark or very light pixels
                const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                if (brightness > 30 && brightness < 220) {
                    r += data[i];
                    g += data[i + 1];
                    b += data[i + 2];
                    count++;

                    const key = `${data[i] >> 5}_${data[i + 1] >> 5}_${data[i + 2] >> 5}`;
                    const bucket = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, n: 0 });
                    bucket.r += data[i];
                    bucket.g += data[i + 1];
                    bucket.b += data[i + 2];
                    bucket.n++;
                }
            }

            if (count > 0) {
                r = Math.round(r / count);
                g = Math.round(g / count);
                b = Math.round(b / count);

                // Boost saturation
                const max = Math.max(r, g, b);
                const min = Math.min(r, g, b);
                const saturationBoost = 1.3;

                if (max !== min) {
                    r = Math.min(255, Math.round(r * saturationBoost));
                    g = Math.min(255, Math.round(g * saturationBoost));
                    b = Math.min(255, Math.round(b * saturationBoost));
                }

                setDominantColor(r, g, b);

                // Secondary color: biggest bucket that reads differently from
                // the dominant average (for gradient lyrics)
                const sorted = Object.values(buckets).sort((a, b2) => b2.n - a.n);
                let accent2 = null;
                for (const bucket of sorted) {
                    const br = Math.round(bucket.r / bucket.n);
                    const bg = Math.round(bucket.g / bucket.n);
                    const bb = Math.round(bucket.b / bucket.n);
                    const dist = Math.abs(br - r) + Math.abs(bg - g) + Math.abs(bb - b);
                    if (dist > 120) {
                        accent2 = `rgb(${Math.min(255, Math.round(br * 1.3))}, ${Math.min(255, Math.round(bg * 1.3))}, ${Math.min(255, Math.round(bb * 1.3))})`;
                        break;
                    }
                }
                document.documentElement.style.setProperty('--accent2-color',
                    accent2 || `rgb(${Math.min(255, r + 80)}, ${Math.min(255, g + 80)}, ${Math.min(255, b + 80)})`);
            }
        } catch (e) {
            console.log('Color extraction failed, using default');
        }
    };

    img.onerror = () => {
        console.log('Could not load image for color extraction');
    };

    img.src = imageUrl;
}

function setDominantColor(r, g, b) {
    state.dominantColor = `rgb(${r}, ${g}, ${b})`;
    state.dominantColorRgb = { r, g, b };

    // Update CSS variables
    document.documentElement.style.setProperty('--dominant-color', state.dominantColor);
    document.documentElement.style.setProperty('--dominant-color-rgb', `${r}, ${g}, ${b}`);

    // Lightened accent for active lyrics / highlights in adaptive theme
    const ar = Math.round(r + (255 - r) * 0.55);
    const ag = Math.round(g + (255 - g) * 0.55);
    const ab = Math.round(b + (255 - b) * 0.55);
    document.documentElement.style.setProperty('--accent-color', `rgb(${ar}, ${ag}, ${ab})`);

    // Auto lyric style follows the album art
    if (state.lyricStyle === 'auto') {
        state.autoStyle = pickAutoStyle(r, g, b);
        applyResolvedLyricStyle();
    }
}

// ============================================================================
// AUDIO VISUALIZER
// ============================================================================
function initVisualizer() {
    createVisualizerCanvas();
    startBeatAnimation();
}

function startBeatAnimation() {
    const canvas = elements.visualizerContainer.querySelector('canvas') || createVisualizerCanvas();
    const ctx = canvas.getContext('2d');

    let animationFrame;
    let phase = 0;
    let pulseIntensity = 0;

    function animate() {
        const width = canvas.width;
        const height = canvas.height;
        const centerX = width / 2;
        const centerY = height / 2;
        const baseRadius = 80;

        // Clear canvas
        ctx.clearRect(0, 0, width, height);

        const now = Date.now() / 1000;

        if (state.beatMs && state.isPlaying && state.trackDuration > 0) {
            // Pulse on the beat grid estimated from synced lyric timing
            const progress = Math.min(state.estimatedProgress + (Date.now() - state.lastFetchTime), state.trackDuration);
            const phase = (progress % state.beatMs) / state.beatMs;
            pulseIntensity = 0.15 + 0.85 * Math.pow(1 - phase, 2);
        } else {
            // Fallback to sine-wave pulsing when no beat estimate
            pulseIntensity = (Math.sin(now * 4) + 1) / 4;
        }

        const radius = baseRadius + pulseIntensity * 15;

        // Draw based on visualizer style
        const { r, g, b } = state.dominantColorRgb;

        switch (state.visualizerStyle) {
            case 'solid':
                drawSolidRing(ctx, centerX, centerY, radius, r, g, b, pulseIntensity);
                break;
            case 'fuzzy':
                drawFuzzyOrb(ctx, centerX, centerY, radius, r, g, b, pulseIntensity);
                break;
            case 'particles':
                drawParticles(ctx, centerX, centerY, radius, r, g, b, pulseIntensity, phase);
                break;
        }

        phase += 0.02;
        animationFrame = requestAnimationFrame(animate);
    }

    animate();
}

function createVisualizerCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 200;
    elements.visualizerContainer.appendChild(canvas);
    return canvas;
}

function drawSolidRing(ctx, cx, cy, radius, r, g, b, intensity) {
    const lineWidth = 6 + intensity * 4;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.8 + intensity * 0.2})`;
    ctx.lineWidth = lineWidth;
    ctx.shadowColor = `rgb(${r}, ${g}, ${b})`;
    ctx.shadowBlur = 20 + intensity * 30;
    ctx.stroke();

    // Inner glow
    ctx.beginPath();
    ctx.arc(cx, cy, radius - lineWidth / 2, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.3 + intensity * 0.2})`;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 10;
    ctx.stroke();
}

function drawFuzzyOrb(ctx, cx, cy, radius, r, g, b, intensity) {
    // Create radial gradient for fuzzy effect
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.5);
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${0.6 + intensity * 0.4})`);
    gradient.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, ${0.3 + intensity * 0.2})`);
    gradient.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, ${0.1})`);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.shadowColor = `rgb(${r}, ${g}, ${b})`;
    ctx.shadowBlur = 40 + intensity * 20;
    ctx.fill();
}

function drawParticles(ctx, cx, cy, radius, r, g, b, intensity, phase) {
    const particleCount = 32;
    const particleSize = 3 + intensity * 2;

    for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2 + phase;
        const scatter = Math.sin(phase * 3 + i) * intensity * 10;
        const particleRadius = radius + scatter;

        const x = cx + Math.cos(angle) * particleRadius;
        const y = cy + Math.sin(angle) * particleRadius;

        ctx.beginPath();
        ctx.arc(x, y, particleSize, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.7 + intensity * 0.3})`;
        ctx.shadowColor = `rgb(${r}, ${g}, ${b})`;
        ctx.shadowBlur = 10 + intensity * 15;
        ctx.fill();
    }
}

function updateVisualizerMode() {
    // Mode is handled in the animation loop based on state.visualizerStyle
    console.log('Visualizer mode updated to:', state.visualizerStyle);
}

// ============================================================================
// START APPLICATION
// ============================================================================
document.addEventListener('DOMContentLoaded', init);
