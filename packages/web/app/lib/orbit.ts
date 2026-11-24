// Orbit, on the workspace home (/workspaces/<handle>), draws a workspace as rings of
// neurons around its constitution: a collection is a ring, a record a neuron,
// a link between records a synapse, and the people, agents and integrations
// that wrote, queried or imported sit around the rings, with a long synapse to
// each ring they touched (decision_01M7FT0GGYWZ8E2CKABFKB4YZV). Its timeline
// bar replays a period of that activity.
//
// This file is what the server sends for it (lib/orbit.server.ts) and the rules
// both sides share. The picture itself is components/orbit.tsx.

import type { LogoId } from "@doco/ui";
/** The periods the timeline bar offers, in milliseconds. Live is not replayed:
 *  its bar holds the last quarter of an hour and its playhead is now, so what
 *  happens in the workspace shows as it happens (Alexander, 2026-11-16: "Add a
 *  real-time button, too, left of 1h." "Live" "That is actually live"). */
export const ORBIT_RANGES = {
  live: 900_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
} as const;
export type OrbitRange = keyof typeof ORBIT_RANGES;
export const DEFAULT_ORBIT_RANGE: OrbitRange = "7d";

/** The period a `?range=` asks for, or the default. */
export function orbitRange(value: string | null | undefined): OrbitRange {
  return value && value in ORBIT_RANGES ? (value as OrbitRange) : DEFAULT_ORBIT_RANGE;
}

/** The period the page is on its way to, while a click on another period is
 *  still loading (`going` is where the router is headed, if anywhere), or null. */
export function switchingTo(
  going: { pathname: string; search: string } | undefined,
  pathname: string,
  range: OrbitRange,
): OrbitRange | null {
  if (!going || going.pathname !== pathname) return null;
  const next = orbitRange(new URLSearchParams(going.search).get("range"));
  return next === range ? null : next;
}

/** Under this width (CSS pixels of the picture's own box) there is no picture:
 *  the workspace home shows only the list of collections (Alexander, 2026-11-16:
 *  "Don't show in mobile (small resolutions). Only show the list of collections
 *  there."). app.css hides it by the same width. */
export const ORBIT_SMALL = 700;

/** The timeline bar cuts any period into this many bars: an hour each for 7 days. */
export const ORBIT_BUCKETS = 168;
/** The most events the picture replays from one bar's time. Past it, one
 *  event stands for several real ones, as one dot stands for several records. */
export const ORBIT_EVENTS_PER_BUCKET = 12;

/** The most new edges the picture flashes from one bar's time. Past it, one
 *  flash stands for several real edges. */
export const ORBIT_NEW_LINKS_PER_BUCKET = 4;

/** The three activity logs, in the order their colors and counts are kept. */
export const ORBIT_LOGS = ["imports", "writes", "queries"] as const;
export type OrbitLog = (typeof ORBIT_LOGS)[number];

export interface OrbitCollection {
  handle: string;
  /** The template it was made from, which names what it holds. */
  template: string | null;
  /** Who may read it: its title says so with an icon left of its name. */
  visibility: "public" | "private";
  /** How many of the one thing it holds the collection has. */
  items: number;
  /** Its activity over the period, by log (ORBIT_LOGS). */
  activity: [imports: number, writes: number, queries: number];
}

export interface OrbitActor {
  kind: "person" | "agent" | "integration";
  /** A person's name, an agent's ("Claude Code") or an integration's. */
  name: string;
  /** What it did over the period; a person's takes in what their agents did. */
  count: number;
  /** The collection it touched most, or -1 for the workspace as a whole. */
  into: number;
  /** What it is drawn with: an agent's kind's logo, kept from when it was added
   *  (lib/agent-kinds.ts), or an integration's; null for a person, drawn with their
   *  initials (Alexander, 2026-11-16: "Let's remove the pictures of users. They look
   *  awful. Let's use only the initials."), and for an integration of no known
   *  logo, drawn with its name's first letter. An agent of no known kind is drawn
   *  with the sparkle ("agent"). */
  logo: LogoId | null;
  /** The person an agent works for, by place among the actors, whom it circles
   *  (Alexander, 2026-11-16: "What if have agents orbit their users?"): every agent
   *  has one ("Every agent belongs to someone, no?"). -1 for anyone else. */
  owner: number;
}

