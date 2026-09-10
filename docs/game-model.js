// The Cadence overlay is a deterministic, DOM-free platformer. Coordinates use a
// positive-down Y axis: player.x is its centre and player.y is its feet.
export const WORLD_WIDTH = 3800;
// Shared by the renderer and course: the album/player lives left of the lyric
// divider; the route visits controls, words, the record and equalizer bars.
export const OVERLAY = Object.freeze({
  left: 50, right: 3700, top: -2950, bottom: 150,
  dividerX: 920, albumX: 170, albumY: -1900, albumSize: 650,
});
export const PLAYER_WIDTH = 22;
export const PLAYER_HEIGHT = 30;
export const FIXED_DT = 1 / 120;
export const PHYSICS = Object.freeze({
  runSpeed: 245,
  groundAcceleration: 1700,
  airAcceleration: 1200,
  friction: 1900,
  jumpSpeed: 620,
  gravity: 1300,
  maxFallSpeed: 880,
  coyoteTime: 0.115,
  jumpBuffer: 0.14,
  shortJumpSpeed: 315,
});

export const CHAPTERS = Object.freeze([
  { name: 'Sound check', color: '#a9e4b0', hint: 'Find your feet. Hold jump for height; tap for a short hop.' },
  { name: 'Vanishing verse', color: '#f8bc70', hint: 'Amber words fall away. Keep moving; solid words are safe.' },
  { name: 'The vinyl climb', color: '#baafff', hint: 'Circle the record. Short hops and direction changes beat speed.' },
  { name: 'Equalizer express', color: '#86d9ee', hint: 'Ride the blue bars. Wait for a lift, then jump with it.' },
  { name: 'Drop the beat', color: '#ff97bc', hint: 'Pink pads launch you. Steer in the air and aim for the landing.' },
  { name: 'Encore', color: '#f3dc82', hint: 'Small words, big gaps. Use the full ledge before the final leap.' },
]);

// Original words, independent from the featured track. Decorative lyric rows
// belong to the overlay; the actual route is hand-authored instead of repeating
// the same row/turn pattern throughout the whole game.
export const COURSE_LINES = Object.freeze([
  'Wake the city let the sunlight find our feet',
  'Turn the little moments into reasons we can dance',
  'Every open window throws a rhythm to the street',
  'We are chasing colors while the whole world spins',
  'Keep your head up let the bassline carry you',
  'All the heavy days become a lighter shade here',
  'A hundred tiny sparks are making this night shine',
  'Catch another heartbeat send it dancing through the room',
  'When the chorus finds us we are already flying',
  'Let your golden laughter leave an echo everywhere tonight',
  'Now the skyline moves like music underneath our shoes',
  'Take this shining feeling keep it close all year',
  'One more leap together there is daylight up ahead',
]);

export const LYRIC_ROWS = Object.freeze(COURSE_LINES.map((text, index) => Object.freeze({
  index, y: -270 - index * 190, direction: 1, text,
  platformIds: Object.freeze([]),
  words: Object.freeze(text.split(' ').map((word, column) => Object.freeze({
    word, x: 1040 + column * 277, y: -270 - index * 190,
    w: Math.max(90, word.length * 16 + 20), id: null,
  }))),
})));

