// The Orbit picture's geometry (components/orbit.tsx draws it): what the
// server sends for a workspace (lib/orbit.ts) becomes rings of neurons around
// the constitution. A collection is a ring, the smallest closest to the core
// and the vast ones broad outer belts; a record is a neuron; a link between
// records a synapse, and only that: a line stands in the picture only between
// records. The rings are folded like a cortex: their outlines wind, and the
// neurons gather on the ridges. A ring stands taller the more records it
// holds. People and agents sit above the rings and integrations below them
// (Alexander, 2026-11-15: "integrations being placed below the galaxy, instead
// of above"), each reaching a ring from its own side along a path that is
// drawn only while it happens. The geometry is kept in three tiers, by
// depth: under the rings, the rings, over them (orbit-engine.ts). Everything
// here is plain numbers, so it runs without a browser.

import { type OrbitData, allocateDots, extent } from "~/lib/orbit";
import {
  type Builder,
  CORE,
  type Curve,
  NO_LAYER,
  OVER,
  RINGS,
  type Rgb,
  type Tier,
  type Tiers,
  UNDER,
  V,
  type Vec3,
  bez,
  clamp,
  emptyTiers,
  gauss,
  hash,
  rng,
  smooth,
  turn,
} from "./orbit-engine";

export interface OrbitPalette {
  /** A light ground multiplies ink onto it; a dark one adds light. */
  light: boolean;
  bg: Rgb;
  ink: Rgb;
  /** The three activity colors, in ORBIT_LOGS order. */
  logs: [imports: Rgb, writes: Rgb, queries: Rgb];
}

export interface OrbitWorldOptions {
  /** The stage's width over its height. */
  aspect: number;
  /** How many dots the device keeps smooth. */
  budget: number;
  palette: OrbitPalette;
}

/** A line of the picture: where it runs, and the tier it is in. A synapse
 *  inside a collection lies in the rings; an arc between two rises over them. */
export interface OrbitPath {
  curve: Curve;
  tier: Tier;
}

/** The path an event travels, from who acted to the neuron it lands on: where
 *  it runs at a moment is `OrbitWorld.path`, since the rings turn and an agent
 *  circles its person. */
export interface OrbitStrand {
  /** Who acted, by place among the actors. */
  actor: number;
  tier: Tier;
  land: Vec3;
  /** The collection it lands on, or NO_LAYER for the core. */
  layer: number;
  /** How the neuron fires: the synapses its glow travels, hop by hop, each
   *  from the neuron that fired to its neighbour. Empty where it has none. */
  wave: Curve[][];
}

export interface OrbitCamera {
  eye: Vec3;
  target: Vec3;
  /** Degrees. */
  fov: number;
  focus: number;
  dof: number;
  fog: [number, number];
}

export interface OrbitWorld {
  /** What stands in the picture, by depth. */
  tiers: Tiers;
  /** A phone held upright: fewer names, a closer camera. */
  portrait: boolean;
  /** The picture's size in its own units: what sizes of marks and pulses scale by. */
  unit: number;
  /** The radius of the core's sphere, the constitution, at the middle of the picture. */
  core: number;
  /** How the rings fold at a place of their plane: 0 in a groove, 1 on a ridge. */
  fold(x: number, z: number): number;
  /** How many dots each collection got. */
  shown: number[];
  /** Where an actor is `seconds` into the picture's clock. People and
   *  integrations stand; an agent circles the person it works for (Alexander,
   *  2026-11-16: "What if have agents orbit their users?"). */
  at(actor: number, seconds: number): Vec3;
  /** How large each actor's mark is, a person's larger than an agent's ("Users
   *  are larger. Agents are smaller."), and which shape it has. */
  actorSize: number[];
  actorShape: number[];
  /** Whether each actor keeps its badge on show; the others show it while they
   *  act. An agent keeps one while its person does. */
  named: boolean[];
  /** Draw the marks that move, `seconds` into the picture's clock: the agents
   *  without a badge that circle their people. */
  moving(seconds: number, into: Tiers): void;
  /** The path of one event from an actor to its collection (or to the core, for
   *  -1). `pick` (0 to 1) is the event's own: it says which neuron it lands on,
   *  so what an actor does goes all over a collection. */
  strand(actor: number, collection: number, pick: number): OrbitStrand;
  /** One synapse drawn between two collections (the same twice for one inside
   *  a collection, the smaller first), picked by `pick` (0 to 1), or null where
   *  none is drawn. */
  synapse(a: number, b: number, pick: number): OrbitPath | null;
  /** Where the camera stands. It stays there: the rings turn instead. */
  camera(): OrbitCamera;
  /** How far the rings have turned `seconds` into the picture's clock (radians),
   *  0 at its start: only they turn, and what acts on them stands (Alexander,
   *  2026-11-16: "Make the agents, people, and the integration providers static,
   *  meaning only the collections are the ones rotating"). */
  spin(seconds: number): number;
  /** A strand's path in the rings' own frame while they are turned by `spin`,
   *  `seconds` into the picture's clock: it lands on the same neuron, and once
   *  turned with the rings it starts where its actor is then. */
  path(strand: OrbitStrand, spin: number, seconds: number): Curve;
}

/** What is not of the rings hangs under them or floats over them. */
export const tierAt = (p: Vec3): Tier => (p[1] < 0 ? UNDER : OVER);

/** What a picture is built from, coarsely: it stays the same while a workspace
 *  only grows a little, so a page that keeps itself up to date rebuilds its
 *  picture only when the workspace's shape changed, or a part of its data it
 *  was drawn without arrived (the links, or the period's activity). */
