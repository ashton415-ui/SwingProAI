/**
 * GJ-PARALLEL-01 — honest read states for the Drill Hub and the Progress Hub.
 *
 * Both pages read lists with the Supabase client. A list read either
 * succeeded — and an empty list then genuinely means "nothing yet" — or it did
 * not, and then nothing is known: not zero analyses, not zero verified drills,
 * not a "pending" status. This module keeps those two outcomes apart.
 *
 * Read-only by construction: it only awaits the read functions it is given.
 * It never retries on its own, writes, or calls a provider, and it keeps no
 * error text, so nothing raw can reach a golfer-facing message.
 */

/** The shape a Supabase list read resolves to. Only these two fields are used. */
export interface ListReadResponse<Row> {
  readonly data: Row[] | null;
  readonly error: unknown;
}

export type ListRead<Row> =
  | { readonly status: "ready"; readonly rows: Row[] }
  | { readonly status: "unavailable" };

/**
 * Runs one list read and classifies it. A returned error, a rejected or thrown
 * read, or a response without a row array is "unavailable". Only a successful
 * response with an array is "ready", and only then is an empty array an
 * empty history.
 */
export async function readList<Row>(
  run: () => PromiseLike<ListReadResponse<Row>>,
): Promise<ListRead<Row>> {
  try {
    const response = await run();
    if (!response || response.error || !Array.isArray(response.data)) {
      return { status: "unavailable" };
    }
    return { status: "ready", rows: response.data };
  } catch {
    return { status: "unavailable" };
  }
}

// ─── Progress Hub ──────────────────────────────────────────────────────────────

/**
 * The Progress Hub's existing bound on its analysis read (unchanged: 10). The
 * count it shows is the number of rows in this window, so its label names the
 * window instead of claiming a lifetime total.
 */
export const PROGRESS_HUB_RECENT_LIMIT = 10;
export const PROGRESS_HUB_COUNT_LABEL = "Recent Analyses";
export const PROGRESS_HUB_COUNT_SCOPE = `Up to ${PROGRESS_HUB_RECENT_LIMIT} most recent`;

export const PROGRESS_HUB_UNAVAILABLE_COPY = {
  title: "Your analyses didn't load",
  body: "We couldn't load your swing history just now, so your stats aren't shown. Try again in a moment.",
  stillUnavailable: "Still couldn't load your swing history. Please try again in a moment.",
  retry: "Try again",
  retrying: "Trying again…",
} as const;

// ─── Drill Hub ─────────────────────────────────────────────────────────────────

export type DrillHubResult<Drill, Progress> =
  | { readonly phase: "ready"; readonly drills: Drill[]; readonly progress: Progress[] }
  | { readonly phase: "unavailable" };

export type DrillHubState<Drill, Progress> =
  | { readonly phase: "loading" }
  | DrillHubResult<Drill, Progress>;

export interface DrillHubReads<Drill, Progress> {
  readonly catalog: () => PromiseLike<ListReadResponse<Drill>>;
  readonly progress: () => PromiseLike<ListReadResponse<Progress>>;
}

/** One Drill Hub read: its outcome, and when every request it started has finished. Neither ever rejects. */
export interface DrillHubRead<Drill, Progress> {
  /** Settles as soon as the outcome is known: the first failure of either read, or both reads succeeding. */
  readonly result: Promise<DrillHubResult<Drill, Progress>>;
  /** Settles once both underlying reads have settled, including a cancelled companion. */
  readonly settled: Promise<void>;
}

const UNAVAILABLE: DrillHubResult<never, never> = Object.freeze({ phase: "unavailable" });

/**
 * Reads the drill catalog and the golfer's drill progress together.
 *
 * The hub is ready only when both reads succeed. Drill statuses and the
 * verified count come from the progress read, so showing the catalog without
 * it would present unknown progress as "pending" and as zero verified drills;
 * a failure of either read is therefore one whole-hub "unavailable" result.
 * `makeReads` builds the client and may throw; that is "unavailable" too.
 *
 * GJ-PARALLEL-01-R1 (GJ-READ-01): the first known failure decides the result
 * at once — it never waits for the other read. That companion is then
 * cancelled through the signal handed to `makeReads` (the page attaches it to
 * each query with the client's `.abortSignal`); its late result, if any, is
 * ignored. `outer` (the loader's signal) cancels both reads, e.g. on unmount.
 */
