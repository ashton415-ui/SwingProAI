# SwingProAI Project Architecture & Rules

## Core Stack
* Frontend/Web: Next.js, React, Tailwind CSS
* Backend/Database: Supabase (Pro Tier)
* Infrastructure: Vercel (Web), Render (Background Workers/Video AI)
* Mobile Wrapper: CapacitorJS

## Critical Engineering Directives
* **Video Processing Limits:** NEVER process raw video files synchronously in Vercel API routes due to 15-second execution limits. All video uploads must go directly from the client to Supabase Storage via Pre-signed URLs.
* **Heavy Compute:** All AI pose estimation and video rendering must occur in a decoupled background worker on Render, triggered by queue events.
* **Mobile First UI:** The web app must remain 100% responsive. Use bottom-tab navigation for screens under 768px. All buttons need a 44x44px minimum touch target.
* **Shared Architecture:** Keep native dependencies modular, as this folder structure is mirrored with our FightPro AI build. 
* **Security:** Never expose Supabase service keys to the client. Ensure Playwright `storage-state.json` files are never tracked in Git.

## Build Commands
* Web Build: `npm run build`
* Mobile Sync: `npx cap sync`
