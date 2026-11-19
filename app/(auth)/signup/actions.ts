"use server";

import { createClient } from "@/utils/supabase/server";

// AG-AUTH-03: the page is told one of three fixed, app-owned outcomes. No provider message, token, session, user
// identifier, metadata or submitted value is ever returned, logged or placed in a URL.
//   continue     Auth answered with a usable user and no error (with or without a session, including the obfuscated
//                user it can return for an existing address), or with the one duplicate code below. These are the same
//                answer, so the page cannot tell them apart; it says only "sign in to continue". The app neither reads
//                nor persists a returned session (the installed SDK holds it only in this request's own client memory):
//                no cookie, no setSession, no refresh, no sign-in and no second Auth request.
//   failed       Auth refused this request (an error with a 4xx status and any other code, an unknown code or no code at
//                all, even when its message says the address is registered).
//   unconfirmed  The outcome is unknown: a transport or server failure (no status, or 5xx), a thrown exception, or an
//                answer with neither an error nor a usable user. The account may or may not exist.
type SignupOutcome = "continue" | "failed" | "unconfirmed";

// Recognized by code only, never by message text. The installed auth-js 2.107.0 lists `user_already_exists` among its
// known error codes (src/lib/error-codes.ts) and copies the server's code onto the error it returns (lib/fetch.js,
// handleError). Other account-existence codes are deliberately not recognized.
const DUPLICATE_CODES: ReadonlySet<string> = new Set(["user_already_exists"]);

// Reads only the fields named here: the result's `data` and `error`, the error's `code` and `status`, and the user's
// `id` (its type only). The error's message, the session and the user's other fields are never read.
function interpret(result: unknown): SignupOutcome {
  if (typeof result !== "object" || result === null) return "unconfirmed";
  const { data, error } = result as { data?: unknown; error?: unknown };
  if (error !== null) {
    if (typeof error !== "object") return "unconfirmed"; // missing, or not an error object
    const { code, status } = error as { code?: unknown; status?: unknown };
    if (typeof code === "string" && DUPLICATE_CODES.has(code)) return "continue";
    return typeof status === "number" && status >= 400 && status < 500 ? "failed" : "unconfirmed";
  }
  if (typeof data !== "object" || data === null) return "unconfirmed";
  const { user } = data as { user?: unknown };
  if (typeof user !== "object" || user === null) return "unconfirmed";
  const { id } = user as { id?: unknown };
  return typeof id === "string" && id.length > 0 ? "continue" : "unconfirmed";
}

// Next.js 14.2.4's own control flow (a redirect or not-found; the same digests its isRedirectError/isNotFoundError
// accept) is rethrown for the framework, never turned into an outcome. Nothing in this action throws one today.
function isFrameworkSignal(error: unknown): boolean {
  try {
    if (typeof error !== "object" || error === null || !("digest" in error)) return false;
    const digest = (error as { digest?: unknown }).digest;
    if (digest === "NEXT_NOT_FOUND") return true;
    if (typeof digest !== "string") return false;
    const [code, type, url, status] = digest.split(";");
    return code === "NEXT_REDIRECT" && (type === "replace" || type === "push") && !!url && /^30[378]$/.test(status ?? "");
  } catch {
    return false;
  }
}

export async function signupAction(formData: FormData) {
  let outcome: SignupOutcome;
  try {
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    const fullName = formData.get("fullName") as string;

    const supabase = await createClient();

    outcome = interpret(
      await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName } },
      }),
    );
  } catch (error) {
    if (isFrameworkSignal(error)) throw error;
    outcome = "unconfirmed";
  }
  return { outcome };
}
