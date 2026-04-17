<?php
/**
 * api/layouts.php
 * =============================================================================
 * REST endpoint for circuit layout management.
 *
 * A layout belongs to a circuit and carries the green_flag_lap_minutes value
 * used by the timetable to compute total session block time.
 *
 * GET    /api/layouts.php?circuit_id=N   — list layouts for a circuit
 * GET    /api/layouts.php?id=N           — get one layout
 * POST   /api/layouts.php                — create  [PIN required]
 *          body: { circuit_id, layout_name, green_flag_lap_minutes }
 * PUT    /api/layouts.php?id=N           — update  [PIN required]
 *          body: { layout_name, green_flag_lap_minutes }
 * DELETE /api/layouts.php?id=N           — delete  [PIN required]
 * =============================================================================
 */

require_once __DIR__ . '/common.php';

$method     = $_SERVER['REQUEST_METHOD'];
$id         = isset($_GET['id'])         ? (int)$_GET['id']         : null;
$circuit_id = isset($_GET['circuit_id']) ? (int)$_GET['circuit_id'] : null;

try {
    switch ($method) {

        // ------------------------------------------------------------------
        case 'GET':
            if ($id) {
                $stmt = db()->prepare('SELECT * FROM circuit_layouts WHERE id = ?');
                $stmt->execute([$id]);
                $row = $stmt->fetch();
                if (!$row) {
                    jsonResponse(['error' => 'Layout not found'], 404);
                }
                jsonResponse($row);
            } elseif ($circuit_id) {
                $stmt = db()->prepare(
                    'SELECT * FROM circuit_layouts WHERE circuit_id = ? ORDER BY layout_name'
                );
                $stmt->execute([$circuit_id]);
                jsonResponse($stmt->fetchAll());
            } else {
                // Return all layouts grouped by circuit (useful for bulk loading)
                $stmt = db()->query('
                    SELECT cl.*, c.name AS circuit_name
                    FROM   circuit_layouts cl
                    JOIN   circuits c ON c.id = cl.circuit_id
                    ORDER  BY c.name, cl.layout_name
                ');
                jsonResponse($stmt->fetchAll());
            }
            break;

        // ------------------------------------------------------------------
        case 'POST':
            requirePin();
            $body         = requestBody();
            $circuit_id   = (int)($body['circuit_id']            ?? 0);
            $layout_name  = trim($body['layout_name']             ?? '');
            $gfl_minutes  = (int)($body['green_flag_lap_minutes'] ?? 2);
            $grid_minutes = (int)($body['grid_minutes']           ?? 5);

            if (!$circuit_id || $layout_name === '') {
                jsonResponse(['error' => 'circuit_id and layout_name are required'], 400);
            }
            if ($gfl_minutes < 1 || $gfl_minutes > 10) {
                jsonResponse(['error' => 'green_flag_lap_minutes must be between 1 and 10'], 400);
            }
            if ($grid_minutes < 1 || $grid_minutes > 30) {
                jsonResponse(['error' => 'grid_minutes must be between 1 and 30'], 400);
            }

            $stmt = db()->prepare('
                INSERT INTO circuit_layouts (circuit_id, layout_name, green_flag_lap_minutes, grid_minutes)
                VALUES (?, ?, ?, ?)
            ');
            $stmt->execute([$circuit_id, $layout_name, $gfl_minutes, $grid_minutes]);
            jsonResponse([
                'id'                     => (int)db()->lastInsertId(),
                'circuit_id'             => $circuit_id,
                'layout_name'            => $layout_name,
                'green_flag_lap_minutes' => $gfl_minutes,
                'grid_minutes'           => $grid_minutes,
            ], 201);

        // ------------------------------------------------------------------
        case 'PUT':
            requirePin();
            if (!$id) {
                jsonResponse(['error' => 'id is required for PUT'], 400);
            }
            $body         = requestBody();
            $layout_name  = trim($body['layout_name']             ?? '');
            $gfl_minutes  = (int)($body['green_flag_lap_minutes'] ?? 2);
            $grid_minutes = (int)($body['grid_minutes']           ?? 5);

            if ($layout_name === '') {
                jsonResponse(['error' => 'layout_name is required'], 400);
            }
            if ($gfl_minutes < 1 || $gfl_minutes > 10) {
                jsonResponse(['error' => 'green_flag_lap_minutes must be between 1 and 10'], 400);
            }
            if ($grid_minutes < 1 || $grid_minutes > 30) {
                jsonResponse(['error' => 'grid_minutes must be between 1 and 30'], 400);
            }

            $stmt = db()->prepare('
                UPDATE circuit_layouts
                SET layout_name = ?, green_flag_lap_minutes = ?, grid_minutes = ?
                WHERE id = ?
            ');
            $stmt->execute([$layout_name, $gfl_minutes, $grid_minutes, $id]);
            jsonResponse(['success' => true]);

        // ------------------------------------------------------------------
        case 'DELETE':
            requirePin();
            if (!$id) {
                jsonResponse(['error' => 'id is required for DELETE'], 400);
            }
            // Check this layout is not in use by any events before deleting
            $check = db()->prepare('SELECT COUNT(*) FROM events WHERE layout_id = ?');
            $check->execute([$id]);
            if ((int)$check->fetchColumn() > 0) {
                jsonResponse([
                    'error' => 'This layout is used by one or more events and cannot be deleted.',
                ], 409);
            }
            $stmt = db()->prepare('DELETE FROM circuit_layouts WHERE id = ?');
            $stmt->execute([$id]);
            jsonResponse(['success' => true]);

        // ------------------------------------------------------------------
        default:
            jsonResponse(['error' => 'Method not allowed'], 405);
    }
} catch (\PDOException $e) {
    $msg = str_contains($e->getMessage(), 'Duplicate entry')
        ? 'A layout with that name already exists for this circuit'
        : 'Database error: ' . $e->getMessage();
    jsonResponse(['error' => $msg], 500);
} catch (\Throwable $e) {
    jsonResponse(['error' => $e->getMessage()], 500);
}
