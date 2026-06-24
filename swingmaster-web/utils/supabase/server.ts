import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: Record<string, unknown>) {
          try {
            cookieStore.set(name, value, {
              ...options,
              path: '/',
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'lax',
            } as Parameters<typeof cookieStore.set>[2]);
          } catch {
            // Server Component context — writes are intentional no-ops.
          }
        },
        remove(name: string, options: Record<string, unknown>) {
          try {
            cookieStore.set(name, '', {
              ...options,
              path: '/',
              maxAge: 0,
            } as Parameters<typeof cookieStore.set>[2]);
          } catch {
            // Server Component context — writes are intentional no-ops.
          }
        },
      },
    }
  );
}
