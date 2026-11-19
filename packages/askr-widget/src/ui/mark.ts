/**
 * The Askr mark: nested rounded triangles, a shaft seen from above. The rings sit at even
 * steps and shrink toward the point under the viewer; the viewer drifts very slowly over the
 * opening, so the far end slides and the bands lean. Drawn as SVG paths filled by the theme's
 * text and background colors (a dark rim in the light theme, a light rim in the dark one).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The rim, in a 100 x 100 box. */
const RIM: ReadonlyArray<readonly [number, number]> = [
  [50, 7],
  [5, 90],
  [95, 90],
];
const RIM_CENTER: readonly [number, number] = [
  (RIM[0][0] + RIM[1][0] + RIM[2][0]) / 3,
  (RIM[0][1] + RIM[1][1] + RIM[2][1]) / 3,
];
const CORNER_RADIUS = 11;
const RINGS = 6;
const WALL = 0.92;

/** Where the drift starts, and how fast it runs (radians of the slower axis per second). */
const START_TIME = 2.2;
const DRIFT_SPEED = 0.18;
/** The drift is slow: about 24 redraws a second are plenty and spare the host page. */
const FRAME_MS = 1000 / 24;

/** The point under the viewer: both axes swing about as far, at unrelated rates. */
function viewpoint(time: number): [number, number] {
  return [50 + 12 * Math.sin(time * 0.61), 64 + 13 * Math.sin(time * 0.47 + 1.1)];
}

function vertex(points: ReadonlyArray<readonly [number, number]>, index: number): [number, number] {
  const point = points[(index + points.length) % points.length];
  if (point === undefined) {
    throw new Error('the triangle has three corners');
  }
  return [point[0], point[1]];
}

/** A closed triangle path with every corner rounded by `radius`. */
function roundedTrianglePath(
  points: ReadonlyArray<readonly [number, number]>,
  radius: number,
): string {
  const parts: string[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = vertex(points, index - 1);
    const current = vertex(points, index);
    const next = vertex(points, index + 1);
    const toPrevious: [number, number] = [previous[0] - current[0], previous[1] - current[1]];
    const toNext: [number, number] = [next[0] - current[0], next[1] - current[1]];
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

/** The ring paths for one moment: the rim first, then every ring inward. */
export function markPaths(time: number): string[] {
  const focus = viewpoint(time);
  const paths = [roundedTrianglePath(RIM, CORNER_RADIUS)];
  for (let ring = 1; ring <= RINGS; ring += 1) {
    const scale = WALL * (1 - (ring - 1) / (RINGS + 0.6));
    const centerX = focus[0] + (RIM_CENTER[0] - focus[0]) * scale;
    const centerY = focus[1] + (RIM_CENTER[1] - focus[1]) * scale;
    const points = RIM.map(([x, y]): [number, number] => [
      centerX + (x - RIM_CENTER[0]) * scale,
      centerY + (y - RIM_CENTER[1]) * scale,
    ]);
    paths.push(roundedTrianglePath(points, CORNER_RADIUS * scale));
  }
  return paths;
}

interface LiveMark {
  svg: SVGSVGElement;
  paths: SVGPathElement[];
}

const LIVE_MARKS = new Set<LiveMark>();
const MARKS = new WeakMap<SVGSVGElement, LiveMark>();
let frame: number | undefined;
let lastDraw = 0;
let time = START_TIME;
let stillQuery: MediaQueryList | undefined;

function draw(mark: LiveMark, moment: number): void {
  const shapes = markPaths(moment);
  mark.paths.forEach((path, index) => {
    path.setAttribute('d', shapes[index] ?? '');
  });
}

/**
 * Read live, so a visitor who turns on reduced motion mid-visit stops the drift at once; the
 * loop parks meanwhile and starts again when the setting is turned off.
 */
function prefersStill(scope: typeof globalThis): boolean {
  if (stillQuery === undefined && typeof scope.matchMedia === 'function') {
    stillQuery = scope.matchMedia('(prefers-reduced-motion: reduce)');
    stillQuery.addEventListener?.('change', resume);
  }
  return stillQuery?.matches ?? false;
}

function resume(): void {
  if (frame === undefined && LIVE_MARKS.size > 0 && !prefersStill(globalThis)) {
    frame = globalThis.requestAnimationFrame(tick);
  }
}

/** A mark the visitor cannot see (the launcher behind the open panel, the closed panel's) waits. */
function shown(svg: SVGSVGElement): boolean {
  return typeof svg.checkVisibility === 'function' ? svg.checkVisibility() : true;
}

function tick(now: number): void {
  frame = undefined;
  for (const mark of LIVE_MARKS) {
    if (!mark.svg.isConnected) {
      LIVE_MARKS.delete(mark);
    }
  }
  if (prefersStill(globalThis)) {
    return;
  }
  const elapsed = now - lastDraw;
  if (elapsed >= FRAME_MS) {
    // A long gap (a background tab) moves the drift on by a few frames only: never a jump.
    time += (Math.min(elapsed, 4 * FRAME_MS) / 1000) * DRIFT_SPEED;
    lastDraw = now;
    for (const mark of LIVE_MARKS) {
      if (shown(mark.svg)) {
        draw(mark, time);
      }
    }
  }
  if (LIVE_MARKS.size > 0) {
    frame = globalThis.requestAnimationFrame(tick);
  }
}

/**
 * A new mark, drawn at once. It drifts with every other mark on the page while it is shown,
 * unless the visitor asks for reduced motion or the browser has no animation frames.
 */
export function createMark(document: Document, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const paths = Array.from({ length: RINGS + 1 }, (_unused, index) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', index % 2 === 0 ? 'mark-ink' : 'mark-paper');
    svg.append(path);
    return path;
  });
  const mark: LiveMark = { svg, paths };
  MARKS.set(svg, mark);
  draw(mark, time);
  animateMark(svg);
  return svg;
}

/**
 * Let a mark drift again after it was taken out of the page and put back (a detached mark
 * leaves the loop, so the loop stops once no mark is on the page).
 */
export function animateMark(svg: SVGSVGElement): void {
  const mark = MARKS.get(svg);
  if (mark === undefined || typeof globalThis.requestAnimationFrame !== 'function') {
    return;
  }
  draw(mark, time);
  LIVE_MARKS.add(mark);
  if (frame === undefined) {
    frame = globalThis.requestAnimationFrame(tick);
  }
}
