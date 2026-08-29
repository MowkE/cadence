/**
 * Spotify links without the Web API. Turns a pasted link into a track URI and
 * looks up title / artists / album / art / duration from Spotify's public
 * link-preview data — the same pages chat apps read to render previews. No
 * keys, no Premium. Used for listen-along song requests.
 */

const cheerio = require('cheerio');

const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT_MS = 8000;

// Accepts "spotify:track:ID", "https://open.spotify.com/track/ID?si=…",
// ".../intl-de/track/ID", ".../embed/track/ID" — anywhere inside pasted text
function parseSpotifyLink(input) {
    const text = String(input || '').trim();
    if (!text) return null;
    let m = text.match(/spotify:(track|episode):([A-Za-z0-9]{22})/);
    if (m) return { type: m[1], id: m[2], uri: `spotify:${m[1]}:${m[2]}` };
    m = text.match(/open\.spotify\.com\/(?:intl-[A-Za-z-]+\/)?(?:embed\/)?(track|episode)\/([A-Za-z0-9]{22})/i);
    if (m) {
        const type = m[1].toLowerCase();
        return { type, id: m[2], uri: `spotify:${type}:${m[2]}` };
    }
    return null;
}

function isShortLink(input) {
    return /https?:\/\/(spotify\.link|spotify\.app\.link)\//i.test(String(input || ''));
}

// spotify.link/… short links redirect to the full track page
async function resolveShortLink(input) {
    const m = String(input || '').match(/https?:\/\/(?:spotify\.link|spotify\.app\.link)\/[A-Za-z0-9_-]+/i);
    if (!m) return null;
    try {
        const res = await fetch(m[0], {
            redirect: 'follow',
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        return parseSpotifyLink(res.url) || parseSpotifyLink(await res.text());
    } catch (e) {
        return null;
    }
}

async function fetchText(url, userAgent) {
    const res = await fetch(url, {
        headers: { 'User-Agent': userAgent, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

// Title / artists / album / art / duration for a parsed link. Three public
// sources, best first; whatever is still missing is filled by the next one.
async function resolveTrackMeta({ type, id }) {
    const meta = { name: null, artist: null, artists: [], album: '', album_art: null, duration_ms: 0 };
    const incomplete = () => !meta.name || !meta.artist || !meta.duration_ms || !meta.album_art;

    // 1. The link-preview page: Open Graph tags, server-rendered for preview bots
    try {
        const $ = cheerio.load(await fetchText(`https://open.spotify.com/${type}/${id}`, PREVIEW_UA));
        const tag = p => $(`meta[property="${p}"]`).attr('content') || $(`meta[name="${p}"]`).attr('content') || null;
        meta.name = tag('og:title') || meta.name;
        meta.album_art = tag('og:image') || meta.album_art;
        const artist = tag('music:musician_description');
        if (artist) {
            meta.artist = artist;
            meta.artists = artist.split(', ');
        }
        const seconds = Number(tag('music:duration'));
        if (seconds) meta.duration_ms = Math.round(seconds * 1000);
        // "Artist · Album · Song · 2020" for tracks, "Show · Episode" for podcasts
        const parts = String(tag('og:description') || '').split(' · ');
        if (!meta.artist && parts.length >= 2) {
            meta.artist = parts[0];
            meta.artists = [parts[0]];
        }
        if (parts.length >= 3) meta.album = parts[1];
    } catch (e) { /* next source */ }

    // 2. The embed page: structured JSON with the exact duration and every artist
    if (incomplete()) {
        try {
            const $ = cheerio.load(await fetchText(`https://open.spotify.com/embed/${type}/${id}`, BROWSER_UA));
            const data = JSON.parse($('#__NEXT_DATA__').html() || 'null');
            const entity = data && data.props && data.props.pageProps && data.props.pageProps.state
                && data.props.pageProps.state.data && data.props.pageProps.state.data.entity;
            if (entity) {
                meta.name = meta.name || entity.title || entity.name || null;
                const names = (entity.artists || []).map(a => a && a.name).filter(Boolean);
                if (names.length && !meta.artist) {
                    meta.artist = names.join(', ');
                    meta.artists = names;
                }
                if (!meta.duration_ms && entity.duration) meta.duration_ms = Number(entity.duration) || 0;
                const images = (entity.visualIdentity && entity.visualIdentity.image) || [];
                const best = images.slice().sort((a, b) => (b.maxWidth || 0) - (a.maxWidth || 0))[0];
                if (!meta.album_art && best && best.url) meta.album_art = best.url;
            }
        } catch (e) { /* next source */ }
    }

    // 3. oEmbed: title + thumbnail, the most stable of the three
    if (!meta.name || !meta.album_art) {
        try {
            const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${type}/${id}`)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            const data = await res.json();
            meta.name = meta.name || data.title || null;
            meta.album_art = meta.album_art || data.thumbnail_url || null;
        } catch (e) { /* nothing more to try */ }
    }

    if (!meta.name) return null;
    if (!meta.artist) meta.artist = type === 'episode' ? 'Podcast' : 'Unknown artist';
    if (meta.album_art) meta.album_art = meta.album_art.replace(/^http:/i, 'https:');
    return meta;
}

module.exports = { parseSpotifyLink, isShortLink, resolveShortLink, resolveTrackMeta };
