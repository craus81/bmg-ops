# Shipping the FleetSuite iOS wrapper

What still has to happen on a Mac before `ios/` is installable on a device,
and before the Siri App Intent for calendar entries can be built at all.
Everything here needs Xcode and an Apple Developer account — none of it can
be done from a build container or from this repo alone.

Read it top to bottom the first time: several steps set values the later
ones depend on.

## What the repo already has

Facts to check against, not to re-decide:

| Thing | Current value | Where |
| --- | --- | --- |
| Bundle ID | `com.bmgfleet.fleetsuite` | `capacitor.config.ts`, `ios/App/App.xcodeproj/project.pbxproj` (both build configs), `ios/App/App/Info.plist` |
| App name | BMG FleetSuite | `capacitor.config.ts`, `Info.plist` (`CFBundleDisplayName`) |
| Deployment target | iOS 15.0 | `project.pbxproj` |
| Signing style | Automatic, **no team set** | `project.pbxproj` (`CODE_SIGN_STYLE = Automatic`, no `DEVELOPMENT_TEAM`) |
| Version / build | 1.0 / 1 | `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION` |
| Push environment | `development` | `ios/App/App/App.entitlements` (`aps-environment`) |
| Associated domain | `applinks:bmg-ops.vercel.app` | `App.entitlements` |
| Privacy strings | Camera + photo library present | `Info.plist` (`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`) |
| Web content | Loaded live from `https://bmg-ops.vercel.app` | `capacitor.config.ts` (`server.url`) |

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
   - pick the BMG team — this writes `DEVELOPMENT_TEAM` into
     `project.pbxproj`; **commit that change**, it is the one signing value
     the repo is missing.
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
> `server.url` at `https://bmg-ops.vercel.app`, so the app is a web view over
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

`App.entitlements` already claims `applinks:bmg-ops.vercel.app`, but nothing
serves the matching file — so today those links open in Safari, not the app.

1. Serve `/.well-known/apple-app-site-association` from the site (no file
   extension, `Content-Type: application/json`, no redirect), containing the
   app ID `<TEAM_ID>.com.bmgfleet.fleetsuite` and the paths to hand over.
2. In Next.js this is a `public/.well-known/apple-app-site-association` file
   plus a header rule in `next.config.js` for the content type.
3. Decide the paths deliberately — every notification deep link comes from
   `src/lib/deep-links.ts`, and those are the URLs worth claiming.
4. If the app ever moves to `ops.bmgfleet.com`, the entitlement, the AASA
   file, and `server.url` all have to move together.

## 7. Then, and only then: the Siri App Intent

The calendar-by-voice feature is blocked on everything above — an App Intent
ships inside a signed, installed app; there is nothing to attach it to until
the wrapper builds and installs.

When the above is done, the shape of the work is:

- a Swift `AppIntent` in the App target (iOS 16+; the deployment target is
  15.0, so either raise it or mark the intent `@available(iOS 16, *)`),
- an `AppShortcutsProvider` so the phrase is offered without the user
  setting anything up,
- parameters for the calendar entry (title, date/time, and whichever of
  vehicle / job / customer the entry needs),
- a Capacitor plugin bridge, or a direct call from the intent to the
  FleetSuite calendar API, plus a way for the intent to authenticate as the
  signed-in user,
- the intent's own privacy string if it reads anything from EventKit.

Write it against the existing calendar-pull cron and calendar API rather
than inventing a second write path.
