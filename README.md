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
6. Click **Deploy**

## After Deploying

1. Copy your Vercel URL (e.g. `https://bmg-ops.vercel.app`)
2. Go to Supabase → Authentication → URL Configuration
3. Update **Site URL** to your Vercel URL
4. Add `https://your-vercel-url.vercel.app/auth/callback` to **Redirect URLs**

## Features

- Magic link auth (no passwords)
- VIN scanning with NHTSA decode + offline fallback
- Part number catalog management
- Purchase order tracking with auto-decrement
- Completion photo capture → Supabase Storage
- Time clock with break tracking and weekly OT calculation
- Role-based access (Admin / Installer)
- PWA support (add to home screen)
