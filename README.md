# BMG Ops

Fleet graphics operations app for BMG Fleet Installations.

## Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) and sign in with GitHub
3. Click **Add New → Project**
4. Import the `bmg-ops` repo
5. Add these **Environment Variables** in the Vercel settings:
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://jdwoceryzhbimjmtwrpr.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your anon key
   - `NEXT_PUBLIC_APP_URL` = `https://go.bmgfleet.com` (type **Config**, not
     Secret — Vercel refuses a `NEXT_PUBLIC_` variable marked Secret). Every
     email and notification link is built from this.
6. Click **Deploy**

## After Deploying

Supabase has to agree with `NEXT_PUBLIC_APP_URL` about where the app lives,
or every auth email silently breaks:

1. Go to Supabase → Authentication → URL Configuration
2. Set **Site URL** to the app's canonical host, `https://go.bmgfleet.com`
3. Add `https://go.bmgfleet.com/**` to **Redirect URLs**

Point these at the app's real domain, **not** at a `*.vercel.app` address.
Supabase discards a `redirect_to` that matches no Redirect URL entry and
silently substitutes the Site URL instead — so a stale allow-list doesn't
error, it just lands invites and password resets on the wrong host. And
Vercel's Deployment Protection (Standard Protection) gates the generated
`*.vercel.app` URLs behind a Vercel team login, so that wrong host shows
recipients a Vercel sign-in page rather than the app.

Whenever the app's hostname changes, these two Supabase fields and
`NEXT_PUBLIC_APP_URL` must move together.

## Features

- Magic link auth (no passwords)
- VIN scanning with NHTSA decode + offline fallback
- Part number catalog management
- Purchase order tracking with auto-decrement
- Completion photo capture → Supabase Storage
- Time clock with break tracking and weekly OT calculation
- Role-based access (Admin / Installer)
- PWA support (add to home screen)