/** Who did something, as a line of words says it: an agent with its person's
 *  first name ("Claude Code · Alice"), anyone else by their name. */
export function whoActed(actors: readonly OrbitActor[], actor: number): string {
  const who = actors[actor];
  if (!who) return "";
  const owner = actors[who.owner];
  return owner ? `${who.name} · ${owner.name.split(/\s+/)[0]}` : who.name;
}

/** What stands for someone without a picture or a logo: the first letters of a
 *  person's first two names ("AR"), the first of an integration's ("M"). */
export function initialsOf(name: string, letters = 2): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, letters)
    .map((word) => Array.from(word)[0] ?? "");
  return initials.join("").toLocaleUpperCase() || "?";
}

type Direction = readonly [number, number, number];

/** How the camera sees a ball, in the picture's own frame (y the rings' axis): the
 *  badge's right and up, and the way from the ball to the camera. */
export interface BallView {
  right: Direction;
  up: Direction;
  toward: Direction;
}

/** How the camera at `eye` sees a ball at `at`, `screenUp` being the camera's up
 *  (the rings' axis, tipped as the camera looks down): the very camera that draws
 *  the rings, from where the ball stands, so a ball and the rings are always seen in
 *  the same perspective (Alexander, 2026-11-16: "The spheres, the galaxy, everything
 *  needs to have the same perspective at the same time"). */
export function ballView(eye: Direction, at: Direction, screenUp?: Direction): BallView {
  const toward = unit([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]);
  const up0 = screenUp ?? cameraUp(eye, at);
  const right = unit(cross(up0, toward));
  return { right, up: cross(toward, right), toward };
}

