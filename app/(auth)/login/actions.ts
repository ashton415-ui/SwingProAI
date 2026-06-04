"use server";

import { cookies } from "next/headers";

export async function setSessionAction(access_token: string, refresh_token: string) {
  const cookieStore = await cookies();

  // Minimal test: set a plain cookie with no Supabase involved
  cookieStore.set("test-auth", "works", {
    path: "/",
    maxAge: 60 * 60,
    sameSite: "lax",
    secure: true,
    httpOnly: false,
  });

  console.log("Cookie set attempt. access_token length:", access_token.length);

  return { success: true };
}
