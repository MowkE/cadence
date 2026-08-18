/**
 * Listen along — share what you're playing with friends.
 *
 * The host publishes small "state" messages (track + position + playing) to a
 * private topic on an ntfy relay (https://ntfy.sh by default; any ntfy server
 * works, including a self-hosted one). Guests subscribe to that topic, follow
 * the host's lyrics live, and can optionally mirror playback on their own
 * Spotify.
 *
 * Wire format (JSON message body):
 *   { t: 'state', v: 1, track: {...} | null, progress_ms, is_playing, at, host }
 *   { t: 'hello' | 'bye', id }          guest presence, for the listener count
 *   { t: 'end' }                        host ended the session
 *
 * Only changes are published (track switch, play/pause, seek), never a
 * heartbeat, so a whole evening of listening costs a few dozen messages —
 * well inside ntfy.sh's free limits.
 */

const crypto = require('crypto');

const DEFAULT_RELAY = 'https://ntfy.sh';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const CODE_LENGTH = 8;
const TOPIC_PREFIX = 'cadence-';
const SEEK_THRESHOLD_MS = 4000;
const PUBLISH_MIN_GAP_MS = 700;
const CLOCK_SKEW_IGNORE_MS = 2500;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30000;
const STALE_STATE_MS = 6 * 60 * 60 * 1000;

function generateCode() {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return code;
}

