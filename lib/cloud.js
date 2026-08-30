/**
 * Cadence Cloud — accounts, friends and presence on Firebase, spoken to over
 * plain REST from the main process (no SDK, no bundle weight).
 *
 * Config lives in src/cloud-config.json: { apiKey, authDomain, projectId,
 * storageBucket, authPage }. An empty apiKey means "not set up in this
 * build" and everything here reports configured: false.
 *
 * Sign-in: Cadence opens `authPage` in the browser, that page does Google
 * sign-in with the Firebase web SDK and comes back through the app's own
 * cadence://auth#state=…&id_token=… link. We trade the Google ID token for
 * Firebase tokens (signInWithIdp), keep the refresh token on disk (0600),
 * and refresh on demand.
 *
 * Data (see cloud/firestore.rules):
 *   users/{uid}                    displayName, handle, photoUrl, createdAt, updatedAt
 *   handles/{handle}               { uid }  — keeps handles unique
 *   users/{uid}/requests/{fromUid} incoming friend requests
 *   friends/{uid}/list/{friendUid} accepted friendships, written both ways
 *   presence/{uid}                 what they're listening to, visible to friends
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REQUEST_TIMEOUT_MS = 12000;
const PRESENCE_MIN_GAP_MS = 45000;
const PRESENCE_ONLINE_MS = 3 * 60 * 1000;
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
// @moke is reserved for nobody; a few others are kept out of auto-generation.
// Owners get a fixed name + handle at first sign-in.
const RESERVED_ALWAYS = new Set(['moke']);
const RESERVED_AUTO = new Set(['moke', 'sama', 'admin', 'cadence', 'support', 'staff']);
const OWNER_PROFILES = { 'samahith@gmail.com': { displayName: 'Sama', handle: 'sama' } };

// ---------------------------------------------------------------------------
// Firestore value encoding
// ---------------------------------------------------------------------------
function encodeValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
    if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
    return { stringValue: String(v) };
}

function encodeFields(obj) {
    const fields = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) fields[k] = encodeValue(v);
    return fields;
}

function decodeValue(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('nullValue' in v) return null;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
    if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
    return null;
}

function decodeFields(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
    return out;
}

function docId(name) {
    return String(name || '').split('/').pop();
}

function cleanText(s, max) {
    return String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

function handleFrom(text) {
    const base = String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9_]+/g, '').slice(0, 16);
    return base.length >= 3 ? base : `cadence${base}`.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createCloud({ config = {}, tokenFile, openExternal, appVersion = '', emulator = null, log = console }) {
    const apiKey = String(config.apiKey || '').trim();
    const projectId = String(config.projectId || '').trim();
    // Pictures are optional: Storage needs the Blaze plan on new projects, so
    // no bucket = keep the Google photo and hide the upload button
    const bucket = String(config.storageBucket || '').trim();
    const authPage = String(config.authPage || '').trim();
    const ownerEmails = (Array.isArray(config.ownerEmails) ? config.ownerEmails : []).map(e => String(e).toLowerCase().trim()).filter(Boolean);

    const endpoints = emulator ? {
        identity: `${emulator.auth}/identitytoolkit.googleapis.com/v1`,
        secureToken: `${emulator.auth}/securetoken.googleapis.com/v1`,
        firestore: `${emulator.firestore}/v1`,
        storage: `${emulator.storage}/v0`
    } : {
        identity: 'https://identitytoolkit.googleapis.com/v1',
        secureToken: 'https://securetoken.googleapis.com/v1',
        firestore: 'https://firestore.googleapis.com/v1',
        storage: 'https://firebasestorage.googleapis.com/v0'
    };
    const docsRoot = `projects/${projectId}/databases/(default)/documents`;
    const docsBase = `${endpoints.firestore}/${docsRoot}`;

    let tokens = null;        // { idToken, refreshToken, expiresAt, uid, email }
    let profile = null;       // users/{uid} as a plain object (+ id)
    let refreshing = null;
    let pendingState = null;
    let lastError = null;
    let busy = false;
    const listeners = new Set();
    let lastPresence = null;  // { key, at }
    let providerReady = Boolean(emulator); // Google provider enabled on the project (checked once per launch)

    const configured = () => Boolean(apiKey && projectId);

    // Public project config: tells us whether the owner has enabled Google
    // sign-in yet, so nothing (like the sign-up gate) relies on it before then
    async function checkProviders() {
        if (!configured() || emulator) return providerReady;
        try {
            const res = await fetch(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/getProjectConfig?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(10000) });
            const data = await res.json();
            providerReady = Array.isArray(data.idpConfig) && data.idpConfig.some(p => p && p.provider === 'google.com' && p.enabled);
        } catch (e) {
            providerReady = false;
        }
        emit();
        return providerReady;
    }

    // ------------------------------------------------------------------
    // Status + events
    // ------------------------------------------------------------------
    function status() {
        return {
            configured: configured(),
            providerReady,
            signedIn: Boolean(tokens && profile),
            canUpload: Boolean(bucket),
            isOwner: Boolean(tokens && tokens.email && ownerEmails.includes(String(tokens.email).toLowerCase())),
            busy,
            error: lastError,
            user: tokens && profile ? {
                uid: tokens.uid,
                email: tokens.email || null,
                displayName: profile.displayName,
                handle: profile.handle,
                photoUrl: profile.photoUrl || null
            } : null
        };
    }

    function emit() {
        for (const cb of listeners) {
            try { cb(status()); } catch (e) { log.error('cloud listener error:', e); }
        }
    }

    function onChange(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
    }

    function fail(message, err) {
        lastError = message;
        log.error('cloud:', message, err && err.stack ? '' : '');
        emit();
        return { success: false, error: message };
    }

    // ------------------------------------------------------------------
    // Tokens
    // ------------------------------------------------------------------
    function loadTokens() {
        if (tokens) return tokens;
        try {
            const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
            if (saved && saved.refreshToken && saved.uid) tokens = saved;
        } catch (e) { /* signed out */ }
        return tokens;
    }

    function saveTokens() {
        try {
            fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
            fs.writeFileSync(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
        } catch (e) {
            log.error('cloud: could not save tokens:', e.message);
        }
    }

    function clearTokens() {
        tokens = null;
        profile = null;
        try { fs.unlinkSync(tokenFile); } catch (e) { /* nothing there */ }
    }

    async function http(url, { method = 'GET', headers = {}, body, raw = false } = {}) {
        const res = await fetch(url, {
            method,
            headers,
            body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        const text = await res.text();
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
        if (!res.ok) {
            const message = (data && data.error && (data.error.message || data.error.status)) || `HTTP ${res.status}`;
            const err = new Error(typeof message === 'string' ? message : JSON.stringify(message));
            err.status = res.status;
            err.code = data && data.error && data.error.status;
            throw err;
        }
        return data;
    }

    async function refreshTokens() {
        if (refreshing) return refreshing;
        const current = loadTokens();
        if (!current) throw new Error('Not signed in');
        refreshing = http(`${endpoints.secureToken}/token?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken }).toString(),
            raw: true
        }).then(data => {
            tokens = {
                ...current,
                idToken: data.id_token,
                refreshToken: data.refresh_token || current.refreshToken,
                expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
                uid: data.user_id || current.uid
            };
            saveTokens();
            return tokens;
        }).catch(err => {
            if (err.status === 400) { clearTokens(); err.signedOut = true; }
            throw err;
        }).finally(() => { refreshing = null; });
        return refreshing;
    }

    async function idToken() {
        const current = loadTokens();
        if (!current) throw new Error('Not signed in');
        if (!current.idToken || Date.now() > current.expiresAt - 60000) await refreshTokens();
        return tokens.idToken;
    }

    // ------------------------------------------------------------------
    // Firestore helpers (paths are relative: 'users/abc', 'friends/abc/list')
    // ------------------------------------------------------------------
    async function authHeaders() {
        return { 'Authorization': `Bearer ${await idToken()}`, 'Content-Type': 'application/json' };
    }

    async function fsGet(docPath) {
        try {
            const doc = await http(`${docsBase}/${docPath}`, { headers: await authHeaders() });
            return { id: docId(doc.name), ...decodeFields(doc.fields) };
        } catch (err) {
            if (err.status === 404) return null;
            throw err;
        }
    }

    // Set (full replace) or patch (mask = field names). mustNotExist makes it
    // a create-only write that fails with 409 if the doc is already there.
    async function fsSet(docPath, data, { mask = null, mustNotExist = false } = {}) {
        const params = new URLSearchParams();
        if (mask) for (const f of mask) params.append('updateMask.fieldPaths', f);
        if (mustNotExist) params.set('currentDocument.exists', 'false');
        const qs = params.toString();
        const doc = await http(`${docsBase}/${docPath}${qs ? `?${qs}` : ''}`, {
            method: 'PATCH', headers: await authHeaders(), body: { fields: encodeFields(data) }
        });
        return { id: docId(doc.name), ...decodeFields(doc.fields) };
    }

    async function fsDelete(docPath) {
        try {
            await http(`${docsBase}/${docPath}`, { method: 'DELETE', headers: await authHeaders() });
        } catch (err) {
            if (err.status !== 404) throw err;
        }
    }

    async function fsList(collectionPath) {
        const data = await http(`${docsBase}/${collectionPath}?pageSize=300`, { headers: await authHeaders() });
        return (data.documents || []).map(doc => ({ id: docId(doc.name), ...decodeFields(doc.fields) }));
    }

    async function fsBatchGet(docPaths) {
        if (!docPaths.length) return [];
        const data = await http(`${docsBase}:batchGet`, {
            method: 'POST', headers: await authHeaders(),
            body: { documents: docPaths.map(p => `${docsRoot}/${p}`) }
        });
        const out = new Map();
        for (const item of (Array.isArray(data) ? data : [])) {
            if (item.found) out.set(docId(item.found.name), { id: docId(item.found.name), ...decodeFields(item.found.fields) });
        }
        return docPaths.map(p => out.get(docId(p)) || null);
    }

    // ------------------------------------------------------------------
    // Sign-in
    // ------------------------------------------------------------------
    function startSignIn() {
        if (!configured()) return { success: false, error: 'Cadence accounts are not set up in this build yet' };
        if (!authPage) return { success: false, error: 'No sign-in page configured' };
        pendingState = crypto.randomBytes(16).toString('hex');
        const url = new URL(authPage);
        url.searchParams.set('state', pendingState);
        url.searchParams.set('apiKey', apiKey);
        url.searchParams.set('authDomain', config.authDomain || '');
        url.searchParams.set('projectId', projectId);
        url.searchParams.set('v', appVersion);
        if (emulator) url.searchParams.set('emulator', emulator.auth);
        Promise.resolve(openExternal(url.toString())).catch(err => log.error('cloud: could not open browser:', err.message));
        return { success: true, url: url.toString() };
    }

    // cadence://auth#state=…&id_token=…   (or &error=…)
    function parseAuthLink(url) {
        const raw = String(url || '');
        if (!/^cadence:\/\/auth/i.test(raw)) return null;
        const hash = raw.split('#')[1] || raw.split('?')[1] || '';
        return Object.fromEntries(new URLSearchParams(hash));
    }

    async function handleAuthLink(url) {
        const params = parseAuthLink(url);
        if (!params) return { success: false, error: 'Not a sign-in link' };
        if (!pendingState || params.state !== pendingState) return fail('That sign-in link is stale. Start again from Cadence');
        pendingState = null;
        if (params.error) return fail(`Google sign-in failed: ${params.error}`);
        if (!params.id_token) return fail('The sign-in link is missing its token');
        return signInWithGoogleIdToken(params.id_token);
    }

    async function signInWithGoogleIdToken(googleIdToken) {
        busy = true; lastError = null; emit();
        try {
            const data = await http(`${endpoints.identity}/accounts:signInWithIdp?key=${encodeURIComponent(apiKey)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: {
                    postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
                    requestUri: authPage ? new URL(authPage).origin : 'http://localhost',
                    returnIdpCredential: true,
                    returnSecureToken: true
                }
            });
            tokens = {
                idToken: data.idToken,
                refreshToken: data.refreshToken,
                expiresAt: Date.now() + (Number(data.expiresIn) || 3600) * 1000,
                uid: data.localId,
                email: data.email || null
            };
            saveTokens();
            await ensureProfile({ displayName: data.displayName, photoUrl: data.photoUrl, email: data.email });
            busy = false;
            emit();
            return { success: true, status: status() };
        } catch (err) {
            busy = false;
            clearTokens();
            return fail(`Could not sign in: ${err.message}`, err);
        }
    }

    // Load the saved session on launch (quietly)
    async function restore() {
        if (!configured() || !loadTokens()) return status();
        try {
            await idToken();
            profile = await fsGet(`users/${tokens.uid}`);
            if (!profile) await ensureProfile({ email: tokens.email });
        } catch (err) {
            if (err.signedOut) { log.log('cloud: session expired, signed out'); clearTokens(); }
            else log.error('cloud: could not restore session:', err.message);
        }
        emit();
        return status();
    }

    // ------------------------------------------------------------------
    // Profile
    // ------------------------------------------------------------------
    // Claim a unique handle. `exact` (an owner's fixed handle) is tried first
    // and may use an auto-reserved name; everything else skips reserved names.
    // @moke is off-limits to everyone.
    async function claimHandle(base, uid, exact = null) {
        const root = handleFrom(base);
        const tries = [];
        if (exact) tries.push(String(exact).toLowerCase());
        tries.push(root);
        while (tries.length < 14) tries.push(`${root.slice(0, 16)}${Math.floor(100 + Math.random() * 900)}`);
        for (const candidate of tries) {
            if (!HANDLE_RE.test(candidate)) continue;
            if (RESERVED_ALWAYS.has(candidate)) continue;
            if (candidate !== exact && RESERVED_AUTO.has(candidate)) continue;
            try {
                await fsSet(`handles/${candidate}`, { uid }, { mustNotExist: true });
                return candidate;
            } catch (err) {
                if (err.status !== 409 && err.code !== 'ALREADY_EXISTS') throw err;
            }
        }
        throw new Error('Could not find a free handle');
    }

    async function ensureProfile(idp) {
        const uid = tokens.uid;
        profile = await fsGet(`users/${uid}`);
        if (profile) return profile;
        const email = String(idp.email || '').toLowerCase();
        const owner = OWNER_PROFILES[email];
        const fallback = email.split('@')[0] || 'cadence';
        const displayName = owner ? owner.displayName : (cleanText(idp.displayName || fallback, 40) || 'Cadence listener');
        const handle = await claimHandle(idp.displayName || fallback, uid, owner ? owner.handle : null);
        const now = new Date();
        profile = await fsSet(`users/${uid}`, {
            displayName, handle, photoUrl: idp.photoUrl || null, createdAt: now, updatedAt: now
        });
        return profile;
    }

    // Only the display name is editable — handles are permanent once set
    async function updateProfile({ displayName } = {}) {
        if (!tokens || !profile) return { success: false, error: 'Not signed in' };
        if (displayName === undefined) return { success: true, status: status() };
        const name = cleanText(displayName, 40);
        if (!name) return { success: false, error: 'Your name can\'t be empty' };
        try {
            profile = await fsSet(`users/${tokens.uid}`, { displayName: name, updatedAt: new Date() }, { mask: ['displayName', 'updatedAt'] });
            lastError = null;
            emit();
            return { success: true, status: status() };
        } catch (err) {
            return fail(`Could not save your profile: ${err.message}`, err);
        }
    }

    // Upload a picture (already resized by the caller) and point the profile at it
    async function uploadAvatar(buffer, contentType = 'image/jpeg') {
        if (!tokens || !profile) return { success: false, error: 'Not signed in' };
        if (!bucket) return { success: false, error: 'Picture uploads aren\'t switched on yet — your Google photo is used' };
        try {
            const objectName = `avatars/${tokens.uid}.jpg`;
            // Multipart upload (what the Firebase SDK does) so the security
            // rules always see the content type
            const boundary = `cadence-${crypto.randomBytes(8).toString('hex')}`;
            const meta = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: objectName, contentType })}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf8');
            const body = Buffer.concat([meta, buffer, Buffer.from(`\r\n--${boundary}--`, 'utf8')]);
            const data = await http(`${endpoints.storage}/b/${encodeURIComponent(bucket)}/o?uploadType=multipart&name=${encodeURIComponent(objectName)}`, {
                method: 'POST',
                headers: { 'Authorization': `Firebase ${await idToken()}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'X-Goog-Upload-Protocol': 'multipart' },
                body, raw: true
            });
            const token = String(data.downloadTokens || '').split(',')[0];
            const photoUrl = `${endpoints.storage}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}?alt=media${token ? `&token=${token}` : ''}&v=${Date.now()}`;
            profile = await fsSet(`users/${tokens.uid}`, { photoUrl, updatedAt: new Date() }, { mask: ['photoUrl', 'updatedAt'] });
            lastError = null;
            emit();
            return { success: true, photoUrl, status: status() };
        } catch (err) {
            return fail(`Could not upload the picture: ${err.message}`, err);
        }
    }

    async function signOut() {
        try { if (tokens) await fsDelete(`presence/${tokens.uid}`); } catch (e) { /* best effort */ }
        clearTokens();
        lastPresence = null;
        lastError = null;
        emit();
        return status();
    }

    // ------------------------------------------------------------------
    // Friends
    // ------------------------------------------------------------------
    function publicUser(doc) {
        return doc ? { uid: doc.id, displayName: doc.displayName || 'Cadence listener', handle: doc.handle || '', photoUrl: doc.photoUrl || null } : null;
    }

    async function lookup(handle) {
        const h = String(handle || '').toLowerCase().trim().replace(/^@/, '');
        if (!HANDLE_RE.test(h)) return { success: false, error: 'Type a handle like @riley' };
        try {
            const entry = await fsGet(`handles/${h}`);
            if (!entry || !entry.uid) return { success: false, error: `Nobody has the handle @${h} yet` };
            const user = await fsGet(`users/${entry.uid}`);
            if (!user) return { success: false, error: `Nobody has the handle @${h} yet` };
            return { success: true, user: publicUser(user) };
        } catch (err) {
            return fail(`Could not look that up: ${err.message}`, err);
        }
    }

    async function sendRequest(handle) {
        if (!tokens || !profile) return { success: false, error: 'Sign in first' };
        const found = await lookup(handle);
        if (!found.success) return found;
        const target = found.user;
        if (target.uid === tokens.uid) return { success: false, error: 'That\'s you' };
        try {
            const already = await fsGet(`friends/${tokens.uid}/list/${target.uid}`);
            if (already) return { success: false, error: `You and ${target.displayName} are already friends` };
            // They asked first? Then this is an accept.
            const theirs = await fsGet(`users/${tokens.uid}/requests/${target.uid}`);
            if (theirs) {
                const r = await accept(target.uid);
                return r.success ? { success: true, accepted: target } : r;
            }
            const mine = await fsGet(`users/${target.uid}/requests/${tokens.uid}`);
            if (mine) return { success: true, sent: target, already: true };
            await fsSet(`users/${target.uid}/requests/${tokens.uid}`, {
                from: tokens.uid, fromName: profile.displayName, fromHandle: profile.handle, fromPhoto: profile.photoUrl || null, createdAt: new Date()
            });
            lastError = null;
            return { success: true, sent: target };
        } catch (err) {
            return fail(`Could not send the request: ${err.message}`, err);
        }
    }

    async function incomingRequests() {
        if (!tokens) return [];
        const docs = await fsList(`users/${tokens.uid}/requests`);
        return docs.map(d => ({ uid: d.id, displayName: d.fromName || 'Cadence listener', handle: d.fromHandle || '', photoUrl: d.fromPhoto || null, createdAt: d.createdAt || null }));
    }

    async function accept(fromUid) {
        if (!tokens || !profile) return { success: false, error: 'Sign in first' };
        try {
            const since = new Date();
            // Their list first (allowed because their request to me exists), then mine, then the request goes away
            await fsSet(`friends/${fromUid}/list/${tokens.uid}`, { since });
            await fsSet(`friends/${tokens.uid}/list/${fromUid}`, { since });
            await fsDelete(`users/${tokens.uid}/requests/${fromUid}`);
            lastError = null;
            return { success: true };
        } catch (err) {
            return fail(`Could not accept: ${err.message}`, err);
        }
    }

    async function decline(fromUid) {
        if (!tokens) return { success: false, error: 'Sign in first' };
        try {
            await fsDelete(`users/${tokens.uid}/requests/${fromUid}`);
            return { success: true };
        } catch (err) {
            return fail(`Could not decline: ${err.message}`, err);
        }
    }

    async function removeFriend(friendUid) {
        if (!tokens) return { success: false, error: 'Sign in first' };
        try {
            await fsDelete(`friends/${tokens.uid}/list/${friendUid}`);
            await fsDelete(`friends/${friendUid}/list/${tokens.uid}`);
            return { success: true };
        } catch (err) {
            return fail(`Could not remove: ${err.message}`, err);
        }
    }

    // Friends with what they're listening to right now
    async function friends() {
        if (!tokens) return { success: false, error: 'Sign in first', friends: [], requests: [] };
        try {
            const [list, requests] = await Promise.all([fsList(`friends/${tokens.uid}/list`), incomingRequests()]);
            const uids = list.map(d => d.id);
            const [users, presence] = await Promise.all([
                fsBatchGet(uids.map(u => `users/${u}`)),
                fsBatchGet(uids.map(u => `presence/${u}`))
            ]);
            const now = Date.now();
            const out = uids.map((uid, i) => {
                const p = presence[i];
                const at = p && p.at ? Date.parse(p.at) : 0;
                const online = Boolean(at && now - at < PRESENCE_ONLINE_MS);
                return {
                    ...(publicUser(users[i]) || { uid, displayName: 'Cadence listener', handle: '', photoUrl: null }),
                    online,
                    listening: online && p && p.track ? { name: p.track.name, artist: p.track.artist, art: p.track.art || null, playing: Boolean(p.playing) } : null,
                    session: online && p && p.session ? { code: p.session.code, link: p.session.link } : null
                };
            }).sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName));
            lastError = null;
            return { success: true, friends: out, requests };
        } catch (err) {
            if (err.signedOut) { emit(); return { success: false, error: 'Signed out', friends: [], requests: [] }; }
            return { ...fail(`Could not load friends: ${err.message}`, err), friends: [], requests: [] };
        }
    }

    // ------------------------------------------------------------------
    // Presence: what I'm listening to, for my friends
    // ------------------------------------------------------------------
    async function publishPresence({ track, playing, session } = {}) {
        if (!tokens || !profile) return;
        const key = JSON.stringify({ t: track ? track.id : null, p: Boolean(playing), s: session ? session.code : null });
        const now = Date.now();
        if (lastPresence && lastPresence.key === key && now - lastPresence.at < PRESENCE_MIN_GAP_MS) return;
        lastPresence = { key, at: now };
        try {
            await fsSet(`presence/${tokens.uid}`, {
                track: track ? { name: track.name, artist: track.artist, art: /^https:\/\//.test(String(track.album_art || '')) ? track.album_art : null } : null,
                playing: Boolean(playing),
                session: session ? { code: session.code, link: session.link } : null,
                app: appVersion,
                at: new Date()
            });
        } catch (err) {
            if (!err.signedOut) log.error('cloud: presence:', err.message);
        }
    }

    return {
        configured, status, onChange, restore, checkProviders,
        startSignIn, handleAuthLink, parseAuthLink, signInWithGoogleIdToken, signOut,
        updateProfile, uploadAvatar,
        lookup, sendRequest, incomingRequests, accept, decline, removeFriend, friends,
        publishPresence,
        // exposed for tests
        _fs: { get: fsGet, set: fsSet, del: fsDelete, list: fsList }
    };
}

module.exports = { createCloud, HANDLE_RE };
