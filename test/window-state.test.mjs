import test from "node:test";
import assert from "node:assert/strict";
import { fitBounds } from "../app/core/window-state.js";

const screen = [{ x: 0, y: 0, width: 1920, height: 1040 }];

test("bounds on a visible screen come back as they were", () => {
  assert.deepEqual(fitBounds({ x: 1300, y: 100, width: 600, height: 720 }, screen), { x: 1300, y: 100, width: 600, height: 720 });
});

test("bounds left on an unplugged monitor move onto the first screen", () => {
  const b = fitBounds({ x: 2500, y: 50, width: 600, height: 720 }, screen);
  assert.deepEqual(b, { x: 660, y: 160, width: 600, height: 720 });
});

test("junk is ignored", () => {
  assert.equal(fitBounds(null, screen), null);
  assert.equal(fitBounds({ x: "a", y: 0, width: 600, height: 700 }, screen), null);
  assert.equal(fitBounds({ x: 0, y: 0, width: 10, height: 10 }, screen), null);
});
