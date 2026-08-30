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
 *   { t: 'hello' | 'bye', id, name }    guest presence, for the listener list
 *   { t: 'request', reqId, id, name, track, at }     guest → host: play this?
 *   { t: 'request-ack', reqId, status, at }          host → guests: played / queued / dismissed
 *   { t: 'handoff', to, toName, from, roster, at }   host → everyone: `to` is the host now
 *   { t: 'game', game, action, ..., id, name, at }   karaoke & games traffic (opaque here)
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
const MAX_REQUESTS = 20;

// Room vote ("the room DJs itself"): the host can let pending requests go to
// a vote in the last stretch of a song; the winner plays next
const VOTE_LEAD_MS = 30000;          // open the vote this long before the song ends
const VOTE_MS = 20000;               // how long the room gets to pick
const VOTE_MAX_OPTIONS = 4;
const VOTE_RESULT_MS = 10000;        // how long the result stays on screen
const PLAY_WINNER_BEFORE_END_MS = 3000;
const TRACK_URI = /^spotify:(track|episode):[A-Za-z0-9]{22}$/;

function cleanName(name) {
    const s = String(name || '').replace(/[\u0000-\u001f]/g, '').trim();
    return s ? s.slice(0, 40) : null;
}

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

// `player` is the main process's player facade: isConnected / getProfile /
// control / playTrack / queueTrack, routed to the Web API or the local
// Spotify app. `getDisplayName` resolves what friends see us as.
function createListenAlong({ getRelayBase, player, getDisplayName, onStatus, onGame, log = console }) {
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
    const listeners = new Map();// guestId -> { name, lastSeen }
    const requests = [];        // pending song requests, oldest first
    let sessionStartedAt = 0;

    // Guest requests
    let requestNote = null;     // what happened to our last request

    // Room vote
    let roomVote = false;       // host setting: the room picks the next song
    let vote = null;            // { id, options, endsAt, picks: Map, myPick, closed }
    let voteResult = null;      // { voteId, winner, tally, auto, until }
    let pendingWinner = null;   // host: { option, playedAt, fromTrackId }
    let votedTrackId = null;    // host: one vote per song
    let lastRequestId = null;

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
        const s = { mode, connected, message, relay: relayBase(), selfId: guestId };
        if (mode !== 'off') {
            s.vote = vote ? { id: vote.id, options: vote.options, endsAt: vote.endsAt, myPick: vote.myPick, votes: vote.picks.size } : null;
            s.voteResult = voteResult && Date.now() < voteResult.until ? voteResult : null;
        }
        if (mode === 'host') {
            s.code = formatCode(code);
            s.link = joinLink(code);
            s.hostName = hostName;
            s.listeners = listeners.size;
            s.listenerNames = [...listeners.values()].map(l => l.name || 'A friend');
            s.listenersDetail = [...listeners.entries()].map(([id, l]) => ({ id, name: l.name || 'A friend' }));
            s.requests = requests.map(r => ({ reqId: r.reqId, name: r.name, track: r.track, at: r.at }));
            s.canQueue = Boolean(player && player.canQueue && player.canQueue());
            s.roomVote = roomVote;
        } else if (mode === 'guest') {
            s.requestNote = requestNote;
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

        // Both roles: game traffic (renderer-defined) and session handoffs
        if (msg.t === 'vote' || msg.t === 'vote-cast' || msg.t === 'vote-result') {
            handleVoteMessage(msg);
            return;
        }
        if (msg.t === 'game') {
            if (msg.id !== guestId && onGame) {
                try { onGame(msg); } catch (e) { log.error('listen-along game handler error:', e); }
            }
            return;
        }
        if (msg.t === 'handoff' && msg.to) {
            const serverMs = (ev.time || 0) * 1000;
            if (serverMs && serverMs < sessionStartedAt - guestOffset - 5000) return; // old history
            if (msg.from_id === guestId) return; // our own
            handleHandoff(msg);
            return;
        }

        if (mode === 'host') {
            if (msg.t === 'hello' && msg.id && msg.id !== guestId) {
                listeners.set(msg.id, { name: cleanName(msg.name), lastSeen: Date.now() });
                emit();
            } else if (msg.t === 'bye' && msg.id) {
                listeners.delete(msg.id);
                emit();
            } else if (msg.t === 'request' && msg.reqId && msg.track) {
                addRequest(msg, ev.time);
            }
            return;
        }

        if (mode === 'guest') {
            if (msg.t === 'state') {
                applyGuestState(msg, ev.time);
            } else if (msg.t === 'request-ack' && msg.reqId && msg.reqId === lastRequestId) {
                const outcome = String(msg.status || '');
                requestNote = outcome === 'played' ? 'The host is playing your request 🎉'
                    : outcome === 'queued' ? 'Your request is in the queue'
                        : outcome === 'dismissed' ? 'The host passed on your request'
                            : null;
                emit();
            } else if (msg.t === 'end') {
                const serverMs = (ev.time || 0) * 1000;
                // Ignore stale "end" messages from an earlier session on the same code
                if (guestState && guestState.serverMs && serverMs < guestState.serverMs) return;
                leave('The host ended the session');
            }
        }
    }

    // What friends see us as (settings override → Spotify / account name)
    async function safeName() {
        try {
            return cleanName(getDisplayName ? await getDisplayName() : null);
        } catch (e) {
            return null;
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
        requests.length = 0;
        resetVote();
        sessionStartedAt = Date.now();
        lastPublished = null;
        lastMessageId = null;

        hostName = await safeName();

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
        hostVoteTick(track);
    }

    // ------------------------------------------------------------------
    // Room vote: the room picks the next song from the pending requests.
    // Host-only setting; the host opens, tallies and plays the winner.
    // ------------------------------------------------------------------
    function resetVote() {
        vote = null;
        voteResult = null;
        pendingWinner = null;
        votedTrackId = null;
    }

    function setRoomVote(on) {
        roomVote = Boolean(on);
        if (!roomVote && vote && mode === 'host') {
            vote = null;
            publish({ t: 'vote-result', voteId: null, cancelled: true, at: Date.now() }).catch(() => {});
        }
        emit();
        return status();
    }

    function voteOptionsFromRequests() {
        const seen = new Set();
        const options = [];
        for (const r of requests) {
            if (seen.has(r.track.uri)) continue;
            seen.add(r.track.uri);
            options.push({
                uri: r.track.uri, id: r.track.id, name: r.track.name, artist: r.track.artist,
                album_art: r.track.album_art, reqId: r.reqId, by: r.name
            });
            if (options.length >= VOTE_MAX_OPTIONS) break;
        }
        return options;
    }

    // Called after every poll of the host's playback
    function hostVoteTick(track) {
        if (mode !== 'host') return;
        const now = Date.now();

        // Close the vote when time is up — or early, the moment the song ends,
        // so Spotify's own next track only ever gets a poll's worth of airtime
        if (vote && !vote.closed) {
            const remaining = track && track.duration_ms ? track.duration_ms - track.progress_ms : Infinity;
            const songOver = !track || track.id !== votedTrackId || (track.is_playing && remaining <= PLAY_WINNER_BEFORE_END_MS);
            if (now >= vote.endsAt || songOver) closeVote();
        }

        // Play the winner as this song ends — or the moment Spotify moves on
        // to something else on its own
        if (pendingWinner && track) {
            const w = pendingWinner;
            if (track.id === w.option.id) {
                pendingWinner = null;
                emit();
            } else {
                const remaining = (track.duration_ms || 0) - (track.progress_ms || 0);
                const movedOn = track.id !== w.fromTrackId;
                const due = (track.is_playing && track.duration_ms && remaining <= PLAY_WINNER_BEFORE_END_MS) || movedOn;
                if (due && (!w.playedAt || now - w.playedAt > 8000)) {
                    w.playedAt = now;
                    player.playTrack(w.option.uri, 0).then(res => {
                        if (!res.success) setMessage(`Couldn't play ${w.option.name}: ${res.error}`);
                    }).catch(() => {});
                }
                if (w.playedAt && now - w.playedAt > 25000) pendingWinner = null; // give up quietly
            }
        }

        // Open a vote in the last stretch of the song (once per song)
        if (roomVote && !vote && !pendingWinner && track && track.is_playing && track.duration_ms
            && track.id !== votedTrackId && requests.length) {
            const remaining = track.duration_ms - track.progress_ms;
            if (remaining <= VOTE_LEAD_MS && remaining > VOTE_MS * 0.6) openVote(track.id);
        }
    }

    function openVote(trackId) {
        votedTrackId = trackId;
        const options = voteOptionsFromRequests();
        if (!options.length) return;
        if (options.length === 1) {
            // Nothing to vote on: the one request just plays next
            settleWinner(null, options[0], { [options[0].uri]: 0 }, true, trackId);
            return;
        }
        vote = { id: crypto.randomBytes(4).toString('hex'), options, endsAt: Date.now() + VOTE_MS, picks: new Map(), myPick: null, closed: false };
        publish({ t: 'vote', voteId: vote.id, options, durationMs: VOTE_MS, at: Date.now() }).catch(() => {});
        emit();
    }

    function closeVote() {
        const v = vote;
        v.closed = true;
        const tally = {};
        for (const o of v.options) tally[o.uri] = 0;
        for (const pick of v.picks.values()) if (pick in tally) tally[pick]++;
        let winner = v.options[0]; // ties go to the earliest request
        for (const o of v.options) if (tally[o.uri] > tally[winner.uri]) winner = o;
        vote = null;
        settleWinner(v.id, winner, tally, false, votedTrackId);
    }

    function settleWinner(voteId, option, tally, auto, fromTrackId) {
        pendingWinner = { option, playedAt: null, fromTrackId };
        const idx = requests.findIndex(r => r.reqId === option.reqId);
        if (idx >= 0) requests.splice(idx, 1);
        publish({ t: 'request-ack', reqId: option.reqId, status: 'queued', at: Date.now() }).catch(() => {});
        voteResult = { voteId, winner: option, tally, auto, until: Date.now() + VOTE_RESULT_MS };
        publish({ t: 'vote-result', voteId, winner: option, tally, auto, at: Date.now() }).catch(() => {});
        emit();
    }

    // Everyone: pick one. The host tallies locally; guests send it in.
    function castVote(pick) {
        if (!vote || vote.closed) return { success: false, error: 'No vote open' };
        pick = String(pick || '');
        if (!vote.options.some(o => o.uri === pick)) return { success: false, error: 'Not one of the options' };
        vote.myPick = pick;
        if (mode === 'host') vote.picks.set(guestId, pick);
        else publish({ t: 'vote-cast', voteId: vote.id, pick, id: guestId, at: Date.now() }).catch(() => {});
        emit();
        return { success: true, status: status() };
    }

    function handleVoteMessage(msg) {
        if (msg.t === 'vote' && mode === 'guest') {
            const options = (Array.isArray(msg.options) ? msg.options : [])
                .filter(o => o && TRACK_URI.test(String(o.uri || '')))
                .slice(0, VOTE_MAX_OPTIONS)
                .map(o => ({
                    uri: o.uri, id: String(o.id || o.uri.split(':').pop()).slice(0, 40),
                    name: String(o.name || 'Untitled').slice(0, 120), artist: String(o.artist || '').slice(0, 120),
                    album_art: /^https:\/\//.test(String(o.album_art || '')) ? o.album_art : null,
                    reqId: o.reqId, by: cleanName(o.by) || 'A friend'
                }));
            if (options.length < 2) return;
            vote = { id: String(msg.voteId || ''), options, endsAt: Date.now() + Math.min(VOTE_MS, Number(msg.durationMs) || VOTE_MS), picks: new Map(), myPick: null, closed: false };
            voteResult = null;
            emit();
        } else if (msg.t === 'vote-cast' && mode === 'host') {
            if (vote && !vote.closed && msg.voteId === vote.id && msg.id) {
                vote.picks.set(String(msg.id), String(msg.pick || ''));
                emit();
            }
        } else if (msg.t === 'vote-result' && mode === 'guest') {
            vote = null;
            const w = msg.winner;
            voteResult = msg.cancelled || !w ? null : {
                voteId: msg.voteId,
                winner: { uri: String(w.uri || ''), id: String(w.id || ''), name: String(w.name || 'Untitled').slice(0, 120), artist: String(w.artist || '').slice(0, 120), album_art: /^https:\/\//.test(String(w.album_art || '')) ? w.album_art : null, by: cleanName(w.by) || 'A friend' },
                tally: msg.tally && typeof msg.tally === 'object' ? msg.tally : {},
                auto: Boolean(msg.auto),
                until: Date.now() + VOTE_RESULT_MS
            };
            emit();
        }
    }

    // A guest asked for a song. Validated and capped; the host decides.
    function addRequest(msg, serverTimeSec) {
        const serverMs = (serverTimeSec || 0) * 1000;
        // Cached relay history from before this session started
        if (serverMs && serverMs < sessionStartedAt - guestOffset - 5000) return;
        if (requests.some(r => r.reqId === msg.reqId)) return;
        const t = msg.track || {};
        if (!TRACK_URI.test(String(t.uri || ''))) return;
        const known = listeners.get(msg.id);
        requests.push({
            reqId: String(msg.reqId).slice(0, 40),
            from: msg.id,
            name: cleanName(msg.name) || (known && known.name) || 'A friend',
            track: {
                uri: t.uri,
                id: String(t.id || t.uri.split(':').pop()).slice(0, 40),
                name: String(t.name || 'Untitled').slice(0, 120),
                artist: String(t.artist || '').slice(0, 120),
                album: String(t.album || '').slice(0, 120),
                album_art: /^https:\/\//.test(String(t.album_art || '')) ? t.album_art : null,
                duration_ms: Number(t.duration_ms) || 0
            },
            at: Number(msg.at) || Date.now()
        });
        while (requests.length > MAX_REQUESTS) requests.shift();
        emit();
    }

    // Host: play / queue / dismiss a request, and tell the guests
    async function requestAction(reqId, action) {
        if (mode !== 'host') return { success: false, error: 'Not hosting a session' };
        const index = requests.findIndex(r => r.reqId === reqId);
        if (index < 0) return { success: false, error: 'That request is gone' };
        const req = requests[index];

        let res = { success: true };
        let outcome = 'dismissed';
        if (action === 'play') {
            res = await player.playTrack(req.track.uri, 0);
            outcome = 'played';
        } else if (action === 'queue') {
            res = await player.queueTrack(req.track.uri);
            outcome = 'queued';
        } else if (action !== 'dismiss') {
            return { success: false, error: `Unknown action: ${action}` };
        }
        if (!res.success) {
            setMessage(`Couldn't ${action} "${req.track.name}": ${res.error}`);
            return { success: false, error: res.error, status: status() };
        }

        requests.splice(index, 1);
        publish({ t: 'request-ack', reqId, status: outcome, at: Date.now() }).catch(() => {});
        emit();
        return { success: true, status: status() };
    }

    // ------------------------------------------------------------------
    // Handoff: the session survives the host leaving
    // ------------------------------------------------------------------
    function rosterExcept(excludeId) {
        return [...listeners.entries()]
            .filter(([id]) => id !== excludeId)
            .map(([id, l]) => ({ id, name: l.name }));
    }

    // Host: hand the session to a listener and stay on as a guest
    async function handoff(toId) {
        if (mode !== 'host') return { success: false, error: 'Not hosting a session' };
        const target = listeners.get(toId);
        if (!target) return { success: false, error: 'That listener is gone' };
        if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; pendingPublish = null; }

        const roster = rosterExcept(toId);
        roster.push({ id: guestId, name: hostName }); // we become a listener
        const ok = await publish({
            t: 'handoff', to: toId, toName: target.name, from: hostName || undefined, from_id: guestId, roster, at: Date.now()
        });
        if (!ok) return { success: false, error: 'Could not reach the relay — try again' };

        // Same topic, new role: keep following without leaving
        mode = 'guest';
        listeners.clear();
        requests.length = 0;
        resetVote();
        guestState = null;
        mirrorNote = null;
        mirrorBlocked = false;
        requestNote = null;
        resetVote();
        lastRequestId = null;
        // Our Spotify is already on this track; the first state from the new
        // host should only nudge the position, not restart the song
        lastMirrored = lastPublished ? { trackId: lastPublished.trackId, is_playing: lastPublished.is_playing } : null;
        publish({ t: 'hello', id: guestId, name: hostName || undefined }).catch(() => {});
        setMessage(`${target.name || 'Your friend'} is hosting now — you're listening along`);
        return { success: true, status: status() };
    }

    // Host quitting with people still listening: pass it on instead of ending
    async function handoffOnQuit() {
        const first = listeners.entries().next().value;
        if (!first) return stopHost();
        const [toId, target] = first;
        if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; pendingPublish = null; }
        const endCode = code;
        unsubscribe();
        mode = 'off';
        listeners.clear();
        requests.length = 0;
        resetVote();
        code = endCode;
        await publish({
            t: 'handoff', to: toId, toName: target.name, from: hostName || undefined, from_id: guestId,
            roster: rosterExcept(toId), quit: true, at: Date.now()
        });
        code = null;
        setMessage(null);
    }

    async function handleHandoff(msg) {
        if (mode === 'off') return;
        if (msg.to === guestId) {
            // We're the host now. lastPublished = null makes the next poll of
            // our own Spotify publish a fresh state right away.
            mode = 'host';
            hostName = await safeName();
            listeners.clear();
            for (const l of (Array.isArray(msg.roster) ? msg.roster : [])) {
                if (l && l.id && l.id !== guestId) listeners.set(String(l.id), { name: cleanName(l.name), lastSeen: Date.now() });
            }
            requests.length = 0;
            resetVote();
            sessionStartedAt = Date.now();
            lastPublished = null;
            guestState = null;
            if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
            lastMirrored = null;
            mirrorNote = null;
            setMessage(`${cleanName(msg.from) || 'The host'} handed you the session — you're hosting now`);
        } else if (mode === 'guest') {
            // Someone else took over: start fresh from their first state
            guestState = null;
            setMessage(`${cleanName(msg.toName) || 'A friend'} is hosting now`);
        } else if (mode === 'host') {
            // A stale handoff can't dethrone a live host
            return;
        }
        emit();
    }

    async function stopHost(reason) {
        if (mode !== 'host') return;
        if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; pendingPublish = null; }
        const endCode = code;
        unsubscribe();
        mode = 'off';
        listeners.clear();
        requests.length = 0;
        resetVote();
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
        requestNote = null;
        resetVote();
        lastRequestId = null;

        const myName = await safeName();
        subscribe();
        publish({ t: 'hello', id: guestId, name: myName || undefined }).catch(() => {});
        emit();
        return { success: true, status: status() };
    }

    // Guest: ask the host to play a track
    async function request(track) {
        if (mode !== 'guest') return { success: false, error: 'Join a session first' };
        if (!track || !TRACK_URI.test(String(track.uri || ''))) {
            return { success: false, error: 'That is not a Spotify song link' };
        }
        const reqId = crypto.randomBytes(6).toString('hex');
        const ok = await publish({
            t: 'request',
            v: 1,
            reqId,
            id: guestId,
            name: (await safeName()) || undefined,
            track: {
                uri: track.uri,
                id: track.id,
                name: track.name,
                artist: track.artist,
                album: track.album,
                album_art: track.album_art,
                duration_ms: track.duration_ms
            },
            at: Date.now()
        });
        if (!ok) return { success: false, error: 'Could not reach the relay — try again' };
        lastRequestId = reqId;
        requestNote = `Requested "${track.name}" — waiting for the host`;
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
        if (!player || !player.isConnected()) {
            mirrorNote = 'Connect your Spotify (gear → 🔑) to play along on your speakers';
            emit();
            return;
        }

        const state = guestState;
        const trackId = state.track ? state.track.id : null;
        // Can we hand our player the host's Spotify uri as-is? Only when both
        // sides speak Spotify. Otherwise (a cross-service pairing, or a host
        // with no uri to share) we resolve the same song by title + artist.
        const canUseUri = Boolean(state.track && state.track.uri) && (!player.canPlayUri || player.canPlayUri());
        mirrorBusy = true;
        try {
            let res;
            if (!state.track || !state.is_playing) {
                // Only send a pause if we were mirroring something
                if (lastMirrored && lastMirrored.is_playing) res = await player.control('pause');
                else { lastMirrored = { trackId, is_playing: false }; return; }
            } else {
                const trackChanged = !lastMirrored || lastMirrored.trackId !== trackId;
                const resumed = lastMirrored && !lastMirrored.is_playing;
                if (trackChanged) {
                    res = canUseUri
                        ? await player.playTrack(state.track.uri, guestProgressNow())
                        : await player.playBySearch({
                            name: state.track.name,
                            artist: state.track.artist,
                            durationMs: state.track.duration_ms,
                            uri: state.track.uri,
                            positionMs: guestProgressNow()
                        });
                } else if (resumed) {
                    // Same song resuming after a pause: the Spotify uri path replays
                    // at the right spot in one call; a search-based guest just resumes
                    // the song it already has loaded, then nudges to the host's spot —
                    // no need to search and reload all over again.
                    if (canUseUri) {
                        res = await player.playTrack(state.track.uri, guestProgressNow());
                    } else {
                        res = await player.control('play');
                        if (res && res.success) player.control('seek', guestProgressNow()).catch(() => {});
                    }
                } else {
                    // Same track, still playing: this was a seek
                    res = await player.control('seek', guestProgressNow());
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
        if (reason === 'NO_SEARCH' || reason === 'NOT_FOUND' || reason === 'NO_QUERY') {
            // Cross-service play-along couldn't resolve the song here, but a later
            // track might (e.g. the host switches back to Spotify) — keep trying.
            mirrorNote = res.error;
        } else if (reason === 'UNSUPPORTED') {
            mirrorNote = res.error;
            mirrorBlocked = true;
        } else if (reason === 'NOT_RUNNING') {
            mirrorNote = 'Open Spotify to play along — following the lyrics only';
        } else if (res.needs_permission) {
            mirrorNote = res.error;
        } else if (res.needs_auth || code === 401) {
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
            if (wasPlaying && player && player.isConnected()) player.control('pause').catch(() => {});
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
        requestNote = null;
        resetVote();
        lastRequestId = null;
        code = oldCode;
        publish({ t: 'bye', id: guestId }).catch(() => {});
        code = null;
        if (wasMirroring && player && player.isConnected()) {
            player.control('pause').catch(() => {});
        }
        setMessage(reason || null);
    }

    // Karaoke & games traffic — the library just carries it
    async function sendGame(payload) {
        if (mode === 'off') return { success: false, error: 'Not in a session' };
        const body = { ...(payload || {}), t: 'game', id: guestId, name: (await safeName()) || undefined, at: Date.now() };
        const ok = await publish(body);
        return { success: ok };
    }

    async function shutdown() {
        if (mode === 'host') {
            if (listeners.size) await handoffOnQuit();
            else await stopHost();
        } else if (mode === 'guest') {
            await leave();
        }
    }

    return {
        status,
        startHost,
        stopHost,
        onHostPoll,
        join,
        leave,
        setMirror,
        request,
        requestAction,
        setRoomVote,
        castVote,
        handoff,
        sendGame,
        guestTrackResult,
        shutdown,
        parseCode,
        isGuest: () => mode === 'guest',
        isHost: () => mode === 'host'
    };
}

module.exports = { createListenAlong, parseCode, generateCode, formatCode, joinLink, DEFAULT_RELAY };
