// Orbit, on the workspace home (/workspaces/<handle>): a workspace drawn as a brain,
// rings of neurons folded like a cortex around its constitution, and a
// timeline bar that replays a period of its activity
// (decision_01M7FT0GGYWZ8E2CKABFKB4YZV).
//
// The picture is one canvas (orbit-engine.ts draws what orbit-world.ts builds).
// Over it, as ordinary elements: each collection's title in a column at the
// edge, the largest first, with no line out to its ring, and left of its name
// a globe or a padlock for whether it is public or private (Alexander,
// 2026-11-19: "Add an icon on the left of each to denote if the collection is
// private or public."). The page's header
// names the workspace, so the picture has no heading of its own (Alexander,
// 2026-11-15, asked for the band of name, totals and activity sums over it to
// go). Under
// it: a chip for each person, agent and integration whose name is on show. A
// chip is part of the picture's depth: the canvas is cut away over it once its
// tier is drawn, so Slack, which hangs under the rings, sits behind their
// neurons, and a person over the rings sits in front of them. A title opens
// its collection; hovering or focusing it picks the collection out, and only
// then does the page say how the collection is drawn ("One dot stands for 12
// records.").
//
// The timeline bar is the period's activity, a bar for each slice of it. Its
// playhead moves through the period. Each event it passes travels from who
// acted to a neuron of its own in its collection, along a connection that is
// there only while the event travels. The neuron fires: its glow travels its synapses
// to its neighbours and one hop further, then dies out. Each edge
// added lights a synapse, which draws itself from one neuron to the other. The
// replay never stops (Alexander, 2026-11-15: "When it reaches
// the end, it should always loop. You can move the time, but you cannot pause
// it."): at the end it asks for what happened meanwhile and starts over, and the
// bar has no keys to play, pause or jump, only its track to drag. Only a reader
// whose computer asks for less motion gets a still picture.
//
// Live, the first of the bar's periods, replays nothing: its bar holds the last
// quarter of an hour and its playhead is now. The picture asks every few
// seconds what happened and plays each event at its own time, a few seconds
// late (lib/orbit.ts: liveAt), so there is no time to move
// (Alexander, 2026-11-16: "Add a real-time button, too, left of 1h." "Live"
// "That is actually live").
//
// On a small screen there is no picture at all, only the collections' titles as
// a list (Alexander, 2026-11-16: "Don't show in mobile (small resolutions). Only
// show the list of collections there."): app.css hides the rest by the
// picture's own width, and under that width nothing is built, drawn or asked for.
//
// The picture stands at once with what the page already has, the collections'
// titles and sizes: its rings are drawn from them, and rise one at a time from
// the constitution outward, each title lighting up with its ring. The rest of its
// data comes in two answers that do not wait for each other, the standing links
// and the period's activity; synapses, people and the replay join the rings as
// each arrives, and nothing that stands moves (Alexander, 2026-11-16: "make sure
// that the list of collection is loaded instantaneously. Then, forget about the
// skeleton", then, of five ways to load it quickly and in sequence, "Do 1 2 and 4
// as you suggest"). Nothing stands in for the picture meanwhile.

import { type ReactTranslator, useT } from "@braino/shared/i18n/react";
import { LOGOS } from "@braino/ui";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useLocation, useNavigation, useRevalidator } from "react-router";
import { cn } from "~/lib/cn";
import { countCollectionItems } from "~/lib/collection-templates-meta";
import {
  type BallView,
  DEFAULT_ORBIT_RANGE,
  ORBIT_BUCKETS,
  ORBIT_LIVE_EVERY,
  ORBIT_PLAY_SECONDS,
  ORBIT_RANGES,
  ORBIT_RISEN,
  ORBIT_SMALL,
  type OrbitActivity,
  type OrbitActor,
  type OrbitCollection,
  type OrbitData,
  type OrbitEvent,
  type OrbitLinks,
  type OrbitRange,
  ballPoint,
  ballSize,
  ballView,
  cameraUp,
  connectionStrength,
  emptyActivity,
  eventAfter,
  firedSince,
  flowAt,
  initialsOf,
  liveAt,
  markShare,
  risenFor,
  risingFrom,
  spinUp,
  switchingTo,
  timelineTicks,
  whoActed,
} from "~/lib/orbit";
import {
  type Curve,
  NO_LAYER,
  type Plate,
  RINGS,
  Renderer,
  type Rgb,
  type Tier,
  V,
  type Vec3,
  bez,
  clamp,
  emptyTiers,
  hash,
  head,
  lookAt,
  mat4mul,
  perspective,
  smooth,
} from "./orbit-engine";
import {
  type OrbitPalette,
  type OrbitStrand,
  type OrbitWorld,
  buildOrbitWorldInStages,
  orbitStructureKey,
  tierAt,
  wander,
} from "./orbit-world";
import { VisibilityIcon } from "./visibility-icon";

/** Seconds an event stays in the picture: its travel, then the neurons it fires. */
const FLIGHT = 3.8;
/** Seconds a firing neuron's glow takes along a synapse, and a neuron stays lit once it has fired. */
const HOP = 0.34;
const LIT = 1.1;
/** Seconds a new synapse takes: its neuron lights, it grows to the other, and both fade,
 *  slowly, one by one (Alexander, 2026-11-16: "having the lines creating new neurons
 *  disappear one by one slowly? Like 10x slower"). */
const SPARK_LIGHTS = 0.3;
const SPARK_GROWS = 1.6;
const SPARK_FADES = 9;
const SPARK = SPARK_LIGHTS + SPARK_GROWS + SPARK_FADES;
/** The most events one frame starts and the picture holds at once: past them, some are skipped. */
const PER_FRAME = 5;
const MAX_FLIGHTS = 70;
/** Badges for people and agents who show one only while they act. */
const POOL = 10;
/** How wide a badge is (CSS pixels): a person's larger than an agent's (Alexander,
 *  2026-11-16: "Users are larger. Agents are smaller."; then "The size of the people
 *  and the size of the moons are too large. Make it smaller."). */
const BADGE = { person: 22, agent: 13, integration: 24 } as const;
/** The most new synapses lit at once: as many lines as every event in flight draws
 *  together, so a slower laptop keeps its pace. */
const MAX_SPARKS = 120;
/** How many dots the picture may draw, however much the workspace holds. */
const DOTS = 40_000;
/** How long each frame spends building the picture, in milliseconds: the rest of the frame stays the page's. */
const STAGE_MS = 10;
/** The activity colors as the page's CSS names them, in ORBIT_LOGS order. */
const LOG_COLORS = ["var(--color-imports)", "var(--color-writes)", "var(--color-queries)"];

interface Flight {
  event: OrbitEvent;
  /** When it started, on the picture's clock (seconds). */
  start: number;
  /** Where it travels: an import is a burst of three, each to a place of its own. */
  strands: OrbitStrand[];
}

