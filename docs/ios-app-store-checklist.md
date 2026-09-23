# Shipping the FleetSuite iOS wrapper

What has to happen on a Mac to build `ios/`, install it on a device and ship
it through TestFlight, plus how the Siri command (step 7) fits together. The
Mac steps need Xcode and an Apple Developer account — none of them can be
done from a build container or from this repo alone.

Read it top to bottom the first time: several steps set values the later
ones depend on.

## What the repo already has

Facts to check against, not to re-decide:

| Thing | Current value | Where |
| --- | --- | --- |
| Bundle ID | `com.bmgfleet.fleetsuite` | `capacitor.config.ts`, `ios/App/App.xcodeproj/project.pbxproj` (both build configs), `ios/App/App/Info.plist` |
| App name | BMG FleetSuite | `capacitor.config.ts`, `Info.plist` (`CFBundleDisplayName`) |
| Deployment target | iOS 16.0 (App Intents, which Siri needs, start there) | `project.pbxproj` |
| Signing style | Automatic, team `RU67C5K44J` (Craig's individual account) | `project.pbxproj` (`CODE_SIGN_STYLE = Automatic`, `DEVELOPMENT_TEAM` in both App configs) |
| Version / build | 1.0 / 2 | `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION` |
| Push environment | `development` | `ios/App/App/App.entitlements` (`aps-environment`) |
| Associated domain | `applinks:go.bmgfleet.com` | `App.entitlements` |
| Privacy strings | Camera + photo library present | `Info.plist` (`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`) |
| Web content | Loaded live from `https://go.bmgfleet.com` | `capacitor.config.ts` (`server.url`) |

APNs sending is already wired server-side (`src/lib/apns.ts`) and reads
`APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, and optionally
`APNS_BUNDLE_ID` (defaults to the bundle ID above).

## 1. Apple Developer account and App ID

1. Enrol the company in the Apple Developer Program (or confirm the existing
   membership is current) — an Organization account, so the app is owned by
   BMG and not by a personal Apple ID.
2. Note the **Team ID** (Membership page). It is needed in three places:
   Xcode signing, the APNs `APNS_TEAM_ID` env var, and the
   apple-app-site-association file in step 6.
3. Certificates, Identifiers & Profiles → Identifiers → register an App ID
   for `com.bmgfleet.fleetsuite`, with these capabilities ticked:
   - Push Notifications
   - Associated Domains

## 2. Signing in Xcode

1. `npx cap sync ios`, then open `ios/App/App.xcodeproj` in Xcode.
2. Target **App** → Signing & Capabilities:
   - tick *Automatically manage signing*,
   - the team should already read `RU67C5K44J` — `DEVELOPMENT_TEAM` is
     committed in `project.pbxproj`. If the account ever moves to a BMG
     organization membership, the Team ID changes: update it here, in the
     AASA file (step 6) and in `APNS_TEAM_ID`.
   - confirm the bundle identifier reads `com.bmgfleet.fleetsuite` for both
     Debug and Release.
3. Let Xcode create the development certificate and provisioning profile. If
   it can't, someone with Admin or Account Holder role on the Apple team has
   to grant it — automatic signing fails silently as "no profiles found" for
   a Developer-role member.
4. Confirm the capabilities list shows **Push Notifications** and
   **Associated Domains** (they come from `App.entitlements`; if Xcode shows
   neither, the entitlements file isn't wired into the target).

At this point the app installs on a device plugged into the Mac. Everything
below is for distribution.

## 3. Push notifications for real

`aps-environment` in `App.entitlements` is `development`. A TestFlight or App
Store build **must** use `production`, or every push to the shipped app is
silently dropped.

1. Change `App.entitlements` to `<string>production</string>` before
   archiving. (Xcode's own release flow does not do this for you.)
2. Create an **APNs Auth Key** (Keys → new key, Apple Push Notifications
   service). Download the `.p8` once — Apple will not re-issue it.
3. Set the server env vars from that key: `APNS_KEY_ID` (the key's ID),
   `APNS_TEAM_ID` (step 1), `APNS_PRIVATE_KEY` (the `.p8` contents, newlines
   escaped as `\n` — `src/lib/apns.ts` un-escapes them).
4. A token-based auth key works for both environments, so no second key is
   needed for development.

## 4. App Store Connect record

1. App Store Connect → Apps → **+** → New App: iOS platform, the
   `com.bmgfleet.fleetsuite` App ID, a SKU (any internal string), and
   primary language.
2. Fill the App Information and Pricing (free) sections.
3. **App Privacy** questionnaire — this app collects account identifiers and
   photos/camera content; answer it against what FleetSuite actually stores,
   not a template.
4. Decide distribution now, because it changes what review expects:
   - **Custom App / Unlisted** (recommended for an internal tool): Apple
     Business Manager distribution, no public listing, far lighter review.
   - **Public App Store**: needs screenshots, a description, a support URL,
     a privacy policy URL, and a demo account for the reviewer.

> **Flag before you submit publicly.** `capacitor.config.ts` points
> `server.url` at `https://go.bmgfleet.com`, so the app is a web view over
> a live site with no bundled web assets. App Review rejects that shape under
> guideline 4.2 ("minimum functionality") with some regularity. Custom App
> distribution through Apple Business Manager avoids the argument entirely
> and is the right fit for a staff tool. If it does go public, expect to
> either bundle the web build or make the native-only features (push,
> camera, calendar, Siri) the visible point of the app.

## 5. Archive and upload

1. Bump `CURRENT_PROJECT_VERSION` for every upload — App Store Connect
   rejects a repeated build number.
2. Xcode → Product → Destination: *Any iOS Device (arm64)* → Product →
   Archive.
3. Organizer → Distribute App → App Store Connect → Upload.
4. Wait for processing, then add internal testers in TestFlight. Internal
   testing needs no review; external testing does.

## 6. Universal links (needed before deep links open in the app)

`App.entitlements` claims `applinks:go.bmgfleet.com`, and
`public/.well-known/apple-app-site-association` (served with a JSON content
type by `vercel.json`) names `RU67C5K44J.com.bmgfleet.fleetsuite` for every
path. The steps below are what that file has to keep satisfying.

1. Serve `/.well-known/apple-app-site-association` from the site (no file
   extension, `Content-Type: application/json`, no redirect), containing the
   app ID `<TEAM_ID>.com.bmgfleet.fleetsuite` and the paths to hand over.
2. In Next.js this is a `public/.well-known/apple-app-site-association` file
   plus a header rule in `next.config.js` for the content type.
3. Decide the paths deliberately — every notification deep link comes from
   `src/lib/deep-links.ts`, and those are the URLs worth claiming.
4. The entitlement, the AASA file and `server.url` all name the same host and
   have to move together. They point at `go.bmgfleet.com` as of the move off
   `bmg-ops.vercel.app` — serve the AASA file from that host, not from the
   old one.

## 7. Siri: add a calendar entry without opening the app

"Hey Siri, add a calendar entry in BMG FleetSuite" ("…in FleetSuite" works
too, via `INAlternativeAppNames` in `Info.plist`). Siri asks for the title
and the day and time, then saves the entry to the FleetSuite schedule as a
Meeting owned by whoever asked, and pushes it to the shared Google calendar
exactly as the Schedule page's New Event does. The app never opens. The
phone must be unlocked (`authenticationPolicy = .requiresAuthentication`),
because the entry lands on the company schedule.

**How Siri signs in.** The intent runs without the web view, so it can't use
the Supabase session. Instead each iPhone gets its own Siri key:

1. After sign-in, `NativeSiriKey` (`src/components/NativeSiriKey.tsx`, via
   `src/lib/siri-bridge.ts`) asks `POST /api/siri/key` for a key and hands it
   to the app's own `SiriKey` plugin (`ios/App/App/SiriKeyPlugin.swift`,
   registered in `MainViewController.swift`, which `Main.storyboard` uses in
   place of `CAPBridgeViewController`). The plugin keeps it in the Keychain
   (`SiriKeyStore.swift`: this device only, so it never syncs to iCloud
   Keychain or moves to a new phone with a backup).
