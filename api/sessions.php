<?php
/**
 * api/sessions.php
 * =============================================================================
 * REST endpoint for on-track session management.
 *
 * Session configuration (pre-event setup):
 *   GET    /api/sessions.php?event_id=N        — list sessions for an event
 *   POST   /api/sessions.php                   — create  [PIN]
 *   PUT    /api/sessions.php?id=N              — update config  [PIN]
 *   DELETE /api/sessions.php?id=N              — delete  [PIN]
 *
 * Actuals (entered by ops clerk during the event):
 *   PUT    /api/sessions.php?id=N&part=actuals — save actual times + weather  [PIN]
 *
 * Reordering:
 *   POST   /api/sessions.php?action=reorder&event_id=N
 *          body: { "order": [ {"id": X, "sort_order": Y}, ... ] }  [PIN]
 * =============================================================================
 */

require_once __DIR__ . '/common.php';

$method    = $_SERVER['REQUEST_METHOD'];
$id        = isset($_GET['id'])        ? (int)$_GET['id']        : null;
$event_id  = isset($_GET['event_id'])  ? (int)$_GET['event_id']  : null;
$part      = $_GET['part']   ?? null;   // "actuals"
$action    = $_GET['action'] ?? null;   // "reorder"

try {

    // -----------------------------------------------------------------------
    // GET — list sessions for a given event
    // -----------------------------------------------------------------------
    if ($method === 'GET') {
        if (!$event_id) {
            jsonResponse(['error' => 'event_id is required'], 400);
        }
        $stmt = db()->prepare('
            SELECT * FROM sessions
            WHERE  event_id = ?
            ORDER  BY sort_order, planned_start
        ');
        $stmt->execute([$event_id]);
        jsonResponse(array_map('normaliseSession', $stmt->fetchAll()));
    }

    // -----------------------------------------------------------------------
    // POST — create a new session (or reorder)
    // -----------------------------------------------------------------------
    if ($method === 'POST') {
        requirePin();

        // -- Reorder --
        if ($action === 'reorder') {
            if (!$event_id) {
                jsonResponse(['error' => 'event_id is required for reorder'], 400);
            }
            $body  = requestBody();
            $order = $body['order'] ?? [];
            if (!is_array($order) || empty($order)) {
                jsonResponse(['error' => 'order must be a non-empty array'], 400);
            }

            $pdo = db();
            $pdo->beginTransaction();
            $upd = $pdo->prepare(
                'UPDATE sessions SET sort_order = ? WHERE id = ? AND event_id = ?'
            );
            foreach ($order as $item) {
                $upd->execute([(int)$item['sort_order'], (int)$item['id'], $event_id]);
            }
            $pdo->commit();
            jsonResponse(['success' => true]);
        }

        // -- Create session --
        $body = requestBody();
        $req_event_id = (int)($body['event_id'] ?? 0);
        if (!$req_event_id) {
            jsonResponse(['error' => 'event_id is required'], 400);
        }

        $series_name               = trim($body['series_name']               ?? '');
        $session_type              = trim($body['session_type']               ?? '');
        $session_number            = (int)($body['session_number']            ?? 1);
        $planned_start             = trim($body['planned_start']              ?? '');
        $planned_duration_minutes  = (int)($body['planned_duration_minutes']  ?? 0);
        // start_type is only relevant for race sessions; NULL for practice/qualifying
        $start_type                = ($session_type === 'race')
                                        ? (in_array($body['start_type'] ?? '', ['standing','rolling'])
                                            ? $body['start_type'] : 'standing')
                                        : null;
        $has_green_flag_lap        = (int)(bool)($body['has_green_flag_lap'] ?? false);
        $has_pit_stops             = (int)(bool)($body['has_pit_stops']      ?? false);
        $session_notes             = trim($body['session_notes'] ?? '') ?: null;

        if (!$series_name || !$session_type || !$planned_start || !$planned_duration_minutes) {
            jsonResponse(['error' => 'series_name, session_type, planned_start and planned_duration_minutes are required'], 400);
        }

        // Place at end of list (sort_order = current max + 10)
        $mstmt = db()->prepare(
            'SELECT COALESCE(MAX(sort_order), 0) AS m FROM sessions WHERE event_id = ?'
        );
        $mstmt->execute([$req_event_id]);
        $maxOrder = (int)$mstmt->fetchColumn();

        $ins = db()->prepare('
            INSERT INTO sessions
              (event_id, sort_order, series_name, session_type, session_number,
               planned_start, planned_duration_minutes, start_type,
               has_green_flag_lap, has_pit_stops, session_notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ');
        $ins->execute([
            $req_event_id, $maxOrder + 10,
            $series_name, $session_type, $session_number,
            $planned_start, $planned_duration_minutes, $start_type,
            $has_green_flag_lap, $has_pit_stops, $session_notes,
        ]);
        jsonResponse(['id' => (int)db()->lastInsertId()], 201);
    }

    // -----------------------------------------------------------------------
    // PUT — update session config OR save actuals
    // -----------------------------------------------------------------------
    if ($method === 'PUT') {
        requirePin();
        if (!$id) {
            jsonResponse(['error' => 'id is required for PUT'], 400);
        }

        $body = requestBody();

        if ($part === 'actuals') {
            // -- Save actual times, duration override, and weather observations --
            // This is the primary endpoint the ops clerk uses during the event.
            $actual_grid_time       = trim($body['actual_grid_time']       ?? '') ?: null;
            $actual_green_flag_time = trim($body['actual_green_flag_time'] ?? '') ?: null;
            $actual_start_time      = trim($body['actual_start_time']      ?? '') ?: null;
            $actual_finish_time     = trim($body['actual_finish_time']     ?? '') ?: null;
            $weather_extra_gfl      = (int)(bool)($body['weather_extra_gfl'] ?? false);
            $weather_notes          = trim($body['weather_notes'] ?? '') ?: null;
            $raw_condition          = $body['track_condition_end'] ?? null;
            $track_condition_end    = in_array($raw_condition, ['dry', 'wet'], true) ? $raw_condition : null;
            // Duration override: null = no override (use planned); positive int = override
            $duration_override_minutes = isset($body['duration_override_minutes'])
                                         && $body['duration_override_minutes'] !== ''
                                         && $body['duration_override_minutes'] !== null
                ? max(1, (int)$body['duration_override_minutes']) : null;
            // Tidy (turn around) override: null = use scheduled gap; positive int = override
            $tidy_override_minutes = isset($body['tidy_override_minutes'])
                                     && $body['tidy_override_minutes'] !== ''
                                     && $body['tidy_override_minutes'] !== null
                ? max(0, (int)$body['tidy_override_minutes']) : null;

            // Status: only accept known values; default to pending
            $allowed_statuses = ['pending','active','completed','red_flagged','cancelled'];
            $status = in_array($body['status'] ?? '', $allowed_statuses)
                        ? $body['status'] : 'pending';

            $stmt = db()->prepare('
                UPDATE sessions SET
                    actual_grid_time           = ?,
                    actual_green_flag_time     = ?,
                    actual_start_time          = ?,
                    actual_finish_time         = ?,
                    duration_override_minutes  = ?,
                    tidy_override_minutes      = ?,
                    weather_extra_gfl          = ?,
                    weather_notes              = ?,
                    track_condition_end        = ?,
                    status                     = ?
                WHERE id = ?
            ');
            $stmt->execute([
                $actual_grid_time,
                $actual_green_flag_time, $actual_start_time, $actual_finish_time,
                $duration_override_minutes, $tidy_override_minutes,
                $weather_extra_gfl, $weather_notes, $track_condition_end, $status, $id,
            ]);
            jsonResponse(['success' => true]);
        }

        // -- Update session configuration (pre-event setup) --
        $series_name              = trim($body['series_name']              ?? '');
        $session_type             = trim($body['session_type']             ?? '');
        $session_number           = (int)($body['session_number']          ?? 1);
        $planned_start            = trim($body['planned_start']            ?? '');
        $planned_duration_minutes = (int)($body['planned_duration_minutes'] ?? 0);
        // start_type is only relevant for race sessions; NULL for practice/qualifying
        $start_type               = ($session_type === 'race')
                                       ? (in_array($body['start_type'] ?? '', ['standing','rolling'])
                                           ? $body['start_type'] : 'standing')
                                       : null;
        $has_green_flag_lap       = (int)(bool)($body['has_green_flag_lap'] ?? false);
        $has_pit_stops            = (int)(bool)($body['has_pit_stops']      ?? false);
        $session_notes            = trim($body['session_notes'] ?? '') ?: null;

        if (!$series_name || !$session_type || !$planned_start || !$planned_duration_minutes) {
            jsonResponse(['error' => 'series_name, session_type, planned_start and planned_duration_minutes are required'], 400);
        }

        $stmt = db()->prepare('
            UPDATE sessions SET
                series_name = ?, session_type = ?, session_number = ?,
                planned_start = ?, planned_duration_minutes = ?,
                start_type = ?, has_green_flag_lap = ?, has_pit_stops = ?,
                session_notes = ?
            WHERE id = ?
        ');
        $stmt->execute([
            $series_name, $session_type, $session_number,
            $planned_start, $planned_duration_minutes,
            $start_type, $has_green_flag_lap, $has_pit_stops,
            $session_notes, $id,
        ]);
        jsonResponse(['success' => true]);
    }

    // -----------------------------------------------------------------------
    // DELETE
    // -----------------------------------------------------------------------
    if ($method === 'DELETE') {
        requirePin();
        if (!$id) {
            jsonResponse(['error' => 'id is required for DELETE'], 400);
        }
        $stmt = db()->prepare('DELETE FROM sessions WHERE id = ?');
        $stmt->execute([$id]);
        jsonResponse(['success' => true]);
    }

    jsonResponse(['error' => 'Method not allowed'], 405);

} catch (\PDOException $e) {
    jsonResponse(['error' => 'Database error: ' . $e->getMessage()], 500);
} catch (\Throwable $e) {
    jsonResponse(['error' => $e->getMessage()], 500);
}
