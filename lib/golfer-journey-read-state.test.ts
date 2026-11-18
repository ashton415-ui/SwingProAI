import { describe, expect, it } from "vitest";
import { readList } from "@/lib/golfer-journey-read-state";

/**
 * GJ-PARALLEL-01 — the shared list-read classification used by the Drill Hub
 * and the Progress Hub. Only a successful response carrying a row array is
 * "ready"; everything else is "unavailable" and keeps no error text.
 */
describe("readList", () => {
  it("a successful read with rows is ready with exactly those rows", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    await expect(readList(async () => ({ data: rows, error: null }))).resolves.toEqual({ status: "ready", rows });
  });

  it("a successful read with zero rows is ready and empty (a genuine empty history)", async () => {
    await expect(readList(async () => ({ data: [], error: null }))).resolves.toEqual({ status: "ready", rows: [] });
  });

  it("a returned error is unavailable even when a data array is present", async () => {
    const result = await readList(async () => ({
      data: [{ id: "a" }],
      error: { message: 'permission denied for table "secret_table"', code: "42501" },
    }));
    expect(result).toEqual({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toMatch(/permission|secret_table|42501/);
  });

  it("a returned error with null data is unavailable, not empty", async () => {
    await expect(readList(async () => ({ data: null, error: { message: "x" } }))).resolves.toEqual({ status: "unavailable" });
  });

  it("null data without an error is unavailable (no rows were actually returned)", async () => {
    await expect(readList(async () => ({ data: null, error: null }))).resolves.toEqual({ status: "unavailable" });
  });

  it("a non-array data value is unavailable", async () => {
    await expect(
      readList(async () => ({ data: { id: "a" } as unknown as { id: string }[], error: null })),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("a rejected read is unavailable and the rejection does not escape", async () => {
    await expect(readList(() => Promise.reject(new Error("TypeError: fetch failed at 10.0.0.1")))).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("a read that throws synchronously is unavailable", async () => {
    await expect(
      readList(() => {
        throw new Error("supabaseUrl is required.");
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("a resolved non-object response is unavailable", async () => {
    await expect(
      readList(async () => undefined as unknown as { data: never[]; error: null }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("awaits a Supabase-style thenable (PromiseLike, not a Promise)", async () => {
    const thenable = {
      then(resolve: (value: { data: { id: string }[]; error: null }) => void) {
        resolve({ data: [{ id: "t" }], error: null });
      },
    };
    await expect(readList(() => thenable as PromiseLike<{ data: { id: string }[]; error: null }>)).resolves.toEqual({
      status: "ready",
      rows: [{ id: "t" }],
    });
  });
});
