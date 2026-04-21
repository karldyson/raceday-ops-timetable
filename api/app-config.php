<?php
/**
 * api/app-config.php
 * =============================================================================
 * Returns non-sensitive, frontend-readable configuration values as JSON.
 * Only include values that are safe to expose publicly — no credentials,
 * no PIN, no database details.
 *
 * GET /api/app-config.php
 * =============================================================================
 */

require_once __DIR__ . '/common.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'Method not allowed'], 405);
}

jsonResponse([
    // When false (default): Safety Car checkbox shown for race sessions only.
    // When true: also offered for practice and qualifying sessions.
    'sc_on_non_race' => defined('SC_ON_NON_RACE') ? (bool) SC_ON_NON_RACE : false,
]);
