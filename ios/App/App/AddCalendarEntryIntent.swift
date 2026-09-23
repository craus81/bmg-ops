import AppIntents
import Foundation

/// "Hey Siri, add a calendar entry in BMG FleetSuite": Siri asks what and
/// when, and the entry is saved to the FleetSuite schedule as a Meeting
/// without opening the app. It signs in with this iPhone's Siri key
/// (SiriKeyStore); the server side is /api/siri/calendar-event.
struct AddCalendarEntryIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Calendar Entry"
    // Siri can run intents from the lock screen. This one writes to the
    // company schedule, so the phone has to be unlocked first.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Title", requestValueDialog: "What's the entry?")
    var entryTitle: String

    @Parameter(title: "Date and time", requestValueDialog: "What day and time?")
    var start: Date

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$entryTitle) on \(\.$start)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let reply = await FleetSuiteSiriAPI.addCalendarEntry(title: entryTitle, start: start)
        return .result(dialog: "\(reply)")
    }
}

/// The phrases Siri and Spotlight offer without any setup. Each must name the
/// app; INAlternativeAppNames in Info.plist lets people say just "FleetSuite".
@available(iOS 17.0, *)
struct FleetSuiteShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddCalendarEntryIntent(),
            phrases: [
                "Add a calendar entry in \(.applicationName)",
                "Add a calendar entry to \(.applicationName)",
                "Add an event in \(.applicationName)",
                "Add to the \(.applicationName) schedule",
            ],
            shortTitle: "Add Calendar Entry",
            systemImageName: "calendar.badge.plus"
        )
    }
}

/// Calls FleetSuite's Siri endpoint with this iPhone's Siri key and returns
/// the sentence Siri should say, success or not.
enum FleetSuiteSiriAPI {
    // Same host as server.url in capacitor.config.ts and the associated domain.
    private static let baseURL = URL(string: "https://go.bmgfleet.com")!

    private struct ErrorBody: Decodable {
        let error: String?
    }

    static func addCalendarEntry(title: String, start: Date) async -> String {
        guard let stored = SiriKeyStore.load() else {
            return "Open FleetSuite on this iPhone and sign in, then ask me again."
        }

        // Siri hands over midnight when only a day was given. Save that as an
        // entry with no time rather than a 12:00 AM meeting.
        let clock = Calendar.current.dateComponents([.hour, .minute], from: start)
        let hasTime = !(clock.hour == 0 && clock.minute == 0)

        var body = ["title": title, "date": format(start, "yyyy-MM-dd")]
        if hasTime { body["time"] = format(start, "HH:mm") }

        var request = URLRequest(url: baseURL.appendingPathComponent("api/siri/calendar-event"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(stored.key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(status) {
                let when = start.formatted(date: .abbreviated, time: hasTime ? .shortened : .omitted)
                return "Added \(title) to the FleetSuite schedule for \(when)."
            }
            if status == 401 {
                // Revoked or unknown: drop it so the app mints a fresh key the
                // next time it opens.
                SiriKeyStore.clear()
            }
            if status == 400 {
                return "FleetSuite couldn't read that entry. Try again with a title and a day."
            }
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            return message ?? "FleetSuite couldn't save that entry. Try again in a minute."
        } catch {
            return "I couldn't reach FleetSuite. Check your connection and try again."
        }
    }

    private static func format(_ date: Date, _ pattern: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }
}