function buildCourse() {
  const platforms = [];
  const addSection = (chapter, entries) => entries.forEach(([cx, y, w, lyric, extra = {}], index) => {
    platforms.push({
      id: platforms.length, x: cx - w / 2, y, w, lyric,
      row: -1, kind: chapter === 0 ? 'control' : 'word', role: 'route',
      chapter, checkpoint: index === 0, finish: false,
      collectible: index > 0 && index % 4 === 0,
      moving: null, crumble: null, spring: null,
      ...extra,
    });
  });
  const crumble = { delay: 0.82, restore: 3.2 };
  const lift = (rangeY, phase, rangeX = 0, speed = 1.05) => ({ rangeX, rangeY, speed, phase });

  // Broad control buttons establish running jumps, short hops, drops and an
  // optional pause on a long word before the first timed section.
  addSection(0, [
    [180, 0, 220, 'START'], [440, -65, 165, 'SHUFFLE'],
    [675, -145, 145, 'PLAY'], [920, -115, 210, 'REPEAT'],
    [1210, -205, 170, 'WAKE'], [1490, -180, 200, 'the city'],
    [1790, -265, 180, 'FEEL'], [2010, -215, 110, 'the'],
    [2250, -290, 180, 'sunlight'], [2560, -250, 235, 'MOVE'],
    [2840, -330, 165, 'your'], [3080, -285, 145, 'FEET'],
    [3370, -385, 210, 'KEEP GOING'],
  ]);

  // A timed run with changing widths and small drops. Longer solid islands
  // provide breathing room; the narrow amber words vanish after contact.
  addSection(1, [
    [3510, -495, 180, 'DON’T STOP'],
    [3300, -525, 90, 'let', { crumble }],
    [3105, -575, 105, 'the', { crumble }],
    [2910, -535, 90, 'night', { crumble }],
    [2710, -590, 110, 'RUN', { crumble }],
    [2470, -615, 210, 'BREATHE'],
    [2225, -665, 80, 'one', { crumble }],
    [2040, -630, 90, 'more', { crumble }],
    [1835, -690, 120, 'STEP', { crumble }],
    [1630, -645, 95, 'and', { crumble }],
    [1415, -700, 160, 'another'],
    [1170, -745, 145, 'FEEL IT', { crumble }],
    [960, -800, 170, 'HOLD ON'],
  ]);

  // Leave the lyric pane and climb the record itself. Compact reversals and
  // asymmetric ledges require measured taps instead of another long straight.
  addSection(2, [
    [750, -885, 180, 'SIDE A'], [525, -965, 140, 'needle'],
    [300, -1045, 145, 'DOWN'], [165, -1155, 130, 'spin'],
    [370, -1245, 140, 'around'], [600, -1330, 165, 'the groove'],
    [800, -1415, 150, 'REWIND'], [650, -1525, 115, 'back'],
    [430, -1570, 105, 'to'], [230, -1665, 145, 'THE BEAT'],
    [395, -1765, 120, 'turn'], [615, -1815, 150, 'it up'],
    [840, -1900, 180, 'SIDE B'],
  ]);

  // Equalizer bars travel far enough to matter. Vertical bars must be ridden;
  // horizontal shuttles change the gap instead of merely wobbling in place.
  addSection(3, [
    [1075, -1675, 170, 'CATCH A RIDE'],
    [1300, -1720, 145, 'LOW', { moving: lift(65, 0.2) }],
    [1530, -1785, 155, 'FREQUENCY'],
    [1770, -1785, 130, 'GLIDE', { moving: lift(0, 1.2, 65, 0.8) }],
    [2040, -1820, 165, 'stay'],
    [2260, -1860, 140, 'HIGH', { moving: lift(85, 2.4) }],
    [2500, -1885, 165, 'with it'],
    [2740, -1895, 125, 'SWAY', { moving: lift(25, 4.1, 60, 0.85) }],
    [2990, -1890, 150, 'then'],
    [3220, -1960, 135, 'RISE', { moving: lift(75, 1.5, 0, 0.9) }],
    [3470, -1980, 200, 'LET GO'],
  ]);

  // Launch pads interrupt the hop rhythm with long, steerable arcs. Some
  // landings are lower; a recovery floor follows the local route envelope.
  addSection(4, [
    [3520, -2100, 165, 'DROP THE BEAT'],
    [3300, -2210, 140, 'BOUNCE', { spring: { speed: 860 } }],
    [3020, -2430, 170, 'FLY'],
    [2800, -2255, 105, 'down'],
    [2580, -2305, 100, 'softly'],
    [2340, -2265, 170, 'BREATHE'],
    [2080, -2315, 130, 'AGAIN', { spring: { speed: 800 } }],
    [1830, -2450, 175, 'FLOAT'],
    [1590, -2290, 125, 'back'],
    [1380, -2320, 105, 'to'],
    [1160, -2265, 180, 'EARTH'],
    [1040, -2360, 130, 'settle'], [880, -2460, 145, 'INHALE'],
  ]);

  // The encore changes direction for the last time: small, offset footholds,
  // two long-gap commitments, then a roomy top-right finishing control.
  addSection(5, [
    [970, -2560, 170, 'ENCORE'], [1140, -2670, 105, 'one'],
    [1340, -2630, 100, 'last'], [1550, -2720, 110, 'dance'],
    [1800, -2670, 180, 'TOGETHER'], [2080, -2750, 140, 'take'],
    [2310, -2645, 85, 'a'], [2530, -2740, 110, 'breath'],
    [2780, -2665, 155, 'hold'], [3060, -2750, 170, 'THIS'],
    [3350, -2690, 175, 'FEELING'],
    [3560, -2770, 210, 'FINISH', { kind: 'finish', role: 'finish', finish: true, collectible: true }],
  ]);
  return platforms;
}

