import { type CookieOptions, createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const SUPABASE_COOKIE_NAME = `sb-atlmnqispyzhsahahpjy-auth-token`;

export async function createClient() {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll().map((c) => ({
            name: c.name,
            value: (() => {
              try {
                return decodeURIComponent(c.value);
              } catch {
                return c.value;
              }
            })(),
          }));
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from Server Component — middleware refreshes session instead
          }
        },
      },
    }
  );

  // Bootstrap: @supabase/ssr's storage lookup fails in some environments.
  // Manually restore the session from the raw cookie if getSession returns null.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      const rawCookie = cookieStore.get(SUPABASE_COOKIE_NAME)?.value;
      if (rawCookie) {
        const decoded = (() => {
          try { return decodeURIComponent(rawCookie); } catch { return rawCookie; }
        })();
        const parsed = JSON.parse(decoded);
        if (parsed?.access_token && parsed?.refresh_token) {
          await supabase.auth.setSession({
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token,
          });
        }
      }
    }
  } catch {
    // Ignore bootstrap errors — page-level checks handle the redirect
  }

  return supabase;
}