/** The up of a camera at `eye` looking at `target`, the rings' axis kept upright. */
export function cameraUp(eye: Direction, target: Direction): Direction {
  const forward = unit([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const right = unit(cross(forward, [0, 1, 0]));
  return cross(right, forward);
}

/** Where on a ball a point of its badge lies (x, y from -1 to 1 across and down), as
 *  `view` sees it: how far round from the side the camera first saw (longitude) and
 *  down from its equator, which lies level with the rings (latitude), in radians, or
 *  null off the ball. A face printed on the ball is drawn by reading it at these, so
 *  it curves over the ball, leans away at the rim as the ball turns, and tips with
 *  the rings as the camera does. */
export function ballPoint(x: number, y: number, view: BallView): [number, number] | null {
  const r2 = x * x + y * y;
  if (r2 >= 1) return null;
  // the ball's surface toward the camera, at this point, in the picture's frame
  const z = Math.sqrt(1 - r2);
  const { right, up, toward } = view;
  const nx = x * right[0] - y * up[0] + z * toward[0];
  const ny = x * right[1] - y * up[1] + z * toward[1];
  const nz = x * right[2] - y * up[2] + z * toward[2];
  return [Math.atan2(nx, nz), 0 - Math.asin(Math.max(-1, Math.min(1, ny)))];
}

/** How wide a logo is printed on someone's ball, as a share of the ball's width: a
 *  moon's half as large again as a planet's (Alexander, 2026-11-17: "make the icons
 *  inside of the moons 50% bigger"). */
export function markShare(kind: OrbitActor["kind"]): number {
  return kind === "agent" ? 0.81 : 0.54;
}

/** How large a ball is drawn (px), `size` being how large it is at `distance`, the
 *  distance the camera stands from the rings, and `depth` how far it stands from this
 *  ball: as the camera's perspective draws the rings. */
export function ballSize(size: number, distance: number, depth: number): number {
  return (size * distance) / depth;
}

function cross(a: Direction, b: Direction): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v: Direction): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** One replayed event: when (ms), which log (index into ORBIT_LOGS), who
 *  (index into actors), where (index into collections, or -1 for a search
 *  across the workspace), and how many real events it stands for. */
export type OrbitEvent = [at: number, log: number, actor: number, collection: number, n: number];

/** Edges added during the period: when (ms), the two collections they join
 *  (the same index twice for edges inside one, the smaller first), and how many
 *  real edges it stands for. */
export type OrbitNewLink = [at: number, a: number, b: number, n: number];

export interface OrbitData {
  /** The period: ISO times. */
  since: string;
  until: string;
  collections: OrbitCollection[];
  /** Live edges between records, as [collection, collection, how many]: the
   *  same index twice for edges inside one collection. */
  links: [number, number, number][];
  /** The edges added during the period, oldest first: the picture brightens a synapse for each. */
  newLinks: OrbitNewLink[];
  actors: OrbitActor[];
  /** The period's events, oldest first. */
  events: OrbitEvent[];
  /** Each bar's true count, by log (ORBIT_LOGS), whatever was left out of `events`. */
  buckets: [imports: number[], writes: number[], queries: number[]];
}

/** What the server answers apart: the standing links, and the period's activity,
 *  which is the slower to count (Alexander, 2026-11-16, picked "two answers from
 *  the server"). Neither waits for the other. */
export type OrbitLinks = OrbitData["links"];
export type OrbitActivity = Omit<OrbitData, "links">;

/** The period before its activity arrives: the collections the page already has,
 *  with nobody acting. The rings are drawn from it at once. */
export function emptyActivity(
  collections: readonly Omit<OrbitCollection, "activity">[],
  range: OrbitRange,
  now: number,
): OrbitActivity {
  return {
    since: new Date(now - ORBIT_RANGES[range]).toISOString(),
    until: new Date(now).toISOString(),
    collections: collections.map((c) => ({ ...c, activity: [0, 0, 0] })),
    newLinks: [],
    actors: [],
    events: [],
    buckets: [[], [], []],
  };
}

/** How long the rings take to rise, all of them, and how long one ring takes at
 *  least and at most; and how long the planets, then the moons, take to fade in. */
const RISE = { all: 1.2, least: 0.08, most: 0.25, fade: 0.3 };

/** Where `risingFrom` ends: every ring, planet and moon stands. */
export const ORBIT_RISEN = -2;

/**
 * The first time the picture stands, it comes in in order (Alexander, 2026-11-16:
 * "first, we render all of the rings of the galaxy, then the planets, and then the
 * moons. They should fade in quickly, but they shouldn't just appear
 * instantaneously ... Only then do we start with representing the images, about
 * writes, reads, connections happening"): its rings rise one at a time from the
 * constitution outward (he picked "ring by ring, from the constitution outward"),
 * then the planets fade in, people and integrations together, then the moons. This
 * is the layer `seconds` in that has not finished rising. The ring layers count from
 * the outside, the largest first: a ring whose layer is under it is still hidden,
 * the one it is inside is fading in. The planets are the layer after the last ring,
 * -1, the moons the one after them, -2, so ORBIT_RISEN means everything stands.
 */
export function risingFrom(seconds: number, rings: number): number {
  const each = rings === 0 ? 0 : Math.min(RISE.most, Math.max(RISE.least, RISE.all / rings));
  const after = seconds - rings * each;
  if (after < 0) return rings - seconds / each;
  return Math.max(ORBIT_RISEN, -after / RISE.fade);
}

/** How far someone has faded in (0 to 1) while the picture comes in, `from` being
 *  where `risingFrom` is: the planets, people and integrations, on the layer after
 *  the last ring, and the moons, the agents, on the one after them. The graphics
 *  card does the same for their marks (components/orbit-engine.ts: risen). */
export function risenFor(kind: OrbitActor["kind"], from: number): number {
  const layer = kind === "agent" ? -2 : -1;
  return Math.min(1, Math.max(0, layer + 1 - from));
}

/** How long the picture takes to reach full speed once everything has loaded. */
export const ORBIT_SPIN_UP = 3;

/**
 * How fast the picture moves, from 0 (standing still) to 1 (full speed), `seconds`
 * after everything loaded: its turning, its playhead and all that lives on its
 * clock speed up together, slowly at first (Alexander, 2026-11-16: "slowly
 * accelerate the entire thing, after everything loaded, including the automatic
 * rotation, from stand still to full speed, in three seconds").
 */
export function spinUp(seconds: number): number {
  const x = Math.min(1, Math.max(0, seconds / ORBIT_SPIN_UP));
  return x * x * (3 - 2 * x);
}

/** How many dots each collection gets out of a fixed budget: every record
 *  while the collection fits, a square-root share of what is left once it does
 *  not. The budget is what keeps a phone smooth however much a workspace
 *  holds; the page says how many records one dot stands for. */
export function allocateDots(counts: readonly number[], budget: number): number[] {
  const shown = counts.map(() => 0);
  let open = counts.map((_, i) => i).filter((i) => counts[i] > 0);
  let left = budget;
  while (open.length > 0) {
    const weight = open.reduce((sum, i) => sum + Math.sqrt(counts[i]), 0);
    const share = (i: number) => (left * Math.sqrt(counts[i])) / weight;
    const full = open.filter((i) => share(i) >= counts[i]);
    if (full.length === 0) {
      for (const i of open) shown[i] = Math.floor(share(i));
      break;
    }
    for (const i of full) {
      shown[i] = counts[i];
      left -= counts[i];
    }
    open = open.filter((i) => !full.includes(i));
  }
  return shown;
}

/** 0.08 to 1: how large a collection is drawn, by its order of magnitude, so
 *  12 records and half a million both read in one picture. */
export function extent(count: number): number {
  return Math.max(0.08, Math.min(1, Math.log10(count + 1) / 5.7));
}

/** What one actor did to one collection through one log during one bar. */
export interface OrbitTally {
  log: number;
  actor: number;
  collection: number;
  n: number;
  /** When the first and the last of them happened (ms). */
  firstAt: number;
  lastAt: number;
}

/** Shares `most` moments out among a bar's tallies: every real thing has its
 *  own while the bar holds few, and past `most` they share that many, every
 *  tally keeping at least one. A tally's moments run from its first real time
 *  to its last. Each is [which tally, when, how many real ones it stands for]. */
function shareOut(
  tallies: readonly { n: number; firstAt: number; lastAt: number }[],
  most: number,
): [tally: number, at: number, n: number][] {
  const total = tallies.reduce((sum, t) => sum + t.n, 0);
  const scale = Math.min(1, most / Math.max(1, total));
  const shares: [number, number, number][] = [];
  tallies.forEach((t, index) => {
    const k = Math.max(1, Math.round(t.n * scale));
    for (let j = 0; j < k; j++) {
      const at = k === 1 ? t.firstAt : t.firstAt + ((t.lastAt - t.firstAt) * j) / (k - 1);
      // the real ones are shared out among the k, the remainder to the first ones
      shares.push([index, Math.round(at), Math.floor(t.n / k) + (j < t.n % k ? 1 : 0)]);
    }
  });
  return shares.sort((a, b) => a[1] - b[1]);
}

/** One bar's tallies as the events the picture replays, oldest first: at most
 *  ORBIT_EVENTS_PER_BUCKET, past which one event stands for several real ones. */
export function spreadEvents(tallies: readonly OrbitTally[]): OrbitEvent[] {
  return shareOut(tallies, ORBIT_EVENTS_PER_BUCKET).map(([index, at, n]) => {
    const t = tallies[index];
    return [at, t.log, t.actor, t.collection, n];
  });
}

/** One bar's new edges as the flashes the picture shows, oldest first: at most
 *  ORBIT_NEW_LINKS_PER_BUCKET, past which one flash stands for several real edges. */
export function spreadNewLinks(
  tallies: readonly { a: number; b: number; n: number; firstAt: number; lastAt: number }[],
): OrbitNewLink[] {
  return shareOut(tallies, ORBIT_NEW_LINKS_PER_BUCKET).map(([index, at, n]) => [
    at,
    tallies[index].a,
    tallies[index].b,
    n,
  ]);
}

/** Anything that happened at a moment: its time (ms) comes first. */
type Timed = readonly [at: number, ...rest: number[]];

/** The first event after `at`, or -1. */
export function eventAfter(events: readonly Timed[], at: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid][0] <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo < events.length ? lo : -1;
}

