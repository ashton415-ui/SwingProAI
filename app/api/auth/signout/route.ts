import { NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/**
 * End Session.
 *
 * POST-only. A GET logout would be triggerable by any link or <img> tag.
 *
 * The previous implementation could not work. It built a plain supabase-js
 * client with `persistSession: false`, so `auth.signOut()` loaded no session,
 * never reached the Auth server, and — having no response-cookie writer — never
 * cleared the browser cookie that `getServerSession()` trusts. The golfer
 * stayed signed in until the stored token expired.
 *
 * This uses the cookie-backed SSR client instead: the session is read from the
 * request cookies, and every cookie removal Supabase performs is written onto
 * THIS redirect response. Note the adapter shape — @supabase/ssr 0.3.0 takes
 * get/set/remove, not the getAll/setAll pair used by newer releases.
 *
 * Scope is `local` by product decision: End Session ends this browser's session
 * only and leaves the golfer's other devices signed in.
 */
export async function POST(req: NextRequest) {
  // Built first so the cookie adapter below can write removals onto it. 303
  // makes the browser follow with GET; NextResponse.redirect defaults to 307,
  // which would re-POST to /login. The origin comes from the request so the
  // Set-Cookie headers and the redirect always share one host.
  const response = NextResponse.redirect(
    new URL("/login", req.url),
    { status: 303 }
  );

  response.headers.set("Cache-Control", "private, no-store");

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return req.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          response.cookies.set({ name, value: "", ...options });
        },
      },
    }
  );

  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error) {
    // auth-js returns before clearing storage when the Auth server fails with
    // anything other than 401/403/404, so on that path the cookies would
    // survive and the golfer would stay signed in. Fail closed instead, over
    // the same three storage roots `_removeSession()` clears, plus the
    // `<root>.<index>` chunks @supabase/ssr writes for oversized values.
    const storageKey =
      `sb-${new URL(
        process.env.NEXT_PUBLIC_SUPABASE_URL!
      ).hostname.split(".")[0]}-auth-token`;

    const storageRoots = [
      storageKey,
      `${storageKey}-code-verifier`,
      `${storageKey}-user`,
    ];

    for (const cookie of req.cookies.getAll()) {
      const isAuthStorageCookie = storageRoots.some(
        (root) =>
          cookie.name === root ||
          cookie.name.startsWith(`${root}.`)
      );

      if (isAuthStorageCookie) {
        response.cookies.set({
          name: cookie.name,
          value: "",
          path: "/",
          maxAge: 0,
        });
      }
    }
  }

  return response;
}