export function readDrillHub<Drill, Progress>(
  makeReads: (signal: AbortSignal) => DrillHubReads<Drill, Progress>,
  outer?: AbortSignal,
): DrillHubRead<Drill, Progress> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (outer?.aborted) cancel();
  else outer?.addEventListener("abort", cancel, { once: true });
  const release = () => outer?.removeEventListener("abort", cancel);

  let reads: DrillHubReads<Drill, Progress>;
  try {
    reads = makeReads(controller.signal);
  } catch {
    release();
    return { result: Promise.resolve(UNAVAILABLE), settled: Promise.resolve() };
  }
  // readList never rejects, so neither chain below can leave an unhandled rejection.
  const catalog = readList(reads.catalog);
  const progress = readList(reads.progress);
  const result = new Promise<DrillHubResult<Drill, Progress>>((resolve) => {
    let drills: Drill[] | null = null;
    let rows: Progress[] | null = null;
    const fail = () => {
      resolve(UNAVAILABLE); // a later resolve (the companion's outcome) is a no-op
      cancel();
    };
    catalog.then((c) => {
      if (c.status !== "ready") return fail();
      drills = c.rows;
      if (rows !== null) resolve({ phase: "ready", drills, progress: rows });
    });
    progress.then((p) => {
      if (p.status !== "ready") return fail();
      rows = p.rows;
      if (drills !== null) resolve({ phase: "ready", drills, progress: rows });
    });
  });
  const settled = Promise.all([catalog, progress]).then(release);
  return { result, settled };
}

export interface DrillHubLoader {
  /**
   * Starts a load. Returns false, doing nothing, while one is pending, after
   * dispose, or while DRILL_HUB_MAX_ABANDONED_LOADS earlier loads still have a
   * cancelled read that has not finished.
   */
  load(): boolean;
  /** Ends this loader: the load in flight is cancelled and completes without publishing. */
  dispose(): void;
}

/**
 * Bound on abandoned work: loads whose outcome is already published but whose
 * cancelled companion read has not finished yet. With the installed client a
 * cancelled read finishes at once, so this is never reached in practice; it
 * stops retries from piling up requests if a read ever ignored cancellation.
 */
export const DRILL_HUB_MAX_ABANDONED_LOADS = 2;

/**
 * One load at a time for the Drill Hub. `load` publishes "loading" (which
 * clears an earlier error), then exactly one result, as soon as it is known.
 * A second `load` while one is pending is ignored, so repeated retries cannot
 * stack reads; a retry is accepted as soon as a result is published, even if
 * the previous load's cancelled companion is still finishing (bounded by
 * DRILL_HUB_MAX_ABANDONED_LOADS). A completion that is not the latest load, or
 * that arrives after `dispose` (unmount), is dropped rather than replacing
 * newer state. Each load has its own cancellation signal.
 */
export function createDrillHubLoader<Drill, Progress>(
  read: (signal: AbortSignal) => DrillHubRead<Drill, Progress>,
  publish: (state: DrillHubState<Drill, Progress>) => void,
): DrillHubLoader {
  let latest = 0;
  let pending = false;
  let disposed = false;
  let abandoned = 0;
  let inFlight: AbortController | null = null;

  return {
    load() {
      if (disposed || pending || abandoned >= DRILL_HUB_MAX_ABANDONED_LOADS) return false;
      pending = true;
      const load = ++latest;
      const controller = new AbortController();
      inFlight = controller;
      publish({ phase: "loading" });
      let current: DrillHubRead<Drill, Progress>;
      try {
        current = read(controller.signal);
      } catch {
        current = { result: Promise.resolve(UNAVAILABLE), settled: Promise.resolve() };
      }
      let decided = false;
      let finished = false;
      Promise.resolve(current.result)
        .then((state) => state, (): DrillHubResult<Drill, Progress> => UNAVAILABLE)
        .then((state) => {
          decided = true;
          if (!finished) abandoned++;
          if (inFlight === controller) inFlight = null;
          if (load !== latest) return; // defensive: single-flight already makes every decision the latest load's
          pending = false;
          if (!disposed) publish(state);
        });
      Promise.resolve(current.settled)
        .then(() => undefined, () => undefined)
        .then(() => {
          finished = true;
          if (decided) abandoned--;
        });
      return true;
    },
    dispose() {
      disposed = true;
      inFlight?.abort();
      inFlight = null;
    },
  };
}

export const DRILL_HUB_UNAVAILABLE_COPY = {
  title: "Your drills didn't load",
  body: "We couldn't load your drills or your drill progress just now, so they aren't shown. Try again in a moment.",
  stillUnavailable: "Still couldn't load your drills. Please try again in a moment.",
  /** Shown only if Try again is refused because earlier cancelled reads are still finishing (bounded). */
  stillFinishing: "Your last attempt is still finishing. Try again in a moment.",
  retry: "Try again",
  retrying: "Trying again…",
} as const;
