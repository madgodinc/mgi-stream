// Saved window bounds are only worth restoring if the window lands somewhere
// the streamer can see: a monitor may have been unplugged since.

/**
 * Returns `saved` if enough of it overlaps one of the work areas, a copy
 * moved fully onto the first area if not, or null if the data is junk.
 */
export function fitBounds(saved, areas, minVisible = 80) {
  const ok = (n) => Number.isFinite(n);
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(ok) || saved.width < 100 || saved.height < 80) return null;
  if (!areas.length) return null;
  const overlaps = areas.some((a) => {
    const w = Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x);
    const h = Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y);
    return w >= minVisible && h >= minVisible;
  });
  if (overlaps) return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  const a = areas[0];
  const width = Math.min(saved.width, a.width);
  const height = Math.min(saved.height, a.height);
  return { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height };
}