2. The server stores only the key's SHA-256 (`siri_keys`, migration 322).
3. Signing out or switching user clears the key from the phone and revokes
   it (`DELETE /api/siri/key`).
4. `POST /api/siri/calendar-event` checks the key on every call
   (`authenticateSiriKey` in `src/lib/siri-keys.ts`): the owner must still be
   approved, not deactivated, and hold the Schedule feature. A 401 makes the
   phone drop its key; the next time the app opens it gets a new one.

Anyone with the Schedule feature gets it once they have opened build 2 or
later while signed in. Older builds have no `SiriKey` plugin, so the web
app's calls fail quietly and nothing changes.

**Changing it later.**

- What the server does with an entry (event type, fields, Google push,
  validation): `src/app/api/siri/calendar-event/route.ts`. It ships with the
  website; no new app build.
- What Siri asks for, the phrases, or what it says back:
  `ios/App/App/AddCalendarEntryIntent.swift`. Needs a new build through
  step 5.
- Another voice command, for example adding a note: a second `AppIntent`
  next to this one, added to the same `FleetSuiteShortcuts` provider (an app
  can only have one), calling its own `/api/siri/...` route that starts
  with `authenticateSiriKey`.

App Intents need iOS 16, hence the deployment target. The spoken phrases
(`FleetSuiteShortcuts`) need iOS 17; on iOS 16 the action is still in the
Shortcuts app, just not offered as a Siri phrase.

**If Siri doesn't recognize the phrase:** open the app once after installing
(that is also what gives the phone its key), then check that the Shortcuts
app lists *Add Calendar Entry* under BMG FleetSuite. If it's listed there and
runs from Shortcuts but not by voice, add the Siri capability (Signing &
Capabilities → + Capability → Siri) and rebuild. Apple says App Shortcuts
don't need it, but it's the next thing to rule out.
