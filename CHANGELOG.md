# Changelog

All notable changes to Race Day Operations Timetable are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [1.2.0] — 2026-04-21

### Added
- **Safety Car badge [SC]** — new yellow badge shown on sessions where a safety car
  is part of the planned format. Controlled by a checkbox in the session form.
- **Live Snatch badge [LS]** — new red badge for live snatch start sessions.
  Only available at circuits marked as live-snatch licensed (set in Circuits & Layouts).
  Available for race, practice, and qualifying sessions.
- **Live snatch licensed** flag on circuit records — tick box in the circuit
  Add/Edit form; displays an LS badge next to the circuit name in the list.
- **`api/app-config.php`** — new public endpoint returning frontend feature flags
  as JSON, used to drive conditional UI behaviour without exposing credentials.
- **`SC_ON_NON_RACE` config option** — when `true`, the SC checkbox is also offered
  for practice and qualifying sessions (default: `false`, race sessions only).

### Changed
- **Flags column renamed to Badges** throughout the timetable and setup pages;
  internal CSS class renamed `col-flags` → `col-badges`.
- **Badge colour scheme refactored:**
  - Standing start (S): now blue (was green)
  - Rolling start (R): now purple (was blue)
  - Formation lap (GFL): now green (was yellow)
  - Safety Car (SC): yellow — inherits the former GFL colour
  - Live Snatch (LS): red
- **Rolling start badge is now circular** to visually distinguish it from the
  square standing start badge.
- **All badges now have a thin `currentColor` border** for better definition.
- **Setup session list** — the three separate S/R, GFL, and Pits columns replaced
  by a single **Badges** column. Applicable badges are shown lit when enabled and
  greyed-out when not enabled, giving a quick visual summary of session format.
- `GFL_ON_NON_RACE` config constant renamed to `SC_ON_NON_RACE` to accurately
  reflect its purpose.

### Fixed
- SC badge was incorrectly shown (greyed out) on non-race sessions in the setup
  session list even when `SC_ON_NON_RACE` was `false`.

### Database migration
```sql
ALTER TABLE circuits ADD COLUMN live_snatch_licensed TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN has_safety_car TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN has_live_snatch TINYINT(1) NOT NULL DEFAULT 0;
```

---

## [1.1.0] — 2026-04-21

### Added
- **"Other" session type** — behaves like a break (no grid transit, no formation
  lap, no pit stops) but carries a sequential session number (Other1, Other2, …).
  Suitable for parades, driver briefings, ceremonies, or any numbered non-racing
  slot that needs to appear in the timetable order.

### Database migration
```sql
ALTER TABLE sessions MODIFY COLUMN session_type
  ENUM('practice','qualifying','race','break','other') NOT NULL;
```

---

## [1.0.0] — 2026-04-17

Initial release.

### Features
- **Live timetable view** — read-only page for officials; auto-refreshes every
  30 seconds. Shows scheduled, predicted, and actual times side by side.
- **Cascading predictions** — predicted times propagate forward from the last
  known actual, respecting duration and tidy-time overrides. Cancelled sessions
  are removed from the cascade without disturbing the surrounding gaps.
- **Ops Mode** — PIN-protected write access on the same URL. Auto-refresh pauses
  while Ops Mode is active or unsaved changes are present.
- **Actual time entry** — Grid, GFL, Start, and Finish time inputs per session,
  each with a ⏱ button to stamp the current time.
- **Status auto-setting** — sessions move to Active when a start time is saved
  and to Done when a finish time is saved; Red Flag and Cancelled must be set
  manually.
- **Duration and tidy-time overrides** — ops clerk can adjust session length or
  turnaround gap in real time without altering the original schedule.
- **Variance and curfew highlighting** — variance column shaded green → amber → red
  for late sessions; predicted finish shaded amber → red as curfew approaches.
  Running early shown in text colour only (no background).
- **Scheduled column group** — includes a Dur (duration) sub-column alongside
  Start, Finish, and Tidy.
- **Actual Grid column** — records the time cars were released to the assembly
  grid for race sessions.
- **Advised Grid and GFL times** — calculated from predicted race start minus
  layout GFL and grid minutes.
- **Session setup** — create, edit, reorder, and delete sessions per event.
  Session types: Practice, Qualifying, Race, Break/Lunch.
- **Circuit and layout management** — venues with default curfew times; layouts
  with per-configuration GFL and grid minutes.
- **Event-level overrides** — GFL and grid minutes can be overridden per event
  without changing the layout default.
- **Help pages** — separate help pages for the timetable view (`help-readonly.html`),
  ops mode (`help-ops.html`), and setup/admin (`help-setup.html`).
- **`api/common.php`** — shared database connection, response helpers, auth, and
  data normalisation extracted from `api/config.php`.
- **README.md** — developer-facing documentation covering installation, stack,
  project structure, and first-time workflow.

[1.2.0]: https://github.com/karldyson/raceday-ops-timetable/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/karldyson/raceday-ops-timetable/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/karldyson/raceday-ops-timetable/releases/tag/v1.0.0
