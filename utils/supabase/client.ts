import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          if (typeof document === "undefined") return [];
          return document.cookie.split(";").map((c) => {
            const [name, ...rest] = c.trim().split("=");
            return { name: name.trim(), value: rest.join("=") };
          });
        },
        setAll(cookiesToSet) {
          if (typeof document === "undefined") return;
          cookiesToSet.forEach(({ name, value, options }) => {
            let cookie = `${name}=${value}; Path=/; SameSite=Lax`;
            if (options?.maxAge) cookie += `; Max-Age=${options.maxAge}`;
            if (options?.expires)
              cookie += `; Expires=${new Date(options.expires).toUTCString()}`;
            if (options?.secure || location.protocol === "https:")
              cookie += `; Secure`;
            document.cookie = cookie;
          });
        },
      },
    }
  );
}
