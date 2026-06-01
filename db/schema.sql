-- =============================================================================
-- Race Day Operations Timetable — Database Schema
-- =============================================================================
-- Compatible with MySQL 5.7+ and MariaDB 10.3+
-- Run once to initialise the database, e.g.:
--   mysql -u root -p < db/schema.sql
-- =============================================================================

CREATE DATABASE IF NOT EXISTS raceday_timetable
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE raceday_timetable;

-- =============================================================================
-- circuits
-- The physical venue.  Curfew time is set at venue level (noise abatement,
-- permit conditions, etc.) and can be overridden per event.
-- =============================================================================
CREATE TABLE IF NOT EXISTS circuits (
  id                   INT UNSIGNED     AUTO_INCREMENT PRIMARY KEY,
  name                 VARCHAR(100)     NOT NULL,
  default_curfew_time  TIME             NOT NULL DEFAULT '18:00:00'
                                        COMMENT 'Default end-of-day curfew for this venue',
  live_snatch_licensed TINYINT(1)       NOT NULL DEFAULT 0
                                        COMMENT 'Whether this venue is licensed for live snatch starts',
  created_at           TIMESTAMP        DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_circuit_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Migration: ALTER TABLE circuits ADD COLUMN live_snatch_licensed TINYINT(1) NOT NULL DEFAULT 0;

-- =============================================================================
-- circuit_layouts
-- A circuit can be run in several configurations (e.g. Silverstone GP,
-- International, National, Historic GP).  Each layout has its own name and its
-- own estimated green flag / formation lap duration, because the lap time
-- varies with layout length.
--
-- green_flag_lap_minutes is the time from "green flag shown" to "race start".
-- It is stored here so the timetable can compute total session block time
-- (= green_flag_lap_minutes + race_duration_minutes) separately from the race
-- duration that the clerk enters per session.
-- =============================================================================
CREATE TABLE IF NOT EXISTS circuit_layouts (
  id                      INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  circuit_id              INT UNSIGNED    NOT NULL,
  layout_name             VARCHAR(100)    NOT NULL
                                          COMMENT 'e.g. Grand Prix, National, Indy',
  green_flag_lap_minutes  TINYINT UNSIGNED NOT NULL DEFAULT 2
                                          COMMENT 'Estimated formation/GFL lap duration for this layout',
  grid_minutes            TINYINT UNSIGNED NOT NULL DEFAULT 5
                                          COMMENT 'Minutes before GFL start that cars assemble on the grid (race sessions)',
  FOREIGN KEY (circuit_id) REFERENCES circuits (id) ON DELETE CASCADE,
  UNIQUE KEY uq_circuit_layout (circuit_id, layout_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- events
-- A single race meeting.  References a specific circuit layout so the correct
-- GFL lap time is automatically applied to every session in the event.
-- The curfew_time is copied from the circuit default but can be adjusted per
-- event (e.g. a special late curfew grant from the local authority).
-- =============================================================================
CREATE TABLE IF NOT EXISTS events (
  id           INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(200)  NOT NULL  COMMENT 'e.g. "BRSCC Brands Hatch Finals"',
  event_date   DATE          NOT NULL,
  layout_id    INT UNSIGNED  NOT NULL  COMMENT 'Circuit layout for this event',
  curfew_time           TIME          NOT NULL  COMMENT 'Hard deadline for final chequered flag',
  gfl_minutes_override  TINYINT UNSIGNED DEFAULT NULL
                                         COMMENT 'Override layout GFL duration for this event; NULL = use layout default',
  grid_minutes_override TINYINT UNSIGNED DEFAULT NULL
                                         COMMENT 'Override layout grid assembly time for this event; NULL = use layout default',
  notes        TEXT,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (layout_id) REFERENCES circuit_layouts (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- sessions
-- Each on-track session in the day's timetable.
--
-- planned_duration_minutes is the RACE/SESSION duration only — it does NOT
-- include the formation lap.  The formation lap time (green_flag_lap_minutes
-- from the circuit layout) is added to this by the timetable calculations when
-- computing total block time and running variance.
-- =============================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id                        INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  event_id                  INT UNSIGNED    NOT NULL,

  -- Display ordering (multiples of 10 leave room to insert between sessions)
  sort_order                INT             NOT NULL DEFAULT 0,

  -- Identity -----------------------------------------------------------------
  series_name               VARCHAR(100)    NOT NULL
                                            COMMENT 'e.g. Formula Ford, Clio Cup',
  session_type              ENUM('practice','qualifying','race','break','other','warmup')
                                            NOT NULL,
                                            -- Migration for existing installations:
                                            -- ALTER TABLE sessions MODIFY COLUMN session_type
                                            --   ENUM('practice','qualifying','race','break','other','warmup') NOT NULL;
  session_number            TINYINT UNSIGNED NOT NULL DEFAULT 1
                                            COMMENT 'Distinguishes FP1/FP2, Race 1/Race 2 etc.',

  -- Planned timetable -------------------------------------------------------
  planned_start             TIME            NOT NULL
                                            COMMENT 'Race/session start time (flag drop for races). Advised GFL start = planned_start − gfl_minutes.',
  planned_duration_minutes  SMALLINT UNSIGNED NOT NULL
                                            COMMENT 'Session duration in minutes (races: flag-drop to finish, excludes formation lap)',
  duration_override_minutes SMALLINT UNSIGNED DEFAULT NULL
                                            COMMENT 'Ops clerk override for session duration; replaces planned for all downstream predictions',
  tidy_override_minutes     SMALLINT UNSIGNED DEFAULT NULL
                                            COMMENT 'Ops clerk override for the tidy/turnaround gap after this session; propagates to next session predicted start',

  -- Session format -----------------------------------------------------------
  start_type                ENUM('standing','rolling') DEFAULT NULL
                                            COMMENT 'Standing or rolling start — races only, NULL for practice/qualifying',
  has_green_flag_lap        TINYINT(1)      NOT NULL DEFAULT 0
                                            COMMENT 'Planned formation/green flag lap before the start',
  has_pit_stops             TINYINT(1)      NOT NULL DEFAULT 0,
  has_safety_car            TINYINT(1)      NOT NULL DEFAULT 0
                                            COMMENT 'Safety car deployed as part of session format',
  has_live_snatch           TINYINT(1)      NOT NULL DEFAULT 0
                                            COMMENT 'Live snatch start — race sessions only, venue must be licensed',

  -- Actual times (filled in by ops clerk during the event) ------------------
  actual_grid_time          TIME            DEFAULT NULL
                                            COMMENT 'Time cars were sent to the assembly grid (race sessions)',
  actual_green_flag_time    TIME            DEFAULT NULL
                                            COMMENT 'Time green flag shown / formation lap begins',
  actual_start_time         TIME            DEFAULT NULL
                                            COMMENT 'Lights out (standing) or rolling-start trigger',
  actual_finish_time        TIME            DEFAULT NULL
                                            COMMENT 'Chequered flag',

  -- Weather tracking --------------------------------------------------------
  -- weather_extra_gfl is kept for schema compatibility but is no longer used in UI.
  weather_extra_gfl         TINYINT(1)      NOT NULL DEFAULT 0
                                            COMMENT 'Reserved — no longer used in UI',
  weather_notes             TEXT            DEFAULT NULL,
  track_condition_end       ENUM('dry','wet') DEFAULT NULL
                                            COMMENT 'Track condition at the end of this session — used to determine if next session for the same series needs an extra formation lap',

  -- Lifecycle ---------------------------------------------------------------
  status                    ENUM('pending','active','completed','red_flagged','cancelled')
                                            NOT NULL DEFAULT 'pending',
  session_notes             TEXT            DEFAULT NULL,
  created_at                TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
                                            ON UPDATE CURRENT_TIMESTAMP,

  -- Migrations:
  -- ALTER TABLE sessions ADD COLUMN has_safety_car TINYINT(1) NOT NULL DEFAULT 0;
  -- ALTER TABLE sessions ADD COLUMN has_live_snatch TINYINT(1) NOT NULL DEFAULT 0;

  FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE,
  INDEX idx_event_sort  (event_id, sort_order),
  INDEX idx_event_start (event_id, planned_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- Sample data — UK circuits with typical layouts and curfew times
-- GFL minutes are estimates; update them to match actual observed lap times.
-- =============================================================================

INSERT INTO circuits (name, default_curfew_time) VALUES
  ('Silverstone Circuit',        '19:00:00'),
  ('Brands Hatch',               '18:30:00'),
  ('Donington Park',             '18:00:00'),
  ('Snetterton Circuit',         '18:00:00'),
  ('Oulton Park',                '18:00:00'),
  ('Croft Circuit',              '18:30:00'),
  ('Castle Combe Circuit',       '18:30:00'),
  ('Thruxton Circuit',           '18:00:00'),
  ('Rockingham Motor Speedway',  '18:00:00')
ON DUPLICATE KEY UPDATE default_curfew_time = VALUES(default_curfew_time);

-- Layouts — inserted using sub-selects so circuit IDs don't need to be hard-coded.
-- Columns: circuit_id, layout_name, green_flag_lap_minutes, grid_minutes
-- grid_minutes = minutes before formation lap start that cars head to the assembly grid.
INSERT INTO circuit_layouts (circuit_id, layout_name, green_flag_lap_minutes, grid_minutes)
SELECT id, 'Grand Prix',             3, 5 FROM circuits WHERE name = 'Silverstone Circuit'
UNION ALL
SELECT id, 'International',          2, 5 FROM circuits WHERE name = 'Silverstone Circuit'
UNION ALL
SELECT id, 'National',               2, 5 FROM circuits WHERE name = 'Silverstone Circuit'
UNION ALL
SELECT id, 'Historic Grand Prix',    3, 5 FROM circuits WHERE name = 'Silverstone Circuit'
UNION ALL
SELECT id, 'Indy',                   2, 5 FROM circuits WHERE name = 'Brands Hatch'
UNION ALL
SELECT id, 'Grand Prix',             3, 5 FROM circuits WHERE name = 'Brands Hatch'
UNION ALL
SELECT id, 'National',               2, 5 FROM circuits WHERE name = 'Donington Park'
UNION ALL
SELECT id, 'Grand Prix',             3, 5 FROM circuits WHERE name = 'Donington Park'
UNION ALL
SELECT id, '100',                    2, 5 FROM circuits WHERE name = 'Snetterton Circuit'
UNION ALL
SELECT id, '200',                    2, 5 FROM circuits WHERE name = 'Snetterton Circuit'
UNION ALL
SELECT id, '300',                    3, 5 FROM circuits WHERE name = 'Snetterton Circuit'
UNION ALL
SELECT id, 'Island',                 2, 5 FROM circuits WHERE name = 'Oulton Park'
UNION ALL
SELECT id, 'International',          2, 5 FROM circuits WHERE name = 'Oulton Park'
UNION ALL
SELECT id, 'Fosters',                2, 5 FROM circuits WHERE name = 'Oulton Park'
UNION ALL
SELECT id, 'Full Circuit',           2, 5 FROM circuits WHERE name = 'Croft Circuit'
UNION ALL
SELECT id, 'Full Circuit',           2, 5 FROM circuits WHERE name = 'Castle Combe Circuit'
UNION ALL
SELECT id, 'Full Circuit',           2, 5 FROM circuits WHERE name = 'Thruxton Circuit'
UNION ALL
SELECT id, 'National',               2, 5 FROM circuits WHERE name = 'Rockingham Motor Speedway'
UNION ALL
SELECT id, 'International Supercar', 2, 5 FROM circuits WHERE name = 'Rockingham Motor Speedway'
ON DUPLICATE KEY UPDATE
    green_flag_lap_minutes = VALUES(green_flag_lap_minutes),
    grid_minutes           = VALUES(grid_minutes);
