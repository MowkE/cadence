/**
 * Updates.
 *
 *   Windows  electron-updater against GitHub Releases: downloads quietly,
 *            installs the next time Cadence is opened (or on "Restart now").
 *   macOS    Apple only lets signed apps self-update, so we check the latest
 *            GitHub release and offer the right DMG with one click.
 *
 * Checks 15s after launch and every 6 hours after that.
 */

const REPO = 'MowkE/cadence';
const FIRST_CHECK_MS = 15000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function parseVersion(v) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(candidate, current) {
    const a = parseVersion(candidate), b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

function createUpdater({ app, shell, version, onStatus, log = console }) {
    const platform = process.platform;
    const auto = platform === 'win32' && app.isPackaged; // silent updates only where they can work unsigned
    let state = {
        mode: auto ? 'auto' : 'manual',
        current: version,
        checking: false,
        available: null,      // { version, url, notes, publishedAt }
        downloaded: false,
        progress: 0,
        error: null,
        checkedAt: null
    };
    let autoUpdater = null;
    let timer = null;

    function set(patch) {
        state = { ...state, ...patch };
        try { onStatus && onStatus(state); } catch (e) { log.error('updater listener error:', e); }
    }

    // ---- Windows: electron-updater ------------------------------------
    function setupAuto() {
        try {
            ({ autoUpdater } = require('electron-updater'));
        } catch (err) {
            log.error('updater: electron-updater unavailable:', err.message);
            state.mode = 'manual';
            return;
        }
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.logger = null;
        autoUpdater.on('checking-for-update', () => set({ checking: true, error: null }));
        autoUpdater.on('update-available', info => set({ checking: false, available: { version: info.version, url: null, notes: '', publishedAt: info.releaseDate || null } }));
        autoUpdater.on('update-not-available', () => set({ checking: false, available: null, downloaded: false, checkedAt: Date.now() }));
        autoUpdater.on('download-progress', p => set({ progress: Math.round(p.percent || 0) }));
        autoUpdater.on('update-downloaded', info => set({ downloaded: true, progress: 100, available: { version: info.version, url: null, notes: '', publishedAt: info.releaseDate || null } }));
        autoUpdater.on('error', err => set({ checking: false, error: String(err && err.message || err).slice(0, 160) }));
    }

    // ---- macOS / dev: GitHub release check ------------------------------
    async function checkManual() {
        set({ checking: true, error: null });
        try {
            const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
                headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': `Cadence/${version}` },
                signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
            const rel = await res.json();
            const latest = String(rel.tag_name || '').replace(/^v/, '');
            if (!isNewer(latest, version)) {
                set({ checking: false, available: null, checkedAt: Date.now() });
                return state;
            }
            const want = platform === 'darwin'
                ? (process.arch === 'arm64' ? 'Cadence-mac-arm64.dmg' : 'Cadence-mac-x64.dmg')
                : 'Cadence-win-x64-Setup.exe';
            const asset = (rel.assets || []).find(a => a.name === want);
            set({
                checking: false, checkedAt: Date.now(),
                available: { version: latest, url: asset ? asset.browser_download_url : rel.html_url, notes: String(rel.body || '').slice(0, 2000), publishedAt: rel.published_at || null }
            });
        } catch (err) {
            set({ checking: false, error: `Update check failed: ${err.message}` });
        }
        return state;
    }

    async function check() {
        if (state.mode === 'auto' && autoUpdater) {
            try { await autoUpdater.checkForUpdates(); } catch (err) { set({ checking: false, error: String(err.message || err).slice(0, 160) }); }
            return state;
        }
        return checkManual();
    }

    // "Restart to update" (Windows, downloaded) or "Download" (Mac)
    function install() {
        if (state.mode === 'auto' && autoUpdater && state.downloaded) {
            setImmediate(() => autoUpdater.quitAndInstall(false, true));
            return { success: true, restarting: true };
        }
        if (state.available && state.available.url) {
            shell.openExternal(state.available.url);
            return { success: true, opened: state.available.url };
        }
        return { success: false, error: 'No update to install' };
    }

    function start() {
        if (state.mode === 'auto') setupAuto();
        timer = setTimeout(() => { check(); setInterval(check, CHECK_EVERY_MS); }, FIRST_CHECK_MS);
    }

    return { start, check, install, status: () => state, isNewer };
}

module.exports = { createUpdater, isNewer };