export function generateCourse() {
  return buildCourse();
}

export function platformsAt(game, time = game.time) {
  return game.platforms.map(platform => {
    const movement = platform.moving;
    const wave = movement ? Math.sin(time * movement.speed + movement.phase) : 0;
    const trigger = game._crumble?.get(platform.id);
    const age = trigger === undefined ? -1 : time - trigger;
    const gone = platform.crumble && age >= platform.crumble.delay
      && age < platform.crumble.delay + platform.crumble.restore;
    return {
      ...platform,
      x: platform.x + wave * (movement?.rangeX ?? movement?.range ?? 0),
      y: platform.y + wave * (movement?.rangeY ?? 0),
      solid: !gone,
      crumbleProgress: platform.crumble && age >= 0 && age < platform.crumble.delay
        ? Math.min(1, age / platform.crumble.delay) : 0,
      respawnIn: gone ? platform.crumble.delay + platform.crumble.restore - age : 0,
    };
  });
}

export function createGame() {
  const platforms = generateCourse();
  const start = platforms[0];
  return {
    platforms,
    player: {
      x: start.x + start.w / 2, y: start.y,
      vx: 0, vy: 0, w: PLAYER_WIDTH, h: PLAYER_HEIGHT,
      grounded: true, platformId: 0,
    },
    time: 0, deaths: 0, checkpoint: 0, highestPlatform: 0,
    maxHeight: 0, finished: false, finishTime: null,
    collectibles: 0, totalCollectibles: platforms.filter(p => p.collectible).length,
    collectedIds: new Set(), events: [],
    _coyote: PHYSICS.coyoteTime, _buffer: 0, _jumpHeld: false,
    _fallFloor: start.y + 470, _crumble: new Map(), _springJump: false,
  };
}

export function restartGame(game) {
  const fresh = createGame();
  for (const key of Object.keys(game)) delete game[key];
  return Object.assign(game, fresh);
}

function event(game, type, platformId = game.player.platformId) {
  game.events.push({ type, x: game.player.x, y: game.player.y, platformId });
}

export function respawnGame(game) {
  if (game.finished) return game;
  const platform = platformsAt(game).find(p => p.id === game.checkpoint) || game.platforms[0];
  Object.assign(game.player, {
    x: platform.x + platform.w / 2, y: platform.y,
    vx: 0, vy: 0, grounded: true, platformId: platform.id,
  });
  game.deaths += 1;
  game._coyote = PHYSICS.coyoteTime;
  game._buffer = 0;
  game._fallFloor = platform.y + 470;
  game._crumble.clear();
  game._springJump = false;
  game._jumpHeld = false;
  event(game, 'respawn', platform.id);
  return game;
}

function approach(value, target, amount) {
  if (value < target) return Math.min(value + amount, target);
  return Math.max(value - amount, target);
}

