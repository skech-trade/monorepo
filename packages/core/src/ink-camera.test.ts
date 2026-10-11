import { expect, test } from "bun:test";
import { drawingCameraAt } from "./ink-camera";
import { drawingLayout } from "./ink";

for (const width of [390, 1280]) {
  test(`selected cards stay fixed while the marker approaches at width ${width}`, () => {
    const layout = drawingLayout(width, 800, 1);
    const placedAt = 100_000;
    const selectedTime = placedAt + 5000;
    const initialX = layout.nowX + (selectedTime - placedAt) * layout.pxMs;
    let camera = drawingCameraAt(null, placedAt, false, Infinity, 16);
    for (let elapsed = 16; elapsed <= 5000; elapsed += 16) {
      const now = placedAt + elapsed;
      camera = drawingCameraAt(camera, now, true, Infinity, 16);
      const selectedX = layout.nowX + (selectedTime - camera) * layout.pxMs;
      const markerX = layout.nowX + (now - camera) * layout.pxMs;
      expect(selectedX).toBe(initialX);
      expect(markerX).toBeGreaterThan(layout.nowX);
      expect(selectedX - markerX).toBeCloseTo((selectedTime - now) * layout.pxMs, 8);
    }
  });

  test(`marker stays visible at the right edge at width ${width}`, () => {
    const layout = drawingLayout(width, 800, 1);
    const maxAdvance = (width - 16 - layout.nowX) / layout.pxMs;
    const camera = drawingCameraAt(100_000, 160_000, true, maxAdvance, 16);
    expect(layout.nowX + (160_000 - camera) * layout.pxMs).toBeCloseTo(width - 16, 8);
  });
}

test("settlement smoothly returns the camera to live time", () => {
  const camera = drawingCameraAt(100_000, 105_000, false, Infinity, 16);
  expect(camera).toBeGreaterThan(100_000);
  expect(camera).toBeLessThan(105_000);
  expect(drawingCameraAt(100_000, 105_000, false, Infinity, 16, true)).toBe(105_000);
});

test("a new selection holds the camera during recentering", () => {
  const camera = drawingCameraAt(100_000, 105_000, false, Infinity, 16);
  expect(drawingCameraAt(camera, 105_016, true, Infinity, 16)).toBe(camera);
});

test("clock resets cannot put the live marker behind its starting position", () => {
  expect(drawingCameraAt(105_000, 100_000, true, Infinity, 16)).toBe(100_000);
});
