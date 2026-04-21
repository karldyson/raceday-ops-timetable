<?php
/**
 * api/common.php
 * =============================================================================
 * Shared database connection, response helpers, auth, and data normalisation
 * for all Race Day Timetable API endpoints.
 *
 * Every endpoint file should begin with:
 *   require_once __DIR__ . '/common.php';
 * =============================================================================
 */

require_once __DIR__ . '/config.php';

// ---------------------------------------------------------------------------
// PDO connection (lazy singleton)
// ---------------------------------------------------------------------------
function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $pdo = new PDO(DB_DSN, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    }
    return $pdo;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Emit a JSON response and terminate execution.
 *
 * @param mixed $data   Value to JSON-encode.
 * @param int   $status HTTP status code.
 */
function jsonResponse(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    // Allow cross-origin requests when frontend is on a different port (dev)
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Ops-Pin');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    exit;
}

/**
 * Decode JSON from the request body (used for POST/PUT requests).
 * Returns an empty array if the body is absent or not valid JSON.
 */
function requestBody(): array
{
    $raw = file_get_contents('php://input');
    if (!$raw || trim($raw) === '') {
        return [];
    }
    try {
        return json_decode($raw, true, 512, JSON_THROW_ON_ERROR) ?? [];
    } catch (\JsonException) {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Verify the X-Ops-Pin header.  Terminates with 403 if it is missing or wrong.
 * Call this at the top of any write operation.
 */
function requirePin(): void
{
    // getallheaders() normalises header names inconsistently across SAPIs;
    // check both capitalisation variants to be safe.
    $headers = array_change_key_case(getallheaders(), CASE_LOWER);
    $pin = $headers['x-ops-pin'] ?? '';
    if ($pin !== OPS_PIN) {
        jsonResponse(['error' => 'Invalid or missing operations PIN'], 403);
    }
}

// ---------------------------------------------------------------------------
// Time / data normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Trim a MySQL TIME string "HH:MM:SS" down to "HH:MM".
 * Returns null if the value is null or empty.
 */
function fmtTime(?string $t): ?string
{
    if ($t === null || $t === '') {
        return null;
    }
    return substr($t, 0, 5);   // "09:30:00" → "09:30"
}

/**
 * Normalise a session row fetched from the database.
 * - Trims TIME columns to HH:MM.
 * - Casts boolean-like TINYINT columns to PHP booleans so they
 *   serialise as true/false in JSON rather than 0/1.
 */
function normaliseSession(array $s): array
{
    foreach (['planned_start', 'actual_grid_time', 'actual_green_flag_time', 'actual_start_time', 'actual_finish_time'] as $col) {
        if (array_key_exists($col, $s)) {
            $s[$col] = fmtTime($s[$col]);
        }
    }
    foreach (['has_green_flag_lap', 'has_pit_stops', 'has_safety_car', 'has_live_snatch', 'weather_extra_gfl'] as $col) {
        if (array_key_exists($col, $s)) {
            $s[$col] = (bool)(int)$s[$col];
        }
    }
    // Cast nullable integers so JS receives null or a number
    foreach (['duration_override_minutes', 'tidy_override_minutes'] as $col) {
        if (array_key_exists($col, $s)) {
            $s[$col] = $s[$col] !== null ? (int)$s[$col] : null;
        }
    }
    return $s;
}

// ---------------------------------------------------------------------------
// Handle pre-flight OPTIONS requests (CORS) — respond immediately
// ---------------------------------------------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Ops-Pin');
    exit;
}
