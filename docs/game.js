import { WORLD_WIDTH, OVERLAY, LYRIC_ROWS, FIXED_DT, CHAPTERS, createGame, stepGame, platformsAt, restartGame, respawnGame } from './game-model.js';
import { TRACK } from './game-track.js';
import { followCourseCamera } from './game-camera.js';

const NOTE = [
  '00000001100', '00000001110', '00000001111', '00000001101', '00000001101',
  '00000001100', '00000001100', '00000001100', '00000001100', '00011111100',
  '00111111100', '01111111100', '01111111000', '00111110000', '00011100000',
];
const CONTROLS = new Map([
  ['KeyA', 'left'], ['ArrowLeft', 'left'], ['KeyD', 'right'], ['ArrowRight', 'right'],
  ['KeyW', 'jump'], ['ArrowUp', 'jump'], ['Space', 'jump'], ['KeyS', 'down'], ['ArrowDown', 'down'],
]);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const clock = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const $ = (root, selector) => root.querySelector(selector);
const pixel = (ctx, x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(w), Math.ceil(h)); };

/** A self-contained arcade. Closing it releases input, animation and audio. */
export function initParkour({ trigger, onOpen = () => {}, onClose = () => {} } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'parkour-dialog';
  dialog.setAttribute('aria-labelledby', 'parkour-title');
  dialog.setAttribute('aria-describedby', 'parkour-instructions');
  dialog.innerHTML = `
    <div class="parkour-shell">
      <header class="parkour-top">
        <div class="parkour-brand"><span aria-hidden="true">c.</span><div><strong id="parkour-title">The high note.</strong><small>CADENCE / INSIDE THE OVERLAY</small></div></div>
        <div class="parkour-top-tools">
          <button class="parkour-tool parkour-map-button" data-action="map" aria-pressed="false" aria-label="Show the full overlay map" disabled>⊞ <span>Map</span></button>
          <button class="parkour-tool" data-action="track" aria-expanded="false" aria-label="Open the official song player">♫ <span>Song</span></button>
          <button class="parkour-tool" data-action="sound" aria-pressed="false" aria-label="Turn game effects on">FX: off</button>
          <button class="parkour-tool" data-action="pause" aria-label="Pause game" disabled>Ⅱ <span>Pause</span></button>
          <button class="parkour-tool parkour-exit" data-action="exit" aria-label="Exit game and return to the site">Exit ↗</button>
        </div>
      </header>
      <div class="parkour-status"><div class="parkour-verse"><span class="parkour-verse-index">01 / 06</span><span class="parkour-verse-name">The first light</span></div><div class="parkour-metrics"><span class="parkour-notes">♪ <b data-stat="notes">0</b></span><span class="parkour-retry-metric">FALLS <b data-stat="falls">0</b></span><span>TIME <b data-stat="time">00:00</b></span></div></div>
      <div class="parkour-arena">
        <canvas class="parkour-canvas" tabindex="0" aria-label="You are a music note inside a Cadence overlay. Start at the bottom left. Cross crumbling words, climb the record, ride moving lifts and launch from springs to the top-right finish."></canvas>
        <div class="parkour-progress" aria-hidden="true"><div class="parkour-progress-fill"></div>${[0,20,40,60,80,100].map(n => `<i style="--marker:${n}%"></i>`).join('')}</div>
        <div class="parkour-toast" aria-hidden="true"></div>
        <div class="parkour-course-hint"><span data-section-icon aria-hidden="true">↗</span><span data-section-hint>Find your footing on the player controls.</span></div>
        <div class="parkour-map-hint" hidden>THE WHOLE OVERLAY <span>M / map to return · timer paused</span></div>
        <div class="parkour-track-player" hidden></div>
        <div class="parkour-screen">
          <section class="parkour-card" data-screen="intro">
            <div class="parkour-label">A SONG YOU CAN STEP INSIDE</div>
            <h2>Play the<br><em>high note.</em></h2>
            <p class="parkour-intro-sub">Ride the beat. Outrun the disappearing words.<br>Climb the record. Launch for the last note.</p>
            <div class="parkour-track-intro"><img data-track-art alt="" width="46" height="46"><div><strong data-track-title></strong><span data-track-artist></span></div><span class="parkour-track-badge">THE SOUNDTRACK</span></div>
            <div class="parkour-pills"><span data-course-sections>6 SECTIONS</span><span>~2–3 MINUTES</span><span data-course-checkpoints>CHECKPOINTS</span></div>
            <div class="parkour-key-legend" id="parkour-instructions"><div class="parkour-wasd" aria-hidden="true"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></div><div class="parkour-key-copy"><b>A / D</b> move · <b>W</b> jump<br><b>Hold W</b> for height · <b>S</b> fall faster<br><b>M</b> see the whole overlay</div></div>
            <button class="parkour-main-button" data-action="start">Step inside <span>↗</span></button>
            <p class="parkour-smallprint">R returns to your checkpoint. Esc / P pauses.<br><span data-track-disclosure></span></p>
          </section>
          <section class="parkour-card" data-screen="pause" hidden>
            <div class="parkour-label">A BREATH BETWEEN THE NOTES</div><h2>Hold that<br><em>thought.</em></h2>
            <p>Your climb is right where you left it.<br>The timer is taking a little breather too.</p>
            <div class="parkour-card-actions"><button class="parkour-main-button" data-action="resume">Keep climbing <span>↑</span></button><button class="parkour-text-button" data-action="checkpoint">Back to checkpoint</button></div>
            <p class="parkour-smallprint"><button class="parkour-text-button" data-action="restart">Start a fresh climb</button></p>
          </section>
          <section class="parkour-card" data-screen="finish" hidden>
            <div class="parkour-label">THE LAST LINE / YOU MADE IT</div><h2>What a<br><em>high note.</em></h2>
            <p>Every word beneath your feet.<br>The whole overlay, yours.</p>
            <div class="parkour-finish-stats"><div><strong data-finish="time">00:00</strong><span>Your climb</span></div><div><strong data-finish="notes">0 / 0</strong><span>Notes found</span></div><div><strong data-finish="falls">0</strong><span>Comebacks</span></div></div>
            <div class="parkour-label" data-finish="best"></div>
            <div class="parkour-card-actions"><button class="parkour-main-button" data-action="restart">One more song <span>↻</span></button><button class="parkour-text-button" data-action="exit">Back to Cadence ↗</button></div>
            <p class="parkour-smallprint">Made of music. Moved by you.</p>
          </section>
        </div>
        <div class="sr-only" aria-live="polite" aria-atomic="true" data-live></div>
      </div>
      <div class="parkour-touch" role="group" aria-label="Touch game controls"><div><button data-control="left" aria-label="Move left">←</button><button data-control="right" aria-label="Move right">→</button></div><div><button class="parkour-touch-fall" data-control="down" aria-label="Fall faster">↓</button><button data-control="jump" aria-label="Jump. Hold to jump higher">JUMP ↑</button></div></div>
      <footer class="parkour-foot"><div class="parkour-foot-guide"><span><kbd>A</kbd><kbd>D</kbd> MOVE</span><span><kbd>W</kbd> JUMP · HOLD FOR HEIGHT</span><span><kbd>S</kbd> FALL</span><span><kbd>R</kbd> CHECKPOINT</span><span><kbd>M</kbd> MAP</span></div><span class="parkour-foot-note">BOTTOM LEFT → TOP RIGHT.</span></footer>
    </div>`;
  document.body.append(dialog);
  $(dialog, '[data-track-title]').textContent = TRACK.title;
  $(dialog, '[data-track-artist]').textContent = TRACK.artist;
  $(dialog, '[data-track-art]').src = TRACK.art;
  $(dialog, '[data-track-disclosure]').textContent = TRACK.originalWords ? 'Original parkour text · optional official song player' : 'Optional official song player';

  const canvas = $(dialog, 'canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const screen = $(dialog, '.parkour-screen');
  const pauseButton = $(dialog, '[data-action="pause"]');
  const soundButton = $(dialog, '[data-action="sound"]');
  const timeNode = $(dialog, '[data-stat="time"]');
  const notesNode = $(dialog, '[data-stat="notes"]');
  const fallsNode = $(dialog, '[data-stat="falls"]');
  const progress = $(dialog, '.parkour-progress-fill');
  const verseIndex = $(dialog, '.parkour-verse-index');
  const verseName = $(dialog, '.parkour-verse-name');
  const live = $(dialog, '[data-live]');
  const toastNode = $(dialog, '.parkour-toast');
  const mediaMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = mediaMotion.matches || document.body.classList.contains('motion-off');
  let game = createGame();
  let phase = 'intro';
  let width = 720, height = 520;
  let frame = 0, lastTime = 0, accumulator = 0;
  let camera = { x: 0, y: 0, zoom: 1 }, cameraPlatform = 0, mapView = false;
  let particles = [], toastTimer = 0, sound = false, audio = null;
  let introShown = false, focusBefore = null, destroyed = false, modalActive = false;
  let jumpPressed = false;
  let statsStamp = '';
  const taught = new Set();
  let routeSnapshot = platformsAt(game);
  const keyHeld = new Set();
  const touchHeld = new Map();
  const pressed = { left: false, right: false, jump: false, down: false };
  const observer = new ResizeObserver(resize);
  const albumArt = new Image();
  let albumReady = false;
  albumArt.onload = () => { albumReady = true; if (dialog.open) draw(); };
  albumArt.src = TRACK.art;
  const mapButton = $(dialog, '[data-action="map"]');
  const trackButton = $(dialog, '[data-action="track"]');
  const trackPlayer = $(dialog, '.parkour-track-player');
  const summit = () => game.platforms[game.platforms.length - 1];
  const currentChapter = () => clamp(game.platforms[cameraPlatform]?.chapter || 0, 0, CHAPTERS.length - 1);
  const totalNotes = () => game.totalCollectibles || game.platforms.filter(p => p.collectible).length;
  $(dialog, '[data-course-sections]').textContent = `${CHAPTERS.length} SECTIONS`;
  $(dialog, '[data-course-checkpoints]').textContent = `${game.platforms.filter(p => p.checkpoint && p.id > 0).length} CHECKPOINTS`;

  function setPhase(value) {
    phase = value;
    dialog.dataset.phase = value;
    screen.hidden = value === 'playing';
    for (const card of dialog.querySelectorAll('[data-screen]')) card.hidden = card.dataset.screen !== value;
    pauseButton.disabled = value === 'intro' || value === 'finish';
    mapButton.disabled = value !== 'playing';
    if (value !== 'playing') {
      mapView = false;
      mapButton.setAttribute('aria-pressed', 'false');
      $(dialog, '.parkour-map-hint').hidden = true;
    }
    pauseButton.innerHTML = value === 'pause' ? '▶ <span>Resume</span>' : 'Ⅱ <span>Pause</span>';
    pauseButton.setAttribute('aria-label', value === 'pause' ? 'Resume game' : 'Pause game');
  }

  function resetInput() {
    keyHeld.clear(); touchHeld.clear(); jumpPressed = false;
    for (const key of Object.keys(pressed)) pressed[key] = false;
    for (const button of dialog.querySelectorAll('[data-control]')) button.classList.remove('is-pressed');
  }

  function syncInput() {
    for (const action of Object.keys(pressed)) {
      const next = [...keyHeld].some(code => CONTROLS.get(code) === action) || [...touchHeld.values()].includes(action);
      if (action === 'jump' && next && !pressed.jump) jumpPressed = true;
      pressed[action] = next;
    }
    for (const button of dialog.querySelectorAll('[data-control]')) button.classList.toggle('is-pressed', pressed[button.dataset.control]);
  }

  function resize() {
    if (!dialog.open || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    width = Math.round(clamp(rect.width * .78, 360, 1000));
    height = Math.round(width * rect.height / rect.width);
    if (height < 300) { height = 300; width = Math.round(height * rect.width / rect.height); }
    canvas.width = width;
    canvas.height = height;
    ctx.imageSmoothingEnabled = false;
    snapCamera();
    draw();
  }

  function overviewCamera() {
    const pad = 85;
    const zoom = Math.min(width / (OVERLAY.right - OVERLAY.left + pad * 2), height / (OVERLAY.bottom - OVERLAY.top + pad * 2));
    return { zoom, x: (OVERLAY.left + OVERLAY.right) / 2 - width / zoom / 2, y: (OVERLAY.top + OVERLAY.bottom) / 2 - height / zoom / 2 };
  }

  function followCamera() {
    if (game.player.grounded && game.player.platformId != null) cameraPlatform = game.player.platformId;
    return followCourseCamera({ player: game.player, platforms: routeSnapshot,
      platformId: cameraPlatform, width, height });
  }

  function snapCamera() {
    routeSnapshot = platformsAt(game);
    Object.assign(camera, phase === 'intro' || phase === 'finish' || mapView ? overviewCamera() : followCamera());
  }

  function updateCamera(delta) {
    const target = mapView ? overviewCamera() : followCamera();
    const follow = reducedMotion ? 1 : 1 - Math.exp(-delta * (mapView ? 5.5 : 7));
    // Interpolating centres prevents an initial zoom from panning through blank space.
    const cx = camera.x + width / camera.zoom / 2;
    const cy = camera.y + height / camera.zoom / 2;
    camera.zoom += (target.zoom - camera.zoom) * follow;
    camera.x = cx + (target.x + width / target.zoom / 2 - cx) * follow - width / camera.zoom / 2;
    camera.y = cy + (target.y + height / target.zoom / 2 - cy) * follow - height / camera.zoom / 2;
  }

  function toggleMap() {
    if (phase !== 'playing') return;
    mapView = !mapView;
    resetInput(); accumulator = 0;
    mapButton.setAttribute('aria-pressed', String(mapView));
    mapButton.setAttribute('aria-label', mapView ? 'Return to your music note' : 'Show the full overlay map');
    $(dialog, '.parkour-map-hint').hidden = !mapView;
    live.textContent = mapView ? 'Full overlay map. The timer is paused. Press M to return.' : 'Back to your note.';
    canvas.focus({ preventScroll: true });
  }

  function stopTrack() {
    trackPlayer.replaceChildren(); trackPlayer.hidden = true;
    trackPlayer.classList.remove('is-minimized'); trackPlayer.inert = false;
    trackButton.setAttribute('aria-expanded', 'false');
  }

  function toggleTrack() {
    if (!trackPlayer.hidden) {
      if (trackPlayer.classList.contains('is-minimized')) { pause(); trackPlayer.classList.remove('is-minimized'); trackPlayer.inert = false; trackPlayer.querySelector('iframe').tabIndex = 0; trackButton.setAttribute('aria-expanded', 'true'); }
      else stopTrack();
      return;
    }
    if (phase === 'playing') pause();
    // A click loads the artist's official player; the game never hosts a recording.
    const iframe = document.createElement('iframe');
    iframe.src = TRACK.embedUrl;
    iframe.title = `${TRACK.title} by ${TRACK.artist} — official Spotify player`;
    iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.loading = 'lazy';
    const caption = document.createElement('p');
    caption.textContent = 'Press play, then keep climbing. Spotify controls playback; the course follows your pace.';
    const link = document.createElement('a');
    link.href = TRACK.spotifyUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open in Spotify ↗';
    const done = document.createElement('button');
    done.className = 'parkour-track-return';
    done.dataset.action = 'track-return';
    done.textContent = phase === 'intro' ? 'Start climbing ↗' : 'Keep climbing ↗';
    trackPlayer.replaceChildren(iframe, caption, link, done); trackPlayer.hidden = false;
    trackButton.setAttribute('aria-expanded', 'true');
  }

  function open() {
    if (destroyed || dialog.open) return;
    focusBefore = document.activeElement;
    dialog.showModal();
    modalActive = true;
    document.documentElement.style.setProperty('--parkour-scrollbar', `${window.innerWidth - document.documentElement.clientWidth}px`);
    document.documentElement.classList.add('parkour-open');
    reducedMotion = mediaMotion.matches || document.body.classList.contains('motion-off');
    try { onOpen(); } catch (error) { console.warn('Cadence arcade open callback:', error); }
    observer.observe(canvas);
    resetInput();
    if (!introShown) { setPhase('intro'); introShown = true; }
    else setPhase(game.finished ? 'finish' : game.time > 0 ? 'pause' : 'intro');
    resize();
    updateStats(true);
    $(dialog, `[data-screen="${phase}"] button`)?.focus({ preventScroll: true });
  }

  function close() {
    if (!modalActive) return;
    if (dialog.open) dialog.close();
    cleanupModal();
  }

  function cleanupModal() {
    if (!modalActive) return;
    modalActive = false;
    stopLoop(); resetInput(); stopTrack();
    clearTimeout(toastTimer);
    toastNode.classList.remove('is-visible');
    observer.disconnect();
    if (audio?.state === 'running') audio.suspend().catch(() => {});
    document.documentElement.classList.remove('parkour-open');
    document.documentElement.style.removeProperty('--parkour-scrollbar');
    try { onClose(); } catch (error) { console.warn('Cadence arcade close callback:', error); }
    (focusBefore?.isConnected ? focusBefore : trigger)?.focus?.({ preventScroll: true });
  }

  function start(fresh = false) {
    if (!ctx) { live.textContent = 'The game needs a browser with Canvas support.'; return; }
    if (fresh || game.finished) { restartGame(game); particles = []; cameraPlatform = 0; taught.clear(); routeSnapshot = platformsAt(game); }
    const entering = phase === 'intro' || phase === 'finish';
    resetInput(); setPhase('playing');
    trackPlayer.classList.toggle('is-minimized', !trackPlayer.hidden);
    trackPlayer.inert = !trackPlayer.hidden;
    if (!trackPlayer.hidden) { trackPlayer.querySelector('iframe').tabIndex = -1; trackButton.setAttribute('aria-expanded', 'false'); }
    if (!entering || reducedMotion) snapCamera();
    draw(); updateStats(true);
    canvas.focus({ preventScroll: true });
    if (sound && audio?.state === 'suspended') audio.resume().then(() => {
      if (!dialog.open || document.hidden || phase !== 'playing' || !sound) audio.suspend().catch(() => {});
    }).catch(() => {});
    lastTime = 0; accumulator = 0;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
    live.textContent = game.time ? 'Climb resumed.' : 'Climb started. Move with A and D. Hold W to jump higher. Climb the lyrics.';
  }

  function pause() {
    if (phase !== 'playing' || !dialog.open) return;
    stopLoop(); resetInput(); setPhase('pause');
    if (audio?.state === 'running') audio.suspend().catch(() => {});
    $(dialog, '[data-action="resume"]').focus({ preventScroll: true });
    live.textContent = 'Game paused. Your timer is stopped.';
  }

  function stopLoop() { cancelAnimationFrame(frame); frame = 0; lastTime = 0; accumulator = 0; }

  function tick(now) {
    if (!dialog.open || phase !== 'playing') return;
    const delta = lastTime ? Math.min((now - lastTime) / 1000, .075) : 0;
    lastTime = now;
    if (!mapView) accumulator += delta;
    while (accumulator >= FIXED_DT && !game.finished) {
      stepGame(game, { ...pressed, jumpPressed }, FIXED_DT);
      jumpPressed = false;
      accumulator -= FIXED_DT;
      consumeEvents();
    }
    routeSnapshot = platformsAt(game);
    updateCamera(delta);
    particles = particles.filter(p => p.life > 0);
    for (const p of particles) { p.life -= delta; p.x += p.vx * delta; p.y += p.vy * delta; p.vy += 180 * delta; }
    updateStats(); draw();
    if (game.finished) finish();
    else frame = requestAnimationFrame(tick);
  }

  function updateStats(force = false) {
    const chapter = currentChapter();
    const stamp = `${Math.floor(game.time)}:${game.collectibles}:${game.deaths}:${chapter}`;
    if (force || stamp !== statsStamp) {
      timeNode.textContent = clock(game.finished ? game.finishTime : game.time);
      notesNode.textContent = `${game.collectibles} / ${totalNotes()}`;
      fallsNode.textContent = String(game.deaths);
      verseIndex.textContent = `${String(chapter + 1).padStart(2, '0')} / ${String(CHAPTERS.length).padStart(2, '0')}`;
      verseName.textContent = CHAPTERS[chapter]?.name || `Section ${chapter + 1}`;
      $(dialog, '[data-section-hint]').textContent = CHAPTERS[chapter]?.hint || 'Follow the lit platforms to the next checkpoint.';
      $(dialog, '[data-section-icon]').textContent = ['↗', '▱', '◎', '↕', '⇈', '⚑'][chapter] || '↗';
      statsStamp = stamp;
    }
    progress.style.height = `${clamp(game.highestPlatform / (game.platforms.length - 1), 0, 1) * 100}%`;
  }

  function burst(x, y, color, count = 10) {
    if (reducedMotion) return;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i / count) + Math.random() * .3;
      particles.push({ x, y, vx: Math.cos(angle) * (35 + Math.random() * 65), vy: Math.sin(angle) * 70 - 40, life: .3 + Math.random() * .4, color });
    }
    if (particles.length > 100) particles.splice(0, particles.length - 100);
  }

  function consumeEvents() {
    for (const event of game.events) {
      if (event.type === 'jump') { burst(event.x, event.y + 2, '#9ebba6', 4); tone(230, .055, 'triangle', .028); }
      if (event.type === 'land' || event.type === 'spring') {
        cameraPlatform = event.platformId;
        const surface = game.platforms[event.platformId];
        const mechanic = surface?.spring ? 'spring' : surface?.crumble ? 'crumble' : surface?.moving ? 'lift' : null;
        if (mechanic && !taught.has(mechanic)) {
          taught.add(mechanic);
          const instruction = {spring:'SPRING / STEER YOUR LANDING WITH A + D',crumble:'CRUMBLING WORDS / KEEP MOVING',lift:'MOVING LIFT / RIDE, THEN JUMP'}[mechanic];
          toast(instruction); live.textContent = instruction;
        }
        burst(event.x, event.y, event.type === 'spring' ? '#ff9ac7' : '#9ebba6', event.type === 'spring' ? 18 : 4);
        if (event.type === 'spring') tone(540, .18, 'triangle', .045);
      }
      if (event.type === 'collect') { burst(event.x, event.y, '#d8ef58', 12); tone(660 + game.collectibles % 4 * 110, .13, 'sine', .045); }
      if (event.type === 'checkpoint') {
        const chapter = game.platforms[event.platformId]?.chapter || 0;
        toast(`${CHAPTERS[chapter]?.name.toUpperCase() || 'NEXT SECTION'} / CHECKPOINT`);
        live.textContent = `Verse ${chapter + 1}. ${CHAPTERS[chapter]?.name || ''}. Checkpoint saved.`;
        burst(event.x, event.y - 20, '#f3917b', 20); tone(440, .18, 'triangle', .045);
      }
      if (event.type === 'respawn') {
        cameraPlatform = game.player.platformId ?? game.checkpoint;
        snapCamera(); toast('BACK AT YOUR CHECKPOINT. YOU’VE GOT THIS.');
        live.textContent = 'Back at your checkpoint. Keep climbing.';
        burst(game.player.x, game.player.y - 15, '#f3917b', 10); tone(180, .13, 'triangle', .03);
      }
      if (event.type === 'finish') burst(event.x, event.y - 20, '#d8ef58', 40);
    }
  }

  function toast(text) {
    clearTimeout(toastTimer);
    toastNode.textContent = text; toastNode.classList.add('is-visible');
    toastTimer = setTimeout(() => toastNode.classList.remove('is-visible'), 2700);
  }

  function finish() {
    stopLoop(); resetInput(); stopTrack(); setPhase('finish');
    snapCamera(); draw();
    let best = null, record = false;
    try {
      const saved = Number(localStorage.getItem('cadence-high-note-parkour-best-v3'));
      best = Number.isFinite(saved) && saved > 0 ? saved : null;
      if (!best || game.finishTime < best) { best = game.finishTime; record = true; localStorage.setItem('cadence-high-note-parkour-best-v3', String(best)); }
    } catch { /* A private browser can still finish a song. */ }
    $(dialog, '[data-finish="time"]').textContent = clock(game.finishTime);
    $(dialog, '[data-finish="notes"]').textContent = `${game.collectibles} / ${totalNotes()}`;
    $(dialog, '[data-finish="falls"]').textContent = String(game.deaths);
    $(dialog, '[data-finish="best"]').textContent = best ? `${record ? 'A NEW PERSONAL BEST' : 'YOUR PERSONAL BEST'} / ${clock(best)}` : 'THE WHOLE COURSE. ALL YOURS.';
    $(dialog, '[data-screen="finish"] [data-action="restart"]').focus({ preventScroll: true });
    tone(880, .3, 'sine', .05);
    live.textContent = `You reached the high note in ${clock(game.finishTime)}. ${game.collectibles} of ${totalNotes()} notes found, with ${game.deaths} falls.`;
  }

  function tone(hz, length, type, volume) {
    if (!sound || !audio || audio.state !== 'running' || !dialog.open || document.hidden) return;
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.type = type; oscillator.frequency.value = hz;
    gain.gain.setValueAtTime(volume, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + length);
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.start(); oscillator.stop(audio.currentTime + length);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  }

  async function toggleSound() {
    sound = !sound;
    if (sound) {
      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!Audio) throw new Error('Audio unavailable');
        audio ||= new Audio();
        if (phase === 'playing') {
          await audio.resume();
          if (!dialog.open || !sound || document.hidden || phase !== 'playing') audio.suspend().catch(() => {});
          else tone(523.25, .11, 'triangle', .035);
        } else audio.suspend().catch(() => {});
      } catch { sound = false; toast('SOUND IS UNAVAILABLE IN THIS BROWSER'); }
    } else if (audio?.state === 'running') audio.suspend().catch(() => {});
    soundButton.textContent = `FX: ${sound ? 'on' : 'off'}`;
    soundButton.setAttribute('aria-pressed', String(sound));
    soundButton.setAttribute('aria-label', `Turn game effects ${sound ? 'off' : 'on'}`);
  }

  function drawNote(x, feet, color, scale = 2, facing = 1) {
    ctx.save();
    ctx.translate(Math.round(x), Math.round(feet));
    if (facing < 0) ctx.scale(-1, 1);
    for (let y = 0; y < NOTE.length; y++) for (let xx = 0; xx < NOTE[y].length; xx++) if (NOTE[y][xx] === '1') pixel(ctx, (xx - 5.5) * scale + 2, (y - 15) * scale + 2, scale, scale, '#0c191780');
    for (let y = 0; y < NOTE.length; y++) for (let xx = 0; xx < NOTE[y].length; xx++) if (NOTE[y][xx] === '1') pixel(ctx, (xx - 5.5) * scale, (y - 15) * scale, scale, scale, color);
    pixel(ctx, -1 * scale, -4 * scale, scale, scale, '#223421');
    pixel(ctx, 2 * scale, -4 * scale, scale, scale, '#223421');
    ctx.restore();
  }

  function textAt(text, x, y, size, color, align = 'left', bold = false) {
    ctx.font = `${bold ? 'bold ' : ''}${size}px monospace`;
    ctx.textAlign = align; ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  function circle(x, y, radius, color, line = 0) {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (line) { ctx.strokeStyle = color; ctx.lineWidth = line; ctx.stroke(); }
    else { ctx.fillStyle = color; ctx.fill(); }
  }

  function drawAlbum(x, y, size, circular = false) {
    ctx.save();
    if (circular) { ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.clip(); }
    if (albumReady) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(albumArt, x, y, size, size);
      ctx.imageSmoothingEnabled = false;
    } else {
      pixel(ctx, x, y, size, size, '#172718');
      textAt('LOADING ART', x + size / 2, y + size / 2, Math.max(10, size / 20), '#b8c8ae', 'center');
    }
    ctx.restore();
  }

  function drawRecord() {
    const { albumX: x, albumY: y, albumSize: size } = OVERLAY;
    const cx = x + size / 2, cy = y + size / 2, radius = size / 2;
    // A circular album sleeve, concentric vinyl grooves and the familiar three
    // transport buttons are anchored to the same world as the lyric platforms.
    circle(cx, cy, radius + 53, '#c3dfb00a');
    circle(cx, cy, radius + 37, '#c3dfb015', 13);
    circle(cx, cy, radius + 18, '#d7edc635', 4);
    drawAlbum(x, y, size, true);
    circle(cx, cy, radius, '#edffdb32', 4);
    for (let ring = radius * .59; ring <= radius - 12; ring += 13) circle(cx, cy, ring, '#fffbe355', 2);
    circle(cx, cy, 50, '#111c1299');
    circle(cx, cy, 31, '#c4d6b833', 3);
    circle(cx, cy, 9, '#e2edd6');
    const completion = Math.max(.035, game.highestPlatform / (game.platforms.length - 1));
    ctx.beginPath(); ctx.arc(cx, cy, radius + 37, -Math.PI / 2, -Math.PI / 2 + completion * Math.PI * 2);
    ctx.strokeStyle = '#d8ffc3'; ctx.lineWidth = 13; ctx.lineCap = 'round'; ctx.stroke(); ctx.lineCap = 'butt';
    for (const offset of [-180, 0, 180]) {
      circle(cx + offset, cy, 74, '#09150ee6');
      circle(cx + offset, cy, 74, '#ecf6e14a', 2);
      if (offset === 0) {
        if (phase === 'playing' && !mapView) { pixel(ctx, cx - 17, cy - 21, 12, 42, '#edf9e5'); pixel(ctx, cx + 7, cy - 21, 12, 42, '#edf9e5'); }
        else { ctx.beginPath(); ctx.moveTo(cx - 12, cy - 24); ctx.lineTo(cx + 25, cy); ctx.lineTo(cx - 12, cy + 24); ctx.closePath(); ctx.fillStyle = '#edf9e5'; ctx.fill(); }
      } else {
        const direction = Math.sign(offset), tx = cx + offset;
        pixel(ctx, tx + direction * 22, cy - 18, 5, 36, '#edf9e5');
        for (const move of [-4, 12]) {
          ctx.beginPath(); ctx.moveTo(tx - direction * move, cy - 19); ctx.lineTo(tx + direction * (18 - move), cy); ctx.lineTo(tx - direction * move, cy + 19); ctx.closePath(); ctx.fillStyle = '#edf9e5'; ctx.fill();
        }
      }
    }
    textAt(TRACK.title, cx, y + size + 125, 53, '#eef7e8', 'center', true);
    textAt(TRACK.artist, cx, y + size + 180, 27, '#aec3a5', 'center');
    textAt(TRACK.album, cx, y + size + 224, 19, '#70946b', 'center');
    textAt(`${clock(game.time)}  ─────────────  YOUR PACE`, cx, y + size + 295, 20, '#779c6e', 'center');
  }

  function drawOverlay() {
    const { left, right, top, bottom, dividerX } = OVERLAY;
    const w = right - left, h = bottom - top;
    pixel(ctx, left + 25, top + 30, w, h, '#00000044');
    const glass = ctx.createLinearGradient(left, top, right, bottom);
    glass.addColorStop(0, '#06180af0'); glass.addColorStop(.56, '#021208f7'); glass.addColorStop(1, '#020d06fa');
    ctx.fillStyle = glass; ctx.fillRect(left, top, w, h);
    pixel(ctx, left, top, w, 3, '#66ac433f');
    pixel(ctx, left, bottom - 3, w, 3, '#84ac614d');
    pixel(ctx, left, top, 3, h, '#a3c98e44');
    pixel(ctx, right - 3, top, 3, h, '#a3c98e44');
    // Window chrome matches the Remix terminal overlay, not a separate arcade tower.
    pixel(ctx, left, top, w, 100, '#14271aad');
    pixel(ctx, left, top + 100, w, 2, '#53a83c60');
    for (let n = 0; n < 3; n++) circle(left + 42 + n * 36, top + 49, 10, ['#639143', '#a5ad4d', '#4caf35'][n]);
    textAt('CADENCE  /  RETRO.SYS — TERMINAL V1.0', left + 180, top + 60, 22, '#559e40');
    const pill = (label, px, pw) => {
      ctx.fillStyle = '#283d2c'; ctx.beginPath(); ctx.roundRect(px, top + 21, pw, 59, 28); ctx.fill();
      ctx.strokeStyle = '#8ba67c59'; ctx.lineWidth = 2; ctx.stroke();
      textAt(label, px + pw / 2, top + 59, 24, '#e1ecd6', 'center');
    };
    pill('Remix', right - 370, 145); pill('Friends ↗', right - 200, 172);
    textAt(TRACK.title, left + 76, top + 213, 59, '#f3f7ee', 'left', true);
    textAt(TRACK.artist, left + 80, top + 273, 29, '#b4c5ac');
    textAt('YOUR DESKTOP. YOUR SOUND.', left + 80, top + 347, 17, '#567f4d');
    pixel(ctx, dividerX, top + 150, 3, bottom - top - 245, '#799c694a');
    textAt('NOW PLAYING  /  A CLIMB THROUGH THE WORDS', dividerX + 112, top + 202, 21, '#70a557');
    textAt(TRACK.originalWords ? 'ORIGINAL PARKOUR TEXT' : 'LYRIC COURSE', right - 75, bottom - 39, 17, '#668357', 'right');
    drawRecord();
    // The first few jumps cross actual little pieces of the player chrome.
    drawAlbum(left + 58, -615, 200);
    textAt(TRACK.title, left + 292, -541, 33, '#d2e8c4', 'left', true);
    textAt(TRACK.artist, left + 292, -499, 20, '#8ca980');
    textAt('♫  PRESS SONG FOR THE SOUNDTRACK', left + 60, -356, 17, '#618052');
    pixel(ctx, left + 60, -329, 677, 3, '#44633b');
    pixel(ctx, left + 60, -329, 677 * game.highestPlatform / (game.platforms.length - 1), 3, '#a6d76a');
    textAt('START', left + 64, 76, 25, '#d7efad', 'left', true);
    textAt('↑  FOLLOW THE WORDS', left + 207, 76, 20, '#829c70');
    // Each row reads left to right. Tiny arrows explain the alternating ascent
    // without turning the words into floating boxes or breaking the lyric sheet.
    const activeRow = game.platforms[cameraPlatform]?.row ?? -1;
    for (const row of LYRIC_ROWS) {
      const current = row.index === activeRow;
      if (current) pixel(ctx, dividerX + 28, row.y - 54, right - dividerX - 74, 82, '#77a84017');
      pixel(ctx, dividerX + 39, row.y - 48, 3, 67, current ? '#9dcd60' : '#436837');
      textAt('>', dividerX + 69, row.y - 8, 26, current ? '#b9f077' : '#547c3c', 'left', true);
      textAt(String(row.index + 1).padStart(2, '0'), dividerX + 69, row.y + 29, 10, '#3e5b35');
      textAt(row.text, dividerX + 115, row.y - 12, 25, '#27421d');
    }
    const scanStart = Math.max(top + 103, Math.floor(camera.y / 11) * 11);
    const scanEnd = Math.min(bottom, camera.y + height / camera.zoom);
    for (let y = scanStart; y < scanEnd; y += 11) pixel(ctx, left + 3, y, w - 6, 1, '#98d56607');
  }

  function draw() {
    if (!ctx || !dialog.open) return;
    const backdrop = ctx.createLinearGradient(0, 0, width, height);
    backdrop.addColorStop(0, '#315143'); backdrop.addColorStop(.45, '#203d33'); backdrop.addColorStop(1, '#142c31');
    ctx.fillStyle = backdrop; ctx.fillRect(0, 0, width, height);
    // A restrained desktop beyond the translucent terminal. It stays stationary
    // while the camera moves through one large, bounded overlay window.
    const glow = ctx.createRadialGradient(width * .17, height * .7, 0, width * .17, height * .7, width * .65);
    glow.addColorStop(0, '#bad69a31'); glow.addColorStop(1, '#355f4300'); ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
    drawOverlay();
    for (const platform of routeSnapshot) {
      if (platform.y < camera.y - 155 || platform.y > camera.y + height / camera.zoom + 160 || platform.x + platform.w < camera.x - 80 || platform.x > camera.x + width / camera.zoom + 80) continue;
      drawPlatform(platform);
    }
    const player = game.player;
    if (player.grounded) pixel(ctx, player.x - 12, player.y + 1, 24, 3, '#b6f66b24');
    drawNote(player.x, player.y, '#e8ff82', 2, Math.abs(player.vx) > 20 && player.vx < 0 ? -1 : 1);
    if (game.time < 7 && !game.finished) {
      textAt('THAT’S YOU', player.x, player.y - 49, 10, '#e8ff82', 'center');
      pixel(ctx, player.x, player.y - 41, 1, 5, '#d8ef58');
    }
    for (const p of particles) { ctx.globalAlpha = clamp(p.life * 3, 0, 1); pixel(ctx, p.x, p.y, 3, 3, p.color); }
    ctx.globalAlpha = 1; ctx.restore();
    // The minimap doubles as a simple location cue, not a second rendering loop.
    if (phase === 'playing' && !mapView && width >= 570) {
      const mw = 84, mh = 67, mx = width - mw - 20, my = 19;
      pixel(ctx, mx, my, mw, mh, '#06140de6');
      ctx.strokeStyle = '#6d8e5966'; ctx.lineWidth = 1; ctx.strokeRect(mx, my, mw, mh);
      pixel(ctx, mx + 20, my + 6, 1, mh - 12, '#63864c55');
      for (const point of game.platforms) {
        const rx = mx + (point.x + point.w / 2 - OVERLAY.left) / (OVERLAY.right - OVERLAY.left) * mw;
        const ry = my + (point.y - OVERLAY.top) / (OVERLAY.bottom - OVERLAY.top) * mh;
        pixel(ctx, rx, ry, point.checkpoint ? 3 : 2, point.checkpoint ? 2 : 1, point.checkpoint ? '#e5dc8b' : '#87ac6766');
      }
      const px = mx + (player.x - OVERLAY.left) / (OVERLAY.right - OVERLAY.left) * mw;
      const py = my + (player.y - OVERLAY.top) / (OVERLAY.bottom - OVERLAY.top) * mh;
      pixel(ctx, clamp(px, mx + 2, mx + mw - 3), clamp(py, my + 2, my + mh - 3), 3, 3, '#e8ff82');
      textAt('M / OVERLAY', mx + mw / 2, my + mh + 11, 7, '#9aa985', 'center');
    }
  }

  function drawPlatform(p) {
    const current = p.id === game.player.platformId;
    const next = p.id === Math.min(cameraPlatform + 1, game.platforms.length - 1);
    const passed = p.id <= game.highestPlatform;
    const mechanic = p.spring ? 'spring' : p.crumble ? 'crumble' : p.moving ? 'lift' : 'word';
    const color = p.finish ? '#edf9c0' : mechanic === 'spring' ? '#ffa4d0'
      : mechanic === 'crumble' ? '#efbb6d' : mechanic === 'lift' ? '#87deec'
      : current ? '#dcffad' : next ? '#c7ef89' : passed ? '#88b95c' : '#8abf59';
    const base = game.platforms[p.id];
    // A lift's complete rail is visible before boarding it.
    if (p.moving) {
      const rx = p.moving.rangeX ?? p.moving.range ?? 0;
      const ry = p.moving.rangeY ?? 0;
      ctx.save(); ctx.strokeStyle = '#87deec42'; ctx.lineWidth = 2; ctx.setLineDash([4, 7]);
      ctx.beginPath(); ctx.moveTo(base.x + p.w / 2 - rx, base.y - ry);
      ctx.lineTo(base.x + p.w / 2 + rx, base.y + ry); ctx.stroke(); ctx.restore();
      for (const sign of [-1, 1]) circle(base.x + p.w / 2 + rx * sign, base.y + ry * sign, 4, '#87deec65');
    }
    ctx.save();
    if (p.solid === false) {
      ctx.globalAlpha = .25;
      textAt(p.word || p.lyric, p.x + p.w / 2, p.y - 5, Math.min(22, (p.w - 10) / Math.max(1, (p.word || p.lyric).length * .61)), color, 'center');
      for (let x = 0; x < p.w; x += 18) pixel(ctx, p.x + x, p.y, Math.min(8, p.w - x), 1, color);
      ctx.globalAlpha = .7;
      if (p.respawnIn > 0) textAt(`BACK IN ${Math.ceil(p.respawnIn)}`, p.x + p.w / 2, p.y + 19, 8, color, 'center');
      ctx.restore(); return;
    }
    if (p.kind === 'word' && !p.spring) {
      const label = p.word || p.lyric;
      const size = Math.min(26, (p.w - 10) / Math.max(1, label.length * .61));
      textAt(label, p.x + p.w / 2, p.y - 6, size, color, 'center', current || next);
      if (p.crumble) {
        const remaining = Math.ceil(p.w * (1 - (p.crumbleProgress || 0)));
        for (let x = 0; x < p.w; x += 12) pixel(ctx, p.x + x, p.y, Math.min(9, p.w - x), 3, x < remaining ? color : '#71543855');
        if (p.crumbleProgress > 0) {
          const seconds = Math.max(0, p.crumble.delay * (1 - p.crumbleProgress));
          textAt(seconds.toFixed(1), p.x + p.w / 2, p.y + 19, 10, '#ffd08b', 'center', true);
        } else textAt('CRUMBLE', p.x + p.w / 2, p.y + 17, 7, '#c9a16a', 'center');
      } else {
        pixel(ctx, p.x, p.y, p.w, current ? 4 : 3, color);
        pixel(ctx, p.x, p.y + 3, 2, 5, `${color}66`);
        pixel(ctx, p.x + p.w - 2, p.y + 3, 2, 5, `${color}66`);
      }
    } else {
      pixel(ctx, p.x, p.y - 26, p.w, 29, '#152d21');
      pixel(ctx, p.x, p.y, p.w, 4, color);
      const label = p.spring ? 'LAUNCH' : p.lyric || 'STEP';
      textAt(label, p.x + p.w / 2, p.y - 9, Math.min(12, (p.w - 12) / (label.length * .61)), color, 'center', true);
    }
    if (p.moving) {
      textAt(p.moving.rangeY ? '↑ RIDE ↓' : '← RIDE →', p.x + p.w / 2, p.y + 19, 8, color, 'center');
      for (let x = 6; x < p.w - 5; x += 11) pixel(ctx, p.x + x, p.y + 5, 5, 5, '#87deec44');
    }
    if (p.spring) {
      for (let i = 0; i < 3; i++) {
        const y = p.y - 45 - i * 11;
        ctx.beginPath(); ctx.moveTo(p.x + p.w / 2 - 10, y + 5); ctx.lineTo(p.x + p.w / 2, y - 2); ctx.lineTo(p.x + p.w / 2 + 10, y + 5);
        ctx.strokeStyle = i === 2 ? '#ffb6da55' : color; ctx.lineWidth = 3; ctx.stroke();
      }
      for (let i = 0; i < 3; i++) pixel(ctx, p.x + 10 + i * 7, p.y + 6 + i * 5, Math.max(8, p.w - 20 - i * 14), 2, '#ff9aca88');
    }
    if (p.checkpoint && !p.finish && p.id > 0) {
      const saved = game.checkpoint >= p.id;
      pixel(ctx, p.x - 12, p.y - 37, 2, 36, saved ? '#edcf7d' : '#9dbb76');
      pixel(ctx, p.x - 10, p.y - 37, 12, 7, saved ? '#edcf7d' : '#9dbb76');
      textAt(saved ? 'SAVED' : 'CHECKPOINT', p.x + 7, p.y - 49, 8, saved ? '#dbc47e' : '#aec48e');
    }
    if (next && phase === 'playing' && !mapView && !p.checkpoint && !p.finish) {
      textAt('▼', p.x + p.w / 2, p.y - (p.spring ? 89 : 56), 10, color, 'center');
    }
    if (p.collectible && !game.collectedIds.has(p.id)) {
      const x = p.x + p.w / 2, y = p.y - 38;
      const bob = reducedMotion || phase !== 'playing' || mapView ? 0 : Math.sin(game.time * 3 + p.id) * 2;
      drawNote(x, y + 6 + bob, '#f1d575', .7);
    }
    if (p.finish) {
      const x = p.x + p.w - 27, y = p.y;
      pixel(ctx, x, y - 144, 5, 144, '#d8edac');
      for (let row = 0; row < 4; row++) for (let col = 0; col < 6; col++) pixel(ctx, x + 5 + col * 10, y - 144 + row * 10, 10, 10, (col + row) % 2 ? '#16301a' : '#dfedbc');
      textAt('THE HIGH NOTE', x - 16, y - 163, 15, '#d8edac', 'right', true);
      textAt('FINISH ↗', p.x + p.w / 2, p.y + 35, 17, '#d8edac', 'center');
    }
    ctx.restore();
  }

  function checkpoint() {
    if (phase !== 'playing' && phase !== 'pause') return;
    game.events = [];
    respawnGame(game); consumeEvents(); snapCamera(); updateStats(true); draw();
    if (phase === 'pause') start();
  }

  function keydown(event) {
    if (!dialog.open) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.code === 'KeyP' || event.code === 'Escape') && !event.repeat) {
      event.preventDefault();
      if (phase === 'playing') pause(); else if (phase === 'pause') start(); else if (event.code === 'Escape') close();
      return;
    }
    if (phase !== 'playing') return;
    if (event.target.closest('button, input, textarea, select, a')) return;
    if (event.code === 'KeyM') { event.preventDefault(); if (!event.repeat) toggleMap(); return; }
    if (mapView) return;
    if (event.code === 'KeyR') { event.preventDefault(); if (!event.repeat) checkpoint(); return; }
    if (!CONTROLS.has(event.code)) return;
    event.preventDefault(); keyHeld.add(event.code); syncInput();
  }
  function keyup(event) { if (CONTROLS.has(event.code)) { if (keyHeld.has(event.code) && dialog.open && phase === 'playing') event.preventDefault(); keyHeld.delete(event.code); syncInput(); } }
  function click(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'exit') close();
    if (action === 'map') toggleMap();
    if (action === 'track') toggleTrack();
    if (action === 'track-return') start();
    if (action === 'start' || action === 'resume') start();
    if (action === 'restart') start(true);
    if (action === 'checkpoint') checkpoint();
    if (action === 'pause') { if (phase === 'playing') pause(); else if (phase === 'pause') start(); }
    if (action === 'sound') {
      toggleSound();
      if (phase === 'playing' && event.detail > 0) canvas.focus({ preventScroll: true });
    }
  }
  function pointerdown(event) {
    const button = event.target.closest('[data-control]');
    if (!button || phase !== 'playing' || mapView) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId); touchHeld.set(event.pointerId, button.dataset.control); syncInput();
  }
  function pointerup(event) { if (touchHeld.delete(event.pointerId)) { event.preventDefault(); syncInput(); } }
  function cancel(event) { event.preventDefault(); if (phase === 'playing') pause(); else if (phase === 'pause') start(); else close(); }
  function visibility() { if (document.hidden) { stopTrack(); pause(); if (audio?.state === 'running') audio.suspend().catch(() => {}); } }
  function motionChanged(event) { reducedMotion = event.matches || document.body.classList.contains('motion-off'); if (reducedMotion) particles = []; if (dialog.open) { snapCamera(); draw(); } }
  function blur() {
    // Cross-origin player focus also blurs the parent window. Its own controls
    // must remain usable; hidden tabs are handled separately by visibility().
    resetInput();
    setTimeout(() => {
      if (!dialog.open || trackPlayer.contains(document.activeElement)) return;
      pause(); stopTrack();
      if (audio?.state === 'running') audio.suspend().catch(() => {});
    }, 0);
  }
  function externalClose() { if (!dialog.open) cleanupModal(); }

  trigger?.addEventListener('click', open);
  dialog.addEventListener('click', click);
  dialog.addEventListener('keydown', keydown);
  dialog.addEventListener('keyup', keyup);
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', externalClose);
  dialog.addEventListener('pointerdown', pointerdown);
  dialog.addEventListener('pointerup', pointerup);
  dialog.addEventListener('pointercancel', pointerup);
  dialog.addEventListener('lostpointercapture', pointerup);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', blur);
  mediaMotion.addEventListener('change', motionChanged);

  function destroy() {
    close(); destroyed = true;
    trigger?.removeEventListener('click', open);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('blur', blur);
    mediaMotion.removeEventListener('change', motionChanged);
    observer.disconnect();
    albumArt.onload = null;
    if (audio) audio.close().catch(() => {});
    dialog.remove();
  }

  return { open, close, destroy };
}
