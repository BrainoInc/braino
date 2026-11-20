// A small WebGL renderer for the Orbit page (components/orbit.tsx): soft
// points, screen-space ribbons and flat triangles, blended so that nothing in a
// tier needs sorting (multiply on a light ground, additive on a dark one). No
// library: the standing picture is three buffers sent to the graphics card
// once, plus what moves in a frame.
//
// Depth. The rings lie in a plane, so the picture has three tiers: what hangs
// under the rings, the rings, and what floats over them. The tier farthest
// from the camera is drawn first, and each nearer one first covers what is
// behind it with the ground (Alexander, 2026-11-15: "If it's below, it should
// be behind"). A neuron or a line covers as far as it is opaque, and more: a
// faint dot still hides what passes behind it. The rings' dots are too sparse
// to hide much by themselves, so the disc they lie in is a veil: its sheets
// cover VEIL of whatever is behind them, a ring or the gap between two.
// A name is an ordinary element under the canvas, seen through a hole cut once
// its tier is drawn (a plate), so whatever is nearer than the name hides it too.

export type Vec3 = [number, number, number];
export type Rgb = [number, number, number];
/** The four control points of a cubic curve. */
export type Curve = [Vec3, Vec3, Vec3, Vec3];

// ---------- math ----------

export const V = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
};

export function perspective(fovy: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ]);
}

export function lookAt(e: Vec3, c: Vec3, up: Vec3) {
  const z = V.norm(V.sub(e, c));
  const x = V.norm(V.cross(up, z));
  const y = V.cross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -V.dot(x, e),
    -V.dot(y, e),
    -V.dot(z, e),
    1,
  ]);
}

export function mat4mul(a: Float32Array, b: Float32Array) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/** The point at `s` (0 to 1) along a cubic curve. */
export function bez(c: Curve, s: number): Vec3 {
  const t = 1 - s;
  const a = t * t * t;
  const b = 3 * t * t * s;
  const d = 3 * t * s * s;
  const e = s * s * s;
  return [
    a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0],
    a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1],
    a * c[0][2] + b * c[1][2] + d * c[2][2] + e * c[3][2],
  ];
}

/** The first `s` (0 to 1) of a cubic curve, as a curve. */
export function head(c: Curve, s: number): Curve {
  const ab = V.lerp(c[0], c[1], s);
  const bc = V.lerp(c[1], c[2], s);
  const cd = V.lerp(c[2], c[3], s);
  const abc = V.lerp(ab, bc, s);
  return [c[0], ab, abc, V.lerp(abc, V.lerp(bc, cd, s), s)];
}

/** A seeded random source, so the same workspace always draws the same picture. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const gauss = (r: () => number) =>
  Math.sqrt(-2 * Math.log(1 - r() + 1e-12)) * Math.cos(6.2831853 * r());
/** `p` turned by `angle` about the core's upright axis: how the rings turn while
 *  everything else stands (the shaders' spun). */
export function turn(p: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
}

export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
export const smooth = (x: number) => {
  const c = clamp(x, 0, 1);
  return c * c * (3 - 2 * c);
};
export const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// ---------- shaders ----------

/** The layer of the core, the constitution: a sphere, so only its side facing the camera shows. */
export const CORE = -8;

const FOG = `
float fogOf(float d){ return clamp((uFog.y - d) / (uFog.y - uFog.x), 0., 1.); }`;

// How squarely a point of the core's sphere, centred on the origin, faces the camera:
// 1 at the middle of the side it sees, 0 at the rim, below 0 round the back.
const FACING = `
float facingOf(vec3 at, vec4 p){ return ((uVP * vec4(0., 0., 0., 1.)).w - p.w) / max(length(at), 1e-4); }`;

// Only the collections and the core turn (Alexander, 2026-11-16: "Make the agents,
// people, and the integration providers static, meaning only the collections are
// the ones rotating"): a mark (a layer code below -19) stands; everything else is
// turned by uSpin about the core's upright axis, as turn() does.
const SPIN = `
uniform float uSpin;
vec3 spun(vec3 p, float layer){
  if (layer < -19.5) return p;
  float c = cos(uSpin), s = sin(uSpin);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}`;