export function orbitStructureKey(data: OrbitData): string {
  const coarse = (n: number) => Math.round(Math.log(n + 1) * 30);
  return JSON.stringify([
    data.collections.map((c) => [c.handle, coarse(c.items)]),
    data.links.map(([a, b, n]) => [a, b, coarse(n)]),
    data.actors.map((a) => [a.kind, a.name]),
    // the period's activity has its bars; the rings drawn before it have none
    data.buckets[0].length > 0,
  ]);
}

const TAU = Math.PI * 2;
/** How fast the rings turn (radians a second), the way the camera once went round;
 *  each person's agents go round them as fast. */
const TURN = 0.04;
const ALPHA = {
  light: { dot: 0.8, line: 0.12, sheet: 0.028, edge: 0.26, core: 0.16, folium: 0.5, fissure: 0.8 },
  dark: { dot: 0.7, line: 0.1, sheet: 0.03, edge: 0.2, core: 0.12, folium: 0.45, fissure: 0.7 },
};
/** The core's sphere: its body's bands and slices, and the folds over it. */
const CORE_BODY = [14, 36];
const FOLIA = 44;
/** A mark is a plain ball (Alexander, 2026-11-16: "let's make sure that the planets and
 *  the moons are just very simple spheres"); its layer says who it is, and keeps it
 *  from turning with the rings. */
const SHAPE = { person: -20, agent: -21, integration: -22 } as const;
/** How far under the rings the integrations hang, as a share of the picture's
 *  radius, at least; and how far clear of the tallest ring's underside. */
const BELOW = 0.2;
const CLEAR = 0.1;
/** An outline is drawn with this many sides, enough for its folds. */
const SIDES = 288;
/** How many neighbours a firing neuron reaches, and how many each of them reaches in turn. */
const REACH = [4, 2];
/** Past this many, people and agents form two belts of their own. */
const CROWD = 40;
const FOV = 32;

interface Sample {
  p: Vec3;
  /** The plane of the ring at `p`. */
  u: Vec3;
  v: Vec3;
}

function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The folds of a cortex over a plane `reach` wide, as a field that is 0
 *  along a groove and grows, either way, towards the ridges beside it. Waves of
 *  one length and every direction add up to winding ridges of one width, with
 *  a groove wherever they cancel. */
function cortex(reach: number): (x: number, z: number) => number {
  const waves = Array.from({ length: 10 }, (_, j) => {
    const turn = ((j + hash(j * 3.7 + 1)) / 10) * Math.PI;
    const k = (27 / reach) * (0.85 + 0.3 * hash(j * 5.3 + 3));
    return [Math.cos(turn) * k, Math.sin(turn) * k, hash(j * 9.1 + 6) * TAU];
  });
  return (x, z) => {
    let sum = 0;
    for (const [kx, kz, phase] of waves) sum += Math.cos(kx * x + kz * z + phase);
    return sum / Math.sqrt(waves.length / 2);
  };
}

const orbitAround = (target: Vec3, distance: number, yaw: number, elevation: number): Vec3 =>
  V.add(target, [
    distance * Math.sin(yaw) * Math.cos(elevation),
    distance * Math.sin(elevation),
    distance * Math.cos(yaw) * Math.cos(elevation),
  ]);

/** How far back a camera stands to fit a box. */
const fit = (halfWidth: number, halfHeight: number, aspect: number) =>
  Math.max(halfHeight, halfWidth / aspect) / Math.tan((FOV * Math.PI) / 360);

/** The whole picture at once. */
export function buildOrbitWorld(data: OrbitData, options: OrbitWorldOptions): OrbitWorld {
  const stages = buildOrbitWorldInStages(data, options);
  for (;;) {
    const next = stages.next();
    if (next.done) return next.value;
  }
}

/**
 * The picture, built a stage at a time: each yield is how far along it is,
 * between 0 and 1, so the page can draw between stages and show its progress
 * (Alexander, 2026-11-16: "loading in portions so that the user sees
 * progress"). The neurons, the bulk of the work, go a collection at a time.
 */
