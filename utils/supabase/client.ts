import { createBrowserClient, isBrowser, parse, serialize } from "@supabase/ssr";

// The installed @supabase/ssr 0.3.0 browser client calls only a cookies.get/set/remove adapter. Without one it
// writes document.cookie itself with its own defaults, and it replaces any cookieOptions.maxAge on every write, so
// the attributes are applied here, per write. Names, values, chunking and ordering stay the SDK's own; encoding is
// the SDK's own cookie parse/serialize.
// - Session cookie (the SDK storage key and its ".N" chunks): Path=/, SameSite=Lax, no Domain, not HttpOnly,
//   Secure on an HTTPS page, Max-Age=2592000 (30 days). A removal is always Max-Age=0.
// - Any other name (the PKCE "-code-verifier" key; "-user" is only ever removed here): the SDK's own options, as
//   before, and a removal is still Max-Age=0.
const SESSION_MAX_AGE_S = 2_592_000;

type SdkCookieOptions = Record<string, unknown>;

/** The SDK's default storage key for this project URL (supabase-js trims the URL, then `sb-<first host label>-auth-token`). */
function sessionStorageKey(supabaseUrl: string | undefined): string | null {
  try {
    return `sb-${new URL((supabaseUrl ?? "").trim()).hostname.split(".")[0]}-auth-token`;
  } catch {
    return null;
  }
}

export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const storageKey = sessionStorageKey(supabaseUrl);
  const isSessionCookie = (name: string) =>
    storageKey !== null &&
    (name === storageKey || (name.startsWith(`${storageKey}.`) && /^\d+$/.test(name.slice(storageKey.length + 1))));
  const sessionOptions = (maxAge: number) => ({
    path: "/",
    sameSite: "lax",
    secure: window.location.protocol === "https:",
    maxAge,
  });

  return createBrowserClient(
    supabaseUrl,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string): string | undefined {
          if (!isBrowser()) return undefined;
          return parse(document.cookie)[name];
        },
        set(name: string, value: string, options: SdkCookieOptions) {
          if (!isBrowser()) return;
          document.cookie = isSessionCookie(name)
            ? serialize(name, value, sessionOptions(SESSION_MAX_AGE_S))
            : serialize(name, value, options);
        },
        remove(name: string, options: SdkCookieOptions) {
          if (!isBrowser()) return;
          document.cookie = isSessionCookie(name)
            ? serialize(name, "", sessionOptions(0))
            : serialize(name, "", { ...options, maxAge: 0 });
        },
      },
    }
  );
}
