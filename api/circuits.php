<?php
/**
 * api/circuits.php
 * =============================================================================
 * REST endpoint for circuit (venue) management.
 *
 * GET    /api/circuits.php         — list all circuits, each with its layouts
 * GET    /api/circuits.php?id=N    — get one circuit with layouts
 * POST   /api/circuits.php         — create  [PIN required]
 * PUT    /api/circuits.php?id=N    — update  [PIN required]
 * DELETE /api/circuits.php?id=N    — delete  [PIN required]
 *
 * Layouts are managed via api/layouts.php.
 * =============================================================================
 */

require_once __DIR__ . '/common.php';

$method = $_SERVER['REQUEST_METHOD'];
$id     = isset($_GET['id']) ? (int)$_GET['id'] : null;

/**
 * Fetch all layouts for a circuit (or multiple circuits).
 * Returns an array keyed by circuit_id, each value an array of layout rows.
 *
 * @param int|null $circuitId  If provided, only fetch layouts for that circuit.
 * @return array
 */
function fetchLayouts(?int $circuitId = null): array
{
    if ($circuitId) {
        $stmt = db()->prepare(
            'SELECT * FROM circuit_layouts WHERE circuit_id = ? ORDER BY layout_name'
        );
        $stmt->execute([$circuitId]);
    } else {
        $stmt = db()->query(
            'SELECT * FROM circuit_layouts ORDER BY circuit_id, layout_name'
        );
    }
    $rows = $stmt->fetchAll();

    // Group by circuit_id for easy merging into the circuit rows
    $grouped = [];
    foreach ($rows as $r) {
        $grouped[(int)$r['circuit_id']][] = $r;
    }
    return $grouped;
}

try {
    switch ($method) {

        // ------------------------------------------------------------------
        case 'GET':
            if ($id) {
                $stmt = db()->prepare('SELECT * FROM circuits WHERE id = ?');
                $stmt->execute([$id]);
                $row = $stmt->fetch();
                if (!$row) {
                    jsonResponse(['error' => 'Circuit not found'], 404);
                }
                $row['default_curfew_time']  = fmtTime($row['default_curfew_time']);
                $row['live_snatch_licensed'] = (bool)(int)$row['live_snatch_licensed'];
                $layouts = fetchLayouts($id);
                $row['layouts'] = $layouts[$id] ?? [];
                jsonResponse($row);
            } else {
                $stmt = db()->query('SELECT * FROM circuits ORDER BY name');
                $rows = $stmt->fetchAll();
                // Fetch all layouts in one query and merge in
                $allLayouts = fetchLayouts();
                foreach ($rows as &$r) {
                    $r['default_curfew_time']  = fmtTime($r['default_curfew_time']);
                    $r['live_snatch_licensed'] = (bool)(int)$r['live_snatch_licensed'];
                    $r['layouts'] = $allLayouts[(int)$r['id']] ?? [];
                }
                jsonResponse($rows);
            }
            break;

        // ------------------------------------------------------------------
        case 'POST':
            requirePin();
            $body          = requestBody();
            $name          = trim($body['name']                ?? '');
            $curfew        = trim($body['default_curfew_time'] ?? '');
            $liveSnatch    = (int)(bool)($body['live_snatch_licensed'] ?? false);
            if ($name === '' || $curfew === '') {
                jsonResponse(['error' => 'name and default_curfew_time are required'], 400);
            }
            $stmt = db()->prepare(
                'INSERT INTO circuits (name, default_curfew_time, live_snatch_licensed) VALUES (?, ?, ?)'
            );
            $stmt->execute([$name, $curfew, $liveSnatch]);
            $newId = (int)db()->lastInsertId();
            jsonResponse(['id' => $newId, 'name' => $name, 'default_curfew_time' => $curfew, 'live_snatch_licensed' => (bool)$liveSnatch, 'layouts' => []], 201);

        // ------------------------------------------------------------------
        case 'PUT':
            requirePin();
            if (!$id) {
                jsonResponse(['error' => 'id is required for PUT'], 400);
            }
            $body       = requestBody();
            $name       = trim($body['name']                ?? '');
            $curfew     = trim($body['default_curfew_time'] ?? '');
            $liveSnatch = (int)(bool)($body['live_snatch_licensed'] ?? false);
            if ($name === '' || $curfew === '') {
                jsonResponse(['error' => 'name and default_curfew_time are required'], 400);
            }
            $stmt = db()->prepare(
                'UPDATE circuits SET name = ?, default_curfew_time = ?, live_snatch_licensed = ? WHERE id = ?'
            );
            $stmt->execute([$name, $curfew, $liveSnatch, $id]);
            jsonResponse(['success' => true]);

        // ------------------------------------------------------------------
        case 'DELETE':
            requirePin();
            if (!$id) {
                jsonResponse(['error' => 'id is required for DELETE'], 400);
            }
            $stmt = db()->prepare('DELETE FROM circuits WHERE id = ?');
            $stmt->execute([$id]);
            jsonResponse(['success' => true]);

        // ------------------------------------------------------------------
        default:
            jsonResponse(['error' => 'Method not allowed'], 405);
    }
} catch (\PDOException $e) {
    $msg = str_contains($e->getMessage(), 'Duplicate entry')
        ? 'A circuit with that name already exists'
        : 'Database error: ' . $e->getMessage();
    jsonResponse(['error' => $msg], 500);
} catch (\Throwable $e) {
    jsonResponse(['error' => $e->getMessage()], 500);
}
