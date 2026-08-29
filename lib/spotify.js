/**
 * Spotify Web API client for the main process.
 *
 * Replaces the old Python/spotipy helper: OAuth (authorization code flow with a
 * local redirect server), token storage/refresh, now-playing polling and
 * playback control — all in plain Node so the app has no runtime dependencies
 * beyond Electron itself.
 *
 * Nothing in here touches Electron directly; the caller injects the token file
 * path, a credentials getter and a function that opens URLs in the browser.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

const CALLBACK_PAGE = (title, body) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Cadence</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0e1014;color:#f2f2f7;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
  .card{max-width:420px;padding:32px 36px;border-radius:16px;border:1px solid rgba(30,215,96,.4);
        background:rgba(255,255,255,.04);text-align:center}
  h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#b8b8c4}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;

function createSpotifyClient({ tokenFile, getCredentials, openExternal, legacyCacheFiles = [], log = console }) {
    let tokens = null;          // { access_token, refresh_token, expires_at (ms), scope }
    let refreshing = null;      // in-flight refresh promise (dedupes concurrent refreshes)
    let authServer = null;
    let authTimer = null;
    let profile = null;
    const authListeners = new Set();

    // ------------------------------------------------------------------
    // Token storage
    // ------------------------------------------------------------------
    function loadTokens() {
        if (tokens) return tokens;
        try {
            const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
            if (saved && saved.refresh_token) {
                tokens = saved;
                return tokens;
            }
        } catch (e) {
            // No token file yet
        }

        // One-time import from the old Python (spotipy) cache so existing users
        // don't have to re-approve the app
        for (const file of legacyCacheFiles) {
            try {
                const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (legacy && legacy.refresh_token) {
                    tokens = {
                        access_token: legacy.access_token || '',
                        refresh_token: legacy.refresh_token,
                        // spotipy stores expires_at in seconds
                        expires_at: legacy.expires_at ? Number(legacy.expires_at) * 1000 : 0,
                        scope: legacy.scope || SCOPES
                    };
                    saveTokens();
                    log.log('Imported Spotify tokens from', file);
                    return tokens;
                }
            } catch (e) {
                // Not there, keep looking
            }
        }
        return null;
    }

    function saveTokens() {
        try {
            fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
            fs.writeFileSync(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
        } catch (e) {
            log.error('Could not save Spotify tokens:', e.message);
        }
    }

    function clearTokens() {
        tokens = null;
        try { fs.unlinkSync(tokenFile); } catch (e) { /* nothing to delete */ }
    }

    function isConnected() {
        return Boolean(loadTokens());
    }

    // ------------------------------------------------------------------
    // Token exchange / refresh
    // ------------------------------------------------------------------
    function basicAuthHeader() {
        const { clientId, clientSecret } = getCredentials();
        return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    }

    async function tokenRequest(params) {
        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Authorization': basicAuthHeader(),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams(params).toString(),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const err = new Error(data.error_description || data.error || `Token request failed (${response.status})`);
            err.status = response.status;
            err.code = data.error;
            throw err;
        }
        return data;
    }

    function storeTokenResponse(data, previous) {
        tokens = {
            access_token: data.access_token,
            refresh_token: data.refresh_token || (previous && previous.refresh_token),
            expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
            scope: data.scope || SCOPES
        };
        saveTokens();
        return tokens;
    }

    async function refreshAccessToken() {
        const current = loadTokens();
        if (!current || !current.refresh_token) {
            const err = new Error('Not connected to Spotify');
            err.needsAuth = true;
            throw err;
        }
        if (refreshing) return refreshing;

        refreshing = tokenRequest({
            grant_type: 'refresh_token',
            refresh_token: current.refresh_token
        }).then(data => storeTokenResponse(data, current))
          .catch(err => {
              // invalid_grant = refresh token revoked (user removed the app, or
              // the client credentials changed) — full re-auth needed
              if (err.code === 'invalid_grant' || err.code === 'invalid_client') {
                  clearTokens();
                  err.needsAuth = true;
              }
              throw err;
          })
          .finally(() => { refreshing = null; });

        return refreshing;
    }

    async function getAccessToken() {
        const current = loadTokens();
        if (!current) {
            const err = new Error('Not connected to Spotify');
            err.needsAuth = true;
            throw err;
        }
        if (!current.access_token || Date.now() > current.expires_at - 60000) {
            await refreshAccessToken();
        }
        return tokens.access_token;
    }

    // ------------------------------------------------------------------
    // OAuth: open the browser, catch the redirect on 127.0.0.1:8888
    // ------------------------------------------------------------------
    function stopAuthServer() {
        if (authTimer) { clearTimeout(authTimer); authTimer = null; }
        if (authServer) {
            try { authServer.close(); } catch (e) { /* already closed */ }
            authServer = null;
        }
    }

    function notifyAuth(result) {
        for (const cb of authListeners) {
            try { cb(result); } catch (e) { log.error('auth listener error:', e); }
        }
    }

    function onAuth(callback) {
        authListeners.add(callback);
        return () => authListeners.delete(callback);
    }

    function startAuth() {
        const { clientId, clientSecret } = getCredentials();
        if (!clientId || !clientSecret) {
            return Promise.resolve({ success: false, error: 'Spotify API keys are not set' });
        }

        stopAuthServer();
        const expectedState = crypto.randomBytes(16).toString('hex');

        return new Promise((resolve) => {
            authServer = http.createServer(async (req, res) => {
                const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
                if (url.pathname !== '/callback') {
                    res.writeHead(404); res.end();
                    return;
                }

                const send = (status, title, body) => {
                    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(CALLBACK_PAGE(title, body));
                };

                if (url.searchParams.get('error')) {
                    send(200, 'Spotify access was declined', 'You can close this tab and try again from Cadence.');
                    stopAuthServer();
                    notifyAuth({ success: false, error: url.searchParams.get('error') });
                    return;
                }

                const code = url.searchParams.get('code');
                if (!code || url.searchParams.get('state') !== expectedState) {
                    send(400, 'Something went wrong', 'The sign-in link was invalid. Please try again from Cadence.');
                    return;
                }

                try {
                    const data = await tokenRequest({
                        grant_type: 'authorization_code',
                        code,
                        redirect_uri: REDIRECT_URI
                    });
                    storeTokenResponse(data, null);
                    profile = null;
                    send(200, '🎧 Cadence is connected', 'You can close this tab and head back to the overlay.');
                    stopAuthServer();
                    notifyAuth({ success: true });
                } catch (err) {
                    log.error('Token exchange failed:', err.message);
                    send(500, 'Could not finish connecting', `${err.message}. Check your Client ID / Secret in Cadence and try again.`);
                    stopAuthServer();
                    notifyAuth({ success: false, error: err.message });
                }
            });

            authServer.on('error', (err) => {
                log.error('Auth server error:', err.message);
                stopAuthServer();
                resolve({
                    success: false,
                    error: err.code === 'EADDRINUSE'
                        ? `Port ${REDIRECT_PORT} is already in use — close whatever is using it and try again`
                        : err.message
                });
            });

            authServer.listen(REDIRECT_PORT, '127.0.0.1', () => {
                const params = new URLSearchParams({
                    client_id: clientId,
                    response_type: 'code',
                    redirect_uri: REDIRECT_URI,
                    scope: SCOPES,
                    state: expectedState,
                    show_dialog: 'false'
                });
                const url = `${AUTH_URL}?${params.toString()}`;

                authTimer = setTimeout(() => {
                    log.log('Spotify sign-in timed out');
                    stopAuthServer();
                }, AUTH_TIMEOUT_MS);

                Promise.resolve(openExternal(url)).catch(err => log.error('Could not open browser:', err.message));
                resolve({ success: true, url });
            });
        });
    }

    // ------------------------------------------------------------------
    // API requests
    // ------------------------------------------------------------------
    async function request(method, endpoint, { query, body, retry = true } = {}) {
        let token;
        try {
            token = await getAccessToken();
        } catch (err) {
            return { success: false, status: 0, error: err.message, needs_auth: Boolean(err.needsAuth) };
        }

        let url = `${API_BASE}${endpoint}`;
        if (query) {
            const qs = new URLSearchParams(query).toString();
            if (qs) url += (url.includes('?') ? '&' : '?') + qs;
        }

        let response;
        try {
            response = await fetch(url, {
                method,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch (err) {
            return { success: false, status: 0, error: err.name === 'TimeoutError' ? 'Spotify request timed out' : err.message };
        }

        if (response.status === 401 && retry) {
            try {
                await refreshAccessToken();
            } catch (err) {
                return { success: false, status: 401, error: err.message, needs_auth: true };
            }
            return request(method, endpoint, { query, body, retry: false });
        }

        if (response.status === 204) {
            return { success: true, status: 204, data: null };
        }

        const text = await response.text();
        let data = null;
        if (text) {
            try { data = JSON.parse(text); } catch (e) { data = text; }
        }

        if (!response.ok) {
            const message = (data && data.error && (data.error.message || data.error)) || `Spotify returned ${response.status}`;
            return {
                success: false,
                status: response.status,
                error: typeof message === 'string' ? message : JSON.stringify(message),
                reason: data && data.error && data.error.reason,
                retry_after: Number(response.headers.get('retry-after')) || undefined,
                needs_auth: response.status === 401
            };
        }

        return { success: true, status: response.status, data };
    }

    // ------------------------------------------------------------------
    // High-level helpers (same result shapes the renderer already expects)
    // ------------------------------------------------------------------
    function describeItem(item) {
        // Tracks have artists + album; podcast episodes have a show
        if (item.type === 'episode') {
            const show = item.show || {};
            const images = item.images && item.images.length ? item.images : (show.images || []);
            return {
                artist: show.name || 'Podcast',
                artists: show.name ? [show.name] : [],
                album: show.name || '',
                album_art: images.length ? images[0].url : null
            };
        }
        const artists = (item.artists || []).map(a => a.name);
        const images = (item.album && item.album.images) || [];
        return {
            artist: artists.join(', '),
            artists,
            album: item.album ? item.album.name : '',
            album_art: images.length ? images[0].url : null
        };
    }

    async function getCurrentTrack() {
        const res = await request('GET', '/me/player/currently-playing', {
            query: { additional_types: 'track,episode' }
        });

        if (!res.success) {
            return { success: false, error: res.error, error_code: res.status || null, needs_auth: res.needs_auth };
        }

        const current = res.data;
        if (!current || !current.item) {
            return { success: true, track: null, message: 'No track currently playing' };
        }

        const item = current.item;
        return {
            success: true,
            track: {
                id: item.id,
                uri: item.uri,
                name: item.name,
                ...describeItem(item),
                duration_ms: item.duration_ms,
                progress_ms: current.progress_ms || 0,
                is_playing: Boolean(current.is_playing)
            }
        };
    }

    function controlResult(res, command) {
        if (res.success) return { success: true, command };
        return {
            success: false,
            command,
            error: res.error,
            error_code: res.status || null,
            reason: res.reason,
            needs_auth: res.needs_auth
        };
    }

    async function control(command, positionMs) {
        switch (command) {
            case 'play':
                return controlResult(await request('PUT', '/me/player/play'), command);
            case 'pause':
                return controlResult(await request('PUT', '/me/player/pause'), command);
            case 'next':
                return controlResult(await request('POST', '/me/player/next'), command);
            case 'previous':
                return controlResult(await request('POST', '/me/player/previous'), command);
            case 'seek':
                return controlResult(await request('PUT', '/me/player/seek', {
                    query: { position_ms: String(Math.max(0, Math.round(Number(positionMs) || 0))) }
                }), command);
            default:
                return { success: false, error: `Unknown command: ${command}` };
        }
    }

    // Start a specific track at a position (used by listen-along mirroring)
    async function playTrack(uri, positionMs) {
        const body = { position_ms: Math.max(0, Math.round(Number(positionMs) || 0)) };
        if (uri) body.uris = [uri];
        return controlResult(await request('PUT', '/me/player/play', { body }), 'play');
    }

    // Add a track to the queue (listen-along song requests)
    async function queueTrack(uri) {
        return controlResult(await request('POST', '/me/player/queue', { query: { uri: String(uri || '') } }), 'queue');
    }

    async function getProfile() {
        if (profile) return profile;
        const res = await request('GET', '/me');
        if (res.success && res.data) {
            profile = { id: res.data.id, display_name: res.data.display_name || res.data.id };
        }
        return profile;
    }

    // Spotify retired these endpoints for new apps in late 2024 — keep the call
    // for apps that still have access, but treat any failure as "no analysis"
    async function getAudioAnalysis(trackId) {
        const [analysisRes, featuresRes] = await Promise.all([
            request('GET', `/audio-analysis/${encodeURIComponent(trackId)}`),
            request('GET', `/audio-features/${encodeURIComponent(trackId)}`)
        ]);

        if (!analysisRes.success || !analysisRes.data) {
            return { success: true, analysis: null, message: analysisRes.error || 'No analysis available' };
        }

        const analysis = analysisRes.data;
        const features = featuresRes.success ? featuresRes.data : null;
        return {
            success: true,
            analysis: {
                track_id: trackId,
                tempo: (features && features.tempo) || (analysis.track && analysis.track.tempo) || 120,
                energy: (features && features.energy) || 0.5,
                beats: (analysis.beats || []).slice(0, 500).map(b => ({
                    start: b.start, duration: b.duration, confidence: b.confidence
                })),
                sections: (analysis.sections || []).map(s => ({
                    start: s.start, duration: s.duration, loudness: s.loudness, tempo: s.tempo
                })),
                total_beats: (analysis.beats || []).length
            }
        };
    }

    // Manual "refresh" button: force a token refresh, or start sign-in if there
    // is nothing to refresh
    async function forceRefresh() {
        if (!loadTokens()) {
            const auth = await startAuth();
            return { success: false, needs_auth: true, error: auth.success ? 'Approve Cadence in your browser' : auth.error };
        }
        try {
            const t = await refreshAccessToken();
            return { success: true, message: 'Token refreshed successfully', expires_at: t.expires_at };
        } catch (err) {
            if (err.needsAuth) {
                const auth = await startAuth();
                return { success: false, needs_auth: true, error: auth.success ? 'Approve Cadence in your browser' : auth.error };
            }
            return { success: false, error: err.message };
        }
    }

    return {
        REDIRECT_URI,
        isConnected,
        clearTokens,
        startAuth,
        onAuth,
        forceRefresh,
        request,
        getCurrentTrack,
        control,
        playTrack,
        queueTrack,
        getProfile,
        getAudioAnalysis,
        shutdown: stopAuthServer
    };
}

module.exports = { createSpotifyClient, REDIRECT_URI, SCOPES };
