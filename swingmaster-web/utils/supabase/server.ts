import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, {
                ...options,
                // path:'/' ensures the cookie is sent on every request,
                // not just the path it was originally set on.
                path: '/',
                // Only mark secure in production — localhost is not HTTPS.
                secure: process.env.NODE_ENV === 'production',
                // lax allows the cookie through same-site navigations
                // (e.g. redirect from /login to /dashboard).
                sameSite: 'lax',
              })
            );
          } catch {
            // Server Component context — cookie writes are intentional no-ops.
          }
        },
      },
    }
  );
}