// The picture comes in in order the first time it stands (lib/orbit.ts: risingFrom):
// its rings one at a time from the constitution outward, a ring not yet risen hidden
// and the one rising fading in; then the planets, people and integrations, as the
// layer after the last ring; then the moons, agents and their orbits, as the one
// after them (lib/orbit.ts: risenFor). What belongs to no ring and no one stands
// from the start.
const RISE = `
uniform float uFrom;
float risen(float layer){
  if (layer < -19.5) return clamp((abs(layer + 21.) < .5 ? -1. : 0.) - uFrom, 0., 1.);
  return layer < -.5 ? 1. : clamp(layer + 1. - uFrom, 0., 1.);
}`;

/** How much of what is behind the rings' disc its sheets hide. */
const VEIL = 0.62;
/** How much more a dot or a line covers than its own ink shows. */
const COVER = { points: 3, ribbons: 1.5, sheets: 1 };

// A fragment lays its ink (multiplied onto a light ground, added to a dark one)
// or, in a tier's first pass (uCover above 0, the gain), covers what is behind
// it with the ground.
const INK = `
uniform float uLight, uCover; uniform vec3 uBg;
vec4 cover(float a){ a = clamp(a, 0., 1.); return vec4(uBg * a, a); }
vec4 ink(vec3 col, float a){
  return uCover > 0. ? cover(a * uCover) : vec4(mix(vec3(uLight), col, clamp(a, 0., 1.)), 1.);
}`;

const POINT_VS = `
attribute vec3 aPos; attribute vec4 aCol; attribute vec4 aMisc;
uniform mat4 uVP; uniform float uTime, uPx, uFocus, uDof, uDpr; uniform mediump float uHalo; uniform vec2 uFog, uNear;
uniform float uHi, uHiK;
varying vec4 vCol; varying float vBlur, vShape, vPx;
${FOG}${RISE}${SPIN}
void main(){
  vec4 p = uVP * vec4(spun(aPos, aMisc.z), 1.);
  float d = p.w;
  vec3 col = aCol.rgb; float a = aCol.a * risen(aMisc.z); float size = aMisc.x;
  // layer codes below -19 are marks: 1 a person (ring), 2 an agent (diamond), 3 an integration (square)
  float shape = aMisc.z < -19.5 ? -aMisc.z - 19. : 0.;
  // at rest a neuron flickers by itself, and slow waves cross the whole cortex
  float rest = .84 + .08 * sin(uTime * .9 + aMisc.y * 6.283) + .1 * sin(uTime * .5 - dot(aPos.xz, vec2(7., 4.)) / uFocus);
  float live = aMisc.w;
  a *= mix(rest, .7 + .3 * sin(uTime * 2.4 + aMisc.y * 40.), live);
  // the collection picked out keeps its light; everything else steps back
  float match = abs(aMisc.z - uHi) < .5 ? 1. : 0.;
  a *= mix(1., mix(shape > .5 ? .4 : .13, 1., match), uHiK);
  // on a dark ground light adds up, so a dense ring needs far less of a lift
  a = mix(a, min(1., a * mix(1.8, 1.12, uHalo) + mix(.12, .02, uHalo)), match * uHiK); size *= 1. + mix(.25, .08, uHalo) * match * uHiK;
  float px = size * uPx / max(d, .01) * 2.;
  float coc = shape > .5 ? 0. : clamp(abs(d - uFocus) / uFocus, 0., 2.) * uDof;
  px *= 1. + coc * 1.7;
  a /= pow(1. + coc * 1.7, 1.25);
  a *= fogOf(d);
  float m = (shape > .5 ? 4.5 : 1.5) * uDpr;
  if (px < m) { if (shape < .5) a *= (px / m) * (px / m); px = m; }
  if (shape < .5) px *= 1. + uHalo * 1.5;
  a *= smoothstep(uNear.x, uNear.y, d);
  gl_PointSize = min(px, 34. * uDpr * (1. + uHalo * .6));
  gl_Position = p;
  vCol = vec4(col, a);
  vBlur = coc; vShape = shape; vPx = gl_PointSize;
}`;