export function* buildOrbitWorldInStages(
  data: OrbitData,
  options: OrbitWorldOptions,
): Generator<number, OrbitWorld, void> {
  const { aspect, budget, palette } = options;
  const cs = data.collections;
  const n = cs.length;
  const portrait = aspect < 0.85;
  const alpha = palette.light ? ALPHA.light : ALPHA.dark;
  const ink = palette.ink;
  const shown = allocateDots(
    cs.map((c) => c.items),
    budget,
  );
  const tiers = emptyTiers();
  const B = tiers[RINGS];
  const rnd = rng(11);

  // ---- rings: the smallest collection closest to the core ----
  const e = cs.map((c) => extent(c.items));
  const kk = 0.3 + 0.7 * Math.max(0.08, ...e);
  const gap = 0.45 * kk;
  const inner: number[] = [];
  const outer: number[] = [];
  let r = 1.5 * kk;
  for (let i = n - 1; i >= 0; i--) {
    inner[i] = r;
    r += 0.32 + 3 * e[i] ** 1.8;
    outer[i] = r;
    r += gap;
  }
  const Ro = n > 0 ? r - gap : 1.5 * kk;
  const unit = Ro * 0.95;
  /** How tall a ring stands: the more records, the much taller (Alexander,
   *  2026-11-15: "we can make the rings much, much taller, as they have more
   *  content"), up to three times as tall as it is wide and 0.8 of the rings'
   *  reach, twice what it was (Alexander, 2026-11-16: "2x the max size of rings"). */
  const height = e.map(
    (x, i) => 0.02 * kk + Math.min(6 * x ** 3, 3 * (outer[i] - inner[i]), 0.8 * Ro),
  );
  /** How far the tallest ring stands above (and below) the rings' plane. */
  const top = Math.max(0, ...height) / 2;
  const circle = (radius: number): Vec3[] => {
    const ps: Vec3[] = [];
    for (let q = 0; q < SIDES; q++) {
      const a = (q / SIDES) * TAU;
      ps.push([Math.cos(a) * radius, 0, Math.sin(a) * radius]);
    }
    return ps;
  };

  // ---- the folds: a ring's outline gives way where a groove crosses it and
  // swells a little on a ridge, never as far as the next ring ----
  const folds = cortex(Ro);
  /** 0 in a groove, 1 on a ridge `width` away from one. */
  const ridge = (x: number, z: number, width: number) => smooth(Math.abs(folds(x, z)) / width);
  const fold = (x: number, z: number) => ridge(x, z, 0.6);
  const sway = cs.map((_, i) => Math.min(0.35 * gap, 0.3 * (outer[i] - inner[i])));
  /** How far from the core ring `i`'s inner (-1) or outer (1) outline is at an angle. */
  const edge = (i: number, side: number, angle: number) => {
    const radius = side < 0 ? inner[i] : outer[i];
    const swell = 1.6 * ridge(Math.cos(angle) * radius, Math.sin(angle) * radius, 1.1) - 1;
    return radius + side * sway[i] * swell;
  };
  const outline = (i: number, side: number): Vec3[] =>
    circle(1).map(([x, , z], q) => {
      const radius = edge(i, side, (q / SIDES) * TAU);
      return [x * radius, 0, z * radius];
    });
  /** How far a ring's folded top dips from a ridge into a groove. */
  const DIP = 0.35;

  // Records gather in communities (a channel, a repository, a topic): each ring gets its own clumps.
  const sources = cs.map((c) => rng(seedOf(c.handle)));
  const clumps = shown.map((N, i) => {
    const K = N < 40 ? 0 : clamp(Math.round(N / 300), 3, 34);
    const list: [number, number, number, number][] = [];
    const s = sources[i];
    for (let j = 0; j < K; j++) {
      list.push([s() * 2 - 1, s() * 2 - 1, 0.12 + 0.2 * s() * s(), 0.3 + s()]);
    }
    return list;
  });
  const uv = (i: number, s: () => number): [number, number] => {
    const list = clumps[i];
    if (list.length === 0 || s() < clamp(1.05 - shown[i] / 2500, 0.32, 0.8)) {
      return [s() * 2 - 1, s() * 2 - 1];
    }
    let t = s() * list.reduce((sum, c) => sum + c[3], 0);
    let chosen = list[0];
    for (const c of list) {
      t -= c[3];
      if (t <= 0) {
        chosen = c;
        break;
      }
    }
    return [chosen[0] + gauss(s) * chosen[2], chosen[1] + gauss(s) * chosen[2]];
  };
  const sample = (i: number, s: () => number): Sample => {
    // a neuron keeps to the ridges: a place in a groove is mostly passed over
    for (let tries = 0; ; tries++) {
      let a = 0;
      let b = 2;
      while (Math.abs(b) > 1) [a, b] = uv(i, s);
      const th = a * Math.PI;
      const from = edge(i, -1, th);
      const to = edge(i, 1, th);
      const radius = Math.sqrt(from * from + (to * to - from * from) * (b * 0.5 + 0.5));
      const x = Math.cos(th) * radius;
      const z = Math.sin(th) * radius;
      const ridged = fold(x, z);
      if (tries < 8 && s() > ridged) continue;
      // anywhere from the ring's flat underside up to its folded top, mostly near the top
      const top = 0.5 - DIP * (1 - ridged);
      return {
        p: [x, height[i] * (-0.5 + (top + 0.5) * Math.sqrt(s())), z],
        u: [-Math.sin(th), 0, Math.cos(th)],
        v: [Math.cos(th), 0, Math.sin(th)],
      };
    }
  };

  // The rings' plane is one disc of sheets laid edge to edge, a ring's faintly inked
  // and the gaps clear: the disc as a whole veils what is behind it (orbit-engine.ts).
  const sheet = (from: Vec3[], to: Vec3[], sheetAlpha: number, layer: number) => {
    if (from === to) return;
    for (let q = 0; q < SIDES; q++) {
      const q2 = (q + 1) % SIDES;
      B.triangle(from[q], to[q], to[q2], ink, sheetAlpha, layer);
      B.triangle(from[q], to[q2], from[q2], ink, sheetAlpha, layer);
    }
  };
  if (n === 0) sheet(circle(0), circle(Ro), 0, NO_LAYER);

  const edgesInside = cs.map(() => 0);
  for (const [a, b, count] of data.links) if (a === b) edgesInside[a] += count;
  const lineBudget = portrait ? 2600 : 6500;
  const rootSum = shown.reduce((sum, x) => sum + Math.sqrt(x), 0) || 1;

  // ---- neurons, and the synapses inside each collection ----
  const P: Sample[][] = [];
  // Every synapse drawn between records is kept by the collections it joins, so
  // a new edge can light one of them.
  const synapses = new Map<string, OrbitPath[]>();
  const drawn = (a: number, b: number, synapse: OrbitPath) => {
    const list = synapses.get(`${a}/${b}`);
    if (list) list.push(synapse);
    else synapses.set(`${a}/${b}`, [synapse]);
  };
  /** A synapse between two neurons: it bends a little, one way or both like an
   *  S, in the plane of its ring and a touch out of it, as a living one does. */
  const organic = (p: Vec3, q: Vec3, s: () => number): Curve => {
    const d = V.sub(q, p);
    // as long as the synapse, square to it in the ring's plane
    const across: Vec3 = [-d[2], 0, d[0]];
    const rise = V.len(d) * 0.1;
    const bend = (at: number): Vec3 =>
      V.add(V.lerp(p, q, at), V.add(V.mul(across, (s() - 0.5) * 0.5), [0, (s() - 0.5) * rise, 0]));
    return [p, bend(1 / 3), bend(2 / 3), q];
  };
  /** A curve run the other way. */
  const back = ([a, b, c, d]: Curve): Curve => [d, c, b, a];
  /** A synapse is drawn in this many stretches: enough for its bend, few enough to keep a frame quick. */
  const STRETCHES = 3;
  // Which neurons of a collection each of its neurons has a synapse to, and
  // along which curve: where its glow goes when it fires.
  const linked: Map<number, [to: number, curve: Curve][]>[] = cs.map(() => new Map());
  const outlineOf = cs.map((_, i) => [outline(i, -1), outline(i, 1)]);
  /** How far along the neurons are: they take about four fifths of the work. */
  const allShown = shown.reduce((sum, count) => sum + count, 0) || 1;
  let builtShown = 0;
  for (let i = 0; i < n; i++) {
    const N = shown[i];
    const before = builtShown;
    builtShown += N;
    /** How far along the picture is, `part` of the way through this collection. */
    const at = (part: number) => (0.8 * (before + part * N)) / allShown;
    const s = sources[i];
    // What the links and the period's activity add draws on randoms of its own, so a
    // picture first drawn from the counts alone keeps every neuron where it stands, and
    // as it flickers, when they arrive.
    const seed = seedOf(cs[i].handle);
    const marks = rng(seed ^ 0x2545f491);
    const look = rng(seed ^ 0x68e31da4);
    const hair = rng(seed ^ 0x1b873593);
    const [a, b] = outlineOf[i];
    sheet(a, b, alpha.sheet, i);
    // the gap out to the next ring, or in to the core, is part of the disc too
    sheet(b, i > 0 ? outlineOf[i - 1][0] : b, 0, NO_LAYER);
    if (i === n - 1) sheet(circle(0), a, 0, NO_LAYER);
    // no line marks where it ends: its neurons and its faint sheet do (Alexander,
    // 2026-11-16: "Let's try removing the lines delimiting the collections")
    const pts: Sample[] = [];
    for (let k = 0; k < N; k++) pts.push(sample(i, s));
    P[i] = pts;
    if (N === 0) continue;
    yield at(0.3);
    const spacing = Math.sqrt((Math.PI * (outer[i] * outer[i] - inner[i] * inner[i])) / N);

    // which of them the period touched: patches, not confetti
    const state = new Uint8Array(N);
    const mark = (share: number, code: number, floor: number) => {
      const want = clamp(
        Math.round(N * share),
        Math.min(Math.ceil(N * 0.2), floor),
        Math.ceil(N * 0.3),
      );
      if (!(share > 0) || want === 0) return;
      const centers = [0, 1, 2]
        .slice(0, 1 + (N > 200 ? 1 : 0) + (N > 3000 ? 1 : 0))
        .map(() => pts[Math.floor(marks() * N)].p);
      const byDistance = pts
        .map((q, k): [number, number] => [
          Math.min(...centers.map((c) => V.len(V.sub(q.p, c)))) * (0.6 + marks() * 0.8),
          k,
        ])
        .sort((x, y) => x[0] - y[0]);
      for (let k = 0, m = 0; k < N && m < want * 0.75; k++) {
        const index = byDistance[k][1];
        if (!state[index]) {
          state[index] = code;
          m++;
        }
      }
      for (let m = 0, tries = 0; m < want * 0.25 && tries < N * 4; tries++) {
        const k = Math.floor(marks() * N);
        if (!state[k]) {
          state[k] = code;
          m++;
        }
      }
    };
    const [imports, writes, queries] = cs[i].activity;
    const items = Math.max(1, cs[i].items);
    mark(Math.min(imports / items, 0.3), 1, 5);
    mark(Math.min(writes / items, 0.3), 2, 3);
    mark(Math.min((queries / items) * 0.12, 0.1), 3, 3);
    yield at(0.5);

    const dense = clamp(1 - spacing / (unit * 0.08), 0, 1);
    const base = alpha.dot * (1 - (palette.light ? 0.56 : 0.4) * dense);
    // the neurons drawn with dendrites, where the collection's records are linked at all
    const detail =
      edgesInside[i] > 0
        ? Math.min(
            Math.ceil(N * 0.16) + 2,
            N,
            Math.round((portrait ? 26 : 60) * (0.35 + 0.65 * (1 - dense))),
          )
        : 0;
    for (let k = 0; k < N; k++) {
      const q = pts[k];
      const hub = k < detail;
      const r3 = look();
      const grow = look();
      const shade = look();
      const phase = look();
      const size =
        clamp(spacing * 0.2, unit * 0.0022, unit * 0.0072) *
        (hub ? 1.6 + grow * 0.8 : 0.6 + 0.9 * r3 * r3 * r3) *
        (portrait ? 0.62 : 1);
      const touched = state[k];
      const col = touched ? palette.logs[touched - 1] : ink;
      B.point(
        q.p,
        col,
        touched ? Math.min(1, base * 1.4 + 0.2) : base * (0.55 + 0.45 * shade),
        size * (touched ? 1.25 : 1),
        i,
        touched ? 1 : 0,
        phase,
      );
      if (hub) {
        const length = clamp(spacing * 0.9, unit * 0.02, unit * 0.09) * (0.7 + hair() * 0.5);
        dendrites(B, q, length, col, alpha.line * 2.6, hair, i);
      }
    }
    yield at(0.7);

    // As many lines as the collection has links, up to its share of what a frame can draw.
    const M = Math.min(
      N,
      Math.round((lineBudget * 0.55 * Math.sqrt(N)) / rootSum) + 12,
      edgesInside[i] + 1,
    );
    if (M < 2) continue;
    const cell = spacing * Math.sqrt(N / M) * 1.8;
    const grid = new Map<string, number[]>();
    const cellOf = (p: Vec3) => p.map((x) => Math.floor(x / cell)) as Vec3;
    for (let k = 0; k < M; k++) {
      const key = cellOf(pts[k].p).join(",");
      const bucket = grid.get(key);
      if (bucket) bucket.push(k);
      else grid.set(key, [k]);
    }
    const lineAlpha = alpha.line * (1 - 0.5 * dense);
    const join = (k: number, j: number, lineK: number, width: number, seed: number) => {
      const curve = organic(pts[k].p, pts[j].p, s);
      B.curve(curve, STRETCHES, ink, lineAlpha * lineK, width, seed, 1, 1, i);
      drawn(i, i, { curve, tier: RINGS });
      for (const [from, to, along] of [
        [k, j, curve],
        [j, k, back(curve)],
      ] as const) {
        const list = linked[i].get(from);
        if (list) list.push([to, along]);
        else linked[i].set(from, [[to, along]]);
      }
    };
    for (let k = 0; k < M; k++) {
      const p = pts[k].p;
      const [cx, cy, cz] = cellOf(p);
      let best = -1;
      let bestDistance = 1e9;
      let second = -1;
      let secondDistance = 1e9;
      for (let x = -1; x <= 1; x++) {
        for (let y = -1; y <= 1; y++) {
          for (let z = -1; z <= 1; z++) {
            for (const j of grid.get(`${cx + x},${cy + y},${cz + z}`) ?? []) {
              if (j === k) continue;
              const distance = V.len(V.sub(pts[j].p, p));
              if (distance < bestDistance) {
                second = best;
                secondDistance = bestDistance;
                best = j;
                bestDistance = distance;
              } else if (distance < secondDistance) {
                second = j;
                secondDistance = distance;
              }
            }
          }
        }
      }
      if (best > k || (best >= 0 && s() < 0.3)) join(k, best, 1, 0.9, s() < 0.22 ? s() : -1);
      if (second > k && s() < 0.55) join(k, second, 0.8, 0.8, s() < 0.15 ? s() : -1);
    }
  }

  // ---- the grooves between the folds: the field's zero line, traced cell by
  // cell across a grid and kept where it runs inside a ring ----
  const cell = Ro / (portrait ? 44 : 64);
  const span = Math.ceil((Ro * 1.03) / cell);
  const side = 2 * span + 1;
  const grid = new Float32Array(side * side);
  for (let ix = 0; ix < side; ix++) {
    for (let iz = 0; iz < side; iz++) {
      grid[ix * side + iz] = folds((ix - span) * cell, (iz - span) * cell);
    }
  }
  /** The ring a place of the plane is in, or -1. */
  const ringAt = (x: number, z: number) => {
    const radius = Math.hypot(x, z);
    const angle = Math.atan2(z, x);
    for (let i = 0; i < n; i++) {
      if (radius > outer[i] + sway[i] || radius < inner[i] - sway[i]) continue;
      if (radius > edge(i, -1, angle) && radius < edge(i, 1, angle)) return i;
    }
    return -1;
  };
  yield 0.88;
  const CORNERS = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (let ix = 0; ix < side - 1; ix++) {
    for (let iz = 0; iz < side - 1; iz++) {
      // where the zero line crosses this cell's four sides
      const crossings: [number, number][] = [];
      for (let c = 0; c < 4; c++) {
        const [ax, az] = CORNERS[c];
        const [bx, bz] = CORNERS[(c + 1) % 4];
        const a = grid[(ix + ax) * side + iz + az];
        const b = grid[(ix + bx) * side + iz + bz];
        if (a > 0 === b > 0) continue;
        const t = a / (a - b);
        crossings.push([
          (ix - span + ax + (bx - ax) * t) * cell,
          (iz - span + az + (bz - az) * t) * cell,
        ]);
      }
      for (let c = 0; c + 1 < crossings.length; c += 2) {
        const [px, pz] = crossings[c];
        const [qx, qz] = crossings[c + 1];
        const i = ringAt((px + qx) / 2, (pz + qz) / 2);
        if (i < 0 || shown[i] === 0) continue;
        const floor = (0.5 - DIP) * height[i];
        B.seg(
          [px, floor, pz],
          [qx, floor, qz],
          ink,
          alpha.edge * (palette.light ? 0.6 : 0.9),
          1,
          0,
          1,
          -1,
          i,
        );
      }
    }
  }

  yield 0.94;

  // ---- synapses between collections: the more links, the more arcs, over the rings ----
  const across = data.links.filter(([a, b]) => a !== b && shown[a] > 0 && shown[b] > 0);
  const mostAcross = Math.max(1, ...across.map((link) => link[2]));
  const turnBetween = (a: Vec3, b: Vec3) => {
    const la = Math.hypot(a[0], a[2]) || 1;
    const lb = Math.hypot(b[0], b[2]) || 1;
    return Math.hypot(a[0] / la - b[0] / lb, a[2] / la - b[2] / lb);
  };
  for (const [a, b, count] of across) {
    const arcs = clamp(
      Math.round(
        Math.sqrt(count / mostAcross) *
          (portrait ? 6 : 10) *
          Math.min(1, Math.min(shown[a], shown[b]) / 24),
      ),
      1,
      count,
    );
    for (let k = 0; k < arcs; k++) {
      const from = P[a][Math.floor(rnd() * P[a].length)].p;
      let to = P[b][0].p;
      let nearest = 1e9;
      for (let j = 0; j < 14; j++) {
        const candidate = P[b][Math.floor(rnd() * P[b].length)].p;
        const turn = turnBetween(from, candidate);
        if (turn < nearest) {
          nearest = turn;
          to = candidate;
        }
      }
      const lift: Vec3 = [0, V.len(V.sub(from, to)) * 0.22, 0];
      const curve: Curve = [
        from,
        V.add(V.lerp(from, to, 0.3), lift),
        V.add(V.lerp(from, to, 0.7), lift),
        to,
      ];
      tiers[OVER].curve(curve, 14, ink, alpha.line * 1.25, 0.9, rnd(), 1, 1, a, b);
      drawn(a, b, { curve, tier: OVER });
    }
  }

  // ---- the core: the constitution every collection answers to, a small sphere
  // folded like a cerebellum (Alexander, 2026-11-16: "make it a small sphere with
  // the texture of a cerbellum"). Fine folds lie side by side from pole to pole,
  // every few a deeper fissure, and kink where the halves meet, over a body that
  // reads as solid. The engine shows only the side facing the camera. ----
  const core = 0.65 * kk;
  // in the queries' green: the constitution is mostly read (Alexander, 2026-11-16:
  // "Given that the constituion is mostly reads, render it green instead")
  const green = palette.logs[2];
  const on = (lat: number, lon: number): Vec3 => [
    Math.cos(lat) * Math.cos(lon) * core,
    Math.sin(lat) * core,
    Math.cos(lat) * Math.sin(lon) * core,
  ];
  for (let a = 0; a < CORE_BODY[0]; a++) {
    const lat0 = -Math.PI / 2 + (a / CORE_BODY[0]) * Math.PI;
    const lat1 = -Math.PI / 2 + ((a + 1) / CORE_BODY[0]) * Math.PI;
    for (let b = 0; b < CORE_BODY[1]; b++) {
      const lon0 = (b / CORE_BODY[1]) * TAU;
      const lon1 = ((b + 1) / CORE_BODY[1]) * TAU;
      B.triangle(on(lat0, lon0), on(lat1, lon0), on(lat1, lon1), green, alpha.core, CORE);
      B.triangle(on(lat0, lon0), on(lat1, lon1), on(lat0, lon1), green, alpha.core, CORE);
    }
  }
  for (let j = 0; j < FOLIA; j++) {
    const lat = -1.42 + (2.84 * (j + 0.5)) / FOLIA;
    const fissure = j % 6 === 3;
    const fold: Vec3[] = [];
    for (let q = 0; q < 96; q++) {
      const lon = (q / 96) * TAU;
      // where the two halves meet, every fold dips towards the pole below it
      const seam = Math.exp(-(Math.sin(lon) ** 2) / 0.05);
      fold.push(
        on(
          lat +
            0.02 * Math.sin(4 * lon + j * 1.7) +
            0.008 * Math.sin(11 * lon + j * 2.3) -
            0.07 * seam * Math.cos(lat),
          lon,
        ),
      );
    }
    B.loop(fold, green, fissure ? alpha.fissure : alpha.folium, fissure ? 1.5 : 1, CORE);
  }
  // ---- people, agents and integrations. Integrations hang below the rings. A
  // handful of people float above them, a crowd in rows outside them, and each
  // person's agents ring them.
  const actors = data.actors;
  const crowd = actors.length > CROWD;
  // The frame is fitted to the rings (and a crowd's rows) as the camera sees them:
  // what hangs below stays within that outline, so it never drops out of the picture.
  const Rx = crowd ? Ro * 1.3 : Ro;
  // the camera's original angle, back after a lower one was tried (Alexander,
  // 2026-11-16: "In ref to the angle, let's go back to the original angle we had by default")
  const elevation = portrait ? 0.6 : 0.46;
  // integrations hang clear of the tallest ring; people and agents float clear above it
  const below = Math.max(Ro * BELOW, top + Ro * CLEAR);
  /** How far out what hangs below may sit and still show inside the frame. */
  const inFrame = Rx - below / Math.tan(elevation);
  /** Who circles a person, and where among that person's agents. */
  const circles = actors.map((a) =>
    a.kind === "agent" && actors[a.owner]?.kind === "person" ? a.owner : -1,
  );
  // People stand at one height over the rings, evenly round a circle (a crowd's in
  // rows of circles, all at that height), and the integrations at one height under
  // them, evenly round a circle of their own (Alexander, 2026-11-16: "distribute the
  // integrators at the bottom in an imaginary circle so that, if there are three, each
  // one of them is going to be 120° separate from the others. Also, let's distribute
  // the users on an imaginary circle on the top").
  const level = (i: number) => (actors[i].kind === "integration" ? "integration" : "person");
  const total = { person: 0, integration: 0 };
  actors.forEach((_, i) => {
    if (circles[i] < 0) total[level(i)]++;
  });
  const PEOPLE_AT = crowd ? top + Ro * 0.06 : top + Ro * 0.22;
  /** The circles people stand on: each its radius and how many stand on it. */
  const rows: { radius: number; count: number }[] = [];
  if (!crowd) rows.push({ radius: Ro * 0.62, count: total.person });
  else {
    // rows outside the rings, as many round each as stand apart by a gap
    for (let left = total.person, k = 0; left > 0; k++) {
      const radius = Ro * (1.1 + 0.08 * k);
      const count = Math.min(left, Math.floor((TAU * radius) / (Ro * 0.06)));
      rows.push({ radius, count });
      left -= count;
    }
  }
  const rank = { person: 0, integration: 0 };
  const stands = actors.map((_, i): Vec3 => {
    if (circles[i] >= 0) return [0, 0, 0];
    const j = rank[level(i)]++;
    if (level(i) === "integration") {
      const radius = Math.min(Ro * 0.55, inFrame);
      const angle = 2.2 + (j * TAU) / total.integration;
      return [Math.cos(angle) * radius, -below, Math.sin(angle) * radius];
    }
    let k = 0;
    let on = j;
    while (k < rows.length - 1 && on >= rows[k].count) on -= rows[k++].count;
    const { radius, count } = rows[k];
    const angle = 0.6 + 0.37 * k + (on * TAU) / Math.max(1, count);
    return [Math.cos(angle) * radius, PEOPLE_AT, Math.sin(angle) * radius];
  });
  // A mark's size is how much its actor did; a person's is larger than an agent's.
  const most = Math.max(1, ...actors.map((a) => a.count));
  const weight = actors.map((a) => a.count / most);
  const SIZE = crowd
    ? { person: [0.0045, 0.014], agent: [0.0022, 0.006], integration: [0.016, 0] }
    : { person: [0.015, 0], agent: [0.008, 0], integration: [0.016, 0] };
  const actorSize = actors.map(
    (a, i) =>
      unit * (SIZE[a.kind][0] + SIZE[a.kind][1] * Math.sqrt(weight[i])) * (portrait ? 0.8 : 1),
  );
  const actorShape = actors.map((a) => SHAPE[a.kind]);
  // Badges: the integrations and the busiest few keep theirs on show (the server
  // sends the busiest first), and an agent while its person does; everyone else
  // shows one while acting.
  const keep = crowd
    ? { person: portrait ? 2 : 4, integration: 9 }
    : { person: Number.POSITIVE_INFINITY, integration: Number.POSITIVE_INFINITY };
  const seen = { person: 0, integration: 0 };
  // an agent has a badge while its person does; one with no person is nobody to draw
  const named = actors.map((a) => a.kind !== "agent" && seen[a.kind]++ < keep[a.kind]);
  circles.forEach((owner, i) => {
    if (owner >= 0) named[i] = named[owner];
  });
  // A person's agents share one orbit, evenly spaced round it, level with the rings and
  // close about the person (Alexander, 2026-11-16: "The orbits of the agents around each
  // user need to be parallel to the orbit of the galaxy. They need to be closer to the
  // person."), yet clear of them ("Separate the moons from the planets a bit more"), a
  // little wider about a person with a badge, whose badge is larger than a mark. They go round as fast as the rings turn.
  const ringOf = new Map<number, number[]>();
  circles.forEach((owner, i) => {
    if (owner >= 0) ringOf.set(owner, [...(ringOf.get(owner) ?? []), i]);
  });
  const ring = (owner: number) => {
    const count = ringOf.get(owner)?.length ?? 0;
    return {
      radius:
        Ro * (named[owner] ? 0.06 + 0.004 * Math.max(0, count - 4) : 0.024) * (portrait ? 0.8 : 1),
      phase: hash(owner * 3.1 + 5) * TAU,
    };
  };
  const rings = new Map([...ringOf.keys()].map((owner) => [owner, ring(owner)]));
  /** A point of a person's orbit, `a` radians round it. */
  const onRing = (owner: number, a: number): Vec3 => {
    const { radius } = rings.get(owner) ?? ring(owner);
    const [x, y, z] = stands[owner];
    return [x + Math.cos(a) * radius, y, z + Math.sin(a) * radius];
  };
  const at = (actor: number, seconds: number): Vec3 => {
    // one the picture was not built with (its data came ahead of it) stands at the middle
    const owner = circles[actor] ?? -1;
    if (owner < 0) return stands[actor] ?? [0, Ro * 0.3, 0];
    const mates = ringOf.get(owner) ?? [actor];
    const o = rings.get(owner) ?? ring(owner);
    return onRing(owner, o.phase + (mates.indexOf(actor) * TAU) / mates.length + seconds * TURN);
  };
  // the orbits, hairlines standing with their people (Alexander, 2026-11-16: "The orbit
  // needs to be more subtle, just a very thin line")
  for (const owner of ringOf.keys()) {
    const steps = named[owner] ? 48 : 24;
    tiers[tierAt(stands[owner])].loop(
      Array.from({ length: steps }, (_, k) => onRing(owner, (k * TAU) / steps)),
      ink,
      named[owner] ? 0.14 : 0.07,
      0.6,
      // it comes in with the moons
      SHAPE.agent,
    );
  }
  const markAlpha = (i: number) => 0.5 + 0.45 * Math.sqrt(weight[i]);
  // Everyone without a standing badge is a mark; a badge is drawn by the page. The
  // agents circling a person move, so the page draws their marks each frame.
  actors.forEach((a, i) => {
    if (named[i] || a.kind === "agent") return;
    tiers[tierAt(stands[i])].point(
      stands[i],
      ink,
      markAlpha(i),
      actorSize[i],
      actorShape[i],
      0,
      rnd(),
    );
  });
  const moving = (seconds: number, into: Tiers) => {
    circles.forEach((owner, i) => {
      if (owner < 0 || named[i]) return;
      into[tierAt(stands[owner])].point(
        at(i, seconds),
        ink,
        markAlpha(i),
        actorSize[i],
        actorShape[i],
        0,
        0.5,
      );
    });
  };

  // ---- the path an event takes. Nothing of it stands in the picture: the page
  // draws it while the event travels (Alexander, 2026-11-15: "The connections
  // between users, agents, and sources of data being imported should be
  // temporary").
  const wired = linked.map((neighbours) => [...neighbours.keys()]);
  const strand = (actor: number, collection: number, pick: number): OrbitStrand => {
    const from = at(actor, 0);
    const onRing = collection >= 0 && collection < n && shown[collection] > 0;
    let land: Vec3 = [0, 0, 0];
    const wave: Curve[][] = [];
    if (onRing) {
      // on a neuron that has synapses, where the collection has any, so it has somewhere to fire
      const pts = P[collection];
      const among = (count: number) => Math.min(count - 1, Math.floor(pick * count));
      const candidates = wired[collection];
      const neuron =
        candidates.length > 0 ? candidates[among(candidates.length)] : among(pts.length);
      land = pts[neuron].p;
      let firing = [neuron];
      const fired = new Set(firing);
      for (const reach of REACH) {
        const hop: Curve[] = [];
        const next: number[] = [];
        for (const k of firing) {
          const neighbours = (linked[collection].get(k) ?? []).filter(([j]) => !fired.has(j));
          for (const [j, curve] of neighbours.slice(0, reach)) {
            fired.add(j);
            next.push(j);
            hop.push(curve);
          }
        }
        if (hop.length === 0) break;
        wave.push(hop);
        firing = next;
      }
    }
    return {
      actor,
      tier: tierAt(from),
      land,
      layer: onRing ? collection : NO_LAYER,
      wave,
    };
  };
  /** The curve from an actor to where it lands: it bows away from the rings on its
   *  actor's side, down from above, up from beneath. */
  function bowed(from: Vec3, land: Vec3): Curve {
    const bow =
      (from[1] < 0 ? -1 : 1) *
      (Math.max(Math.abs(from[1]), Ro * 0.16) * 0.5 +
        Math.hypot(from[0] - land[0], from[2] - land[2]) * 0.12);
    return [
      from,
      [
        from[0] + (land[0] - from[0]) * 0.12,
        from[1] * 0.5 + bow,
        from[2] + (land[2] - from[2]) * 0.12,
      ],
      [land[0] + (from[0] - land[0]) * 0.25, land[1] + bow, land[2] + (from[2] - land[2]) * 0.25],
      land,
    ];
  }

  // ---- the camera: a slow orbit that brings every part of a ring to the front ----
  const distance = portrait
    ? fit(Rx * 0.5, (Rx * Math.sin(elevation) + Ro * 0.16 + top) / 0.78, aspect)
    : fit(Rx * 1.08, (Rx * Math.sin(elevation) + Ro * 0.2 + top) / 0.84, aspect);
  const target: Vec3 = [0, portrait ? -Ro * 0.02 : -Ro * 0.05, 0];

  return {
    tiers,
    portrait,
    unit,
    core,
    fold,
    shown,
    at,
    actorSize,
    actorShape,
    named,
    moving,
    strand,
    synapse(a, b, pick) {
      const list = synapses.get(`${a}/${b}`);
      return list ? list[Math.min(list.length - 1, Math.floor(pick * list.length))] : null;
    },
    camera() {
      return {
        eye: orbitAround(target, distance, 0.74, elevation),
        target,
        fov: FOV,
        focus: distance * 0.97,
        dof: 1.1,
        fog: [distance - Rx * 0.6, distance + Rx * 3.4],
      };
    },
    // the way the camera once went round, at the same pace
    spin: (seconds) => (6 - seconds) * TURN,
    path: (strand, spin, seconds) => bowed(turn(at(strand.actor, seconds), -spin), strand.land),
  };
}