/** A new edge growing along one of the synapses drawn between its two collections. */
interface Spark {
  /** The winding way it grows, from one neuron to the other. */
  path: Vec3[];
  tier: Tier;
  a: number;
  b: number;
  /** When it began, on the picture's clock. */
  t: number;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** What moves between frames without React knowing. */
interface Stage {
  /** The playhead, in milliseconds on the server's clock. */
  at: number;
  scrubbing: boolean;
  /** A reader who asked for less motion: the camera and the playhead stay still. */
  still: boolean;
  flights: Flight[];
  sparks: Spark[];
  recent: OrbitEvent[];
  recentDirty: boolean;
  recentAt: number;
  /** The picture's clock (seconds): everything that moves on its own runs on it, at the
   *  pace `spinUp` gives from when everything loaded, so it all speeds up together. */
  clock: number;
  /** When everything had loaded and the rings stood (performance.now()), or -1. */
  loadedAt: number;
  /** The structure key of the picture last built. */
  built: string;
  last: number;
  drag: [number, number];
  dragTo: [number, number];
  down: { x: number; y: number; from: [number, number]; moved: boolean } | null;
  /** The collection picked out, and how far the picture has eased towards it. */
  hiL: number;
  hiK: number;
  /** The labels need measuring again. */
  dirty: boolean;
  /** Where the titles are: a badge fades before it covers them. */
  avoid: Box[];
  /** Who each of the pool's badges is for, or -1. */
  pool: number[];
  /** Where each actor is on the page this frame, and how far from it the pointer
   *  still finds them: x, y and reach, three numbers an actor. */
  spots: Float32Array;
  /** The actor whose card is open, or -1, and how tall the card is, or 0 until it
   *  has been measured. */
  card: number;
  cardHeight: number;
  shownAt: number;
  shownMinute: number;
  shownMinuteAt: number;
  /** When the first picture stood (performance.now()), or -1: its rings rise from then. */
  risenAt: number;
  /** The collection whose ring is rising, whose title lights up with it, or -1. */
  rising: number;
  /** How far the camera stands from the rings, eased: a picture rebuilt with more in
   *  it (a crowd of people, say) does not jump. 0 before the first frame. */
  distance: number;
}

/** The elements a frame moves. */
interface Elements {
  titles: HTMLElement | null;
  chips: (HTMLDivElement | null)[];
  pool: (HTMLDivElement | null)[];
  card: HTMLDivElement | null;
  core: HTMLDivElement | null;
  head: HTMLDivElement | null;
  fill: HTMLElement | null;
  after: HTMLDivElement | null;
  slider: HTMLInputElement | null;
}

/** What a frame reads that React keeps up to date. */
interface Current {
  data: OrbitData;
  since: number;
  until: number;
  /** The collection picked out, or -1. */
  picked: number;
  /** Who acted on each collection over the period. */
  reach: Set<number>[];
  t: ReactTranslator;
  /** Live: the playhead is now, and `ahead` is how far the server's clock is ahead of
   *  this browser's (ms), by the freshest answer seen. */
  live: boolean;
  ahead: number;
  /** The structure key of the picture the data asks for. */
  key: string;
  /** Both answers, the links and the period's activity, have arrived. */
  complete: boolean;
}

interface FrameContext {
  world: OrbitWorld;
  renderer: Renderer;
  canvas: HTMLCanvasElement;
  palette: OrbitPalette;
  width: number;
  height: number;
  dpr: number;
  rtl: boolean;
  stage: Stage;
  elements: Elements;
  current: RefObject<Current>;
  when: Intl.DateTimeFormat;
  /** The replay reached the end and starts over. */
  again: () => void;
  showRecent: (events: OrbitEvent[]) => void;
  /** Give a badge of the pool to someone acting. */
  lend: (slot: number, actor: number) => void;
}

const FALLBACK_PALETTE: OrbitPalette = {
  light: true,
  bg: [0.953, 0.949, 0.933],
  ink: [0.09, 0.086, 0.071],
  logs: [
    [0.137, 0.469, 0.763],
    [0.867, 0.482, 0.169],
    [0.169, 0.616, 0.561],
  ],
};

/** The app's colors as the graphics card wants them, so the picture follows the theme. */
function readPalette(element: HTMLElement): OrbitPalette {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return FALLBACK_PALETTE;
  // Each token is `light-dark(day, night)`: an element wearing it as its color
  // tells which of the two the page shows now.
  const probe = document.createElement("i");
  probe.hidden = true;
  element.append(probe);
  let understood = true;
  const rgb = (name: string): Rgb => {
    probe.style.color = `var(${name})`;
    const value = getComputedStyle(probe).color;
    context.fillStyle = "#010203";
    context.fillStyle = value;
    // a browser that cannot read the color leaves the one before it
    if (!value || context.fillStyle === "#010203") understood = false;
    context.clearRect(0, 0, 1, 1);
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return [r / 255, g / 255, b / 255];
  };
  const bg = rgb("--color-background");
  const ink = rgb("--color-foreground");
  const logs: OrbitPalette["logs"] = [
    rgb("--color-imports"),
    rgb("--color-writes"),
    rgb("--color-queries"),
  ];
  probe.remove();
  if (!understood) return FALLBACK_PALETTE;
  const luminance = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return { light: luminance(bg) > luminance(ink), bg, ink, logs };
}

function launch(stage: Stage, world: OrbitWorld, event: OrbitEvent, clock: number) {
  const [at, log, actor, collection] = event;
  const strands = Array.from({ length: log === 0 ? 3 : 1 }, (_, part) =>
    world.strand(actor, collection, hash((at % 86_400_000) + actor * 13.7 + part * 5.1)),
  );
  stage.flights.push({ event, start: clock, strands });
  if (stage.flights.length > MAX_FLIGHTS) {
    stage.flights.splice(0, stage.flights.length - MAX_FLIGHTS);
  }
  // the ticker says one line for the same thing happening again
  const latest = stage.recent[stage.recent.length - 1];
  const again =
    latest && latest[1] === event[1] && latest[2] === event[2] && latest[3] === event[3];
  stage.recent = again
    ? [...stage.recent.slice(0, -1), [event[0], event[1], event[2], event[3], latest[4] + event[4]]]
    : [...stage.recent.slice(-2), event];
  stage.recentDirty = true;
}

/** One frame: move the playhead, start the events it passed, draw, and place the labels. */
function frame(now: number, x: FrameContext) {
  const { world, stage: s, elements, palette, width: W, height: H, rtl } = x;
  const {
    data,
    since,
    until,
    picked: hi,
    reach,
    t,
    live: realTime,
    ahead,
    key,
    complete,
  } = x.current.current;
  const elapsed = clamp((now - s.last) / 1000, 0, 0.1);
  s.last = now;

  // ---- the first time the picture stands, it comes in in order: the rings rise from
  // the constitution outward, each title lighting up with its ring, then the planets
  // fade in, then the moons ----
  if (s.risenAt < 0) s.risenAt = now;
  const rings = data.collections.length;
  const from = s.still ? ORBIT_RISEN : risingFrom((now - s.risenAt) / 1000, rings);

  // ---- the pace: the picture stands still until everything has loaded and has come
  // in, then speeds up, its turning, its playhead and all on its clock together, so
  // nothing happens in it before then ----
  if (s.loadedAt < 0 && complete && s.built === key && from === ORBIT_RISEN) s.loadedAt = now;
  const pace = s.loadedAt < 0 ? 0 : spinUp((now - s.loadedAt) / 1000);
  s.clock += elapsed * pace;
  const clock = s.clock;

  // ---- the playhead, and what it passed: it never stops, and starts over at the end.
  // Live, it is now. ----
  s.at = clamp(s.at, since, until);
  const before = s.at;
  if (realTime) {
    if (!s.still && pace > 0) s.at = liveAt(s.at, until, Date.now(), ahead);
  } else if (!s.still && !s.scrubbing) {
    s.at += elapsed * pace * ((until - since) / ORBIT_PLAY_SECONDS);
    if (s.at >= until) {
      s.at = since;
      x.again();
    }
  }
  if (s.at > before && s.at - before < (until - since) / 4) {
    const first = eventAfter(data.events, before);
    if (first >= 0) {
      let end = first;
      while (end < data.events.length && data.events[end][0] <= s.at) end++;
      const stride = Math.max(1, Math.ceil((end - first) / PER_FRAME));
      for (let k = first; k < end; k += stride) launch(s, world, data.events[k], clock);
    }
    // Each edge added lights one of the synapses drawn between its two collections.
    // None is passed over, however many events the same moment holds.
    for (
      let k = eventAfter(data.newLinks, before);
      k >= 0 && k < data.newLinks.length && data.newLinks[k][0] <= s.at;
      k++
    ) {
      const [at, a, b] = data.newLinks[k];
      const pick = hash(at % 86_400_000);
      const synapse = world.synapse(a, b, pick);
      if (synapse) {
        const spark = { path: wander(synapse.curve, pick), tier: synapse.tier, a, b, t: clock };
        s.sparks = [...s.sparks.slice(1 - MAX_SPARKS), spark];
      }
    }
  }
  while (s.flights.length > 0 && clock - s.flights[0].start >= FLIGHT) s.flights.shift();
  while (s.sparks.length > 0 && clock - s.sparks[0].t >= SPARK) s.sparks.shift();

  // ---- the camera stands, turned only by a drag; the rings turn under it ----
  const camera = world.camera();
  const spin = s.still ? 0 : world.spin(clock);
  s.drag[0] += (s.dragTo[0] - s.drag[0]) * 0.12;
  s.drag[1] += (s.dragTo[1] - s.drag[1]) * 0.12;
  const offset: Vec3 = [
    camera.eye[0] - camera.target[0],
    camera.eye[1] - camera.target[1],
    camera.eye[2] - camera.target[2],
  ];
  s.distance =
    s.distance > 0
      ? s.distance + (Math.hypot(...offset) - s.distance) * 0.05
      : Math.hypot(...offset);
  const distance = s.distance;
  const yaw = Math.atan2(offset[0], offset[2]) + s.drag[0];
  const elevation = clamp(Math.asin(offset[1] / distance) + s.drag[1], -1.4, 1.4);
  const eye: Vec3 = [
    camera.target[0] + distance * Math.sin(yaw) * Math.cos(elevation),
    camera.target[1] + distance * Math.sin(elevation),
    camera.target[2] + distance * Math.cos(yaw) * Math.cos(elevation),
  ];
  const fov = (camera.fov * Math.PI) / 180;
  const projection = perspective(fov, W / H, 0.05, 400);
  const vp = mat4mul(projection, lookAt(eye, camera.target, [0, 1, 0]));
  /** A point of the picture on the page: x, y in CSS pixels, and its distance from the camera. */
  const project = (p: Vec3): Vec3 => {
    const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    return [
      (((vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / w) * 0.5 + 0.5) * W,
      (0.5 - ((vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / w) * 0.5) * H,
      w,
    ];
  };

  // the collection picked out, eased in and out
  if (hi >= 0) {
    s.hiL = hi;
    s.hiK += (1 - s.hiK) * 0.2;
  } else {
    s.hiK *= 0.84;
    if (s.hiK < 0.004) s.hiK = 0;
  }

  // ---- what moves this frame, by tier: events in flight, the neurons they
  // fire, who is acting, and new synapses ----
  const live = emptyTiers();
  const acting = new Map<number, number>();
  const small = world.portrait ? 0.7 : 1;
  const pulse = (strand: OrbitStrand, curve: Curve, at: number, col: Rgb, back: boolean) => {
    for (let j = 0; j < 9; j++) {
      const sj = at + (back ? 1 : -1) * j * 0.018;
      if (sj < 0 || sj > 1) continue;
      const f = 1 - j / 9;
      const size = world.unit * (j ? 0.0055 : 0.0095) * (0.5 + 0.5 * f);
      live[strand.tier].point(bez(curve, sj), col, f * f, size, strand.layer, 0, 0.25);
    }
  };
  /** A neuron lit as far as `glow` (0 to 1). */
  const lit = (p: Vec3, col: Rgb, glow: number, layer: number) => {
    if (glow <= 0.01) return;
    live[RINGS].point(p, col, glow, world.unit * (0.006 + 0.01 * glow) * small, layer, 0, 0.25);
  };
  // the agents circling their people, where they are now, under any lit up as they act
  world.moving(clock, live);
  for (const flight of s.flights) {
    const [, log, actor, collection] = flight.event;
    const tau = clock - flight.start;
    const col = palette.logs[log] ?? palette.ink;
    flight.strands.forEach((strand, part) => {
      const own = tau - part * 0.16;
      // drawn in the rings' frame, so it lands on its neuron as they turn, from an actor who stands
      const curve = world.path(strand, spin, clock);
      // the connection is there only while its data moves
      const shows = connectionStrength(own);
      if (shows > 0.01) {
        live[strand.tier].curve(
          curve,
          world.portrait ? 18 : 24,
          col,
          (palette.light ? 0.6 : 0.5) * shows,
          log === 0 ? 1.3 : 1.05,
          -1,
          1,
          0.6,
          NO_LAYER,
          strand.layer,
        );
      }
      // an import or a write flows in, a query's answer out
      const flow = flowAt(log, own);
      if (flow !== null) pulse(strand, curve, smooth(flow), col, log === 2);
      // The neuron it touches fires. Its glow travels each synapse it has to the
      // neuron at the other end, which fires in turn, a hop weaker.
      const fired = firedSince(log, own);
      if (fired <= 0) return;
      lit(strand.land, col, 1 - fired / LIT, strand.layer);
      strand.wave.forEach((hop, h) => {
        const since = fired - h * HOP;
        if (since <= 0) return;
        const strength = h === 0 ? 1 : 0.6;
        for (const curve of hop) {
          // The synapse lights along its own bends as far as the glow has come, with
          // nothing at the glow's tip, and fades once it has arrived; the neuron it
          // reaches lights then (Alexander, 2026-11-16, of these: "New edges still
          // look like straight lines to me").
          const reached = Math.min(1, since / HOP);
          const fades = 1 - smooth((since - HOP) / 0.5);
          if (fades > 0.01) {
            live[RINGS].curve(
              head(curve, reached),
              10,
              col,
              0.8 * strength * fades,
              (world.portrait ? 1.1 : 1.4) * strength,
              -1,
              1,
              1,
              strand.layer,
            );
          }
          if (since >= HOP) lit(curve[3], col, strength * (1 - (since - HOP) / LIT), strand.layer);
        }
      });
    });
    // whoever acts keeps their color (Alexander, 2026-11-16: "Do not change the color of
    // the planets as they get information or they send information"); someone without
    // a standing badge is lent one while they act
    const envelope = smooth(tau / 0.22) * (1 - smooth((tau - 2.5) / 0.9));
    if (envelope > 0.01 && actor < world.actorSize.length) {
      const strength = envelope * (hi >= 0 && collection !== hi ? 0.3 : 1);
      acting.set(actor, Math.max(acting.get(actor) ?? 0, strength));
    }
  }
  // A new synapse grows: the neuron it starts from lights, then a line winds out from
  // it, feeling its way, with nothing at its tip, until it finds the other neuron, which
  // lights; then both fade, leaving the synapse that stands there (Alexander,
  // 2026-11-16: "as the line moves, it shouldn't have a dot in the front of the line. We
  // should only see the dot once it finds the other neuron").
  for (const spark of s.sparks) {
    const age = clock - spark.t;
    const { path, tier } = spark;
    const grown = smooth((age - SPARK_LIGHTS) / SPARK_GROWS) * (path.length - 1);
    const fades = 1 - smooth((age - SPARK_LIGHTS - SPARK_GROWS) / SPARK_FADES);
    const size = world.unit * 0.009 * (world.portrait ? 0.7 : 1);
    const width = world.portrait ? 0.9 : 1.1;
    live[tier].point(path[0], palette.ink, fades * smooth(age / 0.15), size, spark.a, 0, 0.25);
    for (let k = 0; k < Math.ceil(grown); k++) {
      const to = k + 1 <= grown ? path[k + 1] : V.lerp(path[k], path[k + 1], grown - k);
      live[tier].seg(path[k], to, palette.ink, 0.5 * fades, width, 0, 1, -1, spark.a, spark.b);
    }
    if (grown >= path.length - 1) {
      live[tier].point(path[path.length - 1], palette.ink, fades, size, spark.b, 0, 0.25);
    }
  }

  // ---- labels ride the picture ----
  if (s.dirty) {
    s.dirty = false;
    // the titles' column, where the page laid it out: a chip fades before it covers it
    const titles = elements.titles?.getBoundingClientRect();
    const picture = x.canvas.getBoundingClientRect();
    s.avoid =
      titles && titles.width > 0
        ? [
            {
              left: titles.left - picture.left,
              right: titles.right - picture.left,
              top: titles.top - picture.top - 8,
              bottom: titles.bottom - picture.top + 8,
            },
          ]
        : [];
  }
  if (elements.core) {
    // its name hangs under the sphere
    const [cx, cy] = project([0, -world.core, 0]);
    elements.core.style.transform = `translate(${cx.toFixed(1)}px,${cy.toFixed(1)}px)`;
  }
  // A badge is centered on who it is and kept inside the page. It fades before it
  // reaches the column of titles or the page's words, and where it would sit on a
  // badge already placed, unless it circles that one. The nearer lies over the
  // farther. It lies under the canvas and shows through a plate cut once its tier
  // is drawn, as far as it is visible: whatever is nearer hides it.
  const plates: Plate[] = [];
  const placed: { x: number; y: number; d: number; actor: number }[] = [];
  const spots =
    s.spots.length === data.actors.length * 3 ? s.spots : new Float32Array(data.actors.length * 3);
  s.spots = spots;
  // Each ball is seen by the camera that draws the rings, from where it stands: as
  // large as their perspective draws it there, and painted as that camera sees it.
  const up = cameraUp(eye, camera.target);
  const turned = s.still ? 0 : (clock / TURN_ONCE) * TAU;
  const place = (chip: HTMLDivElement, actor: number, strength: number) => {
    const who = data.actors[actor];
    const p = world.at(actor, clock);
    const [sx, sy, w] = project(p);
    const d = ballSize(BADGE[who.kind], distance, w);
    const cx = clamp(sx, d / 2 + 8, W - d / 2 - 8);
    let o =
      (w < 0.2 ? 0 : strength) *
      risenFor(who.kind, from) *
      clamp((sx + 30) / 30, 0, 1) *
      clamp((W + 30 - sx) / 30, 0, 1);
    for (const box of s.avoid) {
      o *= Math.max(
        clamp((box.left - cx - d / 2 - 4) / 22, 0, 1),
        clamp((cx - d / 2 - box.right - 4) / 22, 0, 1),
        clamp((box.top - sy - d / 2) / 12, 0, 1),
        clamp((sy - box.bottom - d / 2) / 12, 0, 1),
      );
    }
    for (const c of placed) {
      if (c.actor === who.owner || data.actors[c.actor]?.owner === actor) continue;
      const apart = Math.hypot(cx - c.x, sy - c.y) - (d + c.d) / 2;
      o *= clamp((apart + 2) / 8, 0, 1);
    }
    if (o > 0.3) placed.push({ x: cx, y: sy, d, actor });
    spots[actor * 3] = cx;
    spots[actor * 3 + 1] = sy;
    spots[actor * 3 + 2] = o > 0.3 ? d / 2 + 3 : 0;
    chip.style.visibility = o > 0.004 ? "visible" : "hidden";
    chip.style.opacity = o.toFixed(3);
    chip.style.zIndex = String(Math.round(1e6 - w * 1000));
    chip.style.transform = `translate(${cx.toFixed(1)}px,${sy.toFixed(1)}px) scale(${(d / BADGE[who.kind]).toFixed(3)})`;
    if (o > 0.004) {
      const canvas = chip.querySelector<HTMLCanvasElement>("canvas.orbit-ball");
      const ball = canvas ? balls.get(canvas) : undefined;
      ball?.paint(ballView(eye, p, up), turned + ball.from);
    }
    plates.push({ tier: tierAt(p), x: cx, y: sy, width: d, height: d, radius: d / 2, alpha: o });
  };
  // the marks without a badge: the pointer finds them where they are
  for (let i = 0; i < data.actors.length; i++) {
    if (world.named[i]) continue;
    const [sx, sy, w] = project(world.at(i, clock));
    spots[i * 3] = sx;
    spots[i * 3 + 1] = sy;
    spots[i * 3 + 2] = w < 0.2 || risenFor(data.actors[i].kind, from) < 0.5 ? 0 : 7;
  }
  // people before the agents that circle them, so an agent may pass over its person
  for (let i = 0; i < data.actors.length; i++) {
    const chip = elements.chips[i];
    if (!chip || !world.named[i]) continue;
    const [, , w] = project(world.at(i, clock));
    const fog = clamp((camera.fog[1] - w) / (camera.fog[1] - camera.fog[0]), 0, 1);
    const far = hi >= 0 && !reach[hi]?.has(i) ? 0.25 : 1;
    place(chip, i, clamp(fog * 1.6, 0, 1) * far);
  }
  // badges that come and go: someone without a standing badge has one while acting
  s.pool.forEach((actor, slot) => {
    if (actor >= 0 && !acting.has(actor)) {
      s.pool[slot] = -1;
      const chip = elements.pool[slot];
      if (chip) chip.style.visibility = "hidden";
    }
  });
  for (const [actor, act] of acting) {
    if (world.named[actor] || !data.actors[actor]) continue;
    let slot = s.pool.indexOf(actor);
    if (slot < 0) {
      slot = s.pool.indexOf(-1);
      if (slot < 0) continue;
      s.pool[slot] = actor;
      x.lend(slot, actor);
    }
    const chip = elements.pool[slot];
    // until the page has drawn the badge for whom it is lent to, it stays hidden
    if (!chip || chip.dataset.actor !== String(actor)) continue;
    place(chip, actor, act);
  }

  // ---- the card of the one under the pointer follows them ----
  if (elements.card) {
    const open = s.card >= 0 && s.card < data.actors.length;
    if (open) {
      const sx = spots[s.card * 3];
      const sy = spots[s.card * 3 + 1];
      const reachOf = Math.max(spots[s.card * 3 + 2], 7);
      if (s.cardHeight === 0) {
        s.cardHeight = elements.card.firstElementChild?.getBoundingClientRect().height ?? 0;
      }
      // over them, or under them where it would run off the top of the picture
      const under = sy - reachOf - 6 - s.cardHeight < 4;
      elements.card.toggleAttribute("data-under", under);
      const y = under ? sy + reachOf + 6 : sy - reachOf - 6;
      elements.card.style.transform = `translate(${clamp(sx, 130, W - 130).toFixed(1)}px,${y.toFixed(1)}px)`;
    }
  }

  // ---- the title of the ring rising lights up with it ----
  const rising = from > 0 ? Math.ceil(from) - 1 : -1;
  if (rising !== s.rising) {
    elements.titles?.children[s.rising]?.removeAttribute("data-rising");
    elements.titles?.children[rising]?.setAttribute("data-rising", "");
    s.rising = rising;
  }

  // ---- the picture, the farthest tier first ----
  x.renderer.draw({
    from,
    spin,
    vp,
    time: clock,
    px: x.canvas.height / 2 / Math.tan(fov / 2),
    focus: camera.focus,
    dof: camera.dof,
    fog: camera.fog,
    near: [0.3, 1.6],
    light: palette.light,
    bg: palette.bg,
    below: eye[1] < 0,
    live,
    plates,
    dpr: x.dpr,
    hi: s.hiL,
    hiK: s.hiK,
  });

  // ---- the timeline bar ----
  const at = clamp((s.at - since) / Math.max(1, until - since), 0, 1);
  if (Math.abs(at - s.shownAt) > 0.0004) {
    s.shownAt = at;
    const percent = `${(at * 100).toFixed(2)}%`;
    if (elements.head) elements.head.style.left = percent;
    if (elements.fill) elements.fill.style.width = percent;
    if (elements.after) elements.after.style.width = `${((1 - at) * 100).toFixed(2)}%`;
    if (elements.slider && !s.scrubbing) elements.slider.value = String(Math.round(at * 1000));
  }
  // the moment in words, for a screen reader, a few times a second at most
  const minute = Math.floor(s.at / 60_000);
  if (minute !== s.shownMinute && now - s.shownMinuteAt > 120) {
    s.shownMinute = minute;
    s.shownMinuteAt = now;
    elements.slider?.setAttribute("aria-valuetext", x.when.format(new Date(s.at)));
  }
  if (s.recentDirty && now - s.recentAt > 150) {
    s.recentDirty = false;
    s.recentAt = now;
    x.showRecent(s.recent);
  }
}

export function Orbit({
  workspace,
  collections,
  links: linksAnswer,
  activity: activityAnswer,
  range,
}: {
  workspace: { handle: string; name: string };
  /** The collections, largest first, with the page: the rings are drawn from them at once. */
  collections: readonly Omit<OrbitCollection, "activity">[];
  /** The standing links, on their way. */
  links: Promise<OrbitLinks>;
  /** The period's activity, on its way. */
  activity: Promise<OrbitActivity>;
  range: OrbitRange;
}) {
  const t = useT();
  // Each answer is taken in as it arrives. While the page brings itself up to date the
  // last one stands; a period's activity stands only for its own period, and links only
  // for the collections they were counted over.
  const handles = collections.map((c) => c.handle).join();
  const [links, setLinks] = useState<{ handles: string; value: OrbitLinks } | null>(null);
  const [activity, setActivity] = useState<{ range: OrbitRange; value: OrbitActivity } | null>(
    null,
  );
  useEffect(() => {
    let on = true;
    linksAnswer.then(
      (value) => on && setLinks({ handles, value }),
      (error) => {
        // the picture goes on without them, so it does not stand still waiting
        console.error("Orbit's links did not arrive", error);
        if (on) setLinks({ handles, value: [] });
      },
    );
    return () => {
      on = false;
    };
  }, [linksAnswer, handles]);
  useEffect(() => {
    let on = true;
    activityAnswer.then(
      (value) => on && setActivity({ range, value }),
      (error) => {
        console.error("Orbit's activity did not arrive", error);
        if (on) setActivity({ range, value: emptyActivity(collections, range, Date.now()) });
      },
    );
    return () => {
      on = false;
    };
  }, [activityAnswer, range, collections]);
  const arrived = activity?.range === range ? activity.value : null;
  const waiting = arrived === null;
  const { revalidate } = useRevalidator();
  // On a small screen there is no picture, only the list of collections (Alexander,
  // 2026-11-16: "Don't show in mobile (small resolutions). Only show the list of
  // collections there."): app.css hides it, and nothing is built, drawn or asked for.
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const wide = box !== null && box.w >= ORBIT_SMALL;
  // Live: every few seconds the picture asks what happened. An answer is everything
  // but the standing links, which the page's own data keeps.
  const live = range === "live";
  const { data: heard, load: ask, state: asking } = useFetcher<OrbitActivity>();
  // a question still unanswered is not asked again over itself
  const answered = useRef(true);
  answered.current = asking === "idle";
  useEffect(() => {
    if (!live || waiting || !wide) return;
    const timer = window.setInterval(() => {
      if (document.hidden || !answered.current) return;
      void ask("/api/v1/orbit.json");
    }, ORBIT_LIVE_EVERY);
    return () => window.clearInterval(timer);
  }, [live, waiting, wide, ask]);
  // An answer about other collections than the page knows (one was added, or outgrew
  // another): the page loads itself again, and keeps what it has until then.
  const stale = heard ? heard.collections.map((c) => c.handle).join() !== handles : false;
  useEffect(() => {
    if (stale) void revalidate();
  }, [stale, revalidate]);
  const standing = links?.handles === handles ? links.value : null;
  const complete = standing !== null && !waiting;
  const data: OrbitData = useMemo(() => {
    const period =
      live && heard && !stale && arrived
        ? heard
        : (arrived ?? emptyActivity(collections, range, Date.now()));
    return { ...period, links: standing ?? [] };
  }, [arrived, heard, stale, live, collections, range, standing]);
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const elements = useRef<Elements>({
    titles: null,
    chips: [],
    pool: [],
    card: null,
    core: null,
    head: null,
    fill: null,
    after: null,
    slider: null,
  });
  const since = Date.parse(data.since);
  const until = Date.parse(data.until);
  const stage = useRef<Stage>({
    at: since,
    scrubbing: false,
    still: false,
    flights: [],
    sparks: [],
    recent: [],
    recentDirty: false,
    recentAt: 0,
    clock: 6,
    loadedAt: -1,
    built: "",
    last: 0,
    drag: [0, 0],
    dragTo: [0, 0],
    down: null,
    hiL: -1,
    hiK: 0,
    dirty: true,
    avoid: [],
    pool: new Array(POOL).fill(-1),
    spots: new Float32Array(0),
    card: -1,
    cardHeight: 0,
    shownAt: -1,
    shownMinute: -1,
    shownMinuteAt: 0,
    risenAt: -1,
    rising: -1,
    distance: 0,
  });

  const [palette, setPalette] = useState<OrbitPalette | null>(null);
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const [failed, setFailed] = useState(false);
  const [rtl, setRtl] = useState(false);
  // The collection under the mouse, or whose title has the focus, is picked out.
  const [hover, setHover] = useState(-1);
  const picked = Math.min(hover, data.collections.length - 1);
  // A click on another period: until the page answers, the picture steps back.
  const going = useNavigation().location;
  const pending = switchingTo(going, useLocation().pathname, range);
  // The ticker keeps its own state, so an event landing redraws three lines and not the page.
  const showRecent = useRef<(events: OrbitEvent[]) => void>(() => {});
  // Who the pool's badges are lent to, as the page draws them; a frame lends one
  // only when someone new starts acting.
  const [lent, setLent] = useState<number[]>(() => new Array(POOL).fill(-1));
  const lend = useCallback((slot: number, actor: number) => {
    setLent((was) => was.map((a, i) => (i === slot ? actor : a)));
  }, []);
  // The person, agent or integration under the pointer, whose card is open, or -1
  // (Alexander, 2026-11-16: "On mouse over of person or agent, we should show who
  // the person is are and their list of agents").
  const [who, setWho] = useState(-1);
  const showCard = (actor: number) => {
    stage.current.card = actor;
    stage.current.cardHeight = 0;
    setWho(actor);
  };
  const [ticks, setTicks] = useState<{ at: number[]; days: boolean } | null>(null);

  // The picture is rebuilt only when the workspace's shape changes, or a part of its data
  // arrives, not each time the page brings itself up to date.
  const key = orbitStructureKey(data);
  const wanted = useRef({ key, data });
  if (wanted.current.key !== key) wanted.current = { key, data };
  // It is built a stage at a time, a little each frame, so the page answers while it
  // builds. A rebuild keeps the last picture on show, and one under way finishes
  // before the next starts, so a part arriving never holds back the rings.
  const [world, setWorld] = useState<OrbitWorld | null>(null);
  useEffect(() => {
    if (!wide || !box || !palette) return;
    const options = { aspect: box.w / box.h, budget: DOTS, palette };
    let built = "";
    let building: { key: string; stages: ReturnType<typeof buildOrbitWorldInStages> } | null = null;
    let request = requestAnimationFrame(function step() {
      request = requestAnimationFrame(step);
      if (!building) {
        const { key, data } = wanted.current;
        if (key === built) return;
        building = { key, stages: buildOrbitWorldInStages(data, options) };
      }
      const until = performance.now() + STAGE_MS;
      while (performance.now() < until) {
        const next = building.stages.next();
        if (next.done) {
          built = building.key;
          stage.current.built = built;
          building = null;
          setWorld(next.value);
          return;
        }
      }
    });
    return () => cancelAnimationFrame(request);
  }, [wide, box, palette]);

  const reach = useMemo(() => {
    const sets = data.collections.map(() => new Set<number>());
    for (const [, , actor, collection] of data.events) sets[collection]?.add(actor);
    return sets;
  }, [data]);
  const current = useRef<Current>({
    data,
    since,
    until,
    picked,
    reach,
    t,
    live,
    ahead: Number.NEGATIVE_INFINITY,
    key,
    complete,
  });
  useEffect(() => {
    // the less an answer was delayed, the nearer `until` is to the server's clock on arrival
    const ahead = Math.max(current.current.ahead, until - Date.now());
    current.current = { data, since, until, picked, reach, t, live, ahead, key, complete };
    stage.current.dirty = true;
  }, [data, since, until, picked, reach, t, live, key, complete]);

  // Each time the replay starts over, it takes in what happened meanwhile.
  const again = useCallback(() => {
    void revalidate();
  }, [revalidate]);

  // ---- once, in the browser: the clock, the reader's motion setting, the colors, the canvas ----
  useEffect(() => {
    const s = stage.current;
    s.last = performance.now();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // less motion: a still camera and the picture as it is now; the timeline still moves by hand
      s.still = true;
      s.at = current.current.until;
    }
    const root = rootRef.current;
    const read = () => {
      if (!root) return;
      setPalette(readPalette(root));
      setRtl(getComputedStyle(root).direction === "rtl");
    };
    read();
    // the computer turning dark or light, or a pick in the theme menu (lib/theme.ts)
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", read);
    const picked = new MutationObserver(read);
    picked.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => {
      scheme.removeEventListener("change", read);
      picked.disconnect();
    };
  }, []);

  // The canvas is drawn on only where there is room to draw it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !wide) return;
    let made: Renderer | null = null;
    try {
      made = new Renderer(canvas);
    } catch {
      setFailed(true);
    }
    setRenderer(made);
    return () => {
      setRenderer(null);
      made?.dispose();
    };
  }, [wide]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    let timer = 0;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w < 40 || h < 40) return;
      setBox((was) => (was && was.w === w && was.h === h ? was : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 120);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  // Round local times for the timeline's marks: the reader's zone is only known in the browser.
  useEffect(() => {
    setTicks(timelineTicks(since, until, new Date().getTimezoneOffset()));
  }, [since, until]);

  // ---- the frames ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!world || !renderer || !palette || !box || !canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(box.w * dpr);
    canvas.height = Math.round(box.h * dpr);
    renderer.upload(world.tiers);
    stage.current.dirty = true;
    const context: FrameContext = {
      world,
      renderer,
      canvas,
      palette,
      width: box.w,
      height: box.h,
      dpr,
      rtl,
      stage: stage.current,
      elements: elements.current,
      current,
      when: new Intl.DateTimeFormat(t.locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      }),
      again,
      showRecent: (events) => showRecent.current(events),
      lend,
    };
    stage.current.shownMinute = -1;
    stage.current.shownMinuteAt = 0;
    let request = requestAnimationFrame(function tick(now) {
      frame(now, context);
      request = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(request);
  }, [world, renderer, palette, box, rtl, t.locale, again, lend]);

