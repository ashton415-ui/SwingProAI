import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/signup', '/auth'];

export async function middleware(request: NextRequest) {
  // 1. Create a response object that we can modify with secure cookies
  let supabaseResponse = NextResponse.next({ request });

  // 2. Initialize Supabase for EVERY route so the cookie lifecycle never breaks
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // 3. Securely check the user's auth status with the database
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  // ── WIRETAP ──────────────────────────────────────────────────────────────
  console.log('--- MIDDLEWARE WIRETAP ---');
  console.log('Path:           ', request.nextUrl.pathname);
  console.log('Cookies present:', request.cookies.getAll());
  console.log('User check:     ', user);
  console.log('Auth error:     ', authError);
  console.log('──────────────────────────');
  // ─────────────────────────────────────────────────────────────────────────

  const isPublicPath = PUBLIC_PATHS.some((p) => request.nextUrl.pathname.startsWith(p));

  // 4. THE BOUNCER: If NOT logged in and trying to access a private page -> Kick to Login
  if (!user && !isPublicPath) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // 5. THE ESCORT: If ARE logged in and trying to access the login page -> Push to Dashboard
  if (user && isPublicPath) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Apply middleware to everything except static files and images
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};