const POINT_FS = `
precision mediump float;
varying vec4 vCol; varying float vBlur, vShape, vPx; uniform float uHalo;
${INK}
void main(){
  vec2 q = gl_PointCoord * 2. - 1.; float r = length(q);
  if (vShape > .5) {
    // someone without a badge: a plain ball, lit from above
    float aa = 2.4 / vPx;
    float lit = 1.12 - .3 * length(q - vec2(-.35, -.4));
    gl_FragColor = ink(vCol.rgb * lit, vCol.a * (1. - smoothstep(.96 - aa, .96, r)));
    return;
  }
  if (r > 1.) discard;
  float edge = mix(.74, .08, clamp(vBlur, 0., 1.));
  float core = uHalo > .5 ? 1. - smoothstep(.4 * edge, .4, r) : 1. - smoothstep(edge, 1., r);
  float halo = uHalo * .22 * pow(1. - r, 2.2);
  gl_FragColor = ink(vCol.rgb, vCol.a * (core + halo));
}`;

const RIBBON_VS = `
attribute vec3 aPos; attribute vec3 aOther; attribute vec4 aCol; attribute vec4 aW; attribute vec2 aL;
uniform mat4 uVP; uniform vec2 uRes, uFog; uniform float uTime, uDpr, uHi, uHiK;
varying vec4 vCol; varying float vSide;
${FOG}${FACING}${RISE}${SPIN}
void main(){
  vec3 at = spun(aPos, aL.x);
  vec4 p = uVP * vec4(at, 1.), q = uVP * vec4(spun(aOther, aL.x), 1.);
  if (p.w < .05 || q.w < .05) { gl_Position = vec4(2., 2., 2., 1.); vCol = vec4(0.); vSide = 0.; return; }
  vec2 sp = p.xy / p.w * uRes * .5, sq = q.xy / q.w * uRes * .5;
  vec2 dir = sp - sq; float l = length(dir);
  dir = l > 1e-4 ? dir / l : vec2(1., 0.);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = aW.y * uDpr, a = aCol.a * risen(aL.x) * risen(aL.y);
  float match = (abs(aL.x - uHi) < .5 || abs(aL.y - uHi) < .5) ? 1. : 0.;
  a *= mix(1., mix(.2, 1.9, match), uHiK);
  // the core's folds round the back of its sphere are hidden by it
  if (abs(aL.x - ${CORE}.) < .5) a *= smoothstep(.02, .3, facingOf(at, p));
  float m = 1.25 * uDpr;
  if (w < m) { a *= w / m; w = m; }
  if (aW.w >= 0.) {
    float x = fract(aW.z - uTime * .22 + aW.w);
    a *= 1. + 3.5 * smoothstep(0., .05, x) * (1. - smoothstep(.05, .2, x));
  }
  float side = sign(aW.x), end = abs(aW.x) > 1.5 ? -1. : 1.;
  p.xy += nrm * side * end * (w * .5 + 1.) / (uRes * .5) * p.w;
  gl_Position = p;
  vCol = vec4(aCol.rgb, a * fogOf(p.w));
  vSide = side * (w * .5 + 1.) / (w * .5);
}`;

const RIBBON_FS = `
precision mediump float;
varying vec4 vCol; varying float vSide;
${INK}
void main(){ gl_FragColor = ink(vCol.rgb, vCol.a * (1. - smoothstep(.55, 1.25, abs(vSide)))); }`;