/** The way a new synapse grows from the neuron that lit to the one it finds: it sets
 *  off along the synapse it will settle into and winds about it, across and up and
 *  down, as if feeling its way, then comes in onto the other neuron (Alexander,
 *  2026-11-16: "it starts going around and looking for something until it connects
 *  to another neuron somewhere else (as if we were just tracing a path that, again,
 *  looks more organic)"). `pick` gives each new edge a way of its own. */
export function wander(c: Curve, pick: number, steps = 48): Vec3[] {
  const [a, , , b] = c;
  const length = V.len(V.sub(b, a));
  const along = V.norm(V.sub(b, a));
  const flat = Math.hypot(along[0], along[2]);
  // across the way, level, and up from it
  const across: Vec3 = flat > 1e-6 ? [-along[2] / flat, 0, along[0] / flat] : [1, 0, 0];
  const up = V.cross(across, along);
  const r = (k: number) => hash(pick * 97.3 + k * 13.1);
  const waves = [0, 1].map((k) => ({
    turns: 0.8 + 1.1 * r(k * 3 + 1),
    phase: r(k * 3 + 2) * TAU,
    reach: length * (0.09 + 0.08 * r(k * 3 + 3)),
  }));
  return Array.from({ length: steps + 1 }, (_, k): Vec3 => {
    if (k === 0) return a;
    if (k === steps) return b;
    const s = k / steps;
    // it strays most in the middle of its way, and none at either neuron
    const free = Math.sin(Math.PI * s);
    const [w0, w1] = waves.map((w) => w.reach * free * Math.sin(TAU * w.turns * s + w.phase));
    return V.add(V.add(bez(c, s), V.mul(across, w0)), V.mul(up, w1 * 0.4));
  });
}

