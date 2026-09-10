const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const lerp = (from, to, progress) => from + (to - from) * progress;
const SOCIAL_CHAPTERS = ['chat', 'timeline', 'recap'];

/** Enhance the two previews without changing their readable, no-JavaScript layout. */
export function initScrollExamples({ motion, onWorld = () => {}, onSocial = () => {} } = {}) {
  const reduced = motion || matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = matchMedia('(min-width: 900px) and (min-height: 740px)');
  const sections = [];
  const cleanups = [];
  let frame = 0;
  let scrollChanged = false;
  let destroyed = false;

  function prepare(id, labels, callback) {
    const section = document.getElementById(id);
    if (!section) return null;
    const originalNodes = [...section.childNodes];
    const inner = document.createElement('div');
    inner.className = 'example-inner';
    originalNodes.forEach(node => inner.append(node));
    // Keep the editorial introduction and feature details readable without
    // spending the pinned viewport on duplicate headings and footers.
    const intro = document.createElement('div');
    intro.className = 'example-intro';
    const outro = document.createElement('div');
    outro.className = 'example-outro';
    const track = document.createElement('div');
    track.className = 'example-track';
    const heading = inner.querySelector('.section-heading');
    if (heading) intro.append(heading);
    if (id === 'remix') {
      const editorial = inner.querySelector('.remix-heading');
      if (editorial) intro.append(editorial);
    }
    const details = inner.querySelector(id === 'remix' ? '.remix-footer' : '.together-bottom');
    if (details) outro.append(details);
    track.append(inner);
    section.append(intro, track, outro);
    section.classList.add('example-scroll');
    section.style.setProperty('--example-chapter-count', String(labels.length));
    const rail = document.createElement('div');
    rail.className = 'example-scroll-rail';
    // The descriptive controls already announce their selected states. This is decorative.
    rail.setAttribute('aria-hidden', 'true');
    const hint = document.createElement('span');
    hint.className = 'example-scroll-hint';
    const ticks = document.createElement('div');
    ticks.className = 'example-scroll-ticks';
    const bars = labels.map(() => {
      const tick = document.createElement('i');
      const fill = document.createElement('b');
      tick.append(fill);
      ticks.append(tick);
      return fill;
    });
    const caption = document.createElement('span');
    caption.className = 'example-scroll-caption';
    rail.append(hint, ticks, caption);
    inner.append(rail);
    const state = { section, inner, track, originalNodes, rail, hint, bars, caption, labels, callback, active: 0,
      manual: null, pinned: false, progress: 0, local: .8 };
    sections.push(state);
    return state;
  }

  const worldSelector = document.getElementById('remix')?.querySelector('.world-selector');
  const worldButtons = worldSelector ? [...worldSelector.querySelectorAll('[data-world]')] : [];
  const worldLabels = worldButtons.map((button, index) =>
    (button.querySelector('b')?.textContent.trim() || `World ${index + 1}`).toUpperCase());
  const remix = worldLabels.length ? prepare('remix', worldLabels, onWorld) : null;
  const together = prepare('together', ['A SONG FOR YOU', 'THE LITTLE THINGS', 'YOUR MONTH, IN MUSIC'], index => onSocial(SOCIAL_CHAPTERS[index]));
  const words = [];
  const lyric = remix?.section.querySelector('.world-lyric p');
  if (lyric) {
    // Preserve the existing emphasis, text, and natural reading order.
    const walker = document.createTreeWalker(lyric, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      const fragment = document.createDocumentFragment();
      (node.textContent.match(/\s+|\S+/g) || []).forEach(text => {
        if (/^\s+$/.test(text)) fragment.append(document.createTextNode(text));
        else {
          const word = document.createElement('span');
          word.className = 'example-lyric-word';
          word.textContent = text;
          words.push(word);
          fragment.append(word);
        }
      });
      node.replaceWith(fragment);
    });
  }

  const revealSelectors = [
    '.chat-date, .chat-bubble, .song-postcard, .reaction-row, #demo-chat',
    '.timeline-title, .friend-timeline li',
    '.mini-recap > span, .mini-recap h3, .mini-recap > p, .recap-columns, .mini-recap-footer'
  ];
  const chapterItems = SOCIAL_CHAPTERS.map((key, index) => together
    ? [...together.section.querySelector(`[data-social-view="${key}"]`).querySelectorAll(revealSelectors[index])] : []);
  const revealItems = chapterItems.flat();
  revealItems.forEach(el => el.classList.add('example-chat-piece'));
  const image = remix?.section.querySelector('#world-image');
  let previousImage, fade;
  if (image) {
    previousImage = document.createElement('img');
    previousImage.className = 'example-previous-world';
    previousImage.alt = '';
    previousImage.setAttribute('aria-hidden', 'true');
    image.after(previousImage);
    // Keep the old artwork over the next decoded image for a real crossfade.
    const observer = new MutationObserver(records => {
      const changed = records.find(record => record.attributeName === 'src');
      if (!changed || !changed.oldValue || changed.oldValue === image.getAttribute('src')) return;
      fade?.cancel();
      if (reduced.matches || typeof previousImage.animate !== 'function') {
        previousImage.style.opacity = '0';
        return;
      }
      previousImage.src = changed.oldValue;
      fade = previousImage.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 800, easing: 'cubic-bezier(.2,.65,.3,1)' });
    });
    observer.observe(image, { attributes: true, attributeFilter: ['src'], attributeOldValue: true });
    cleanups.push(() => observer.disconnect());
  }

  function paint(state, progress, local = state.local) {
    state.progress = progress;
    state.local = local;
    state.section.dataset.exampleChapter = String(state.active);
    state.section.style.setProperty('--example-progress', progress.toFixed(4));
    state.section.style.setProperty('--example-local-progress', local.toFixed(4));
    const caption = `${String(state.active + 1).padStart(2, '0')} / ${String(state.labels.length).padStart(2, '0')}  ·  ${state.labels[state.active]}`;
    if (state.caption.textContent !== caption) state.caption.textContent = caption;
    state.bars.forEach((bar, index) => {
      const amount = reduced.matches || state.manual ? (index <= state.active ? 1 : 0) : clamp(progress * state.labels.length - index);
      bar.style.transform = `scaleX(${amount})`;
      bar.parentElement.classList.toggle('is-current', index === state.active);
    });
    // Every chapter has its own entrance, generous readable middle, and exit.
    // These phases repeat for every world/card instead of spending all motion
    // on the first example and leaving the rest as a static scroll delay.
    const still = reduced.matches || state.manual;
    const enter = still ? 1 : ease(local / .26);
    const leave = still ? 0 : ease((local - .86) / .14);
    if (state === remix) {
      const drift = ease(local);
      state.section.style.setProperty('--example-image-scale', String(reduced.matches ? 1 : 1.095 - enter * .065 + drift * .018 + leave * .015));
      state.section.style.setProperty('--example-image-drift', `${reduced.matches ? 0 : lerp(16, -15, drift)}px`);
      state.section.style.setProperty('--example-lyric-rise', `${reduced.matches ? 0 : (1 - enter) * 24 - leave * 12}px`);
      words.forEach((word, index) => {
        const amount = still ? 1 : ease((local - .02 - index * .028) / .19);
        word.style.opacity = String(lerp(.3, 1, amount) * (1 - leave * .15));
        word.style.transform = `translateY(${lerp(18, 0, amount)}px)`;
      });
    } else {
      const tilt = [2.2, -1.6, .8][state.active];
      state.section.style.setProperty('--example-card-tilt', `${reduced.matches ? 0 : tilt * (1 - enter * .75) - leave * .8}deg`);
      state.section.style.setProperty('--example-card-rise', `${reduced.matches ? 0 : (1 - enter) * 32 - leave * 16}px`);
      state.section.style.setProperty('--example-note-tilt', `${reduced.matches ? -7 : -9 + enter * 3 + leave * 2}deg`);
      chapterItems.forEach((items, chapter) => items.forEach((item, index) => {
        const amount = still || state.active !== chapter ? 1 : ease((local - .025 - index * .036) / .19);
        item.style.opacity = String(lerp(.2, 1, amount) * (state.active === chapter ? 1 - leave * .1 : 1));
        item.style.transform = `translateY(${lerp(18 + index * 2, 0, amount)}px) scale(${lerp(.982, 1, amount)})`;
      }));
    }
  }

  function revealWorldButton(index) {
    const button = worldButtons[index];
    if (!worldSelector || !button || worldSelector.scrollWidth <= worldSelector.clientWidth) return;
    const rail = worldSelector.getBoundingClientRect();
    const item = button.getBoundingClientRect();
    const inset = 5;
    const delta = item.left < rail.left + inset ? item.left - rail.left - inset
      : item.right > rail.right - inset ? item.right - rail.right + inset : 0;
    if (Math.abs(delta) < 1) return;
    // scrollIntoView can also move the document and interrupt the pinned story.
    // Move just this strip, leaving the chapter and its reading position alone.
    worldSelector.scrollTo({
      left: clamp(worldSelector.scrollLeft + delta, 0, worldSelector.scrollWidth - worldSelector.clientWidth),
      behavior: reduced.matches ? 'instant' : 'smooth'
    });
  }

  function change(state, index) {
    if (state.active === index) return;
    state.active = index;
    if (state === remix) revealWorldButton(index);
    state.callback(index);
  }

  function setMode() {
    sections.forEach(state => {
      state.pinned = desktop.matches && !reduced.matches;
      state.section.classList.toggle('example-scroll--pinned', state.pinned);
      state.section.classList.toggle('example-scroll--still', reduced.matches);
      state.hint.textContent = reduced.matches ? 'CHOOSE A PREVIEW ABOVE' : state.pinned ? 'KEEP SCROLLING TO EXPLORE ↓' : 'SCROLL OR CHOOSE A PREVIEW ↑';
      // A resize must not carry a now-invalid scroll destination into the new layout.
      if (state.manual) state.manual.target = null;
      paint(state, state.progress);
    });
    if (reduced.matches) fade?.cancel();
    if (remix) revealWorldButton(remix.active);
    queue();
  }

  function update() {
    frame = 0;
    if (destroyed || document.hidden) return;
    const moved = scrollChanged;
    scrollChanged = false;
    const height = window.innerHeight;
    const y = window.scrollY;
    sections.forEach(state => {
      const rect = state.section.getBoundingClientRect();
      if (reduced.matches || rect.bottom <= 0 || rect.top >= height) return;
      let progress;
      if (state.pinned) {
        const trackRect = state.track.getBoundingClientRect();
        progress = clamp(-trackRect.top / Math.max(1, state.track.offsetHeight - height));
      } else {
        // No oversized scroll containers on phones: follow the preview itself.
        const preview = state.section.querySelector(state === remix ? '.world-stage' : '.social-stage').getBoundingClientRect();
        progress = clamp((height * .9 - preview.top) / Math.max(1, preview.height + height * .55));
      }
      const manual = state.manual;
      if (manual && moved) {
        if (manual.target !== null) {
          if (Math.abs(y - manual.target) < 4 || performance.now() - manual.at > 1600) state.manual = null;
        } else if (Math.abs(y - manual.y) > Math.max(90, height * .2)) state.manual = null;
      }
      // Keyboard/visual-viewport scrolls must never dismiss a composer while someone is typing.
      const focused = document.activeElement;
      const editing = state === together && focused && state.section.contains(focused)
        && (focused.matches('input, textarea') || focused.isContentEditable);
      // Resize/refresh can animate geometry, but only scrolling changes the chosen example.
      if (!state.manual && moved && !editing) change(state, Math.min(state.labels.length - 1, Math.floor(progress * state.labels.length)));
      const local = state.manual ? .6 : clamp(progress * state.labels.length - state.active);
      paint(state, progress, local);
    });
  }

  function queue() { if (!destroyed && !frame) frame = requestAnimationFrame(update); }
  function onScroll() { scrollChanged = true; queue(); }
  function onResize() { setMode(); }
  function onVisibility() { if (document.hidden && frame) { cancelAnimationFrame(frame); frame = 0; } else if (!document.hidden) queue(); }
  function select(state, index) {
    if (!state || destroyed || !Number.isInteger(index) || index < 0 || index >= state.labels.length) return;
    if (state === remix && state.active === index) revealWorldButton(index);
    change(state, index);
    const y = window.scrollY;
    state.manual = { y, target: null, at: performance.now() };
    if (state.pinned) {
      const start = state.track.getBoundingClientRect().top + y;
      const distance = Math.max(1, state.track.offsetHeight - window.innerHeight);
      // Land well inside the chosen chapter so tiny scrolls do not flip it back.
      state.manual.target = start + distance * (index + .58) / state.labels.length;
      window.scrollTo({ top: state.manual.target, behavior: 'smooth' });
    }
    paint(state, (index + .58) / state.labels.length, .6);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  reduced.addEventListener('change', setMode);
  desktop.addEventListener('change', setMode);
  setMode();
  return {
    selectWorld(index) { select(remix, index); },
    selectSocial(key) { select(together, SOCIAL_CHAPTERS.indexOf(key)); },
    refresh: setMode,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(frame);
      fade?.cancel();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', setMode);
      desktop.removeEventListener('change', setMode);
      cleanups.forEach(cleanup => cleanup());
      previousImage?.remove();
      words.forEach(word => word.replaceWith(document.createTextNode(word.textContent)));
      revealItems.forEach(item => { item.classList.remove('example-chat-piece'); item.style.removeProperty('opacity'); item.style.removeProperty('transform'); });
      sections.forEach(state => {
        state.rail.remove();
        state.section.replaceChildren(...state.originalNodes);
        state.section.classList.remove('example-scroll', 'example-scroll--pinned', 'example-scroll--still');
        delete state.section.dataset.exampleChapter;
        ['--example-chapter-count', '--example-progress', '--example-local-progress', '--example-image-scale', '--example-image-drift', '--example-lyric-rise', '--example-card-tilt', '--example-card-rise', '--example-note-tilt'].forEach(name => state.section.style.removeProperty(name));
      });
    }
  };
}
