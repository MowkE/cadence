/**
 * Karaoke & games
 *
 * A setlist of room games built on what Cadence already has: synced lyric
 * timestamps from LRCLIB, the current track, playback control, and the
 * listen-along relay. No microphone, no extra services.
 *
 *   Karaoke          anyone   full-screen lyrics that fill as the line plays
 *   Guess the song   friends  title hides, lyrics roll, first to name it wins
 *   Duet             friends  two singers split the song, chorus for both
 *   Hot mic          friends  every line lands on someone in the room
 *   Lyric liar       friends  write a fake next line, fool the room, spot the real one
 *   Finish the line  friends  the end of the next line is missing — fastest correct answer wins
 *   Beat tap         solo     tap as each line lands
 *
 * Friends games run on the listen-along session: the host starts them and
 * judges; everyone's overlay follows. Everyone in the room gets a colour
 * (host first), and that colour is how a person shows up everywhere here.
 *
 * Loaded before renderer.js; only touches `state` / `elements` from inside
 * functions the renderer calls later.
 */

window.Games = (() => {
    'use strict';

    const PALETTE = ['#ff7a59', '#5ff2c2', '#c69cff', '#ffd166', '#5ee1ff', '#ff6ec7', '#9bff8a', '#ffb3a7'];
    const EVERYONE = { id: 'all', name: 'Everyone', color: '#ffd166' };

    const GAMES = [
        { id: 'karaoke', name: 'Karaoke', hook: 'Full-screen lyrics that fill as you sing.', who: 'anyone' },
        { id: 'guess', name: 'Guess the song', hook: 'The title hides. First to name it takes the round.', who: 'friends' },
        { id: 'duet', name: 'Duet', hook: 'Two singers, one song. The chorus is for both.', who: 'friends' },
        { id: 'hotmic', name: 'Hot mic', hook: 'Every line lands on someone in the room. Miss yours and everyone knows.', who: 'friends' },
        { id: 'liar', name: 'Lyric liar', hook: 'Write a fake next line. Fool the room, then spot the real one.', who: 'friends' },
        { id: 'finish', name: 'Finish the line', hook: 'The end of the next line goes missing. Fastest correct answer wins it.', who: 'friends' },
        { id: 'beat', name: 'Beat tap', hook: 'Tap as each line lands. Combos and accuracy, no mercy.', who: 'solo' }
    ];

    let panel, hub, screen, titleEl, backBtn, statusEl;
    let active = null;
    let keyHandler = null;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    const $ = (sel, root = document) => root.querySelector(sel);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const words = s => String(s || '').trim().split(/\s+/).filter(Boolean);
    const fmtSec = ms => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
    const rid = () => Math.random().toString(36).slice(2, 8);

    function norm(s) {
        return String(s || '').toLowerCase()
            .replace(/\(.*?\)|\[.*?\]/g, ' ')
            .replace(/\b(feat|ft|featuring)\b.*$/, ' ')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function levenshtein(a, b) {
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        let prev = new Array(b.length + 1);
        let cur = new Array(b.length + 1);
        for (let j = 0; j <= b.length; j++) prev[j] = j;
        for (let i = 1; i <= a.length; i++) {
            cur[0] = i;
            for (let j = 1; j <= b.length; j++) {
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            [prev, cur] = [cur, prev];
        }
        return prev[b.length];
    }

    function similarity(a, b) {
        a = norm(a); b = norm(b);
        if (!a || !b) return 0;
        return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    }

    function titleMatches(guessText, title) {
        const g = norm(guessText), t = norm(title);
        if (!g || !t) return false;
        if (g === t || similarity(g, t) >= 0.8) return true;
        return g.length >= 4 && t.includes(g) && g.length >= t.length * 0.6;
    }

    const progressNow = () => Math.min(
        state.estimatedProgress + (state.isPlaying ? Date.now() - state.lastFetchTime : 0),
        state.trackDuration || Infinity
    );
    const synced = () => Boolean(state.lyricsAreSynced && state.lyrics.length && !state.lyrics[0].placeholder);
    const lineStart = i => (state.lyrics[i] && state.lyrics[i].startTimeMs != null) ? state.lyrics[i].startTimeMs : null;
    const lineEnd = i => {
        const next = state.lyrics[i + 1];
        if (next && next.startTimeMs != null) return next.startTimeMs;
        const s = lineStart(i);
        return s == null ? null : s + 4000;
    };
    const trackId = () => (state.currentTrack && state.currentTrack.id) || '';

    const inSession = () => Boolean(state.laStatus && state.laStatus.mode !== 'off');
    const isHost = () => Boolean(state.laStatus && state.laStatus.mode === 'host');
    const selfId = () => (state.laStatus && state.laStatus.selfId) || 'me';
    const myName = () => (state.playerInfo && (state.playerInfo.displayName || state.playerInfo.nameHint)) || 'You';
    const hostName = () => (state.laStatus && state.laStatus.hostName) || 'The host';
    const listeners = () => (state.laStatus && state.laStatus.listenersDetail) || [];
    const send = payload => {
        if (!inSession()) return Promise.resolve({ success: false });
        return window.electronAPI.listenAlong.sendGame(payload).catch(() => ({ success: false }));
    };
    const isTyping = e => e && e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);

    function focusInput(sel) {
        const el = $(sel);
        if (el) { el.value = ''; el.focus(); }
    }

    function onEnter(sel, fn) {
        const el = $(sel);
        if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fn(); } });
    }

    function status(text, actionLabel, action) {
        if (!statusEl) return;
        statusEl.innerHTML = text ? `<span>${esc(text)}</span>${actionLabel ? `<button class="status-action">${esc(actionLabel)}</button>` : ''}` : '';
        statusEl.classList.toggle('hidden', !text);
        const btn = $('.status-action', statusEl);
        if (btn && action) btn.addEventListener('click', action);
    }

    function feed(sel, html) {
        const box = $(sel);
        if (!box) return;
        const row = document.createElement('div');
        row.className = 'feed-row';
        row.innerHTML = html;
        box.prepend(row);
        while (box.children.length > 40) box.lastChild.remove();
    }

    // ------------------------------------------------------------------
    // The room: everyone gets a colour (host first)
    // ------------------------------------------------------------------
    const room = { players: [] };

    function refreshRoom() {
        if (isHost()) {
            room.players = [{ id: selfId(), name: myName() }, ...listeners().map(l => ({ id: l.id, name: l.name }))];
        } else if (!inSession()) {
            room.players = [{ id: selfId(), name: myName() }];
        }
        // Guests keep the roster the host last sent
    }

    function adoptPlayers(list) {
        if (!Array.isArray(list) || !list.length) return;
        room.players = list.map(p => ({ id: String(p.id), name: String(p.name || 'Friend').slice(0, 24) }));
    }

    function playersPayload() {
        refreshRoom();
        return room.players.map(p => ({ id: p.id, name: p.name }));
    }

    function colorFor(id) {
        if (id === 'all') return EVERYONE.color;
        const i = room.players.findIndex(p => p.id === id);
        return i < 0 ? '#8e8e9a' : PALETTE[i % PALETTE.length];
    }

    function nameFor(id) {
        if (id === 'all') return EVERYONE.name;
        if (id === selfId()) return room.players.find(p => p.id === id)?.name || myName();
        const p = room.players.find(p => p.id === id);
        return p ? p.name : 'Friend';
    }

    const cap = (id, name) => `<span class="cap" style="--c:${colorFor(id)}">${esc(name || nameFor(id))}</span>`;

    function leaderboard(scores) {
        const rows = Object.entries(scores || {}).sort((a, b) => b[1] - a[1]);
        if (!rows.length) return '';
        return `<div class="board">${rows.map(([id, pts], i) => `
            <div class="board-row${i === 0 ? ' lead' : ''}">${cap(id)}<span class="board-pts">${pts}</span></div>`).join('')}</div>`;
    }

    function friendsOnly(game) {
        if (inSession()) return false;
        screen.innerHTML = `
            <div class="stage stage-empty">
                <p class="stage-title">${esc(game.name)} needs a room</p>
                <p class="stage-note">Start a session in Listen along, or join a friend's. Everyone who's listening can play.</p>
                <button class="btn primary" id="g-open-la">Open Listen along</button>
            </div>`;
        $('#g-open-la').addEventListener('click', () => {
            close();
            elements.settingsMenu.classList.remove('hidden');
            const la = document.getElementById('listen-along-section');
            if (la) la.scrollIntoView({ block: 'start' });
        });
        return true;
    }

    function waitingForHost(game, extra) {
        screen.innerHTML = `
            <div class="stage stage-empty">
                <p class="stage-title">Waiting for ${esc(hostName())}</p>
                <p class="stage-note">${esc(hostName())} starts ${esc(game.name)} from their overlay. ${esc(extra || 'You\'ll be pulled in the moment it begins.')}</p>
            </div>`;
    }

    // Lyric list masking (Lyric liar, Finish the line hide the target line)
    const masks = new Map();
    function maskLine(i, text) {
        const el = elements.lyricsContainer.querySelector(`.lyric-line[data-index="${i}"] .lyric-text`);
        if (!el) return;
        if (!masks.has(i)) masks.set(i, el.textContent);
        el.textContent = text;
    }
    function unmaskAll() {
        for (const [i, original] of masks) {
            const el = elements.lyricsContainer.querySelector(`.lyric-line[data-index="${i}"] .lyric-text`);
            if (el) el.textContent = original;
        }
        masks.clear();
    }

    // Countdown bar driven by track time
    function clock(sel, remainingMs, totalMs) {
        const el = $(sel);
        if (!el) return;
        el.style.setProperty('--p', clamp(remainingMs / Math.max(1, totalMs), 0, 1).toFixed(3));
        const label = $('.clock-label', el.parentElement || el);
        if (label) label.textContent = `${Math.max(0, Math.ceil(remainingMs / 1000))}`;
    }

    // ------------------------------------------------------------------
    // Karaoke layer (Karaoke, Duet, Hot mic): big lyrics, line fill,
    // gap countdown, singer tags
    // ------------------------------------------------------------------
    const kk = {
        on: false,
        singerFor: null,   // (lineIndex) => { id, name, color } | null
        lastText: null,

        start(opts = {}) {
            this.on = true;
            this.singerFor = opts.singerFor || null;
            this.lastText = null;
            document.body.classList.add('karaoke-mode');
            window.electronAPI.setOverlayFullscreen(true).catch(() => {});
            this.render(progressNow());
        },

        stop() {
            if (!this.on) return;
            this.on = false;
            this.singerFor = null;
            document.body.classList.remove('karaoke-mode');
            window.electronAPI.setOverlayFullscreen(false).catch(() => {});
        },

        render(now) {
            if (!this.on) return;
            const prevEl = $('#kk-prev'), curEl = $('#kk-current'), nextEl = $('#kk-next');
            const gapEl = $('#kk-gap'), singerEl = $('#kk-singer'), metaEl = $('#kk-meta');
            if (!curEl) return;
            const base = $('.kk-base', curEl), fill = $('.kk-fill', curEl);

            const lines = state.lyrics;
            const i = state.currentLyricIndex;
            const cur = lines[i];
            metaEl.textContent = state.currentTrack ? `${state.currentTrack.name} — ${state.currentTrack.artist}` : '';

            const blank = text => {
                base.textContent = fill.textContent = text;
                prevEl.textContent = nextEl.textContent = gapEl.textContent = singerEl.textContent = '';
                fill.style.clipPath = 'inset(0 100% 0 0)';
                curEl.className = 'kk-line kk-current';
                singerEl.className = 'kk-singer';
            };
            if (!cur) return blank(state.currentTrack ? '♪' : 'Play something on Spotify');
            if (cur.placeholder) return blank(cur.text);

            const prev = lines[i - 1], next = lines[i + 1];
            const who = this.singerFor ? this.singerFor(i) : null;
            const nextWho = next && this.singerFor ? this.singerFor(i + 1) : null;

            prevEl.textContent = prev ? prev.text : '';
            nextEl.textContent = next ? (nextWho ? `${nextWho.name} · ${next.text}` : next.text) : '';
            if (this.lastText !== cur.text) {
                base.textContent = cur.text;
                fill.textContent = cur.text;
                this.lastText = cur.text;
            }

            let pct = 1;
            if (synced() && cur.startTimeMs != null) {
                const s = cur.startTimeMs;
                const sung = Math.min(lineEnd(i) - s, Math.max(900, cur.text.length * 75));
                pct = clamp((now - s) / sung, 0, 1);
            }
            fill.style.clipPath = `inset(0 ${(100 - pct * 100).toFixed(1)}% 0 0)`;

            let gap = '';
            if (synced() && next && next.startTimeMs != null) {
                const remaining = next.startTimeMs - now;
                if (pct >= 1 && remaining > 2500) gap = `${Math.ceil(remaining / 1000)}`;
            }
            gapEl.textContent = gap;

            const mine = Boolean(who && (who.id === selfId() || who.id === 'all'));
            curEl.className = `kk-line kk-current${who ? ' has-singer' : ''}${mine ? ' mine' : ''}`;
            if (who) curEl.style.setProperty('--singer', who.color);
            singerEl.className = `kk-singer${who ? ' has-singer' : ''}`;
            if (who) singerEl.style.setProperty('--singer', who.color);
            singerEl.textContent = who ? `${who.name}${mine && who.id !== 'all' ? ' · you' : ''}` : '';
        }
    };

    // ------------------------------------------------------------------
    // Karaoke (anyone)
    // ------------------------------------------------------------------
    const karaoke = {
        id: 'karaoke',
        start() {
            screen.innerHTML = `
                <div class="stage">
                    <p class="stage-note">The overlay fills the screen. Lines fill as they play, a countdown runs through the gaps, and the next line waits below. Press <b>Esc</b> or the button to come back.</p>
                    <p class="stage-note dim">${synced() ? 'Synced lyrics loaded.' : 'This song has no synced lyrics, so lines show without the fill.'}</p>
                    <button class="btn" id="g-exit">Leave karaoke</button>
                </div>`;
            $('#g-exit').addEventListener('click', () => back());
            kk.start({});
        },
        stop() { kk.stop(); },
        onTick(now) { kk.render(now); },
        onLine() {}, onTrack() { kk.lastText = null; }, onLyrics() { kk.render(progressNow()); }, onMessage() {}, onRoom() {}
    };

    // ------------------------------------------------------------------
    // Guess the song (friends): the host DJs, everyone else races
    // ------------------------------------------------------------------
    const guess = {
        id: 'guess',
        round: null,      // { id, startedAt, won, revealed, wrong, hints }
        scores: {},

        start(remote) {
            if (friendsOnly(GAMES[1])) return;
            refreshRoom();
            this.render();
            if (remote && remote.action === 'start') this.onMessage(remote);
            else if (isHost() && state.currentTrack) this.beginRound();
        },

        render() {
            const host = isHost();
            screen.innerHTML = `
                <div class="stage">
                    <div class="stage-top">
                        <span class="live"><b id="g-timer">0.0</b>s</span>
                        <span class="live dim" id="g-roundstate">${this.round ? (this.round.won ? 'Solved' : 'Round on') : 'No round yet'}</span>
                    </div>
                    ${host ? `
                        <p class="stage-note">You're the DJ: you see the title, so the room does the guessing. Skipping to the next song starts a new round.</p>
                        <div class="actions">
                            <button class="btn primary" id="g-next">Next song</button>
                            <button class="btn" id="g-reveal">Reveal</button>
                        </div>` : `
                        <div class="ask">
                            <input id="g-guess" class="field" placeholder="What song is this?" autocomplete="off" maxlength="120">
                            <button class="btn primary" id="g-send">Guess</button>
                        </div>`}
                    <div class="feed" id="g-feed"></div>
                    <div id="g-board">${leaderboard(this.scores)}</div>
                </div>`;
            if (host) {
                $('#g-next').addEventListener('click', () => {
                    if (this.round && !this.round.won && !this.round.revealed) this.reveal();
                    window.electronAPI.controlPlayback('next').catch(() => {});
                });
                $('#g-reveal').addEventListener('click', () => this.reveal());
            } else {
                const submit = () => this.submit($('#g-guess').value);
                $('#g-send').addEventListener('click', submit);
                onEnter('#g-guess', submit);
            }
        },

        setRoundState(text) {
            const el = $('#g-roundstate');
            if (el) el.textContent = text;
        },

        board() {
            const el = $('#g-board');
            if (el) el.innerHTML = leaderboard(this.scores);
        },

        points(elapsedMs) {
            return Math.max(10, 100 - Math.floor(elapsedMs / 1000)) + (elapsedMs < 10000 ? 20 : 0);
        },

        // Host
        beginRound() {
            if (!isHost() || !state.currentTrack) return;
            this.round = { id: rid(), startedAt: Date.now(), won: false, revealed: false, wrong: 0, hints: 0 };
            send({ game: 'guess', action: 'start', roundId: this.round.id, players: playersPayload() });
            const f = $('#g-feed');
            if (f) f.innerHTML = '';
            this.setRoundState('Round on');
            feed('#g-feed', `<span class="dim">New round. The room is guessing ${esc(state.currentTrack.name)}.</span>`);
        },

        reveal() {
            if (!this.round || this.round.revealed) return;
            this.round.revealed = true;
            this.setRoundState('Revealed');
            applyTitleMask();
            if (state.currentTrack) {
                updateTrackDisplay(state.currentTrack);
                feed('#g-feed', `It was <b>${esc(state.currentTrack.name)}</b> — ${esc(state.currentTrack.artist)}`);
                if (isHost()) send({ game: 'guess', action: 'reveal', roundId: this.round.id, title: state.currentTrack.name, artist: state.currentTrack.artist });
            }
        },

        // Guest
        submit(text) {
            text = String(text || '').trim();
            if (!text) return;
            if (this.round && (this.round.won || this.round.revealed)) return;
            send({ game: 'guess', action: 'guess', roundId: this.round ? this.round.id : undefined, text });
            feed('#g-feed', `${cap(selfId(), myName())} ${esc(text)} <span class="dim">· sent</span>`);
            focusInput('#g-guess');
        },

        stop() {
            if (isHost() && inSession()) send({ game: 'guess', action: 'stop' });
            this.round = null;
            applyTitleMask();
            if (state.currentTrack) updateTrackDisplay(state.currentTrack);
        },

        onTick() {
            const el = $('#g-timer');
            if (!this.round || this.round.won || this.round.revealed) return;
            const elapsed = Date.now() - this.round.startedAt;
            if (el) el.textContent = (elapsed / 1000).toFixed(1);
            // Host drops hints as the room struggles
            if (isHost() && state.currentTrack) {
                if (this.round.hints === 0 && elapsed > 20000) {
                    this.round.hints = 1;
                    const text = `It's by ${state.currentTrack.artist}`;
                    send({ game: 'guess', action: 'hint', roundId: this.round.id, text });
                    feed('#g-feed', `<span class="dim">Hint sent: ${esc(text)}</span>`);
                } else if (this.round.hints === 1 && elapsed > 45000) {
                    this.round.hints = 2;
                    const text = `It starts with "${state.currentTrack.name.slice(0, 2)}"`;
                    send({ game: 'guess', action: 'hint', roundId: this.round.id, text });
                    feed('#g-feed', `<span class="dim">Hint sent: ${esc(text)}</span>`);
                }
            }
        },
        onLine() {}, onLyrics() {},
        onTrack(track) { if (track && isHost()) this.beginRound(); },
        onRoom() { this.board(); },

        onMessage(msg) {
            const host = isHost();
            if (msg.players) adoptPlayers(msg.players);
            if (msg.action === 'start' && !host) {
                this.round = { id: String(msg.roundId || ''), startedAt: Date.now(), won: false, revealed: false, wrong: 0, hints: 0 };
                const f = $('#g-feed');
                if (f) f.innerHTML = '';
                this.setRoundState('Round on');
                applyTitleMask();
                if (state.currentTrack) updateTrackDisplay(state.currentTrack);
                feed('#g-feed', `<span class="dim">${esc(msg.name || hostName())} started a round. What song is this?</span>`);
                focusInput('#g-guess');
            } else if (msg.action === 'guess' && host) {
                if (!this.round || (msg.roundId && msg.roundId !== this.round.id)) return;
                const text = String(msg.text || '').slice(0, 120);
                const whoId = String(msg.id || '');
                const elapsed = Date.now() - this.round.startedAt;
                const correct = !this.round.won && !this.round.revealed && titleMatches(text, state.currentTrack ? state.currentTrack.name : '');
                send({ game: 'guess', action: 'result', roundId: this.round.id, whoId, who: msg.name, text, correct });
                feed('#g-feed', `${cap(whoId, msg.name)} ${esc(text)} ${correct ? '<b>· correct</b>' : '<span class="dim">· no</span>'}`);
                if (correct) {
                    const pts = this.points(elapsed);
                    this.scores[whoId] = (this.scores[whoId] || 0) + pts;
                    this.round.won = true;
                    this.setRoundState('Solved');
                    this.board();
                    send({
                        game: 'guess', action: 'winner', roundId: this.round.id, whoId, who: msg.name, elapsedMs: elapsed, points: pts,
                        title: state.currentTrack.name, artist: state.currentTrack.artist, scores: this.scores, players: playersPayload()
                    });
                    feed('#g-feed', `${cap(whoId, msg.name)} got it in ${fmtSec(elapsed)} and won ${pts}`);
                }
            } else if (msg.action === 'result' && !host) {
                if (msg.whoId === selfId()) feed('#g-feed', msg.correct ? '<b>Correct.</b>' : '<span class="dim">Not it.</span>');
                else feed('#g-feed', `${cap(msg.whoId, msg.who)} ${esc(msg.text)} ${msg.correct ? '<b>· correct</b>' : '<span class="dim">· no</span>'}`);
            } else if (msg.action === 'hint' && !host) {
                feed('#g-feed', `<span class="dim">Hint: ${esc(msg.text)}</span>`);
            } else if (msg.action === 'winner' && !host) {
                if (this.round) { this.round.won = true; this.setRoundState('Solved'); }
                if (msg.scores && typeof msg.scores === 'object') this.scores = msg.scores;
                applyTitleMask();
                if (state.currentTrack) updateTrackDisplay(state.currentTrack);
                feed('#g-feed', `${cap(msg.whoId, msg.who)} got <b>${esc(msg.title)}</b> in ${fmtSec(msg.elapsedMs)} and won ${msg.points}`);
                this.board();
            } else if (msg.action === 'reveal' && !host) {
                if (this.round) { this.round.revealed = true; this.setRoundState('Revealed'); }
                applyTitleMask();
                if (state.currentTrack) updateTrackDisplay(state.currentTrack);
                feed('#g-feed', `It was <b>${esc(msg.title)}</b> — ${esc(msg.artist)}`);
            } else if (msg.action === 'stop' && !host) {
                back();
            }
        }
    };

    // ------------------------------------------------------------------
    // Duet (friends): the host picks two people from the room
    // ------------------------------------------------------------------
    const duet = {
        id: 'duet',
        mode: 'alternate',
        a: null,
        b: null,
        running: false,

        modeLabel(m) {
            return m === 'verse' ? 'switching every verse' : m === 'random' ? 'passing the mic at random' : 'alternating lines';
        },

        start(remote) {
            if (friendsOnly(GAMES[2])) return;
            refreshRoom();
            if (remote && remote.action === 'start') return this.begin(remote.mode, remote.aId, remote.bId, false);
            if (!isHost()) return waitingForHost(GAMES[2], 'If they pick you, your lines light up.');
            const opts = sel => room.players.map((p, i) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
            const second = room.players[1] ? room.players[1].id : room.players[0].id;
            screen.innerHTML = `
                <div class="stage">
                    <p class="stage-note">Two singers split the song and the chorus is for both. Everyone's overlay shows who's up.</p>
                    <div class="pair">
                        <label class="pick"><span class="pick-label">First singer</span><select id="g-a" class="field">${opts(room.players[0].id)}</select></label>
                        <label class="pick"><span class="pick-label">Second singer</span><select id="g-b" class="field">${opts(second)}</select></label>
                    </div>
                    <div class="seg" id="g-modes">
                        <button class="seg-btn active" data-mode="alternate">Alternate lines</button>
                        <button class="seg-btn" data-mode="verse">Every verse</button>
                        <button class="seg-btn" data-mode="random">Pass the mic</button>
                    </div>
                    <button class="btn primary" id="g-start">Start duet</button>
                </div>`;
            let mode = 'alternate';
            screen.querySelectorAll('#g-modes .seg-btn').forEach(btn => btn.addEventListener('click', () => {
                mode = btn.dataset.mode;
                screen.querySelectorAll('#g-modes .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
            }));
            $('#g-start').addEventListener('click', () => {
                const aId = $('#g-a').value, bId = $('#g-b').value;
                if (aId === bId) { status('Pick two different singers'); return; }
                this.begin(mode, aId, bId, true);
            });
        },

        begin(mode, aId, bId, local) {
            this.mode = ['alternate', 'verse', 'random'].includes(mode) ? mode : 'alternate';
            this.a = { id: String(aId), name: nameFor(String(aId)), color: colorFor(String(aId)) };
            this.b = { id: String(bId), name: nameFor(String(bId)), color: colorFor(String(bId)) };
            this.running = true;
            if (local && isHost()) send({ game: 'duet', action: 'start', mode: this.mode, aId: this.a.id, bId: this.b.id, players: playersPayload() });
            screen.innerHTML = `
                <div class="stage">
                    <p class="stage-note">${cap(this.a.id)} and ${cap(this.b.id)}, ${this.modeLabel(this.mode)}. Chorus: ${cap('all')}.</p>
                    <button class="btn" id="g-exit">${isHost() ? 'End duet' : 'Leave duet'}</button>
                </div>`;
            $('#g-exit').addEventListener('click', () => back());
            kk.start({ singerFor: i => this.singerFor(i) });
        },

        singerFor(i) {
            const l = state.lyrics[i];
            if (!l || l.placeholder) return null;
            if (l.chorus) return EVERYONE;
            let second;
            if (this.mode === 'verse') second = Math.floor(i / 4) % 2 === 1;
            else if (this.mode === 'random') second = Math.abs(hashString(`${trackId()}:${i}`)) % 2 === 1;
            else second = i % 2 === 1;
            return second ? this.b : this.a;
        },

        stop() {
            if (this.running && isHost()) send({ game: 'duet', action: 'stop' });
            this.running = false;
            kk.stop();
        },
        onTick(now) { kk.render(now); },
        onLine() {}, onTrack() { kk.lastText = null; }, onLyrics() { kk.render(progressNow()); }, onRoom() {},
        onMessage(msg) {
            if (msg.players) adoptPlayers(msg.players);
            if (msg.action === 'start' && !isHost()) this.begin(msg.mode, msg.aId, msg.bId, false);
            else if (msg.action === 'stop' && !isHost()) { this.running = false; back(); }
        }
    };

    // ------------------------------------------------------------------
    // Hot mic (friends): the mic jumps around the whole room
    // ------------------------------------------------------------------
    const hotmic = {
        id: 'hotmic',
        running: false,
        players: [],

        start(remote) {
            if (friendsOnly(GAMES[3])) return;
            refreshRoom();
            if (remote && remote.action === 'start') return this.begin(false);
            if (!isHost()) return waitingForHost(GAMES[3], 'When it starts, watch for your name — that line is yours.');
            screen.innerHTML = `
                <div class="stage">
                    <p class="stage-note">Every line is dealt to someone in the room, the chorus to everyone. Your line lights up in your colour a line ahead, so you can see it coming.</p>
                    <div class="who">${room.players.map(p => cap(p.id, p.name)).join('')}</div>
                    <button class="btn primary" id="g-start">Start hot mic</button>
                </div>`;
            $('#g-start').addEventListener('click', () => this.begin(true));
        },

        begin(local) {
            this.running = true;
            if (local && isHost()) send({ game: 'hotmic', action: 'start', players: playersPayload() });
            screen.innerHTML = `
                <div class="stage">
                    <p class="stage-note">Live. ${room.players.length} in the room: ${room.players.map(p => cap(p.id, p.name)).join(' ')}</p>
                    <button class="btn" id="g-exit">${isHost() ? 'End hot mic' : 'Leave hot mic'}</button>
                </div>`;
            $('#g-exit').addEventListener('click', () => back());
            kk.start({ singerFor: i => this.singerFor(i) });
        },

        singerFor(i) {
            const l = state.lyrics[i];
            if (!l || l.placeholder) return null;
            if (l.chorus) return EVERYONE;
            const n = room.players.length;
            if (!n) return null;
            const p = room.players[Math.abs(hashString(`${trackId()}:${i}`)) % n];
            return { id: p.id, name: p.name, color: colorFor(p.id) };
        },

        stop() {
            if (this.running && isHost()) send({ game: 'hotmic', action: 'stop' });
            this.running = false;
            kk.stop();
        },
        onTick(now) { kk.render(now); },
        onLine() {}, onTrack() { kk.lastText = null; }, onLyrics() { kk.render(progressNow()); },
        onRoom() { if (this.running && isHost()) send({ game: 'hotmic', action: 'start', players: playersPayload() }); },
        onMessage(msg) {
            if (msg.players) adoptPlayers(msg.players);
            if (msg.action === 'start' && !isHost()) { if (!this.running) this.begin(false); else kk.render(progressNow()); }
            else if (msg.action === 'stop' && !isHost()) { this.running = false; back(); }
        }
    };

    // ------------------------------------------------------------------
    // Lyric liar (friends): write a fake next line, fool the room, spot
    // the real one. Rounds are timed off the song itself.
    // ------------------------------------------------------------------
    const LIAR_WRITE_MS = 22000;
    const LIAR_VOTE_MS = 12000;
    const LIAR_LEAD_MS = 3000;

    const liar = {
        id: 'liar',
        scores: {},
        round: null,   // { id, line, context, writeUntil, voteUntil, phase, fakes: Map(id->text), votes: Map(id->pick), options, myFake, myVote, realText }
        running: false,

        start(remote) {
            if (friendsOnly(GAMES[4])) return;
            refreshRoom();
            if (remote && remote.action === 'prompt') { this.running = true; return this.onMessage(remote); }
            if (!isHost()) return waitingForHost(GAMES[4], 'Rounds start a few lines ahead of the music.');
            if (listeners().length < 1) {
                screen.innerHTML = `<div class="stage stage-empty"><p class="stage-title">Needs at least one friend</p><p class="stage-note">Lyric liar is about fooling each other. Share your session code first.</p></div>`;
                return;
            }
            screen.innerHTML = `
                <div class="stage">
                    <p class="stage-note">A line a little way ahead is hidden from everyone. You each write a fake version, then vote on which is real. 3 for spotting the real one, 2 for every vote your fake takes.</p>
                    <div class="who">${room.players.map(p => cap(p.id, p.name)).join('')}</div>
                    <button class="btn primary" id="g-start">Start lyric liar</button>
                    <p class="stage-note dim">${synced() ? '' : 'This song has no synced lyrics; rounds begin with the next one that does.'}</p>
                </div>`;
            $('#g-start').addEventListener('click', () => { this.running = true; this.lobby(); this.schedule(); });
        },

        lobby() {
            screen.innerHTML = `
                <div class="stage">
                    <div class="stage-top"><span class="live dim" id="g-phase">Finding the next line</span></div>
                    <div id="g-play"></div>
                    <div id="g-board">${leaderboard(this.scores)}</div>
                    <button class="btn" id="g-exit">${isHost() ? 'End lyric liar' : 'Leave lyric liar'}</button>
                </div>`;
            $('#g-exit').addEventListener('click', () => back());
        },

        phase(text) {
            const el = $('#g-phase');
            if (el) el.textContent = text;
        },

        board() {
            const el = $('#g-board');
            if (el) el.innerHTML = leaderboard(this.scores);
        },

        // Host: pick the next target line far enough ahead
        schedule() {
            if (!isHost() || !this.running || this.round) return;
            if (!synced()) { this.phase('Waiting for a song with synced lyrics'); return; }
            const now = progressNow();
            const need = LIAR_WRITE_MS + LIAR_VOTE_MS + LIAR_LEAD_MS;
            let target = -1;
            for (let i = state.currentLyricIndex + 1; i < state.lyrics.length; i++) {
                const l = state.lyrics[i];
                if (l.startTimeMs == null || l.chorus) continue;
                if (words(l.text).length < 4) continue;
                if (l.startTimeMs - now >= need) { target = i; break; }
            }
            if (target < 0) { this.phase('Not enough song left. Next round on the next track'); return; }
            const s = lineStart(target);
            this.round = {
                id: rid(), line: target, context: state.lyrics[target - 1] ? state.lyrics[target - 1].text : '',
                writeUntil: s - LIAR_VOTE_MS - LIAR_LEAD_MS, voteUntil: s - 800, phase: 'write',
                fakes: new Map(), votes: new Map(), options: null, myFake: null, myVote: null,
                realText: state.lyrics[target].text
            };
            send({
                game: 'liar', action: 'prompt', roundId: this.round.id, line: target, context: this.round.context,
                writeUntil: this.round.writeUntil, voteUntil: this.round.voteUntil, players: playersPayload()
            });
            this.showWrite();
        },

        showWrite() {
            const r = this.round;
            maskLine(r.line, '· · · the line everyone is faking · · ·');
            this.phase('Write a fake');
            const play = $('#g-play');
            if (!play) return;
            play.innerHTML = `
                <div class="liar-context"><span class="eyebrow">The line after</span><p>“${esc(r.context || '…')}”</p></div>
                <div class="clock"><i id="g-clock" style="--p:1"></i><span class="clock-label"></span></div>
                <div class="ask">
                    <input id="g-fake" class="field" placeholder="Your fake next line" autocomplete="off" maxlength="120">
                    <button class="btn primary" id="g-sendfake">Send fake</button>
                </div>
                <p class="stage-note dim" id="g-fakestate">Make it sound like the song.</p>`;
            const submit = () => this.submitFake($('#g-fake').value);
            $('#g-sendfake').addEventListener('click', submit);
            onEnter('#g-fake', submit);
            focusInput('#g-fake');
        },

        submitFake(text) {
            const r = this.round;
            text = String(text || '').trim().slice(0, 120);
            if (!r || r.phase !== 'write' || !text) return;
            r.myFake = text;
            if (isHost()) r.fakes.set(selfId(), text);
            else send({ game: 'liar', action: 'fake', roundId: r.id, text });
            const el = $('#g-fakestate');
            if (el) el.textContent = 'Sent. Waiting for the others.';
            const input = $('#g-fake');
            if (input) input.disabled = true;
        },

        // Host: close writing, open voting
        openVote() {
            const r = this.round;
            const options = [{ id: 'real', text: r.realText }, ...[...r.fakes.entries()].map(([id, text]) => ({ id, text }))];
            for (let i = options.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [options[i], options[j]] = [options[j], options[i]]; }
            r.options = options;
            r.phase = 'vote';
            send({ game: 'liar', action: 'vote', roundId: r.id, options: options.map(o => ({ id: o.id, text: o.text })) });
            this.showVote();
        },

        showVote() {
            const r = this.round;
            this.phase('Which one is real?');
            const play = $('#g-play');
            if (!play) return;
            play.innerHTML = `
                <div class="clock"><i id="g-clock" style="--p:1"></i><span class="clock-label"></span></div>
                <div class="options">${r.options.map(o => {
                    const mine = o.id === selfId() || (o.id !== 'real' && o.text === r.myFake && o.id === selfId());
                    return `<button class="option${mine ? ' mine' : ''}" data-pick="${esc(o.id)}" ${mine ? 'disabled' : ''}>${esc(o.text)}${mine ? '<span class="option-tag">yours</span>' : ''}</button>`;
                }).join('')}</div>`;
            play.querySelectorAll('.option').forEach(btn => btn.addEventListener('click', () => this.vote(btn.dataset.pick)));
        },

        vote(pick) {
            const r = this.round;
            if (!r || r.phase !== 'vote' || r.myVote) return;
            r.myVote = pick;
            if (isHost()) r.votes.set(selfId(), pick);
            else send({ game: 'liar', action: 'vote', roundId: r.id, pick });
            $('#g-play').querySelectorAll('.option').forEach(b => { b.disabled = true; b.classList.toggle('picked', b.dataset.pick === pick); });
            this.phase('Voted. Reveal when the line plays');
        },

        // Host: tally and reveal
        revealRound() {
            const r = this.round;
            r.phase = 'reveal';
            const tally = {};
            for (const [voter, pick] of r.votes) {
                (tally[pick] = tally[pick] || []).push(voter);
                if (pick === 'real') this.scores[voter] = (this.scores[voter] || 0) + 3;
                else if (r.fakes.has(pick) && pick !== voter) this.scores[pick] = (this.scores[pick] || 0) + 2;
            }
            for (const id of room.players.map(p => p.id)) if (!(id in this.scores)) this.scores[id] = this.scores[id] || 0;
            const payload = {
                game: 'liar', action: 'reveal', roundId: r.id, line: r.line,
                options: r.options.map(o => ({ id: o.id, text: o.text, votes: tally[o.id] || [] })),
                scores: this.scores, players: playersPayload()
            };
            send(payload);
            this.showReveal(payload);
            this.round = null;
            this.holdUntil = Date.now() + 10000; // let the room read the results
            unmaskAll();
        },

        showReveal(msg) {
            this.phase('The real line');
            const play = $('#g-play');
            if (play) {
                play.innerHTML = `<div class="options reveal">${(msg.options || []).map(o => `
                    <div class="option static${o.id === 'real' ? ' real' : ''}">
                        <span class="option-text">${esc(o.text)}</span>
                        <span class="option-by">${o.id === 'real' ? 'the song' : cap(o.id)}</span>
                        <span class="option-votes">${(o.votes || []).map(v => cap(v)).join('')}</span>
                    </div>`).join('')}</div>`;
            }
            if (msg.scores) this.scores = msg.scores;
            this.board();
        },

        stop() {
            if (this.running && isHost()) send({ game: 'liar', action: 'stop' });
            this.running = false;
            this.round = null;
            unmaskAll();
        },

        onTick(now) {
            const r = this.round;
            if (!r) {
                if (!isHost() || !this.running) return;
                const hold = (this.holdUntil || 0) - Date.now();
                if (hold > 0) { this.phase(`Next round in ${Math.ceil(hold / 1000)}`); return; }
                this.schedule();
                return;
            }
            if (r.phase === 'write') {
                clock('#g-clock', r.writeUntil - now, LIAR_WRITE_MS);
                if (isHost() && now >= r.writeUntil) this.openVote();
            } else if (r.phase === 'vote') {
                clock('#g-clock', r.voteUntil - now, LIAR_VOTE_MS);
                if (isHost() && now >= r.voteUntil) this.revealRound();
            }
        },
        onLine() {},
        onLyrics() { if (this.round && !isHost()) maskLine(this.round.line, '· · · the line everyone is faking · · ·'); },
        onTrack() {
            // Song changed mid-round: drop it
            if (this.round && isHost()) send({ game: 'liar', action: 'abort', roundId: this.round.id });
            this.round = null;
            unmaskAll();
            if (this.running && $('#g-phase')) this.phase('New song. Finding the next line');
        },
        onRoom() { this.board(); },

        onMessage(msg) {
            if (msg.players) adoptPlayers(msg.players);
            const host = isHost();
            if (msg.action === 'prompt' && !host) {
                this.running = true;
                if (!$('#g-phase')) this.lobby();
                this.round = {
                    id: String(msg.roundId), line: Number(msg.line), context: String(msg.context || ''),
                    writeUntil: Number(msg.writeUntil), voteUntil: Number(msg.voteUntil), phase: 'write',
                    fakes: new Map(), votes: new Map(), options: null, myFake: null, myVote: null
                };
                this.showWrite();
            } else if (msg.action === 'fake' && host) {
                if (this.round && this.round.phase === 'write' && msg.roundId === this.round.id) this.round.fakes.set(String(msg.id), String(msg.text || '').slice(0, 120));
            } else if (msg.action === 'vote' && !host) {
                if (!this.round || msg.roundId !== this.round.id) return;
                this.round.phase = 'vote';
                this.round.options = (msg.options || []).map(o => ({ id: String(o.id), text: String(o.text || '') }));
                this.showVote();
            } else if (msg.action === 'vote' && host) {
                if (this.round && this.round.phase === 'vote' && msg.roundId === this.round.id && !this.round.votes.has(String(msg.id))) {
                    this.round.votes.set(String(msg.id), String(msg.pick || ''));
                }
            } else if (msg.action === 'reveal' && !host) {
                unmaskAll();
                this.round = null;
                this.showReveal(msg);
            } else if (msg.action === 'abort' && !host) {
                unmaskAll();
                this.round = null;
                this.phase('Round dropped. Waiting for the next');
            } else if (msg.action === 'stop' && !host) {
                back();
            }
        }
    };

    // ------------------------------------------------------------------
    // Finish the line (friends): the fastest correct answer wins the line
    // ------------------------------------------------------------------
    const FINISH_LEAD_MS = 6000;

    const finish = {
        id: 'finish',
        scores: {},
        running: false,
        challenge: null,   // { id, line, prefix, missing, k, winner, correct: Set, mine: 'pending'|'right'|'wrong' }

        start(remote) {
            if (friendsOnly(GAMES[5])) return;
            refreshRoom();
            if (remote && remote.action === 'challenge') { this.running = true; this.lobby(); return this.onMessage(remote); }
            if (!isHost()) return waitingForHost(GAMES[5], 'Have your fingers ready.');
            screen.innerHTML = `
                <div class="stage">
                    <p class="stage-note">The last words of an upcoming line disappear from everyone's lyrics. Type them before the line plays. First correct answer wins the line, everyone else who's right still scores.</p>
                    <div class="who">${room.players.map(p => cap(p.id, p.name)).join('')}</div>
                    <button class="btn primary" id="g-start">Start finish the line</button>
                </div>`;
            $('#g-start').addEventListener('click', () => { this.running = true; send({ game: 'finish', action: 'start', players: playersPayload() }); this.lobby(); this.next(); });
        },

        lobby() {
            screen.innerHTML = `
                <div class="stage">
                    <div class="stage-top"><span class="live dim" id="g-phase">Waiting for a line</span><span class="live"><b id="g-clockn">–</b>s</span></div>
                    <div class="prompt" id="g-prompt"></div>
                    <div class="ask">
                        <input id="g-answer" class="field" placeholder="The missing words" autocomplete="off" maxlength="120">
                        <button class="btn primary" id="g-send">Answer</button>
                    </div>
                    <div class="feed" id="g-feed"></div>
                    <div id="g-board">${leaderboard(this.scores)}</div>
                    <button class="btn" id="g-exit">${isHost() ? 'End finish the line' : 'Leave finish the line'}</button>
                </div>`;
            const submit = () => this.answer($('#g-answer').value);
            $('#g-send').addEventListener('click', submit);
            onEnter('#g-answer', submit);
            $('#g-exit').addEventListener('click', () => back());
        },

        phase(text) { const el = $('#g-phase'); if (el) el.textContent = text; },
        board() { const el = $('#g-board'); if (el) el.innerHTML = leaderboard(this.scores); },

        // Host: choose the next line to blank
        next() {
            if (!isHost() || !this.running || this.challenge) return;
            if (!synced()) { this.phase('Waiting for a song with synced lyrics'); return; }
            const now = progressNow();
            for (let j = state.currentLyricIndex + 1; j < state.lyrics.length; j++) {
                const l = state.lyrics[j];
                if (l.startTimeMs == null || words(l.text).length < 5) continue;
                if (l.startTimeMs - now < FINISH_LEAD_MS) continue;
                const w = words(l.text);
                const k = w.length <= 6 ? 1 : w.length <= 9 ? 2 : 3;
                this.challenge = { id: rid(), line: j, prefix: w.slice(0, -k).join(' '), missing: w.slice(-k).join(' '), k, winner: null, correct: new Set(), mine: 'pending' };
                send({ game: 'finish', action: 'challenge', roundId: this.challenge.id, line: j, prefix: this.challenge.prefix, k, players: playersPayload() });
                this.showChallenge();
                return;
            }
            this.phase('No more lines in this song');
        },

        showChallenge() {
            const c = this.challenge;
            maskLine(c.line, `${c.prefix} ${'____ '.repeat(c.k).trim()}`);
            this.phase('Finish it');
            const p = $('#g-prompt');
            if (p) p.innerHTML = `<span class="prefix">${esc(c.prefix)}</span> ${'<span class="blank">____</span> '.repeat(c.k)}`;
            const input = $('#g-answer');
            if (input) { input.disabled = false; input.value = ''; input.focus(); }
        },

        // Everyone checks their own answer against the lyrics they already have;
        // only the host decides who was first
        answer(text) {
            const c = this.challenge;
            text = String(text || '').trim();
            if (!c || c.mine !== 'pending' || !text) return;
            const ok = similarity(text, c.missing) >= 0.75;
            c.mine = ok ? 'right' : 'wrong';
            const input = $('#g-answer');
            if (ok) {
                if (input) input.disabled = true;
                feed('#g-feed', `${cap(selfId(), myName())} <b>right</b> · ${esc(text)}`);
                if (isHost()) this.record(selfId(), myName(), text);
                else send({ game: 'finish', action: 'answer', roundId: c.id, text });
            } else {
                c.mine = 'pending';
                feed('#g-feed', `${cap(selfId(), myName())} <span class="dim">not quite</span> · ${esc(text)}`);
                if (input) { input.value = ''; input.focus(); }
            }
        },

        // Host: a correct answer arrived
        record(whoId, who, text) {
            const c = this.challenge;
            if (!c || c.correct.has(whoId)) return;
            c.correct.add(whoId);
            if (!c.winner) {
                c.winner = whoId;
                send({ game: 'finish', action: 'winner', roundId: c.id, whoId, who, text });
                if (whoId !== selfId()) feed('#g-feed', `${cap(whoId, who)} <b>first</b> · ${esc(text)}`);
            }
        },

        // Host: the line played
        reveal() {
            const c = this.challenge;
            if (!c) return;
            for (const id of c.correct) this.scores[id] = (this.scores[id] || 0) + (id === c.winner ? 10 * c.k : 3);
            send({ game: 'finish', action: 'reveal', roundId: c.id, missing: c.missing, whoId: c.winner, scores: this.scores, players: playersPayload() });
            this.showReveal({ missing: c.missing, whoId: c.winner, scores: this.scores });
            this.challenge = null;
            unmaskAll();
        },

        showReveal(msg) {
            const p = $('#g-prompt');
            if (p) p.innerHTML = `<span class="prefix dim">…</span> <b>${esc(msg.missing)}</b>`;
            feed('#g-feed', msg.whoId ? `${cap(msg.whoId)} won the line` : '<span class="dim">Nobody got that one.</span>');
            if (msg.scores) this.scores = msg.scores;
            this.board();
            this.phase('Next line coming');
            const input = $('#g-answer');
            if (input) input.disabled = true;
        },

        stop() {
            if (this.running && isHost()) send({ game: 'finish', action: 'stop' });
            this.running = false;
            this.challenge = null;
            unmaskAll();
        },

        onTick(now) {
            const c = this.challenge;
            const el = $('#g-clockn');
            if (c) {
                const remaining = (lineStart(c.line) || now) - now;
                if (el) el.textContent = Math.max(0, remaining / 1000).toFixed(1);
                if (isHost() && remaining <= 0) this.reveal();
            } else {
                if (el) el.textContent = '–';
                if (isHost() && this.running) this.next();
            }
        },
        onLine() {},
        onLyrics() { if (this.challenge && !isHost()) maskLine(this.challenge.line, `${this.challenge.prefix} ${'____ '.repeat(this.challenge.k).trim()}`); },
        onTrack() {
            this.challenge = null;
            unmaskAll();
            if (this.running && $('#g-phase')) this.phase('New song');
        },
        onRoom() { this.board(); },

        onMessage(msg) {
            if (msg.players) adoptPlayers(msg.players);
            const host = isHost();
            if (msg.action === 'start' && !host) {
                this.running = true;
                if (!$('#g-phase')) this.lobby();
            } else if (msg.action === 'challenge' && !host) {
                this.running = true;
                if (!$('#g-phase')) this.lobby();
                const line = Number(msg.line);
                const l = state.lyrics[line];
                const k = Number(msg.k) || 1;
                const w = l ? words(l.text) : [];
                this.challenge = { id: String(msg.roundId), line, prefix: String(msg.prefix || ''), missing: w.length ? w.slice(-k).join(' ') : '', k, winner: null, correct: new Set(), mine: 'pending' };
                this.showChallenge();
            } else if (msg.action === 'answer' && host) {
                if (this.challenge && msg.roundId === this.challenge.id) this.record(String(msg.id), msg.name, String(msg.text || ''));
            } else if (msg.action === 'winner' && !host) {
                if (msg.whoId !== selfId()) feed('#g-feed', `${cap(msg.whoId, msg.who)} <b>first</b> · ${esc(msg.text)}`);
            } else if (msg.action === 'reveal' && !host) {
                unmaskAll();
                this.showReveal(msg);
                this.challenge = null;
            } else if (msg.action === 'stop' && !host) {
                back();
            }
        }
    };

    // ------------------------------------------------------------------
    // Beat tap (solo)
    // ------------------------------------------------------------------
    const beat = {
        id: 'beat',
        WINDOW: 2400,
        LATE: 350,
        notes: [],
        score: 0,
        combo: 0,
        best: 0,
        hits: { perfect: 0, good: 0, ok: 0, miss: 0 },

        start() {
            this.reset();
            screen.innerHTML = `
                <div class="stage">
                    <div class="stage-top">
                        <span class="live">Score <b id="g-score">0</b></span>
                        <span class="live">Combo <b id="g-combo">0</b></span>
                        <span class="live">Best <b id="g-best">0</b></span>
                        <span class="live">Accuracy <b id="g-acc">–</b></span>
                    </div>
                    <div class="lane" id="g-lane"><div class="lane-bar"></div><div class="lane-judge" id="g-judge"></div></div>
                    <button class="btn primary" id="g-tap">Tap — or press space</button>
                    <p class="stage-note dim">${synced() ? 'Each lyric line is a note. Hit it as it reaches the bar.' : 'This song has no synced lyrics, so there are no notes to hit.'}</p>
                </div>`;
            $('#g-tap').addEventListener('click', () => this.tap());
            $('#g-lane').addEventListener('mousedown', e => { e.preventDefault(); this.tap(); });
        },

        reset() {
            this.notes = state.lyrics
                .map((l, i) => ({ i, t: l.startTimeMs, judged: false }))
                .filter(n => n.t != null && !state.lyrics[n.i].placeholder);
            const now = progressNow();
            for (const n of this.notes) if (n.t < now - this.LATE) n.judged = true;
            this.score = 0; this.combo = 0; this.best = 0;
            this.hits = { perfect: 0, good: 0, ok: 0, miss: 0 };
            this.stats();
        },

        stats() {
            const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
            set('#g-score', this.score);
            set('#g-combo', this.combo);
            set('#g-best', this.best);
            const judged = this.hits.perfect + this.hits.good + this.hits.ok + this.hits.miss;
            set('#g-acc', judged ? `${Math.round((this.hits.perfect + this.hits.good + this.hits.ok) / judged * 100)}%` : '–');
        },

        judgeText(text, cls) {
            const el = $('#g-judge');
            if (!el) return;
            el.textContent = text;
            el.className = `lane-judge show ${cls}`;
            clearTimeout(this.judgeTimer);
            this.judgeTimer = setTimeout(() => el.classList.remove('show'), 500);
        },

        miss() {
            this.hits.miss++;
            this.combo = 0;
            this.judgeText('Miss', 'miss');
            this.stats();
        },

        tap() {
            if (!synced()) return;
            const now = progressNow();
            let best = null;
            for (const n of this.notes) {
                if (n.judged) continue;
                const d = Math.abs(n.t - now);
                if (d <= this.LATE && (!best || d < best.d)) best = { n, d };
            }
            if (!best) { this.combo = 0; this.judgeText('Miss', 'miss'); this.stats(); return; }
            best.n.judged = true;
            let pts, label, cls;
            if (best.d <= 120) { pts = 100; label = 'Perfect'; cls = 'perfect'; }
            else if (best.d <= 220) { pts = 50; label = 'Good'; cls = 'good'; }
            else { pts = 20; label = 'OK'; cls = 'ok'; }
            this.hits[cls]++;
            this.combo++;
            this.best = Math.max(this.best, this.combo);
            this.score += pts + Math.min(50, this.combo * 2);
            this.judgeText(`${label} ${pts}`, cls);
            this.stats();
        },

        onTick(now) {
            for (const n of this.notes) {
                if (!n.judged && now > n.t + this.LATE) { n.judged = true; this.miss(); }
            }
            const lane = $('#g-lane');
            if (!lane) return;
            const visible = this.notes.filter(n => !n.judged && n.t - now < this.WINDOW);
            const seen = new Set();
            for (const n of visible) {
                seen.add(n.i);
                let el = lane.querySelector(`.lane-note[data-i="${n.i}"]`);
                if (!el) {
                    el = document.createElement('div');
                    el.className = 'lane-note';
                    el.dataset.i = n.i;
                    lane.appendChild(el);
                }
                el.style.top = `${clamp((1 - (n.t - now) / this.WINDOW) * 82, -5, 95).toFixed(1)}%`;
            }
            lane.querySelectorAll('.lane-note').forEach(el => { if (!seen.has(Number(el.dataset.i))) el.remove(); });
        },
        onLine() {}, onTrack() { this.reset(); }, onLyrics() { this.reset(); }, onMessage() {}, onRoom() {},
        stop() { clearTimeout(this.judgeTimer); }
    };

    const REGISTRY = { karaoke, guess, duet, hotmic, liar, finish, beat };

    // ------------------------------------------------------------------
    // Panel: setlist + game screens
    // ------------------------------------------------------------------
    function renderHub() {
        refreshRoom();
        const session = inSession();
        const host = isHost();
        const t = state.currentTrack;
        const roomHtml = `
            <div class="room">
                <div class="room-now">${t ? `<span class="room-dot${state.isPlaying ? ' on' : ''}"></span><span class="room-track">${esc(t.name)}</span><span class="room-artist">${esc(t.artist)}</span>` : '<span class="room-dot"></span><span class="room-track dim">Nothing playing</span>'}</div>
                <div class="room-people">${session
                    ? room.players.map(p => cap(p.id, p.name)).join('')
                    : '<span class="room-solo">Just you. Start a session to bring friends in.</span>'}</div>
            </div>`;
        let idx = 0;
        const row = g => {
            const locked = g.who === 'friends' && !session;
            let meta;
            if (g.who === 'solo') meta = 'Solo';
            else if (g.who === 'anyone') meta = 'Anyone';
            else if (locked) meta = 'Needs a session';
            else if (!host) meta = `${hostName()} starts it`;
            else meta = room.players.length === 1 ? 'Waiting for friends' : `${room.players.length} in the room`;
            return `<button class="setlist-row${locked ? ' locked' : ''}" data-game="${g.id}" style="--i:${idx++}">
                <span class="row-name">${esc(g.name)}</span>
                <span class="row-hook">${esc(g.hook)}</span>
                <span class="row-meta">${esc(meta)}</span>
            </button>`;
        };
        const anyone = GAMES.filter(g => g.who === 'anyone').map(row).join('');
        const friends = GAMES.filter(g => g.who === 'friends').map(row).join('');
        const solo = GAMES.filter(g => g.who === 'solo').map(row).join('');
        hub.innerHTML = roomHtml + `
            <div class="setlist">
                ${anyone}
                <div class="setlist-cut"><span>With friends</span></div>
                ${friends}
                <div class="setlist-cut"><span>On your own</span></div>
                ${solo}
            </div>`;
    }

    function open() {
        if (!panel) return;
        panel.classList.remove('hidden');
        if (!active) {
            renderHub();
            hub.classList.remove('hidden');
            screen.classList.add('hidden');
            backBtn.classList.add('hidden');
            titleEl.textContent = 'Karaoke & games';
        }
        status('');
    }

    function show(id, remote) {
        const game = REGISTRY[id];
        if (!game) return;
        if (active && active !== game) stopActive();
        open();
        active = game;
        const meta = GAMES.find(g => g.id === id);
        titleEl.textContent = meta.name;
        hub.classList.add('hidden');
        screen.classList.remove('hidden');
        backBtn.classList.remove('hidden');
        screen.innerHTML = '';
        status('');
        game.start(remote);
    }

    function stopActive() {
        if (!active) return;
        try { active.stop(); } catch (e) { console.error('game stop error:', e); }
        active = null;
        unmaskAll();
        applyTitleMask();
    }

    function back() {
        stopActive();
        open();
    }

    function close() {
        stopActive();
        if (panel) panel.classList.add('hidden');
    }

    // ------------------------------------------------------------------
    // Title mask (Guess the song hides what's playing from guessers)
    // ------------------------------------------------------------------
    function hidesTitle() {
        return Boolean(active === guess && guess.round && !guess.round.won && !guess.round.revealed && !isHost());
    }

    function applyTitleMask() {
        const on = hidesTitle();
        document.body.classList.toggle('title-hidden', on);
        if (on) {
            elements.trackName.textContent = '? ? ?';
            elements.artistName.textContent = 'Guess the song';
        }
    }

    const maskedLabel = () => '? ? ? — guess the song';

    // ------------------------------------------------------------------
    // Hooks from the renderer
    // ------------------------------------------------------------------
    // A game bug must never take the lyric sync loop down with it
    function guarded(fn) {
        try { fn(); } catch (e) { console.error('games:', e); }
    }
    function onTick(progressMs) { if (active) guarded(() => active.onTick(progressMs)); }
    function onLine(index) { if (active) guarded(() => active.onLine(index)); }

    // Only a genuinely different song resets a game. An empty poll (Spotify
    // hiccup) or the same track showing up again is not a change.
    let lastTrackId = null;
    function onTrackChange(track) {
        if (!track) return;
        if (track.id === lastTrackId) return;
        lastTrackId = track.id;
        if (active) guarded(() => active.onTrack(track));
        if (hidesTitle()) applyTitleMask();
    }
    function onLyrics() { masks.clear(); if (active) guarded(() => active.onLyrics()); }
    function onRoom() {
        if (!panel || panel.classList.contains('hidden')) return;
        if (active) guarded(() => active.onRoom());
        else renderHub();
    }

    function onGameMessage(msg) {
        if (!msg || !msg.game || !REGISTRY[msg.game]) return;
        const game = REGISTRY[msg.game];
        const opener = ['start', 'prompt', 'challenge'].includes(msg.action);
        if (opener && active !== game) {
            guarded(() => show(msg.game, msg));
            return;
        }
        if (active === game) guarded(() => game.onMessage(msg));
    }

    function init() {
        panel = $('#games-panel');
        hub = $('#games-hub');
        screen = $('#games-screen');
        titleEl = $('#games-title');
        backBtn = $('#games-back');
        statusEl = $('#games-status');
        if (!panel) return;

        backBtn.addEventListener('click', back);
        $('#games-close').addEventListener('click', close);
        hub.addEventListener('click', e => {
            const row = e.target.closest('.setlist-row');
            if (!row) return;
            const game = GAMES.find(g => g.id === row.dataset.game);
            if (row.classList.contains('locked')) {
                status(`${game.name} needs a session. Start one or join a friend's in Listen along.`, 'Open Listen along', () => {
                    close();
                    elements.settingsMenu.classList.remove('hidden');
                    const la = document.getElementById('listen-along-section');
                    if (la) la.scrollIntoView({ block: 'start' });
                });
                return;
            }
            show(game.id);
        });

        keyHandler = e => {
            if (panel.classList.contains('hidden')) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                if (active) back(); else close();
            } else if (e.code === 'Space' && active === beat && !isTyping(e)) {
                e.preventDefault();
                beat.tap();
            }
        };
        window.addEventListener('keydown', keyHandler);
    }

    return {
        init, open, show, back, close,
        onTick, onLine, onTrackChange, onLyrics, onRoom, onGameMessage,
        hidesTitle, applyTitleMask, maskedLabel,
        isOpen: () => Boolean(panel && !panel.classList.contains('hidden')),
        active: () => (active ? active.id : null)
    };
})();