/** A neuron's dendrites: a few forked hairs in the plane of its ring. */
function dendrites(
  B: Builder,
  q: Sample,
  length: number,
  col: Rgb,
  alpha: number,
  s: () => number,
  layer: number,
) {
  const count = 3 + Math.floor(s() * 3);
  const start = s() * TAU;
  const normal = V.cross(q.u, q.v);
  const at = (angle: number, reach: number, lift: number): Vec3 =>
    V.add(
      q.p,
      V.add(
        V.add(V.mul(q.u, Math.cos(angle) * reach), V.mul(q.v, Math.sin(angle) * reach)),
        V.mul(normal, lift),
      ),
    );
  for (let i = 0; i < count; i++) {
    const angle = start + (i * TAU) / count + (s() - 0.5) * 0.9;
    const reach = length * (0.55 + s() * 0.6);
    const mid = at(angle + (s() - 0.5) * 0.5, reach * 0.55, (s() - 0.5) * reach * 0.2);
    const end = at(angle, reach, (s() - 0.5) * reach * 0.3);
    B.seg(q.p, mid, col, alpha, 1.3, 0, 1, -1, layer);
    B.seg(mid, end, col, alpha * 0.6, 0.9, 0, 1, -1, layer);
    if (s() < 0.65) {
      B.seg(
        mid,
        at(angle + (s() < 0.5 ? 0.7 : -0.7), reach * 0.85, 0),
        col,
        alpha * 0.5,
        0.8,
        0,
        1,
        -1,
        layer,
      );
    }
  }
}
