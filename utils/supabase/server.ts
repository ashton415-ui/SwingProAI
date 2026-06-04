import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

const COOKIE_NAME = `sb-atlmnqispyzhsahahpjy-auth-token`;

interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: {
    id: string;
    email: string;
    user_metadata: Record<string, unknown>;
  };
}

/**
 * Reads the Supabase session directly from the cookie.
 * Returns null if no valid session found.
 */
export async function getServerSession(): Promise<StoredSession | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  try {
    const decoded = (() => {
      try { return decodeURIComponent(raw); } catch { return raw; }
    })();
    const parsed: StoredSession = JSON.parse(decoded);
    if (!parsed?.access_token || !parsed?.user?.id) return null;

    // Check token expiry
    const now = Math.floor(Date.now() / 1000);
    if (parsed.expires_at && parsed.expires_at < now - 60) return null;

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Creates a Supabase client authenticated as the current user
 * by passing their access token in the Authorization header.
 * RLS policies enforce data security.
 */
export async function createClient() {
  const session = await getServerSession();

  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: session
          ? { Authorization: `Bearer ${session.access_token}` }
          : {},
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  );
}