  // ---- the timeline bar's controls ----
  const seek = (fraction: number) => {
    const s = stage.current;
    s.at = since + clamp(fraction, 0, 1) * (until - since);
    s.flights = [];
    s.sparks = [];
  };

  // ---- the picture: a drag turns it, a tap away from any title lets the picked collection go ----
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const s = stage.current;
    s.down = { x: event.clientX, y: event.clientY, from: [...s.dragTo], moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const s = stage.current;
    const down = s.down;
    if (!down) {
      // the nearest of those the pointer is on opens its card
      const rect = event.currentTarget.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      let found = -1;
      let nearest = Number.POSITIVE_INFINITY;
      for (let i = 0; i * 3 < s.spots.length; i++) {
        const gap = Math.hypot(px - s.spots[i * 3], py - s.spots[i * 3 + 1]);
        if (gap <= s.spots[i * 3 + 2] && gap < nearest) {
          nearest = gap;
          found = i;
        }
      }
      if (found !== s.card) showCard(found);
      return;
    }
    const dx = event.clientX - down.x;
    const dy = event.clientY - down.y;
    if (Math.hypot(dx, dy) > 5) down.moved = true;
    s.dragTo = [down.from[0] - dx * 0.006, clamp(down.from[1] + dy * 0.004, -0.6, 0.6)];
  };
  const onPointerUp = () => {
    const s = stage.current;
    s.down = null;
  };

