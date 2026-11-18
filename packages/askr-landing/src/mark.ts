/**
 * The Askr mark's geometry, as the widget draws it (`packages/askr-widget/src/ui/mark.ts`):
 * nested rounded triangles, a shaft seen from above. The rings shrink toward the point under
 * the viewer; moving that point makes the far end slide and the bands lean. The page moves it
 * with the pointer, and drifts it the widget's way when the pointer is still.
 */

export type Point = readonly [number, number];

/** The rim, in a 100 x 100 box. */
const RIM: readonly Point[] = [
  [50, 7],
  [5, 90],
  [95, 90],
];
const RIM_CENTER: Point = [
  (RIM[0][0] + RIM[1][0] + RIM[2][0]) / 3,
  (RIM[0][1] + RIM[1][1] + RIM[2][1]) / 3,
];
const CORNER_RADIUS = 11;
const WALL = 0.92;

/** The widget's ring count; the page's big marks may draw more for a deeper shaft. */
export const MARK_RINGS = 6;

/** Where the widget's drift starts. */
export const DRIFT_START = 2.2;

/** The farthest the point under the viewer goes from the middle, on each axis. */
export const VIEW_RANGE: Point = [12, 13];

/** The middle of the viewpoint's range: looking straight down the shaft. */
export const VIEW_CENTER: Point = [50, 64];

/** The widget's drift: both axes swing about as far, at unrelated rates. */
export function driftViewpoint(time: number): Point {
  return [
    VIEW_CENTER[0] + VIEW_RANGE[0] * Math.sin(time * 0.61),
    VIEW_CENTER[1] + VIEW_RANGE[1] * Math.sin(time * 0.47 + 1.1),
  ];
}

function vertex(points: readonly Point[], index: number): Point {
  const point = points[(index + points.length) % points.length];
  if (point === undefined) {
    throw new Error('the triangle has three corners');
  }
  return point;
}

/** A closed triangle path with every corner rounded by `radius`. */
function roundedTrianglePath(points: readonly Point[], radius: number): string {
  const parts: string[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = vertex(points, index - 1);
    const current = vertex(points, index);
    const next = vertex(points, index + 1);
    const toPrevious: Point = [previous[0] - current[0], previous[1] - current[1]];
    const toNext: Point = [next[0] - current[0], next[1] - current[1]];
    const lengthPrevious = Math.hypot(toPrevious[0], toPrevious[1]);
    const lengthNext = Math.hypot(toNext[0], toNext[1]);
    const cosine =
      (toPrevious[0] * toNext[0] + toPrevious[1] * toNext[1]) / (lengthPrevious * lengthNext);
    const cut = radius / Math.tan(Math.acos(cosine) / 2);
    const startX = current[0] + (toPrevious[0] / lengthPrevious) * cut;
    const startY = current[1] + (toPrevious[1] / lengthPrevious) * cut;
    const endX = current[0] + (toNext[0] / lengthNext) * cut;
    const endY = current[1] + (toNext[1] / lengthNext) * cut;
    parts.push(
      `${index === 0 ? 'M' : 'L'}${startX.toFixed(2)} ${startY.toFixed(2)}`,
      `A${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 0 ${endX.toFixed(2)} ${endY.toFixed(2)}`,
    );
  }
  return `${parts.join(' ')}Z`;
}

/** The ring paths seen from `focus`: the rim first, then every ring inward. */
export function markPaths(focus: Point, rings: number = MARK_RINGS): string[] {
  const paths = [roundedTrianglePath(RIM, CORNER_RADIUS)];
  for (let ring = 1; ring <= rings; ring += 1) {
    const scale = WALL * (1 - (ring - 1) / (rings + 0.6));
    const centerX = focus[0] + (RIM_CENTER[0] - focus[0]) * scale;
    const centerY = focus[1] + (RIM_CENTER[1] - focus[1]) * scale;
    const points = RIM.map(
      ([x, y]): Point => [
        centerX + (x - RIM_CENTER[0]) * scale,
        centerY + (y - RIM_CENTER[1]) * scale,
      ],
    );
    paths.push(roundedTrianglePath(points, CORNER_RADIUS * scale));
  }
  return paths;
}
