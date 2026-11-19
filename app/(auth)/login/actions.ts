// Retired (AG-AUTH-02). The sign-in page used to send the new session's tokens to a Server Action here, which ignored
// them and set an unrelated test cookie. When sign-in succeeds, the installed browser Supabase client has already kept
// the session in its own cookie (inherited and unchanged: readable by page scripts and sent with this site's requests),
// and pages that need a signed-in golfer verify it on the server (utils/supabase/server.ts). The page therefore makes no
// request with the session itself. This module exports nothing, sets no cookie and is imported by no page; the file
// stays only so existing source checks that read this path keep applying.
export {};