function formatCode(code) {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// Accepts "ABCD-EFGH", "abcdefgh", "cadence://join/ABCD-EFGH",
// "https://…/#join=ABCD-EFGH" and friends. Returns the bare code or null.
function parseCode(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const fromLink = raw.match(/join[/=:#]*([A-Za-z0-9-]{8,12})/i);
    const candidate = (fromLink ? fromLink[1] : raw).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (candidate.length !== CODE_LENGTH) return null;
    for (const ch of candidate) {
        if (!CODE_ALPHABET.includes(ch)) return null;
    }
    return candidate;
}

function joinLink(code) {
    return `cadence://join/${formatCode(code)}`;
}

function createListenAlong({ getRelayBase, spotify, onStatus, log = console }) {
    const relayBase = () => String((getRelayBase && getRelayBase()) || DEFAULT_RELAY).replace(/\/+$/, '');
    const topicFor = code => `${TOPIC_PREFIX}${code.toLowerCase()}`;

    let mode = 'off';           // 'off' | 'host' | 'guest'
    let code = null;
    let hostName = null;        // display name we advertise while hosting
    let message = null;         // human-readable status line for the UI

    // Host state
    let lastPublished = null;   // { trackId, is_playing, progress_ms, at }
    let lastPollTrack = null;   // most recent real poll result, for the opening state
    let publishTimer = null;
    let pendingPublish = null;
    const listeners = new Map();// guestId -> lastSeen

    // Guest state
    const guestId = crypto.randomBytes(6).toString('hex');
    let guestState = null;      // { track, progress_ms, is_playing, at, hostOffset, receivedAt }
    let guestOffset = 0;        // our clock minus the relay's clock (ms)
    let mirror = true;
    let mirrorNote = null;
    let mirrorBlocked = false;  // stop retrying after "Premium required"-type failures
    let mirrorBusy = false;
    let mirrorTimer = null;
    let lastMirrored = null;    // { trackId, is_playing } — what we last told Spotify to do
    const MIRROR_DEBOUNCE_MS = 400;

    // Subscription plumbing (both roles subscribe: host counts listeners)
    let subscription = null;    // { controller, generation }
    let generation = 0;
    let lastMessageId = null;
    let connected = false;

    // ------------------------------------------------------------------
    // Status
    // ------------------------------------------------------------------
    function status() {
        const s = { mode, connected, message, relay: relayBase() };
        if (mode === 'host') {
            s.code = formatCode(code);
            s.link = joinLink(code);
            s.hostName = hostName;
            s.listeners = listeners.size;
        } else if (mode === 'guest') {
            s.code = formatCode(code);
            s.hostName = guestState ? guestState.host : null;
            s.track = guestState && guestState.track
                ? { name: guestState.track.name, artist: guestState.track.artist }
                : null;
            s.is_playing = Boolean(guestState && guestState.is_playing);
            s.mirror = mirror;
            s.mirrorNote = mirrorNote;
        }
        return s;
    }

    function emit() {
        try { onStatus && onStatus(status()); } catch (e) { log.error('listen-along status error:', e); }
    }

    function setMessage(text) {
        message = text || null;
        emit();
    }

    // ------------------------------------------------------------------
    // Relay I/O
    // ------------------------------------------------------------------
    async function publish(payload) {
        if (!code) return false;
        try {
            const res = await fetch(`${relayBase()}/${topicFor(code)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Priority': 'min',
                    'Firebase': 'no',
                    'X-Title': 'cadence'
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(8000)
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                log.error('listen-along publish failed:', res.status, text.slice(0, 200));
                if (res.status === 429) setMessage('The relay is rate-limiting us — updates may lag');
                return false;
            }
            return true;
        } catch (err) {
            log.error('listen-along publish error:', err.message);
            return false;
        }
    }

    function unsubscribe() {
        generation++;
        if (subscription) {
            try { subscription.controller.abort(); } catch (e) { /* ignore */ }
            subscription = null;
        }
        connected = false;
    }

    function subscribe() {
        unsubscribe();
        const myGeneration = generation;
        const myCode = code;
        let attempt = 0;

        const loop = async () => {
            while (myGeneration === generation && mode !== 'off' && code === myCode) {
                const controller = new AbortController();
                subscription = { controller, generation: myGeneration };
                try {
                    const since = lastMessageId || '12h';
                    const url = `${relayBase()}/${topicFor(myCode)}/json?since=${encodeURIComponent(since)}`;
                    const res = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/x-ndjson' } });
                    if (!res.ok || !res.body) {
                        throw new Error(`relay returned ${res.status}`);
                    }
                    attempt = 0;
                    await readStream(res.body, controller.signal, myGeneration);
                } catch (err) {
                    if (myGeneration !== generation) return;
                    if (err.name !== 'AbortError') log.log('listen-along connection dropped:', err.message);
                }
                if (myGeneration !== generation) return;

                connected = false;
                emit();
                const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt++));
                await new Promise(r => setTimeout(r, delay));
            }
        };
        loop();
    }

    async function readStream(body, signal, myGeneration) {
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of body) {
            if (signal.aborted || myGeneration !== generation) return;
            buffer += decoder.decode(chunk, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line) handleRelayEvent(line);
            }
        }
    }

    function handleRelayEvent(line) {
        let ev;
        try { ev = JSON.parse(line); } catch (e) { return; }

        if (ev.event === 'open') {
            connected = true;
            // Estimate our clock vs the relay's (second resolution)
            if (ev.time) guestOffset = Date.now() - ev.time * 1000;
            emit();
            return;
        }
        if (ev.event !== 'message' || !ev.message) return;
        if (ev.id) lastMessageId = ev.id;

        let msg;
        try { msg = JSON.parse(ev.message); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;

        if (mode === 'host') {
            if (msg.t === 'hello' && msg.id && msg.id !== guestId) {
                listeners.set(msg.id, Date.now());
                emit();
            } else if (msg.t === 'bye' && msg.id) {
                listeners.delete(msg.id);
                emit();
            }
            return;
        }

        if (mode === 'guest') {
            if (msg.t === 'state') {
                applyGuestState(msg, ev.time);
            } else if (msg.t === 'end') {
                const serverMs = (ev.time || 0) * 1000;
                // Ignore stale "end" messages from an earlier session on the same code
                if (guestState && guestState.serverMs && serverMs < guestState.serverMs) return;
                leave('The host ended the session');
            }
        }
    }

    // ------------------------------------------------------------------
    // Host role
    // ------------------------------------------------------------------
    async function startHost() {
        if (mode !== 'off') leave();
        code = generateCode();
        mode = 'host';
        message = null;
        listeners.clear();
        lastPublished = null;
        lastMessageId = null;

        hostName = null;
        try {
            const profile = spotify && spotify.isConnected() ? await spotify.getProfile() : null;
            hostName = profile ? profile.display_name : null;
        } catch (e) { /* stay anonymous */ }

        subscribe();
        // Announce the current state right away so late joiners see something
        queuePublish(buildState(lastPollTrack));
        emit();
        return status();
    }

    function buildState(result) {
        const track = result && result.success && result.track ? result.track : null;
        return {
            t: 'state',
            v: 1,
            host: hostName || undefined,
            track: track ? {
                id: track.id,
                uri: track.uri,
                name: track.name,
                artist: track.artist,
                artists: track.artists,
                album: track.album,
                album_art: track.album_art,
                duration_ms: track.duration_ms
            } : null,
            progress_ms: track ? track.progress_ms : 0,
            is_playing: Boolean(track && track.is_playing),
            at: Date.now()
        };
    }

    function queuePublish(state) {
        pendingPublish = state;
        lastPublished = {
            trackId: state.track ? state.track.id : null,
            is_playing: state.is_playing,
            progress_ms: state.progress_ms,
            at: state.at
        };
        if (publishTimer) return;
        publishTimer = setTimeout(async () => {
            publishTimer = null;
            const payload = pendingPublish;
            pendingPublish = null;
            if (payload && mode === 'host') await publish(payload);
        }, PUBLISH_MIN_GAP_MS);
    }

    // Called by the main process after every real Spotify poll
    function onHostPoll(result) {
        if (result && result.success) lastPollTrack = result;
        if (mode !== 'host' || !result || !result.success) return;

        const track = result.track;
        const trackId = track ? track.id : null;
        const isPlaying = Boolean(track && track.is_playing);
        const now = Date.now();

        let changed = !lastPublished;
        if (!changed) {
            if (lastPublished.trackId !== trackId || lastPublished.is_playing !== isPlaying) {
                changed = true;
            } else if (track) {
                const expected = lastPublished.is_playing
                    ? lastPublished.progress_ms + (now - lastPublished.at)
                    : lastPublished.progress_ms;
                if (Math.abs(track.progress_ms - expected) > SEEK_THRESHOLD_MS) changed = true;
            }
        }

        if (changed) queuePublish(buildState(result));
    }

    async function stopHost(reason) {
        if (mode !== 'host') return;
        if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; pendingPublish = null; }
        const endCode = code;
        unsubscribe();
        mode = 'off';
        listeners.clear();
        // Best-effort goodbye so guests drop back to their own Spotify
        code = endCode;
        await publish({ t: 'end', at: Date.now() });
        code = null;
        setMessage(reason || null);
    }

    // ------------------------------------------------------------------
    // Guest role
    // ------------------------------------------------------------------
    async function join(input) {
        const parsed = parseCode(input);
        if (!parsed) {
            return { success: false, error: 'That doesn\'t look like a Cadence code (e.g. ABCD-EFGH)' };
        }
        if (mode !== 'off') await leave();

        code = parsed;
        mode = 'guest';
        message = null;
        guestState = null;
        mirrorNote = null;
        mirrorBlocked = false;
        lastMirrored = null;
        lastMessageId = null;

        subscribe();
        publish({ t: 'hello', id: guestId }).catch(() => {});
        emit();
        return { success: true, status: status() };
    }

    function applyGuestState(msg, serverTimeSec) {
        const prev = guestState;
        const serverMs = (serverTimeSec || 0) * 1000;
        // (relay − host) skew + one-way latency, from the relay's receipt time
        const hostOffset = serverMs && msg.at ? serverMs - msg.at : 0;
        // Ignore ancient cached states (host long gone)
        if (serverMs && Date.now() - guestOffset - serverMs > STALE_STATE_MS) return;
        // Ignore out-of-order messages
        if (prev && prev.at && msg.at && msg.at < prev.at) return;

        guestState = {
            track: msg.track || null,
            progress_ms: Number(msg.progress_ms) || 0,
            is_playing: Boolean(msg.is_playing),
            at: Number(msg.at) || Date.now(),
            host: msg.host || null,
            hostOffset,
            serverMs,
            receivedAt: Date.now()
        };
        emit();
        scheduleMirror();
    }

    // Debounced so a burst of cached history on join collapses into one call
    function scheduleMirror() {
        if (!mirror) return;
        if (mirrorTimer) clearTimeout(mirrorTimer);
        mirrorTimer = setTimeout(() => {
            mirrorTimer = null;
            mirrorPlayback();
        }, MIRROR_DEBOUNCE_MS);
    }

    // What the host is hearing right now, in host-track milliseconds
    function guestProgressNow() {
        if (!guestState || !guestState.track) return 0;
        if (!guestState.is_playing) return guestState.progress_ms;
        // total skew between our clock and the host's; small values are noise
        // from the relay's one-second timestamps, so only correct big drifts
        let skew = guestOffset + guestState.hostOffset;
        if (Math.abs(skew) < CLOCK_SKEW_IGNORE_MS) skew = 0;
        const elapsed = Date.now() - guestState.at - skew;
        return Math.max(0, guestState.progress_ms + Math.max(0, elapsed));
    }

    // Shaped exactly like spotify.getCurrentTrack() so the renderer can't tell
    function guestTrackResult() {
        if (mode !== 'guest') return null;
        if (!guestState || !guestState.track) {
            return {
                success: true,
                track: null,
                message: 'Waiting for the host',
                listenAlong: { waitingFor: (guestState && guestState.host) || 'the host' }
            };
        }
        const t = guestState.track;
        const duration = Number(t.duration_ms) || 0;
        const progress = duration ? Math.min(guestProgressNow(), duration) : guestProgressNow();
        // The host's song ended and nothing new arrived — treat as paused at the end
        const finished = duration && guestState.is_playing && guestProgressNow() > duration + 3000;
        return {
            success: true,
            track: {
                id: t.id,
                uri: t.uri,
                name: t.name,
                artist: t.artist,
                artists: t.artists || [],
                album: t.album,
                album_art: t.album_art,
                duration_ms: duration,
                progress_ms: progress,
                is_playing: guestState.is_playing && !finished
            },
            listenAlong: { host: guestState.host }
        };
    }

    async function mirrorPlayback() {
        if (mode !== 'guest' || !guestState || !mirror || mirrorBlocked) return;
        if (mirrorBusy) { scheduleMirror(); return; }
        if (!spotify || !spotify.isConnected()) {
            mirrorNote = 'Connect your Spotify (gear → 🔑) to play along on your speakers';
            emit();
            return;
        }

        const state = guestState;
        const trackId = state.track ? state.track.id : null;
        mirrorBusy = true;
        try {
            let res;
            if (!state.track || !state.is_playing) {
                // Only send a pause if we were mirroring something
                if (lastMirrored && lastMirrored.is_playing) res = await spotify.control('pause');
                else { lastMirrored = { trackId, is_playing: false }; return; }
            } else {
                const trackChanged = !lastMirrored || lastMirrored.trackId !== trackId;
                const resumed = lastMirrored && !lastMirrored.is_playing;
                if (trackChanged || resumed) {
                    res = await spotify.playTrack(state.track.uri, guestProgressNow());
                } else {
                    // Same track, still playing: this was a seek
                    res = await spotify.control('seek', guestProgressNow());
                }
            }

            if (res && !res.success) {
                handleMirrorError(res);
            } else if (res && res.success) {
                lastMirrored = { trackId, is_playing: state.is_playing };
                mirrorNote = null;
                emit();
            }
        } catch (err) {
            log.error('listen-along mirror error:', err.message);
        } finally {
            mirrorBusy = false;
        }
    }

    function handleMirrorError(res) {
        const code = res.error_code;
        const reason = String(res.reason || '');
        if (res.needs_auth || code === 401) {
            mirrorNote = 'Connect your Spotify (gear → 🔑) to play along on your speakers';
        } else if (code === 404 || /NO_ACTIVE_DEVICE/i.test(reason)) {
            mirrorNote = 'Open Spotify and press play on anything once — then Cadence can take over';
        } else if (code === 403 && /PREMIUM/i.test(reason + res.error)) {
            mirrorNote = 'Spotify Premium is needed to play along — following the lyrics only';
            mirrorBlocked = true;
        } else if (code === 403) {
            // e.g. "already paused" restriction — harmless
            return;
        } else if (code === 429) {
            mirrorNote = 'Spotify is rate-limiting playback control — retrying on the next change';
        } else {
            mirrorNote = `Couldn't control your Spotify: ${res.error}`;
        }
        log.log('listen-along mirror:', mirrorNote);
        emit();
    }

    function setMirror(on) {
        mirror = Boolean(on);
        mirrorBlocked = false;
        if (mirror) {
            // Jump in where the host is right now
            lastMirrored = null;
            scheduleMirror();
        } else {
            if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
            const wasPlaying = lastMirrored && lastMirrored.is_playing;
            lastMirrored = null;
            mirrorNote = null;
            if (wasPlaying && spotify && spotify.isConnected()) spotify.control('pause').catch(() => {});
        }
        emit();
        return status();
    }

    async function leave(reason) {
        if (mode === 'host') return stopHost(reason);
        if (mode !== 'guest') return;
        const wasMirroring = Boolean(lastMirrored && lastMirrored.is_playing);
        const oldCode = code;
        if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
        unsubscribe();
        mode = 'off';
        guestState = null;
        lastMirrored = null;
        mirrorNote = null;
        code = oldCode;
        publish({ t: 'bye', id: guestId }).catch(() => {});
        code = null;
        if (wasMirroring && spotify && spotify.isConnected()) {
            spotify.control('pause').catch(() => {});
        }
        setMessage(reason || null);
    }

    async function shutdown() {
        if (mode === 'host') await stopHost();
        else if (mode === 'guest') await leave();
    }

    return {
        status,
        startHost,
        stopHost,
        onHostPoll,
        join,
        leave,
        setMirror,
        guestTrackResult,
        shutdown,
        parseCode,
        isGuest: () => mode === 'guest',
        isHost: () => mode === 'host'
    };
}

module.exports = { createListenAlong, parseCode, generateCode, formatCode, joinLink, DEFAULT_RELAY };
