import { OVERLAY } from './game-model.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// Frame the note and its actual next landing together, including moving lifts.
export function followCourseCamera({ player, platforms, platformId, width, height }) {
  const current = platforms[platformId] || platforms[0];
  const next = platforms[Math.min(current.id + 1, platforms.length - 1)] || current;
  const nextX = next.x + next.w / 2;
  const left = Math.min(player.x - 90, next.x - 65);
  const right = Math.max(player.x + 90, next.x + next.w + 65);
  const top = Math.min(player.y - player.h - 95, next.y - 115);
  const bottom = Math.max(player.y + 90, next.y + 70);
  const scenic = player.grounded && !current.spring && !current.moving && player.x < 1050;
  const baseZoom = width < 500 ? .82 : scenic ? .84 : 1.02;
  const zoom = Math.min(baseZoom, width / (right - left), height / (bottom - top));
  const viewW = width / zoom, viewH = height / zoom;
  const lead = clamp((nextX - player.x) * .3, -115, 115);
  const wantedX = player.x - viewW * .5 + lead - (scenic ? 65 : 0);
  const wantedY = player.y - viewH * .64;
  // These intervals are valid because the zoom fits the complete envelope.
  let x = clamp(wantedX, right - viewW, left);
  let y = clamp(wantedY, bottom - viewH, top);
  const worldLeft = OVERLAY.left - 80, worldRight = OVERLAY.right + 80;
  const worldTop = OVERLAY.top - 100, worldBottom = OVERLAY.bottom + 80;
  if (viewW < worldRight - worldLeft) x = clamp(x, worldLeft, worldRight - viewW);
  if (viewH < worldBottom - worldTop) y = clamp(y, worldTop, worldBottom - viewH);
  return { x, y, zoom };
}
