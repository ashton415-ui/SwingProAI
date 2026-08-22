# SwingProAI Project Architecture & Rules

## Canonical Product Direction
* Read `docs/SWINGPROAI_PRODUCT_CONSTITUTION.md` before planning or implementing product work. It is the canonical source for SwingProAI's permanent product direction, product principles, locked product pillars, premium-quality standard, and long-term architectural intent.
* `docs/LAUNCH_GATES.md` remains the canonical source for hard launch-blocking requirements and launch sequencing.
* Subsystem rollout documents remain authoritative for their own scoped implementation contracts and recorded rollout status.
* Verified repository, database, hosted-service, and deployment evidence takes precedence over stale documentation when determining current implementation state. If authoritative sources materially conflict, stop and resolve the conflict rather than silently improvising.
* Documentation records requirements; it does not itself authorize implementation, Git mutation, database actions, deployments, native releases, or production rollout.

## Current Stack
* Frontend/Web: Next.js, React, Tailwind CSS
* Backend/Database: Supabase (Pro Tier)
* Infrastructure: Vercel (Web) with decoupled background-worker architecture for heavy video/AI processing. Render is the project-designated background-worker deployment target; live hosted state must be verified rather than inferred solely from repository text.
* Native Mobile Architecture: Not yet locked. The legacy `swingmaster-web/` tree contains a Capacitor configuration, but the canonical root application does not currently establish Capacitor as the permanent Android/iPhone/iPad architecture. Native architecture requires a separately authorized investigation. Shared code where sensible; native capability where premium functionality requires it.

## Critical Engineering Directives
* **Video Processing Limits:** NEVER process raw video files synchronously in Vercel API routes due to 15-second execution limits. All video uploads must go directly from the client to Supabase Storage via Pre-signed URLs.
* **Heavy Compute:** All AI pose estimation and video rendering must occur in a decoupled background worker, triggered by queue events.
* **Mobile First UI:** The web app must remain 100% responsive. Use bottom-tab navigation for screens under 768px. All buttons need a 44x44px minimum touch target.
* **Shared Architecture:** Keep platform-specific and native dependencies modular. Prefer shared domain logic and server-authoritative services across Web, Android, iPhone, and iPad while isolating client-specific implementation details. Do not assume structural parity with another repository unless that relationship has been separately verified.
* **Security:** Never expose Supabase service keys to the client. Ensure Playwright `storage-state.json` files are never tracked in Git.

## Build Commands
* Web Build: `npm run build`
* Native/Mobile Build: No canonical native build/sync command is currently locked. Do not assume `npx cap sync`; follow separately verified architecture and build documentation when native implementation is explicitly authorized.
