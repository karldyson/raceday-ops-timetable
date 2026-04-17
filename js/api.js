/**
 * js/api.js
 * =============================================================================
 * Centralised API client for the Race Day Timetable.
 *
 * All HTTP communication with the PHP backend goes through this module so
 * that URL paths, the ops PIN header, and error handling are defined in one
 * place.  Both timetable.js and setup.js import from this module via a shared
 * namespace on the window object (window.RDT).
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// Module namespace — attached to window so it's available to all scripts
// loaded in the same page.
// ---------------------------------------------------------------------------
window.RDT = window.RDT || {};

(function (RDT) {
    'use strict';

    // -----------------------------------------------------------------------
    // State — ops PIN (null = viewer mode, set after successful PIN entry)
    // -----------------------------------------------------------------------
    let _opsPin = null;

    /** Return true if the user has entered the ops PIN this session. */
    RDT.isOpsMode = () => _opsPin !== null;

    /** Store the ops PIN (called after user enters it in the PIN dialog). */
    RDT.setPin = (pin) => { _opsPin = pin; };

    /** Clear the ops PIN (log out of ops mode). */
    RDT.clearPin = () => { _opsPin = null; };

    // -----------------------------------------------------------------------
    // Core fetch wrapper
    // -----------------------------------------------------------------------

    /**
     * Make an HTTP request to the PHP API and return the parsed JSON body.
     *
     * @param {string} url        Full path, e.g. "/api/events.php?id=3"
     * @param {string} method     HTTP verb
     * @param {object|null} body  Request body (serialised to JSON if present)
     * @param {boolean} requirePin  If true, include the X-Ops-Pin header
     * @returns {Promise<any>}    Resolved with parsed response body
     * @throws {Error}            On non-2xx responses or network failures
     */
    async function apiFetch(url, method = 'GET', body = null, requirePin = false) {
        const headers = { 'Content-Type': 'application/json' };
        if (requirePin) {
            if (!_opsPin) throw new Error('Ops mode is not active — enter the PIN first.');
            headers['X-Ops-Pin'] = _opsPin;
        }

        const init = { method, headers };
        if (body !== null) {
            init.body = JSON.stringify(body);
        }

        let response;
        try {
            response = await fetch(url, init);
        } catch (networkErr) {
            throw new Error(`Network error: ${networkErr.message}`);
        }

        // Always attempt to parse JSON — the API always returns JSON
        let data;
        try {
            data = await response.json();
        } catch (_) {
            throw new Error(`Server returned non-JSON response (HTTP ${response.status})`);
        }

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        return data;
    }

    // -----------------------------------------------------------------------
    // Convenience helpers for each HTTP verb
    // -----------------------------------------------------------------------
    const get  = (url)          => apiFetch(url, 'GET',    null, false);
    const post = (url, body)     => apiFetch(url, 'POST',   body, true);
    const put  = (url, body)     => apiFetch(url, 'PUT',    body, true);
    const del  = (url)           => apiFetch(url, 'DELETE', null, true);

    // -----------------------------------------------------------------------
    // API methods — Circuits
    // -----------------------------------------------------------------------

    /** List all circuits. */
    RDT.getCircuits = () => get('/api/circuits.php');

    /** Create a circuit.  body: { name, default_curfew_time }  [PIN] */
    RDT.createCircuit = (data) => post('/api/circuits.php', data);

    /** Update a circuit.  [PIN] */
    RDT.updateCircuit = (id, data) => put(`/api/circuits.php?id=${id}`, data);

    /** Delete a circuit.  [PIN] */
    RDT.deleteCircuit = (id) => del(`/api/circuits.php?id=${id}`);

    // -----------------------------------------------------------------------
    // API methods — Events
    // -----------------------------------------------------------------------

    /** List all events (summary only, no sessions). */
    RDT.getEvents = () => get('/api/events.php');

    /**
     * Get a single event with its sessions embedded.
     * This is the primary data-fetch used by the timetable view.
     */
    RDT.getEvent = (id) => get(`/api/events.php?id=${id}`);

    /** Create an event.  body: { name, event_date, circuit_id, curfew_time, notes }  [PIN] */
    RDT.createEvent = (data) => post('/api/events.php', data);

    /** Update an event.  [PIN] */
    RDT.updateEvent = (id, data) => put(`/api/events.php?id=${id}`, data);

    /** Delete an event (and all its sessions via cascade).  [PIN] */
    RDT.deleteEvent = (id) => del(`/api/events.php?id=${id}`);

    // -----------------------------------------------------------------------
    // API methods — Sessions
    // -----------------------------------------------------------------------

    /**
     * Create a new session.
     * body must include event_id plus all required session fields.  [PIN]
     */
    RDT.createSession = (data) => post('/api/sessions.php', data);

    /**
     * Update session configuration (pre-event setup).  [PIN]
     * Does NOT touch actual times — use updateActuals for that.
     */
    RDT.updateSession = (id, data) => put(`/api/sessions.php?id=${id}`, data);

    /**
     * Save actual times and weather data for a session (ops clerk, during event).
     * body: { actual_green_flag_time, actual_start_time, actual_finish_time,
     *          weather_extra_gfl, weather_notes, status }  [PIN]
     */
    RDT.updateActuals = (id, data) => put(`/api/sessions.php?id=${id}&part=actuals`, data);

    /** Delete a session.  [PIN] */
    RDT.deleteSession = (id) => del(`/api/sessions.php?id=${id}`);

    /**
     * Reorder sessions within an event.
     * order: Array of { id, sort_order }  [PIN]
     */
    RDT.reorderSessions = (eventId, order) =>
        post(`/api/sessions.php?action=reorder&event_id=${eventId}`, { order });

    // -----------------------------------------------------------------------
    // API methods — Circuit Layouts
    // -----------------------------------------------------------------------

    /**
     * List all layouts for a given circuit.
     * Returns array of { id, circuit_id, layout_name, green_flag_lap_minutes }
     */
    RDT.getLayouts = (circuitId) => get(`/api/layouts.php?circuit_id=${circuitId}`);

    /**
     * Create a layout.
     * body: { circuit_id, layout_name, green_flag_lap_minutes }  [PIN]
     */
    RDT.createLayout = (data) => post('/api/layouts.php', data);

    /** Update a layout's name or GFL minutes.  [PIN] */
    RDT.updateLayout = (id, data) => put(`/api/layouts.php?id=${id}`, data);

    /**
     * Delete a layout.  Will fail (409) if the layout is in use by any event.
     * [PIN]
     */
    RDT.deleteLayout = (id) => del(`/api/layouts.php?id=${id}`);

    // -----------------------------------------------------------------------
    // PIN verification helper
    // Attempts a write operation that requires the PIN so we can verify it
    // before storing it.  Uses a GET (read-only) with the PIN header —
    // a 403 means the PIN is wrong; 200 means it's correct.
    // -----------------------------------------------------------------------

    /**
     * Verify a PIN against the server by attempting an authenticated request.
     * Returns true if the PIN is accepted, false if rejected, throws on network error.
     */
    RDT.verifyPin = async (pin) => {
        // Temporarily set pin so apiFetch can include it
        _opsPin = pin;
        try {
            // We POST a reorder with an empty order to event_id=0.
            // The server validates the PIN header before inspecting the body:
            //   Wrong PIN  → 403 "Invalid or missing operations PIN" → return false
            //   Correct PIN → 400 "event_id is required" (event 0 doesn't exist) → return true
            await apiFetch('/api/sessions.php?action=reorder&event_id=0', 'POST', { order: [] }, true);
            return true;   // unexpected 2xx — still means PIN was accepted
        } catch (err) {
            // Network failure — re-throw so the caller can surface the error
            if (err.message.startsWith('Network error')) {
                _opsPin = null;
                throw err;
            }
            // 403: wrong PIN
            if (err.message.includes('Invalid') || err.message.includes('403')) {
                _opsPin = null;
                return false;
            }
            // 400 / other server error — PIN was accepted by the middleware
            return true;
        }
    };

})(window.RDT);