const TRI_VS = `
attribute vec3 aPos; attribute vec4 aCol; attribute float aL;
uniform mat4 uVP; uniform vec2 uFog; uniform float uHi, uHiK;
varying vec4 vCol;
${FOG}${FACING}${RISE}${SPIN}
void main(){
  vec3 at = spun(aPos, aL);
  vec4 p = uVP * vec4(at, 1.); gl_Position = p;
  float match = abs(aL - uHi) < .5 ? 1. : 0.;
  float a = aCol.a * risen(aL) * mix(1., mix(.45, 2.8, match), uHiK) * fogOf(p.w);
  // the core's sphere shows its near side only, fullest where it faces the camera
  if (abs(aL - ${CORE}.) < .5) a *= sqrt(max(facingOf(at, p), 0.));
  vCol = vec4(aCol.rgb, a);
}`;

const TRI_FS = `
precision mediump float;
varying vec4 vCol;
${INK}
void main(){ gl_FragColor = uCover > 0. ? cover(${VEIL}) : ink(vCol.rgb, vCol.a); }`;

// A plate: a rounded box of the picture made see-through, so the name under the canvas shows.
const PLATE_VS = `
attribute vec2 aCorner; uniform vec4 uBox; uniform vec2 uRes; varying vec2 vAt, vHalf;
void main(){
  vHalf = uBox.zw;
  vAt = aCorner * (vHalf + 1.);
  vec2 p = (uBox.xy + vAt) / uRes * 2. - 1.;
  gl_Position = vec4(p.x, -p.y, 0., 1.);
}`;

const PLATE_FS = `
precision mediump float;
varying vec2 vAt, vHalf; uniform float uRadius, uAlpha;
void main(){
  vec2 q = abs(vAt) - vHalf + uRadius;
  float d = length(max(q, 0.)) + min(max(q.x, q.y), 0.) - uRadius;
  gl_FragColor = vec4(0., 0., 0., uAlpha * clamp(.5 - d, 0., 1.));
}`;

// ---------- builder: the world pushes its geometry here ----------

/** Floats per point, per ribbon vertex and per triangle vertex. */
export const POINT_STRIDE = 11;
const RIBBON_STRIDE = 16;
const TRI_STRIDE = 8;
/** The layer of geometry that belongs to no collection. */
export const NO_LAYER = -9;

/** The picture's three tiers: under the rings, the rings, and over them. */
export const UNDER = 0;
export const RINGS = 1;
export const OVER = 2;
export type Tier = typeof UNDER | typeof RINGS | typeof OVER;
/** The geometry of each tier. */
export type Tiers = [under: Builder, rings: Builder, over: Builder];
export const emptyTiers = (): Tiers => [new Builder(), new Builder(), new Builder()];

export class Builder {
  pts: number[] = [];
  rib: number[] = [];
  tri: number[] = [];
  segments = 0;

  /** `size` in world units; `live` 0 to 1 makes it breathe; `layer` is the collection's index. */
  point(
    p: Vec3,
    col: Rgb,
    alpha: number,
    size: number,
    layer: number,
    live: number,
    phase: number,
  ) {
    this.pts.push(p[0], p[1], p[2], col[0], col[1], col[2], alpha, size, phase, layer, live);
  }

  /** `width` in CSS pixels; `t0`, `t1` place the segment along its strand for
   *  the light that travels it, and a `seed` below 0 means no light. `la`, `lb`
   *  are the collections it belongs to: one inside a ring, two across rings. */
  seg(
    a: Vec3,
    b: Vec3,
    col: Rgb,
    alpha: number,
    width: number,
    t0 = 0,
    t1 = 1,
    seed = -1,
    la: number = NO_LAYER,
    lb: number = la,
  ) {
    const r = this.rib;
    const v = (p: Vec3, o: Vec3, side: number, t: number) =>
      r.push(
        p[0],
        p[1],
        p[2],
        o[0],
        o[1],
        o[2],
        col[0],
        col[1],
        col[2],
        alpha,
        side,
        width,
        t,
        seed,
        la,
        lb,
      );
    // side is ±1 at the segment's start and ±2 at its end, so both ends agree on which side is which
    v(a, b, 1, t0);
    v(a, b, -1, t0);
    v(b, a, 2, t1);
    v(a, b, -1, t0);
    v(b, a, -2, t1);
    v(b, a, 2, t1);
    this.segments++;
  }

