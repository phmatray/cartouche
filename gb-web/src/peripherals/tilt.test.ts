import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySensitivity, keysToTilt, motionToTilt, orientationToMotion, pickSource, stickToTilt } from './tilt.ts';

const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  assert.ok(Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3, `${JSON.stringify(a)} ≈ ${JSON.stringify(b)}`);
};
const zero = { x: 0, y: 0 };

test('motionToTilt: a side tilted down reads negative and gives + tilt', () => {
  near(motionToTilt({ x: -4.905, y: 0, z: 8.5 }, 0, zero), { x: 0.5, y: 0 }); // portrait, right side down
  near(motionToTilt({ x: 0, y: -4.905, z: 8.5 }, 0, zero), { x: 0, y: 0.5 }); // portrait, top side down
  near(motionToTilt({ x: 0, y: 0, z: 9.81 }, 0, zero), zero); // flat
});

test('motionToTilt follows the screen angle', () => {
  // Landscape (90°, device top on the left): the screen's right is the device's bottom edge.
  near(motionToTilt({ x: 0, y: 4.905, z: 8.5 }, 90, zero), { x: 0.5, y: 0 });
  near(motionToTilt({ x: -4.905, y: 0, z: 8.5 }, 90, zero), { x: 0, y: 0.5 });
  near(motionToTilt({ x: 0, y: -4.905, z: 8.5 }, 270, zero), { x: 0.5, y: 0 });
  near(motionToTilt({ x: 4.905, y: 0, z: 8.5 }, 180, zero), { x: 0.5, y: 0 });
});

test('motionToTilt subtracts the recenter offset', () => {
  // Held like a Game Boy: top raised 30°. Recentering there reads level.
  const held = { x: 0, y: 4.905, z: 8.5 };
  const offset = motionToTilt(held, 0, zero);
  near(offset, { x: 0, y: -0.5 });
  near(motionToTilt(held, 0, offset), zero);
});

test('orientationToMotion matches the gravity reading', () => {
  const m = orientationToMotion(0, 30); // flat, rolled right 30°
  near(motionToTilt(m, 0, zero), { x: 0.5, y: 0 });
});

test('stickToTilt: deadzone, full throw is 1 g, up tilts the top down', () => {
  near(stickToTilt(0.1, -0.1), zero);
  near(stickToTilt(1, 0), { x: 1, y: 0 });
  near(stickToTilt(0, -1), { x: 0, y: 1 });
  near(stickToTilt(-0.575, 0), { x: -0.5, y: 0 });
});

test('keysToTilt ramps to 0.6 g in 250 ms and back', () => {
  near(keysToTilt(new Set(['l']), zero, 125), { x: 0.3, y: 0 });
  near(keysToTilt(new Set(['l']), zero, 250), { x: 0.6, y: 0 });
  near(keysToTilt(new Set(['l']), { x: 0.6, y: 0 }, 500), { x: 0.6, y: 0 });
  near(keysToTilt(new Set(['i', 'j']), zero, 250), { x: -0.6, y: 0.6 });
  near(keysToTilt(new Set(), { x: 0.6, y: -0.6 }, 125), { x: 0.3, y: -0.3 });
});

test('pickSource: motion, then pad, then keys', () => {
  assert.equal(pickSource({ motion: true, pad: true }), 'motion');
  assert.equal(pickSource({ motion: false, pad: true }), 'pad');
  assert.equal(pickSource({ motion: false, pad: false }), 'keys');
});

test('applySensitivity scales and clamps at 2 g', () => {
  near(applySensitivity({ x: 1, y: -0.5 }, 150), { x: 1.5, y: -0.75 });
  near(applySensitivity({ x: 1.8, y: -1.8 }, 200), { x: 2, y: -2 });
  near(applySensitivity({ x: 1, y: 0 }, 50), { x: 0.5, y: 0 });
});
