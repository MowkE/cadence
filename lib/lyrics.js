/**
 * Synced lyrics from LRCLIB (free, no auth). Returns the same shape the
 * renderer has always consumed:
 *   { success, synced, syncType, lines: [{ text, startTimeMs }], source }
 */

const LRCLIB_GET = 'https://lrclib.net/api/get';
const LRCLIB_SEARCH = 'https://lrclib.net/api/search';
const USER_AGENT = 'Cadence/2.1 (https://github.com/MowkE/cadence)';
const TIMEOUT_MS = 10000;

function parseLrc(lrcText) {
    const lines = [];
    for (const raw of String(lrcText).split(/\r?\n/)) {
        // [mm:ss.xx] or [mm:ss.xxx] — a line may carry several timestamps
        const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
        if (!stamps.length) continue;
        const text = raw.replace(/\[[^\]]*\]/g, '').trim();
        if (!text) continue;
        for (const m of stamps) {
            const frac = m[3] || '0';
            const ms = frac.length === 1 ? Number(frac) * 100
                : frac.length === 2 ? Number(frac) * 10
                : Number(frac);
            lines.push({
                startTimeMs: Number(m[1]) * 60000 + Number(m[2]) * 1000 + ms,
                text
            });
        }
    }
    lines.sort((a, b) => a.startTimeMs - b.startTimeMs);
    return lines;
}

async function lrclibFetch(url, params) {
    const qs = new URLSearchParams(params).toString();
    const response = await fetch(`${url}?${qs}`, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    return response;
}

function toResult(data) {
    if (data && data.syncedLyrics) {
        const lines = parseLrc(data.syncedLyrics);
        if (lines.length) {
            return { success: true, synced: true, syncType: 'LINE_SYNCED', lines, source: 'lrclib' };
        }
    }
    if (data && data.plainLyrics) {
        const lines = String(data.plainLyrics).split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .map(text => ({ text, startTimeMs: null }));
        if (lines.length) {
            return { success: true, synced: false, syncType: 'UNSYNCED', lines, source: 'lrclib' };
        }
    }
    return null;
}

async function getSyncedLyrics({ trackName, artistName, albumName, durationMs }) {
    const durationSeconds = Math.round((Number(durationMs) || 0) / 1000);
    try {
        // 1. Exact match with album (LRCLIB needs a real duration for /get)
        let response = durationSeconds > 0
            ? await lrclibFetch(LRCLIB_GET, {
                track_name: trackName,
                artist_name: artistName,
                album_name: albumName || '',
                duration: String(durationSeconds)
            })
            : { ok: false, status: 404 };

        // 2. Exact match without album
        if (response.status === 404 && durationSeconds > 0) {
            response = await lrclibFetch(LRCLIB_GET, {
                track_name: trackName,
                artist_name: artistName,
                duration: String(durationSeconds)
            });
        }

        if (response.ok) {
            const result = toResult(await response.json());
            if (result) return result;
        } else if (response.status >= 500 || response.status === 429) {
            return { success: false, error: `LRCLIB returned status ${response.status}`, lines: [] };
        }
        // 400/404: no exact match (or unusable params) — fall through to search

        // 3. Fuzzy search, prefer a synced hit with a matching duration
        const search = await lrclibFetch(LRCLIB_SEARCH, {
            track_name: trackName,
            artist_name: artistName
        });
        if (search.ok) {
            const hits = await search.json();
            if (Array.isArray(hits) && hits.length) {
                const close = h => !durationSeconds || Math.abs((h.duration || 0) - durationSeconds) <= 5;
                const pick = hits.find(h => h.syncedLyrics && close(h))
                    || hits.find(h => h.syncedLyrics)
                    || hits.find(h => h.plainLyrics && close(h))
                    || hits.find(h => h.plainLyrics);
                const result = pick && toResult(pick);
                if (result) return result;
            }
        }

        return { success: false, error: 'No lyrics found on LRCLIB', lines: [] };
    } catch (err) {
        const message = err.name === 'TimeoutError' ? 'LRCLIB request timed out' : `LRCLIB request failed: ${err.message}`;
        return { success: false, error: message, lines: [] };
    }
}

module.exports = { getSyncedLyrics, parseLrc };