  curve(
    c: Curve,
    n: number,
    col: Rgb,
    alpha: number,
    width: number,
    seed: number,
    a0: number,
    a1: number,
    la: number,
    lb: number = la,
  ) {
    let prev = c[0];
    for (let i = 1; i <= n; i++) {
      const s = i / n;
      const p = bez(c, s);
      const k = a0 + (a1 - a0) * (s - 0.5 / n);
      this.seg(prev, p, col, alpha * k, width, (i - 1) / n, s, seed, la, lb);
      prev = p;
    }
  }

  /** A closed outline. */
  loop(ps: Vec3[], col: Rgb, alpha: number, width: number, layer: number = NO_LAYER) {
    for (let i = 0; i < ps.length; i++) {
      this.seg(ps[i], ps[(i + 1) % ps.length], col, alpha, width, 0, 1, -1, layer);
    }
  }

  triangle(a: Vec3, b: Vec3, c: Vec3, col: Rgb, alpha: number, layer: number) {
    for (const p of [a, b, c]) {
      this.tri.push(p[0], p[1], p[2], col[0], col[1], col[2], alpha, layer);
    }
  }
}

// ---------- renderer ----------

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  attributes: Record<string, number>;
}

/** A name's box on the page, in CSS pixels from the canvas's corner: the
 *  picture is cut away there once the name's tier is drawn, as far as `alpha`. */
export interface Plate {
  tier: Tier;
  /** Its center. */
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  alpha: number;
}

export interface Frame {
  vp: Float32Array;
  time: number;
  /** Pixels per world unit at distance 1. */
  px: number;
  focus: number;
  dof: number;
  fog: [number, number];
  near: [number, number];
  /** A light ground multiplies ink onto it; a dark one adds light. */
  light: boolean;
  bg: Rgb;
  /** The camera is under the rings' plane, so what hangs under them is nearest. */
  below: boolean;
  /** What moves this frame, by tier: pulses, the connections they travel, neurons firing, a new synapse lighting. */
  live: Tiers;
  plates: Plate[];
  dpr: number;
  /** The collection picked out, and how far the picture has eased towards it (0 to 1). */
  hi: number;
  hiK: number;
  /** The layer not yet risen, the rings counted from the outside, then the planets
   *  and the moons: those under it are hidden, and ORBIT_RISEN shows everything
   *  (lib/orbit.ts: risingFrom). */
  from: number;
  /** How far the rings have turned (radians): see SPIN. */
  spin: number;
}

type Layout = [name: string, size: number, offset: number][];
const POINT_LAYOUT: Layout = [
  ["aPos", 3, 0],
  ["aCol", 4, 3],
  ["aMisc", 4, 7],
];
const RIBBON_LAYOUT: Layout = [
  ["aPos", 3, 0],
  ["aOther", 3, 3],
  ["aCol", 4, 6],
  ["aW", 4, 10],
  ["aL", 2, 14],
];
const TRI_LAYOUT: Layout = [
  ["aPos", 3, 0],
  ["aCol", 4, 3],
  ["aL", 1, 7],
];
const PLATE_LAYOUT: Layout = [["aCorner", 2, 0]];

/** Where each tier's vertices start in a buffer, and how many it has. */
type Spans = [first: number, count: number][];

/** The three tiers' numbers of one kind, end to end. */
function pack(tiers: Tiers, kind: "pts" | "rib" | "tri", stride: number) {
  const data = new Float32Array(tiers.reduce((sum, tier) => sum + tier[kind].length, 0));
  const spans: Spans = [];
  let at = 0;
  for (const tier of tiers) {
    data.set(tier[kind], at);
    spans.push([at / stride, tier[kind].length / stride]);
    at += tier[kind].length;
  }
  return { data, spans };
}

