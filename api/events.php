<?php
/**
 * api/events.php
 * =============================================================================
 * REST endpoint for race meeting (event) management.
 *
 * Events now reference a specific circuit layout (layout_id) rather than just
 * a circuit, so the green_flag_lap_minutes for that layout is available to the
 * timetable calculations on the frontend.
 *
 * GET    /api/events.php           — list all events (newest first)
 * GET    /api/events.php?id=N      — get one event with sessions embedded
 * POST   /api/events.php           — create  [PIN required]
 *          body: { name, event_date, layout_id, curfew_time, notes }
 * PUT    /api/events.php?id=N      — update  [PIN required]
 * DELETE /api/events.php?id=N      — delete (cascades to sessions)  [PIN required]
 * =============================================================================
 */

require_once __DIR__ . '/common.php';

$method = $_SERVER['REQUEST_METHOD'];
$id     = isset($_GET['id']) ? (int)$_GET['id'] : null;

try {
    switch ($method) {

        // ------------------------------------------------------------------
        case 'GET':
            if ($id) {
                // Single event — JOIN through circuit_layouts → circuits so
                // the frontend gets circuit name, layout name, and GFL minutes
                // in one call.
                $stmt = db()->prepare('
                    SELECT
                        e.*,
                        cl.layout_name,
                        cl.green_flag_lap_minutes,
                        cl.grid_minutes,
                        cl.circuit_id,
                        c.name  AS circuit_name,
                        c.default_curfew_time AS circuit_default_curfew,
                        c.live_snatch_licensed
                    FROM   events e
                    JOIN   circuit_layouts cl ON cl.id = e.layout_id
                    JOIN   circuits c         ON c.id  = cl.circuit_id
                    WHERE  e.id = ?
                ');
                $stmt->execute([$id]);
                $event = $stmt->fetch();
                if (!$event) {
                    jsonResponse(['error' => 'Event not found'], 404);
                }
                $event['curfew_time']            = fmtTime($event['curfew_time']);
                $event['circuit_default_curfew'] = fmtTime($event['circuit_default_curfew']);
                $event['live_snatch_licensed']   = (bool)(int)$event['live_snatch_licensed'];
                // Effective values: event overrides take precedence over layout defaults
                $event['effective_gfl_minutes']  = $event['gfl_minutes_override'] !== null
                    ? (int)$event['gfl_minutes_override']
                    : (int)$event['green_flag_lap_minutes'];
                $event['effective_grid_minutes'] = $event['grid_minutes_override'] !== null
                    ? (int)$event['grid_minutes_override']
                    : (int)$event['grid_minutes'];

                // Fetch sessions ordered by sort_order then planned_start
                $sstmt = db()->prepare('
                    SELECT * FROM sessions
                    WHERE  event_id = ?
                    ORDER  BY sort_order, planned_start
                ');
                $sstmt->execute([$id]);
                $event['sessions'] = array_map('normaliseSession', $sstmt->fetchAll());

                jsonResponse($event);

            } else {
                // List — summary only, no sessions
                $stmt = db()->query('
                    SELECT
                        e.id, e.name, e.event_date, e.curfew_time, e.notes, e.created_at,
                        e.layout_id, e.gfl_minutes_override, e.grid_minutes_override,
                        cl.layout_name,
                        cl.green_flag_lap_minutes,
                        cl.grid_minutes,
                        cl.circuit_id,
                        c.name AS circuit_name
                    FROM   events e
                    JOIN   circuit_layouts cl ON cl.id = e.layout_id
                    JOIN   circuits c         ON c.id  = cl.circuit_id
                    ORDER  BY e.event_date DESC, e.id DESC
                ');
                $rows = $stmt->fetchAll();
                foreach ($rows as &$r) {
                    $r['curfew_time'] = fmtTime($r['curfew_time']);
                }
                jsonResponse($rows);
            }
            break;

        // ------------------------------------------------------------------
        case 'POST':
            requirePin();
            $body        = requestBody();
            $name        = trim($body['name']        ?? '');
            $event_date  = trim($body['event_date']  ?? '');
            $layout_id   = (int)($body['layout_id']  ?? 0);
            $curfew_time = trim($body['curfew_time'] ?? '');
            $notes       = trim($body['notes']       ?? '') ?: null;
            $gfl_override  = isset($body['gfl_minutes_override'])  && $body['gfl_minutes_override']  !== '' && $body['gfl_minutes_override']  !== null
                ? (int)$body['gfl_minutes_override']  : null;
            $grid_override = isset($body['grid_minutes_override']) && $body['grid_minutes_override'] !== '' && $body['grid_minutes_override'] !== null
                ? (int)$body['grid_minutes_override'] : null;

            if (!$name || !$event_date || !$layout_id || !$curfew_time) {
                jsonResponse(['error' => 'name, event_date, layout_id and curfew_time are required'], 400);
            }

            $stmt = db()->prepare('
                INSERT INTO events (name, event_date, layout_id, curfew_time, gfl_minutes_override, grid_minutes_override, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ');
            $stmt->execute([$name, $event_date, $layout_id, $curfew_time, $gfl_override, $grid_override, $notes]);
            jsonResponse(['id' => (int)db()->lastInsertId()], 201);

        // ------------------------------------------------------------------
        case 'PUT':
            requirePin();
            if (!$id) {
                jsonResponse(['error' => 'id is required for PUT'], 400);
            }
            $body        = requestBody();
            $name        = trim($body['name']        ?? '');
            $event_date  = trim($body['event_date']  ?? '');
            $layout_id   = (int)($body['layout_id']  ?? 0);
            $curfew_time = trim($body['curfew_time'] ?? '');
            $notes       = trim($body['notes']       ?? '') ?: null;
            $gfl_override  = isset($body['gfl_minutes_override'])  && $body['gfl_minutes_override']  !== '' && $body['gfl_minutes_override']  !== null
                ? (int)$body['gfl_minutes_override']  : null;
            $grid_override = isset($body['grid_minutes_override']) && $body['grid_minutes_override'] !== '' && $body['grid_minutes_override'] !== null
                ? (int)$body['grid_minutes_override'] : null;

            if (!$name || !$event_date || !$layout_id || !$curfew_time) {
                jsonResponse(['error' => 'name, event_date, layout_id and curfew_time are required'], 400);
            }

            $stmt = db()->prepare('
                UPDATE events
                SET name=?, event_date=?, layout_id=?, curfew_time=?,
                    gfl_minutes_override=?, grid_minutes_override=?, notes=?
                WHERE id=?
            ');
            $stmt->execute([$name, $event_date, $layout_id, $curfew_time,
                            $gfl_override, $grid_override, $notes, $id]);
            jsonResponse(['success' => true]);

        // ------------------------------------------------------------------
        case 'DELETE':
            requirePin();
            if (!$id) {
                jsonResponse(['error' => 'id is required for DELETE'], 400);
            }
            $stmt = db()->prepare('DELETE FROM events WHERE id = ?');
            $stmt->execute([$id]);
            jsonResponse(['success' => true]);

        // ------------------------------------------------------------------
        default:
            jsonResponse(['error' => 'Method not allowed'], 405);
    }
} catch (\PDOException $e) {
    jsonResponse(['error' => 'Database error: ' . $e->getMessage()], 500);
} catch (\Throwable $e) {
    jsonResponse(['error' => $e->getMessage()], 500);
}
