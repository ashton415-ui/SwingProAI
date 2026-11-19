/**
 * GJ-PARALLEL-02 — My Bag read state.
 *
 * The bag page reads the golfer's saved clubs and their swing telemetry on the
 * server. Either read can fail; before this, a failure became an empty list and
 * the page said "Your bag is empty" or "No data". Here both reads must succeed
 * before any bag data is shown. The first known failure of either read decides
 * at once ("unavailable") — it does not wait for the other read — and the other
 * read is then cancelled through the client's own `.abortSignal`; its late
 * outcome is ignored. Both reads hanging without failing stays pending (no
 * timeout policy is added). Read-only: no write, retry or provider call.
 *
 * Reuses the accepted `readList` classification unchanged.
 */
import { readList, type ListReadResponse } from "@/lib/golfer-journey-read-state";

export interface BagReads<Equipment, Telemetry> {
  readonly equipment: () => PromiseLike<ListReadResponse<Equipment>>;
  readonly telemetry: () => PromiseLike<ListReadResponse<Telemetry>>;
}

export type BagRead<Equipment, Telemetry> =
  | { readonly status: "ready"; readonly equipment: Equipment[]; readonly telemetry: Telemetry[] }
  | { readonly status: "unavailable" };

const UNAVAILABLE: BagRead<never, never> = Object.freeze({ status: "unavailable" });

/**
 * Next.js signals a redirect, a not-found or a dynamic-rendering bail-out by
 * throwing an error with one of these digests; such signals must propagate,
 * never become "unavailable".
 */
function isNextControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest;
  return typeof digest === "string" && /^(NEXT_REDIRECT|NEXT_NOT_FOUND|DYNAMIC_SERVER_USAGE)/.test(digest);
}

/**
 * Runs both bag reads. `makeReads` builds the client (it runs after the page's
 * unchanged session decision and may throw or reject: that is "unavailable").
 * Never rejects, except to pass on a Next.js control-flow signal thrown while
 * building the client.
 */
export async function readBag<Equipment, Telemetry>(
  makeReads: (signal: AbortSignal) => BagReads<Equipment, Telemetry> | PromiseLike<BagReads<Equipment, Telemetry>>,
): Promise<BagRead<Equipment, Telemetry>> {
  const controller = new AbortController();
  let reads: BagReads<Equipment, Telemetry>;
  try {
    reads = await makeReads(controller.signal);
  } catch (error) {
    if (isNextControlFlow(error)) throw error;
    return UNAVAILABLE;
  }
  // readList never rejects, so neither chain below can leave an unhandled rejection.
  const equipment = readList(reads.equipment);
  const telemetry = readList(reads.telemetry);
  return new Promise<BagRead<Equipment, Telemetry>>((resolve) => {
    let clubs: Equipment[] | null = null;
    let rows: Telemetry[] | null = null;
    const fail = () => {
      resolve(UNAVAILABLE); // a later resolve (the other read's outcome) is a no-op
      controller.abort();
    };
    equipment.then((e) => {
      if (e.status !== "ready") return fail();
      clubs = e.rows;
      if (rows !== null) resolve({ status: "ready", equipment: clubs, telemetry: rows });
    });
    telemetry.then((t) => {
      if (t.status !== "ready") return fail();
      rows = t.rows;
      if (clubs !== null) resolve({ status: "ready", equipment: clubs, telemetry: rows });
    });
  });
}

/**
 * Attaches a read's cancellation signal (the client's own `.abortSignal`, which
 * sets it on the same builder and returns it) without changing the query.
 */
export function cancellable<Q extends { abortSignal(signal: AbortSignal): unknown }>(query: Q, signal: AbortSignal): Q {
  query.abortSignal(signal);
  return query;
}

export const BAG_COPY = {
  title: "My Bag",
  description: "Keep your clubs in one place and see the latest swing numbers saved for each one.",
  unavailableTitle: "Your bag didn't load",
  unavailableBody: "We couldn't load your clubs or their swing data just now, so your bag isn't shown. Try again in a moment.",
  stillUnavailable: "Still couldn't load your bag. Please try again in a moment.",
  retry: "Try again",
  retrying: "Trying again…",
} as const;