  const number = (value: number) => value.toLocaleString(t.locale);
  const pickedCollection = picked >= 0 ? data.collections[picked] : undefined;

  return (
    <div
      ref={rootRef}
      className="orbit"
      data-loading={pending ? "" : undefined}
      data-drawn={world ? "" : undefined}
      aria-busy={pending ? true : undefined}
    >
      <div ref={stageRef} className="orbit-stage" data-picked={picked >= 0 ? "" : undefined}>
        <div className="orbit-picture">
          {/* Badges lie under the canvas, which is cut away over each at its depth. */}
          <div className="orbit-names">
            {data.actors.map((actor, i) =>
              world?.named[i] ? (
                <div
                  key={`${actor.kind}:${actor.owner}:${actor.name}`}
                  className="orbit-label orbit-chip"
                  ref={(element) => {
                    elements.current.chips[i] = element;
                  }}
                >
                  <Badge actor={actor} />
                </div>
              ) : null,
            )}
            {lent.map((actor, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed pool of badges, told apart only by position
                key={i}
                className="orbit-label orbit-chip"
                data-actor={actor >= 0 && data.actors[actor] ? actor : undefined}
                ref={(element) => {
                  elements.current.pool[i] = element;
                }}
              >
                {actor >= 0 && data.actors[actor] ? <Badge actor={data.actors[actor]} /> : null}
              </div>
            ))}
          </div>
          <canvas
            ref={canvasRef}
            className="orbit-canvas"
            role="img"
            aria-label={t("{workspace} drawn as rings of neurons around its constitution", {
              workspace: workspace.name,
            })}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              stage.current.down = null;
            }}
            onPointerLeave={() => showCard(-1)}
          />
          <div
            ref={(element) => {
              elements.current.card = element;
            }}
            className="orbit-card"
            hidden={who < 0 || !data.actors[who]}
          >
            {who >= 0 && data.actors[who] ? (
              <div className="orbit-card-box">
                <ActorCard actors={data.actors} actor={who} />
              </div>
            ) : null}
          </div>
        </div>
        {failed ? (
          <p className="orbit-fallback">
            {t("This picture needs WebGL, which this browser has turned off.")}
          </p>
        ) : null}

        <div className="orbit-labels">
          <div
            className="orbit-label orbit-core"
            ref={(element) => {
              elements.current.core = element;
            }}
          >
            <span>{t("Constitution")}</span>
          </div>
        </div>

        {/* The collections, largest first: links the page lays out itself, so they stand
            before the picture does. A click or tap opens the collection (Alexander,
            2026-11-16: "clicking on a collection should simply open the collection");
            hovering or focusing picks it out. */}
        <nav
          className="orbit-titles"
          aria-label={t("Collections")}
          ref={(element) => {
            elements.current.titles = element;
          }}
        >
          {data.collections.map((collection, i) => (
            <Link
              key={collection.handle}
              className="orbit-title"
              data-on={picked === i ? "" : undefined}
              to={`/${collection.handle}`}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") setHover(i);
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") setHover(-1);
              }}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(-1)}
            >
              <VisibilityIcon visibility={collection.visibility} className="orbit-visibility" />
              <span className="orbit-name" dir="auto">
                {collection.handle}
              </span>
              <span className="orbit-count">{number(collection.items)}</span>
            </Link>
          ))}
        </nav>

        {pending || waiting ? null : <Ticker data={data} show={showRecent} />}

        {/* What the page says about how a collection is drawn, only while one is picked out. */}
        {pickedCollection ? (
          <output className="orbit-hud orbit-note">
            <p>
              <b>{pickedCollection.handle}</b>{" "}
              {countCollectionItems(t, pickedCollection.items, pickedCollection.template)}
            </p>
            <p>
              <DrawnAs items={pickedCollection.items} dots={world?.shown[picked]} />{" "}
              <Reached count={reach[picked]?.size ?? 0} />
            </p>
          </output>
        ) : null}
      </div>

      <div className="orbit-timeline">
        {/* Time runs left to right in every language, as it does on any player. */}
        <div className="orbit-track" dir="ltr">
          <Bars buckets={data.buckets} />
          <div
            className="orbit-after"
            ref={(element) => {
              elements.current.after = element;
            }}
          />
          <div className="orbit-groove">
            <b
              ref={(element) => {
                elements.current.fill = element;
              }}
            />
          </div>
          <div
            className="orbit-playhead"
            ref={(element) => {
              elements.current.head = element;
            }}
          />
          <div
            className="orbit-ticks"
            aria-hidden="true"
            style={{ "--orbit-ticks": ticks?.at.length ?? 1 } as React.CSSProperties}
          >
            {ticks?.at.map((at) => (
              <span key={at} style={{ left: `${((at - since) / (until - since)) * 100}%` }}>
                {ticks.days
                  ? new Date(at).toLocaleDateString(
                      t.locale,
                      range === "30d"
                        ? { day: "numeric", month: "short" }
                        : { weekday: "short", day: "numeric" },
                    )
                  : new Date(at).toLocaleTimeString(t.locale, {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
              </span>
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={1000}
            step={5}
            defaultValue={0}
            // live, there is no time to move to
            disabled={live}
            aria-label={t("Timeline")}
            ref={(element) => {
              elements.current.slider = element;
            }}
            onChange={(event) => seek(Number(event.currentTarget.value) / 1000)}
            onPointerDown={() => {
              stage.current.scrubbing = true;
            }}
            onPointerUp={() => {
              stage.current.scrubbing = false;
            }}
            onPointerCancel={() => {
              stage.current.scrubbing = false;
            }}
          />
        </div>
        <nav aria-label={t("Period")} className="orbit-ranges">
          {(Object.keys(ORBIT_RANGES) as OrbitRange[]).map((option) => (
            <Link
              key={option}
              to={{ search: option === DEFAULT_ORBIT_RANGE ? "" : `?range=${option}` }}
              replace
              preventScrollReset
              aria-current={option === (pending ?? range) ? "true" : undefined}
              className={cn(
                "neu-button neu-small rounded-md px-2.5 py-1.5 text-xs font-semibold",
                option === (pending ?? range) && "neu-pressed",
              )}
            >
              {t("{range, select, live {Live} 1h {1h} 24h {24h} 7d {7d} other {30d}}", {
                range: option,
              })}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

/** How a collection is drawn: record for record, or one dot for several. */
function DrawnAs({ items, dots }: { items: number; dots: number | undefined }) {
  const t = useT();
  const ratio = dots ? items / dots : 1;
  if (ratio < 1.01) return t("Every record is drawn.");
  return t(
    "{ratio, plural, one {One dot stands for # record.} other {One dot stands for # records.}}",
    { ratio: ratio < 3 ? Math.round(ratio * 10) / 10 : Math.round(ratio) },
  );
}

/** How many people, agents and integrations acted on a collection over the period. */
function Reached({ count }: { count: number }) {
  const t = useT();
  if (count === 0) return t("Nobody acted here in this period.");
  return t(
    "{count, plural, one {# person, agent or integration acted here in this period.} other {# people, agents and integrations acted here in this period.}}",
    { count },
  );
}

/** The last three events the playhead passed, the latest lowest. */
function Ticker({
  data,
  show,
}: {
  data: OrbitData;
  /** Where the ticker leaves the function that gives it new events. */
  show: RefObject<(events: OrbitEvent[]) => void>;
}) {
  const t = useT();
  const [recent, setRecent] = useState<OrbitEvent[]>([]);
  useEffect(() => {
    show.current = setRecent;
    return () => {
      show.current = () => {};
    };
  }, [show]);
  return (
    <ul className="orbit-hud orbit-ticker">
      {recent.map((event, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: the last three events, which may repeat
          key={i}
          data-age={recent.length - 1 - i}
        >
          <i className="orbit-dot" style={{ color: LOG_COLORS[event[1]] }} />
          <span>
            <Happened event={event} data={data} />
          </span>
          {event[4] > 1 ? (
            <span className="orbit-times" dir="ltr">{`×${event[4].toLocaleString(t.locale)}`}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** One replayed event, in words. */
function Happened({ event, data }: { event: OrbitEvent; data: OrbitData }) {
  const t = useT();
  const [, log, actor, collection] = event;
  const values = {
    who: whoActed(data.actors, actor),
    where: data.collections[collection]?.handle ?? "",
    b: (children: React.ReactNode) => <b dir="auto">{children}</b>,
    em: (children: React.ReactNode) => <em dir="auto">{children}</em>,
  };
  if (collection < 0) return t.rich("<b>{who}</b> searched the workspace", values);
  if (log === 0) return t.rich("<b>{who}</b> imported into <em>{where}</em>", values);
  if (log === 1) return t.rich("<b>{who}</b> wrote to <em>{where}</em>", values);
  return t.rich("<b>{who}</b> queried <em>{where}</em>", values);
}

/** Who someone is, on a plain ball: a person's initials, an agent's logo (the
 *  sparkle when its kind is unknown), an integration's logo (Alexander, 2026-11-16: "Integrations use
 *  their logo, not their name. Agents also use their related logo"; then, of
 *  people's pictures, "Let's use only the initials"). Three of them go round the
 *  ball, which turns slowly ("let's put the initials and the logos in them in such a
 *  way that there are three of them around each one of those spheres, and those
 *  spheres are slowly rotating as well"). The frame paints the ball as the camera
 *  sees it (`Ball`). An agent's ball is its brand's color, black for the sparkle,
 *  everyone else's silver. */
function Badge({ actor, small }: { actor: OrbitActor; small?: boolean }) {
  const logo = actor.logo ? LOGOS[actor.logo] : null;
  const size = small ? 16 : BADGE[actor.kind];
  const canvas = useRef<HTMLCanvasElement>(null);
  const { name, kind } = actor;
  useEffect(() => {
    const element = canvas.current;
    if (!element || small) return;
    balls.set(element, new Ball(element, { name, logo: actor.logo, kind }, size));
    return () => {
      balls.delete(element);
    };
  }, [small, name, actor.logo, kind, size]);
  return (
    <span
      className="orbit-badge"
      data-kind={actor.kind}
      data-small={small ? "" : undefined}
      style={
        {
          "--orbit-size": `${size}px`,
          "--orbit-mark": markShare(actor.kind),
          "--orbit-tone": actor.kind === "agent" ? logo?.color : undefined,
        } as React.CSSProperties
      }
    >
      <span className="orbit-face" aria-hidden="true">
        {small ? (
          logo ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={logo.path} />
            </svg>
          ) : (
            <span className="orbit-initials">
              {initialsOf(actor.name, actor.kind === "person" ? 2 : 1)}
            </span>
          )
        ) : (
          <canvas ref={canvas} className="orbit-ball" />
        )}
      </span>
      {/* the card beside a small one says the name already */}
      {small ? null : (
        <span className="sr-only" dir="auto">
          {actor.name}
        </span>
      )}
    </span>
  );
}

/** Seconds a ball takes to turn once round. */
const TURN_ONCE = 27;
const TAU = Math.PI * 2;
/** How much sharper than its size a ball is painted, so it stays crisp drawn nearer. */
const BALL_SHARPER = 1.5;

/** The balls on the page, by their canvas, for the frame to paint. */
const balls = new WeakMap<HTMLCanvasElement, Ball>();

/** A badge's ball: three of its marks, a third of the way round from each other, are
 *  printed on a map of the ball, and each frame every pixel of the badge reads the map
 *  where it lies on the ball as the camera that draws the rings sees it (`ballPoint`),
 *  so a mark curves over the ball, leans away at its rim, and tips with the rings
 *  whenever the picture is turned (Alexander, 2026-11-16: "The spheres, the galaxy,
 *  everything needs to have the same perspective at the same time"). It turns on the
 *  picture's clock, so a reader who asked for less motion sees it still. */
class Ball {
  /** How far round it had turned when the picture began, its own for each name, so the
   *  balls do not turn in step (radians). */
  readonly from: number;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly px: number;
  private readonly w: number;
  private readonly h: number;
  private readonly ink: Uint8ClampedArray;
  private readonly out: ImageData | null;
  /** Each pixel of the badge where it lies on the ball as last seen: longitude, and the
   *  map's row, or -1 off the ball. */
  private readonly lon: Float32Array;
  private readonly row: Int32Array;
  private seen: BallView | null = null;
  private drawn = Number.NaN;

  constructor(
    canvas: HTMLCanvasElement,
    actor: Pick<OrbitActor, "name" | "logo" | "kind">,
    size: number,
  ) {
    let h = 0;
    for (let i = 0; i < actor.name.length; i++) h = (h * 31 + actor.name.charCodeAt(i)) >>> 0;
    this.from = ((h % 1000) / 1000) * TAU;
    const px = Math.round(size * Math.min(2, window.devicePixelRatio || 1) * BALL_SHARPER);
    canvas.width = px;
    canvas.height = px;
    this.px = px;
    this.context = canvas.getContext("2d");
    this.out = this.context?.createImageData(px, px) ?? null;
    this.lon = new Float32Array(px * px);
    this.row = new Int32Array(px * px).fill(-1);
    // the map: a pixel a radian of its height per half the badge, so a mark at the
    // front shows at its own size
    const k = px / 2;
    this.w = Math.round(TAU * k);
    this.h = Math.round(Math.PI * k);
    const sheet = document.createElement("canvas");
    sheet.width = this.w;
    sheet.height = this.h;
    const map = sheet.getContext("2d");
    const icon = actor.logo ? LOGOS[actor.logo] : null;
    const font = getComputedStyle(canvas).fontFamily;
    if (map) {
      map.fillStyle = "#fff";
      for (let third = 0; third < 3; third++) {
        for (const wrap of [-this.w, 0, this.w]) {
          const x = (third * this.w) / 3 + wrap;
          if (icon) {
            const side = px * markShare(actor.kind);
            map.save();
            map.translate(x - side / 2, this.h / 2 - side / 2);
            map.scale(side / 24, side / 24);
            map.fill(new Path2D(icon.path));
            map.restore();
          } else {
            map.font = `700 ${px * 0.42}px ${font}`;
            map.textAlign = "center";
            map.textBaseline = "middle";
            map.fillText(initialsOf(actor.name, actor.kind === "person" ? 2 : 1), x, this.h / 2);
          }
        }
      }
    }
    this.ink = map ? map.getImageData(0, 0, this.w, this.h).data : new Uint8ClampedArray(0);
  }

  /** Paints the ball as `view` sees it, turned `turned` radians round its axis. */
  paint(view: BallView, turned: number) {
    const { context, out, px, w, h, lon, row, ink } = this;
    if (!context || !out || ink.length === 0) return;
    const moved = !this.seen || !alike(this.seen, view);
    if (moved) {
      this.seen = view;
      for (let j = 0; j < px; j++) {
        for (let i = 0; i < px; i++) {
          const at = ballPoint(((i + 0.5) / px) * 2 - 1, ((j + 0.5) / px) * 2 - 1, view);
          const p = j * px + i;
          if (!at) {
            row[p] = -1;
            continue;
          }
          lon[p] = at[0];
          row[p] = Math.min(h - 1, Math.floor((at[1] / Math.PI + 0.5) * h));
        }
      }
    } else if (Math.abs(turned - this.drawn) < 0.002) {
      return;
    }
    this.drawn = turned;
    const data = out.data;
    for (let p = 0; p < px * px; p++) {
      const y = row[p];
      const o = p * 4;
      if (y < 0) {
        data[o + 3] = 0;
        continue;
      }
      const u = ((((lon[p] + turned) / TAU) % 1) + 1) % 1;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = ink[(y * w + Math.min(w - 1, Math.floor(u * w))) * 4 + 3];
    }
    context.putImageData(out, 0, 0);
  }
}

/** Two views of a ball too near alike to tell apart on its badge. */
function alike(a: BallView, b: BallView): boolean {
  for (const key of ["right", "up", "toward"] as const) {
    for (let i = 0; i < 3; i++) if (Math.abs(a[key][i] - b[key][i]) > 0.002) return false;
  }
  return true;
}

/** The card of whoever is under the pointer: a person with the agents they worked
 *  through, an agent's person with theirs, the agent picked out, or an
 *  integration's name. */
function ActorCard({ actors, actor }: { actors: readonly OrbitActor[]; actor: number }) {
  const t = useT();
  const who = actors[actor];
  const person = who.kind === "person" ? actor : who.kind === "agent" ? who.owner : -1;
  if (person < 0 || !actors[person]) {
    return (
      <div className="orbit-card-head">
        <Badge actor={who} small />
        <b dir="auto">{who.name}</b>
      </div>
    );
  }
  const agents = actors.flatMap((a, i) => (a.owner === person ? [i] : []));
  return (
    <>
      <div className="orbit-card-head">
        <Badge actor={actors[person]} small />
        <b dir="auto">{actors[person].name}</b>
      </div>
      <p className="orbit-card-count">
        {t("{count, plural, =0 {No agents} one {# agent} other {# agents}}", {
          count: agents.length,
        })}
      </p>
      {agents.length > 0 ? (
        <ul className="orbit-card-agents">
          {agents.map((i) => (
            <li key={i} data-picked={i === actor ? "" : undefined}>
              <Badge actor={actors[i]} small />
              <span dir="auto">{actors[i].name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** The period's activity, a bar for each slice of it: queries at the foot, then
 *  writes, then imports. Heights follow the square root of the count, so a quiet
 *  hour still shows beside an import of thousands. */
function Bars({ buckets }: { buckets: OrbitData["buckets"] }) {
  const bars = useMemo(() => {
    const [imports, writes, queries] = buckets;
    const totals = Array.from(
      { length: ORBIT_BUCKETS },
      (_, i) => (imports[i] ?? 0) + (writes[i] ?? 0) + (queries[i] ?? 0),
    );
    const most = Math.max(1, ...totals);
    return totals.map((total, i) => {
      if (total === 0) return { height: "0", background: "none" };
      const q = ((queries[i] ?? 0) / total) * 100;
      const w = q + ((writes[i] ?? 0) / total) * 100;
      return {
        height: `${(6 + 94 * Math.sqrt(total / most)).toFixed(1)}%`,
        background: `linear-gradient(to top, var(--color-queries) 0 ${q.toFixed(1)}%, var(--color-writes) 0 ${w.toFixed(1)}%, var(--color-imports) 0)`,
      };
    });
  }, [buckets]);
  return (
    <div className="orbit-bars" aria-hidden="true">
      {bars.map((style, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the bars are the period's slices, in order
        <i key={i} style={style} />
      ))}
    </div>
  );
}