/** Seconds an event's data takes between who acted and the neuron it touches. */
export const ORBIT_TRAVEL = 1.15;
/** Seconds a connection takes to appear, and to fade once its data has arrived. */
const CONNECTION_IN = 0.12;
const CONNECTION_OUT = 0.5;

/** How much of the connection between who acted and a collection shows (0 to
 *  1), `seconds` after an event set off along it. A connection is no standing
 *  line: it is there only while data moves and fades soon after (Alexander,
 *  2026-11-15: "they should only pop up when there is information being sent
 *  or received"). */
export function connectionStrength(seconds: number): number {
  if (seconds <= 0 || seconds >= ORBIT_TRAVEL + CONNECTION_OUT) return 0;
  return Math.min(
    1,
    seconds / CONNECTION_IN,
    (ORBIT_TRAVEL + CONNECTION_OUT - seconds) / CONNECTION_OUT,
  );
}

/** Where an event's data is `seconds` after it set off, from who acted (0) to
 *  the neuron it touches (1), or null while none moves. Data flows one way: an
 *  import or a write into the collection, a query's answer out of it to who
 *  asked (Alexander, 2026-11-16: "have the animation of queries only flow one
 *  way, and writes and import the other way"). */
export function flowAt(log: number, seconds: number): number | null {
  if (seconds < 0 || seconds > ORBIT_TRAVEL) return null;
  const done = seconds / ORBIT_TRAVEL;
  return log === 2 ? 1 - done : done;
}

