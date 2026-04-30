# Getting started

Covers the first-time login flow, magic-link auth, profile setup, and how
to switch between roles if you're an admin.

Applies to **all roles**.

## How do I sign in?

The app uses passwordless **magic-link** auth. There are no passwords to
remember.

1. Go to the app URL (production: `https://bmg-ops.vercel.app`).
2. Enter your work email on the login screen.
3. Click **Send Magic Link**.
4. Check email. Click the link in the message titled "Sign in to BMG Fleet".
5. The link opens the app already authenticated. Bookmark or add to home
   screen for next time.

Magic links expire after about an hour. If yours has expired, request a new
one from the same login screen.

## What if my account is "pending"?

New accounts start in `pending` status. You'll see a banner that says
*"Your account has been created but hasn't been approved yet."*

An admin needs to approve you at **Admin → Users** before you can use the
app. Ping whoever runs your team and ask them to approve your account.

If your account was set to `denied`, you'll see a different banner — talk
to an admin if you think that's a mistake.

## How do I install the app on my phone?

The app is a Progressive Web App (PWA), so you don't need the App Store /
Play Store on most devices.

**iPhone (Safari):**

1. Open the app URL in Safari.
2. Tap the **Share** button.
3. Tap **Add to Home Screen**.
4. Confirm. The app icon appears on your home screen and runs full-screen.

**Android (Chrome):**

1. Open the app URL in Chrome.
2. Tap the three-dot menu.
3. Tap **Add to Home Screen** (or **Install app** if shown).
4. Confirm.

There are also wrapped iOS and Android Capacitor builds. If your shop has
been issued a native build, install the .ipa or .apk through your normal
device-management workflow.

## How do I set up my profile?

1. Tap your avatar in the top-right corner.
2. Tap **Settings** (or go to `/settings`).
3. Fill in **Full name**, **Phone number**, and any role-specific fields.
4. Tap **Save**.

Phone number powers SMS notifications and the in-app messaging routing,
so don't skip it.

## How do I change my notification preferences?

1. Go to **Settings**.
2. Toggle the notification rows you care about. Common ones:
   - **Notify me when a vehicle is ready for install** (installers / admins).
   - **Notify me when a graphics job is shipped** (admins, sales).
   - **Email** vs. **Push** vs. **SMS** per channel.
3. Save.

If you want to receive notifications even when you're not directly assigned
to a job, opt in there.

## How do I switch which role I'm acting as? (admin-only)

Admins can preview the app the way another role sees it.

1. Tap your avatar in the top-right corner.
2. Tap **View as…** and pick a role (Sales / Installer / Graphics / etc.).
3. The header shows a yellow banner: *"Viewing as: <role>"*.
4. Tap **Exit View As** to return to your full admin view.

"View as" only changes the UI surface — it doesn't change your real
permissions, so writes still go through as the admin user. Use it for
training, screenshots, or to debug what someone else is seeing.

## How do I sign out?

1. Tap your avatar in the top-right corner.
2. Tap **Sign Out**.

The session is revoked on the next request. If you're on a shared device,
also clear the browser's stored magic-link cookie.

## Where do I report a bug or ask for help?

- **In-app**: tap the **AI** chat button (FleetSuite AI). It can answer
  most "how do I…" and "what's the status of…" questions and pulls from
  this help library.
- **Slack / email**: ping whoever runs ops at your shop. They'll triage to
  the engineering team.