function substep(game, input, dt) {
  const player = game.player;
  const before = platformsAt(game);
  game.time += dt;
  const platforms = platformsAt(game);
  const supported = player.grounded && platforms[player.platformId]?.solid;
  if (supported) {
    const previous = before[player.platformId];
    const current = platforms[player.platformId];
    if (previous && current) {
      player.x += current.x - previous.x;
      player.y += current.y - previous.y;
    }
    game._coyote = PHYSICS.coyoteTime;
  } else {
    game._coyote = Math.max(0, game._coyote - dt);
  }

  game._buffer = Math.max(0, game._buffer - dt);
  const direction = Number(Boolean(input.right)) - Number(Boolean(input.left));
  const acceleration = direction
    ? (supported ? PHYSICS.groundAcceleration : PHYSICS.airAcceleration)
    : PHYSICS.friction;
  player.vx = approach(player.vx, direction * PHYSICS.runSpeed, acceleration * dt);

  if (game._buffer > 0 && game._coyote > 0) {
    player.vy = -PHYSICS.jumpSpeed;
    player.grounded = false;
    game._buffer = 0;
    game._coyote = 0;
    event(game, 'jump');
    player.platformId = null;
  }
  if (!input.jump && !game._springJump && player.vy < -PHYSICS.shortJumpSpeed) player.vy = -PHYSICS.shortJumpSpeed;
  if (player.vy >= 0) game._springJump = false;

  const oldX = player.x;
  const oldY = player.y;
  player.x = Math.max(player.w / 2, Math.min(WORLD_WIDTH - player.w / 2, player.x + player.vx * dt));
  const gravity = PHYSICS.gravity * (input.down && player.vy > 0 ? 2.1 : 1);
  player.vy = Math.min(PHYSICS.maxFallSpeed, player.vy + gravity * dt);
  player.y += player.vy * dt;
  player.grounded = false;

  // Sweep relative to each moving surface. A lift moving upward can catch a
  // descending character even if neither endpoint crosses its final Y alone.
  let landing = null;
  let landingT = Infinity;
  for (const platform of platforms) {
    if (!platform.solid) continue;
    const previous = before[platform.id];
    const surfaceOldY = supported && player.platformId === platform.id ? platform.y : previous.y;
    const relativeOld = oldY - surfaceOldY;
    const relativeNew = player.y - platform.y;
    if (relativeOld > 0.05 || relativeNew < -0.001 || relativeNew < relativeOld) continue;
    const travel = relativeNew - relativeOld;
    const t = travel > 0 ? Math.max(0, -relativeOld / travel) : 0;
    const x = oldX + (player.x - oldX) * t;
    const left = previous.x + (platform.x - previous.x) * t;
    if (x + player.w / 2 <= left + 1 || x - player.w / 2 >= left + platform.w - 1) continue;
    if (t < landingT) { landing = platform; landingT = t; }
  }
  if (landing) {
    player.y = landing.y;
    player.vy = 0;
    player.grounded = true;
    const newLanding = !supported || player.platformId !== landing.id;
    if (newLanding) event(game, 'land', landing.id);
    player.platformId = landing.id;
    game.highestPlatform = Math.max(game.highestPlatform, landing.id);
    // Account for deliberate drop sections instead of treating any descent as
    // failure. This floor remains close enough for a prompt checkpoint retry.
    const next = platforms[landing.id + 1];
    game._fallFloor = Math.max(landing.y, next?.y ?? landing.y) + 430;
    if (landing.crumble && newLanding) {
      const triggeredAt = game._crumble.get(landing.id);
      if (triggeredAt === undefined || game.time - triggeredAt >= landing.crumble.delay + landing.crumble.restore) {
        game._crumble.set(landing.id, game.time);
        event(game, 'crumble', landing.id);
      }
    }
    if (landing.checkpoint && landing.id > game.checkpoint) {
      game.checkpoint = landing.id;
      event(game, 'checkpoint', landing.id);
    }
    if (landing.finish && !game.finished) {
      game.finished = true;
      game.finishTime = game.time;
      event(game, 'finish', landing.id);
    } else if (landing.spring) {
      player.vy = -landing.spring.speed;
      player.grounded = false;
      game._springJump = true;
      game._coyote = 0;
      game._buffer = 0;
      event(game, 'spring', landing.id);
      player.platformId = null;
    }
  } else {
    player.platformId = null;
  }

  game.maxHeight = Math.max(game.maxHeight, -player.y);
  for (const platform of platforms) {
    if (!platform.solid || !platform.collectible || game.collectedIds.has(platform.id)) continue;
    const x = platform.x + platform.w / 2;
    const y = platform.y - 38;
    if (Math.abs(player.x - x) < 31 && Math.abs(player.y - player.h / 2 - y) < 31) {
      game.collectedIds.add(platform.id);
      game.collectibles += 1;
      event(game, 'collect', platform.id);
    }
  }
  // Recover well before the bottom of the whole overlay. A missed leap costs a
  // checkpoint, while accidental pauses/tab switches never advance physics.
  if (player.y > game._fallFloor) respawnGame(game);
}

export function stepGame(game, input = {}, dt = FIXED_DT) {
  game.events = [];
  if (game.finished || !Number.isFinite(dt) || dt <= 0) return game;
  const held = Boolean(input.jump ?? input.jumpPressed);
  if (input.jumpPressed || (held && !game._jumpHeld)) game._buffer = PHYSICS.jumpBuffer;
  game._jumpHeld = held;
  const normalized = { ...input, jump: held };
  // Supporting a renderer's variable delta is useful, but never integrate a
  // large tab-suspension interval as one destructive physics frame.
  let remaining = Math.min(dt, 0.1);
  while (remaining > 1e-8 && !game.finished) {
    const tick = Math.min(remaining, FIXED_DT);
    substep(game, normalized, tick);
    remaining -= tick;
  }
  return game;
}