const NONE: Spans = [
  [0, 0],
  [0, 0],
  [0, 0],
];

export class Renderer {
  private gl: WebGLRenderingContext;
  private points: Program;
  private ribbons: Program;
  private triangles: Program;
  private plate: Program;
  private buffers: Record<
    "pts" | "rib" | "tri" | "livePts" | "liveRib" | "corners",
    WebGLBuffer | null
  >;
  private spans = { pts: NONE, rib: NONE, tri: NONE };

  /** Throws where WebGL is not available. */
  constructor(private canvas: HTMLCanvasElement) {
    // The canvas is see-through only where a plate is cut, for the name under it.
    const gl = canvas.getContext("webgl", {
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    this.points = this.compile(POINT_VS, POINT_FS);
    this.ribbons = this.compile(RIBBON_VS, RIBBON_FS);
    this.triangles = this.compile(TRI_VS, TRI_FS);
    this.plate = this.compile(PLATE_VS, PLATE_FS);
    this.buffers = {
      pts: gl.createBuffer(),
      rib: gl.createBuffer(),
      tri: gl.createBuffer(),
      livePts: gl.createBuffer(),
      liveRib: gl.createBuffer(),
      corners: gl.createBuffer(),
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }

  private compile(vs: string, fs: string): Program {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new Error("WebGL is not available");
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vs],
      [gl.FRAGMENT_SHADER, fs],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("WebGL is not available");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? "A shader did not compile");
      }
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "A program did not link");
    }
    const uniforms: Program["uniforms"] = {};
    const attributes: Program["attributes"] = {};
    const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < uniformCount; i++) {
      const name = gl.getActiveUniform(program, i)?.name.replace("[0]", "");
      if (name) uniforms[name] = gl.getUniformLocation(program, name);
    }
    const attributeCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
    for (let i = 0; i < attributeCount; i++) {
      const name = gl.getActiveAttrib(program, i)?.name;
      if (name) attributes[name] = gl.getAttribLocation(program, name);
    }
    return { program, uniforms, attributes };
  }

  /** Send the world's geometry to the graphics card: once per world. */
  upload(tiers: Tiers) {
    const gl = this.gl;
    const send = (buffer: WebGLBuffer | null, kind: "pts" | "rib" | "tri", stride: number) => {
      const { data, spans } = pack(tiers, kind, stride);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return spans;
    };
    this.spans = {
      pts: send(this.buffers.pts, "pts", POINT_STRIDE),
      rib: send(this.buffers.rib, "rib", RIBBON_STRIDE),
      tri: send(this.buffers.tri, "tri", TRI_STRIDE),
    };
  }

  private bind(p: Program, layout: Layout, stride: number) {
    const gl = this.gl;
    for (let i = 0; i < 8; i++) gl.disableVertexAttribArray(i);
    for (const [name, size, offset] of layout) {
      const location = p.attributes[name];
      if (location === undefined || location < 0) continue;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride * 4, offset * 4);
    }
  }

  draw(f: Frame) {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(f.bg[0], f.bg[1], f.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // ---- what every pass of this frame shares ----
    for (const p of [this.triangles, this.ribbons, this.points]) {
      const u = p.uniforms;
      gl.useProgram(p.program);
      gl.uniformMatrix4fv(u.uVP, false, f.vp);
      gl.uniform2f(u.uFog, f.fog[0], f.fog[1]);
      gl.uniform1f(u.uLight, f.light ? 1 : 0);
      gl.uniform3f(u.uBg, f.bg[0], f.bg[1], f.bg[2]);
      gl.uniform1f(u.uHi, f.hi);
      gl.uniform1f(u.uHiK, f.hiK);
      gl.uniform1f(u.uTime, f.time);
      gl.uniform1f(u.uDpr, f.dpr);
      gl.uniform1f(u.uFrom, f.from);
      gl.uniform1f(u.uSpin, f.spin);
    }
    gl.useProgram(this.ribbons.program);
    gl.uniform2f(this.ribbons.uniforms.uRes, w, h);
    const u = this.points.uniforms;
    gl.useProgram(this.points.program);
    gl.uniform1f(u.uPx, f.px);
    gl.uniform1f(u.uFocus, f.focus);
    gl.uniform1f(u.uDof, f.dof);
    gl.uniform1f(u.uHalo, f.light ? 0 : 1);
    gl.uniform2f(u.uNear, f.near[0], f.near[1]);

    const live = {
      pts: pack(f.live, "pts", POINT_STRIDE),
      rib: pack(f.live, "rib", RIBBON_STRIDE),
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.livePts);
    gl.bufferData(gl.ARRAY_BUFFER, live.pts.data, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.liveRib);
    gl.bufferData(gl.ARRAY_BUFFER, live.rib.data, gl.DYNAMIC_DRAW);

    /** One tier's geometry: its ink, or (cover) the ground over what is behind it. */
    const lay = (tier: Tier, cover: boolean) => {
      const some = (
        p: Program,
        layout: Layout,
        stride: number,
        mode: number,
        gain: number,
        sources: [buffer: WebGLBuffer | null, spans: Spans][],
      ) => {
        let used = false;
        for (const [buffer, spans] of sources) {
          const [first, count] = spans[tier];
          if (count === 0) continue;
          if (!used) {
            gl.useProgram(p.program);
            gl.uniform1f(p.uniforms.uCover, cover ? gain : 0);
            used = true;
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          this.bind(p, layout, stride);
          gl.drawArrays(mode, first, count);
        }
      };
      some(this.triangles, TRI_LAYOUT, TRI_STRIDE, gl.TRIANGLES, COVER.sheets, [
        [this.buffers.tri, this.spans.tri],
      ]);
      some(this.ribbons, RIBBON_LAYOUT, RIBBON_STRIDE, gl.TRIANGLES, COVER.ribbons, [
        [this.buffers.rib, this.spans.rib],
        [this.buffers.liveRib, live.rib.spans],
      ]);
      some(this.points, POINT_LAYOUT, POINT_STRIDE, gl.POINTS, COVER.points, [
        [this.buffers.pts, this.spans.pts],
        [this.buffers.livePts, live.pts.spans],
      ]);
    };

    // ---- the tiers, the farthest first ----
    const order: Tier[] = f.below ? [OVER, RINGS, UNDER] : [UNDER, RINGS, OVER];
    order.forEach((tier, i) => {
      if (i > 0) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        lay(tier, true);
      }
      // ink never closes a plate cut before it: the picture's own alpha is left alone
      if (f.light) gl.blendFuncSeparate(gl.ZERO, gl.SRC_COLOR, gl.ZERO, gl.ONE);
      else gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      lay(tier, false);
      const plates = f.plates.filter((plate) => plate.tier === tier && plate.alpha > 0.004);
      if (plates.length === 0) return;
      const p = this.plate;
      gl.useProgram(p.program);
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform2f(p.uniforms.uRes, w, h);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.corners);
      this.bind(p, PLATE_LAYOUT, 2);
      for (const plate of plates) {
        const halfW = (plate.width / 2) * f.dpr;
        const halfH = (plate.height / 2) * f.dpr;
        gl.uniform4f(p.uniforms.uBox, plate.x * f.dpr, plate.y * f.dpr, halfW, halfH);
        gl.uniform1f(p.uniforms.uRadius, Math.min(plate.radius * f.dpr, halfW, halfH));
        gl.uniform1f(p.uniforms.uAlpha, plate.alpha);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    });
  }

  /** Give the graphics card its memory back when the page is left. The context
   *  itself is the canvas's, which may be drawn on again (React mounts an
   *  effect twice in development), so it is left alive. */
  dispose() {
    const gl = this.gl;
    for (const buffer of Object.values(this.buffers)) gl.deleteBuffer(buffer);
    for (const p of [this.points, this.ribbons, this.triangles, this.plate]) {
      gl.deleteProgram(p.program);
    }
  }
}