/** Seconds since the neuron an event touches fired, `seconds` after it set off
 *  (below 0 before): an import or a write fires it on landing, a query at once,
 *  as its answer leaves. */
export function firedSince(log: number, seconds: number): number {
  return log === 2 ? seconds : seconds - ORBIT_TRAVEL;
}

/** How often a live picture asks what happened, and how far behind now its
 *  playhead runs (ms): far enough that an event is heard of before its moment
 *  comes, so each plays once, at its own time. */
export const ORBIT_LIVE_EVERY = 3_000;
export const ORBIT_LIVE_DELAY = 5_000;

/** Where a live picture's playhead is: now on the server's clock (this browser's
 *  `now` plus how far the server's is `ahead`), ORBIT_LIVE_DELAY back, never past
 *  the last answer's `until` and never behind where it was (`at`). */
export function liveAt(at: number, until: number, now: number, ahead: number): number {
  return Math.max(at, Math.min(until, now + ahead - ORBIT_LIVE_DELAY));
}

/** How long the timeline takes to play a period through. */
export const ORBIT_PLAY_SECONDS = 120;

const TICK_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1_440, 2_880, 7_200, 10_080].map(
  (minutes) => minutes * 60_000,
);

/** Where the timeline bar marks time between `since` and `until` (ms): at most
 *  eight marks on round local times, days when a mark is a day or more apart.
 *  `offsetMinutes` is the reader's Date#getTimezoneOffset. */
export function timelineTicks(
  since: number,
  until: number,
  offsetMinutes: number,
): { at: number[]; days: boolean } {
  const step =
    TICK_STEPS.find((s) => (until - since) / s <= 8) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const offset = offsetMinutes * 60_000;
  const at: number[] = [];
  for (let t = Math.ceil((since - offset) / step) * step + offset; t <= until; t += step) {
    at.push(t);
  }
  return { at, days: step >= 86_400_000 };
}
