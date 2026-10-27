// ENT-1D integration fixtures (LOCAL ONLY). Synthetic golfers, clubs, videos
// and analysis rows, created through the local stack's own Auth, PostgREST and
// Storage with the service role, and removed afterwards. Fixture writes are
// test setup, not the behaviour under test: every assertion in the suites is
// about what the application modules do to these rows.

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Family = "full_swing" | "putting";

export const admin: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const created = { users: [] as string[], objects: [] as string[] };

/**
 * Privileged fixture SQL, as the database owner, inside this run's own
 * database container (ENT1D_DB_CONTAINER, whose project label must equal
 * ENT1D_EXPECTED_LABEL). Used only for states no API role may create: a
 * historical row that predates a guard, or an explicit operator change under
 * the execution guard's operator override. Returns psql's tuples-only output.
 */
let containerVerified = false;
export function operatorSql(sql: string): string {
  const container = process.env.ENT1D_DB_CONTAINER;
  const label = process.env.ENT1D_EXPECTED_LABEL;
  if (!container || !label) throw new Error("ENT1D_DB_CONTAINER and ENT1D_EXPECTED_LABEL are required for operator fixtures.");
  if (!containerVerified) {
    const actual = execFileSync("docker", ["inspect", "--format", '{{index .Config.Labels "com.supabase.cli.project"}}', container], { encoding: "utf8" }).trim();
    if (actual !== label) throw new Error(`TARGET_MISMATCH: ${container} is ${actual}`);
    containerVerified = true;
  }
  return execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
  }).trim();
}

/** The execution guard's operator override, bound to the current transaction. */
export const OPERATOR_OVERRIDE =
  "select pg_catalog.set_config('swingproai.execution_guard', 'operator_override:' || pg_catalog.txid_current(), true);";

/** Statements run under the execution guard's explicit operator override. */
export function asOperator(statements: string): string {
  return operatorSql(`begin;
${OPERATOR_OVERRIDE}
${statements}
commit;`);
}

export interface Golfer {
  readonly id: string;
  readonly accessToken: string;
}

/** A confirmed synthetic golfer, signed in through local Auth. */
export async function createGolfer(tier = "none"): Promise<Golfer> {
  const email = `ent1d-app-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  created.users.push(data.user.id);
  await setTier(data.user.id, tier);
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn failed: ${signIn.error?.message}`);
  return { id: data.user.id, accessToken: signIn.data.session.access_token };
}

export async function setTier(userId: string, tier: string, status = "active"): Promise<void> {
  const { error } = await admin
    .from("users")
    .update({ subscription_tier: tier, subscription_status: tier === "none" ? "none" : status })
    .eq("id", userId);
  if (error) throw new Error(`setTier failed: ${error.message}`);
}

/** Bytes that look like the start of an MP4; never decoded by anything here. */
export const SYNTHETIC_VIDEO = new Uint8Array([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
  ...Array.from(randomBytes(4096)),
]);

/**
 * One analysis row in the given family and status, with its club and video.
 * `upload` stores the synthetic video in the golfer's own folder of the real
 * local `swing-videos` bucket.
 */
export async function createAnalysis(
  golfer: Golfer,
  family: Family,
  options: { status?: string; upload?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const clubId = randomUUID();
  const club = family === "putting" ? "Putter" : "Driver";
  // The browser upload form: <owner>/<uuid>/<file>.
  const storagePath = `${golfer.id}/${id}/ent1d.mp4`;

  let r = await admin.from("user_equipment").insert({
    id: clubId, user_id: golfer.id, club_type: club, custom_club: true, custom_brand: "Synthetic", custom_model: "E1",
  });
  if (r.error) throw new Error(`club insert failed: ${r.error.message}`);

  if (options.upload) {
    const up = await admin.storage.from("swing-videos").upload(storagePath, SYNTHETIC_VIDEO, { contentType: "video/mp4" });
    if (up.error) throw new Error(`upload failed: ${up.error.message}`);
    created.objects.push(storagePath);
  }

  r = await admin.from("swing_videos").insert({
    id, user_id: golfer.id, status: "uploaded", storage_path: storagePath, video_url: storagePath,
    original_filename: "ent1d.mp4", file_size: SYNTHETIC_VIDEO.byteLength, mime_type: "video/mp4",
  });
  if (r.error) throw new Error(`video insert failed: ${r.error.message}`);

  r = await admin.from("swing_analysis").insert({ id, swing_video_id: id, user_id: golfer.id, club_id: clubId });
  if (r.error) throw new Error(`analysis insert failed: ${r.error.message}`);

  if (options.status && options.status !== "pending") {
    // A seeded status is a fixture state, set as an operator would.
    asOperator(`update public.swing_analysis set status = '${options.status}' where id = '${id}';`);
  }
  const fam = await row(id);
  const expected = family === "putting" ? "putting" : "full_swing";
  if ((fam.analysis_family ?? "full_swing") !== expected) throw new Error(`family seed mismatch: ${String(fam.analysis_family)}`);
  return id;
}

/** The whole stored row, read with the service role. */
export async function row(id: string): Promise<Record<string, unknown>> {
  const { data, error } = await admin.from("swing_analysis").select("*").eq("id", id).single();
  if (error || !data) throw new Error(`row read failed: ${error?.message}`);
  return data as Record<string, unknown>;
}

/** Removes every golfer this process created; their rows go with them. */
export async function cleanupFixtures(): Promise<string[]> {
  const errors: string[] = [];
  if (created.objects.length > 0) {
    const rm = await admin.storage.from("swing-videos").remove(created.objects);
    if (rm.error) errors.push(`storage: ${rm.error.message}`);
  }
  for (const id of created.users) {
    for (const table of ["swing_analysis", "swing_videos", "user_equipment"]) {
      const d = await admin.from(table).delete().eq("user_id", id);
      if (d.error) errors.push(`${table}: ${d.error.message}`);
    }
    const u = await admin.auth.admin.deleteUser(id);
    if (u.error) errors.push(`auth: ${u.error.message}`);
  }
  created.users.length = 0;
  created.objects.length = 0;
  return errors;
}
