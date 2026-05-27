/**
 * js/setup.js
 * =============================================================================
 * Event and session configuration page logic.
 *
 * Responsibilities:
 *  - Ops PIN entry (all setup operations require the PIN)
 *  - Event management: create / edit / delete events
 *  - Session list for the selected event: CRUD and up/down reordering
 *  - Add/edit session modal
 *
 * Circuit management has moved to circuits.html / circuits.js.
 * =============================================================================
 */

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentEventId      = null;   // event currently being edited
let currentSessions     = [];     // session array from last server fetch
let editingSessionId    = null;   // null = adding new, N = editing existing
let circuits            = [];     // cached circuit list (with layouts)
let liveSnatchAvailable = false;  // whether the current event's circuit is LS-licensed
let appConfig           = { sc_on_non_race: false };  // feature flags from server

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    const params       = new URLSearchParams(window.location.search);
    const urlEventId   = params.get('event') ? parseInt(params.get('event'), 10) : null;

    await ensurePin();
    await Promise.all([loadCircuits(), loadEventList(), loadAppConfig()]);

    if (urlEventId) {
        selectEvent(urlEventId);
        document.getElementById('event-select').value = urlEventId;
    }

    // ---- Wire up controls ----
    document.getElementById('event-select').addEventListener('change', e => {
        const id = parseInt(e.target.value, 10);
        if (id) selectEvent(id);
    });
    document.getElementById('btn-save-event').addEventListener('click',   saveEvent);
    document.getElementById('btn-new-event').addEventListener('click',    () => {
        currentEventId = null;
        clearEventForm();
        document.getElementById('event-form-section').classList.remove('hidden');
        document.getElementById('event-name-input').focus();
    });
    document.getElementById('btn-delete-event').addEventListener('click', deleteCurrentEvent);
    document.getElementById('btn-add-session').addEventListener('click',  () => openSessionModal(null));

    // Circuit selector → load layouts for chosen circuit
    document.getElementById('event-circuit').addEventListener('change', onCircuitChange);
    // Layout selector → update override field placeholders
    document.getElementById('event-layout').addEventListener('change', updateLayoutOverridePlaceholders);

    // Session modal
    document.getElementById('modal-session-save').addEventListener('click',   saveSession);
    document.getElementById('modal-session-cancel').addEventListener('click', closeSessionModal);
    document.getElementById('session-modal-overlay').addEventListener('click', e => {
        if (e.target === document.getElementById('session-modal-overlay')) closeSessionModal();
    });

    // Session type change → update number and form visibility
    document.getElementById('sess-type').addEventListener('change', () => {
        updateSessionNumberDefault();
        updateSessionFormVisibility();
    });
});

// ---------------------------------------------------------------------------
// PIN management
// ---------------------------------------------------------------------------

async function ensurePin() {
    if (RDT.isOpsMode()) return;
    while (true) {
        const pin = prompt('Setup requires the Operations PIN.\nEnter PIN (or Cancel to view read-only):');
        if (!pin) { window.location.href = '/'; return; }
        try {
            const ok = await RDT.verifyPin(pin);
            if (ok) { showAlert('setup-alert', 'Ops mode active.', 'success'); return; }
            alert('Incorrect PIN — please try again.');
        } catch (err) {
            alert(`Error verifying PIN: ${err.message}`);
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// App config (feature flags)
// ---------------------------------------------------------------------------

async function loadAppConfig() {
    try {
        const res = await fetch('/api/app-config.php');
        if (res.ok) appConfig = await res.json();
    } catch (_) { /* use defaults */ }
}

// ---------------------------------------------------------------------------
// Circuits (selector only — full management is in circuits.html)
// ---------------------------------------------------------------------------

async function loadCircuits() {
    try {
        circuits = await RDT.getCircuits();
        renderCircuitSelector(circuits);
    } catch (err) {
        showAlert('setup-alert', `Failed to load circuits: ${err.message}`, 'danger');
    }
}

/** Populate the circuit <select> in the event form. */
function renderCircuitSelector(circuitList) {
    const sel = document.getElementById('event-circuit');
    const savedId = sel.value;
    sel.innerHTML = '<option value="">— select circuit —</option>';
    circuitList.forEach(c => {
        const opt = document.createElement('option');
        opt.value           = c.id;
        opt.textContent     = c.name;
        opt.dataset.curfew  = c.default_curfew_time;
        sel.appendChild(opt);
    });
    if (savedId) sel.value = savedId;
}

/** When the circuit changes, repopulate the layout dropdown. */
async function onCircuitChange() {
    const sel       = document.getElementById('event-circuit');
    const circuitId = parseInt(sel.value, 10);
    const opt       = sel.selectedOptions[0];

    if (opt && opt.dataset.curfew) {
        setValue('event-curfew', opt.dataset.curfew);
    }

    await loadLayoutsForCircuit(circuitId);
}

/** Populate the layout <select> for a given circuit. */
async function loadLayoutsForCircuit(circuitId) {
    const sel = document.getElementById('event-layout');
    sel.innerHTML = '<option value="">— select layout —</option>';
    if (!circuitId) return;

    const circuit = circuits.find(c => c.id === circuitId);
    const layouts = circuit?.layouts ?? await RDT.getLayouts(circuitId);

    layouts.forEach(l => {
        const opt = document.createElement('option');
        opt.value             = l.id;
        opt.textContent       = `${l.layout_name} (GFL ${l.green_flag_lap_minutes} min / Grid ${l.grid_minutes || 5} min)`;
        opt.dataset.gfl       = l.green_flag_lap_minutes;
        opt.dataset.grid      = l.grid_minutes || 5;
        opt.dataset.name      = l.layout_name;
        sel.appendChild(opt);
    });

    if (layouts.length === 1) sel.value = layouts[0].id;

    updateLayoutOverridePlaceholders();
}

/** Update placeholder text on override inputs to show the layout's default values. */
function updateLayoutOverridePlaceholders() {
    const sel = document.getElementById('event-layout');
    const opt = sel?.selectedOptions[0];
    const gfl  = opt ? (opt.dataset.gfl  || '—') : '—';
    const grid = opt ? (opt.dataset.grid || '—') : '—';
    const gflEl  = document.getElementById('event-gfl-override');
    const gridEl = document.getElementById('event-grid-override');
    if (gflEl)  gflEl.placeholder  = `default: ${gfl}`;
    if (gridEl) gridEl.placeholder = `default: ${grid}`;
}

// ---------------------------------------------------------------------------
// Event list + selection
// ---------------------------------------------------------------------------

async function loadEventList() {
    try {
        const events = await RDT.getEvents();
        const sel    = document.getElementById('event-select');
        const saved  = sel.value;
        sel.innerHTML = '<option value="">— select event —</option>';
        events.forEach(ev => {
            const opt = document.createElement('option');
            opt.value       = ev.id;
            opt.textContent = `${ev.event_date}  ${ev.name}  (${ev.circuit_name} — ${ev.layout_name})`;
            sel.appendChild(opt);
        });
        if (saved) sel.value = saved;
    } catch (err) {
        showAlert('setup-alert', `Failed to load events: ${err.message}`, 'danger');
    }
}

async function selectEvent(id) {
    currentEventId = id;
    try {
        const event = await RDT.getEvent(id);
        liveSnatchAvailable = !!event.live_snatch_licensed;
        await fillEventForm(event);
        currentSessions = event.sessions || [];
        renderSessionsTable(currentSessions, event.effective_gfl_minutes || 0);
        document.getElementById('event-form-section').classList.remove('hidden');
        document.getElementById('sessions-section').classList.remove('hidden');
        document.getElementById('btn-delete-event').classList.remove('hidden');
        history.replaceState(null, '', `/setup.html?event=${id}`);
        const link = document.getElementById('timetable-link');
        if (link) { link.href = `/?event=${id}`; link.textContent = `/?event=${id}`; }
    } catch (err) {
        showAlert('setup-alert', `Failed to load event: ${err.message}`, 'danger');
    }
}

async function fillEventForm(event) {
    setValue('event-name-input',    event.name);
    setValue('event-date-input',    event.event_date);
    setValue('event-curfew',        event.curfew_time);
    setValue('event-gfl-override',  event.gfl_minutes_override  != null ? event.gfl_minutes_override  : '');
    setValue('event-grid-override', event.grid_minutes_override != null ? event.grid_minutes_override : '');
    setValue('event-notes',         event.notes || '');
    document.getElementById('event-form-title').textContent = 'Edit Event';

    setValue('event-circuit', event.circuit_id);
    await loadLayoutsForCircuit(event.circuit_id);
    setValue('event-layout', event.layout_id);
    updateLayoutOverridePlaceholders();
}

function clearEventForm() {
    ['event-name-input','event-date-input','event-curfew',
     'event-gfl-override','event-grid-override','event-notes'].forEach(id => setValue(id, ''));
    setValue('event-circuit', '');
    document.getElementById('event-layout').innerHTML = '<option value="">— select layout —</option>';
    document.getElementById('event-form-title').textContent = 'New Event';
    document.getElementById('btn-delete-event').classList.add('hidden');
    document.getElementById('sessions-section').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Event save / delete
// ---------------------------------------------------------------------------

async function saveEvent() {
    const name        = getValue('event-name-input').trim();
    const eventDate   = getValue('event-date-input').trim();
    const layoutId    = parseInt(getValue('event-layout'), 10);
    const curfew      = getValue('event-curfew').trim();
    const notes       = getValue('event-notes').trim();
    const gflOverride  = getValue('event-gfl-override').trim()  || null;
    const gridOverride = getValue('event-grid-override').trim() || null;

    if (!name || !eventDate || !layoutId || !curfew) {
        showAlert('event-alert', 'Name, date, circuit layout and curfew time are all required.', 'warning');
        return;
    }

    const payload = {
        name, event_date: eventDate, layout_id: layoutId, curfew_time: curfew,
        gfl_minutes_override:  gflOverride  ? parseInt(gflOverride,  10) : null,
        grid_minutes_override: gridOverride ? parseInt(gridOverride, 10) : null,
        notes,
    };

    const btn = document.getElementById('btn-save-event');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        if (currentEventId) {
            await RDT.updateEvent(currentEventId, payload);
            showAlert('event-alert', 'Event updated.', 'success');
        } else {
            const result = await RDT.createEvent(payload);
            currentEventId = result.id;
            history.replaceState(null, '', `/setup.html?event=${currentEventId}`);
            document.getElementById('sessions-section').classList.remove('hidden');
            document.getElementById('btn-delete-event').classList.remove('hidden');
            showAlert('event-alert', 'Event created.', 'success');
        }
        await loadEventList();
        document.getElementById('event-select').value = currentEventId;
        const link = document.getElementById('timetable-link');
        if (link) { link.href = `/?event=${currentEventId}`; link.textContent = `/?event=${currentEventId}`; }
    } catch (err) {
        showAlert('event-alert', `Error saving event: ${err.message}`, 'danger');
    } finally {
        btn.disabled = false; btn.textContent = 'Save Event';
    }
}

async function deleteCurrentEvent() {
    if (!currentEventId) return;
    if (!confirm('Delete this event and all its sessions?  This cannot be undone.')) return;
    try {
        await RDT.deleteEvent(currentEventId);
        currentEventId = null;
        clearEventForm();
        await loadEventList();
        showAlert('setup-alert', 'Event deleted.', 'success');
        history.replaceState(null, '', '/setup.html');
    } catch (err) {
        showAlert('setup-alert', `Could not delete event: ${err.message}`, 'danger');
    }
}

// ---------------------------------------------------------------------------
// Session table
// ---------------------------------------------------------------------------

function renderSessionsTable(sessions, gflMinutes) {
    const tbody = document.getElementById('sessions-table-body');
    tbody.innerHTML = '';

    if (!sessions.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="7" style="text-align:center;color:var(--clr-text-muted);padding:1.5rem">No sessions yet — click "Add Session".</td>';
        tbody.appendChild(tr);
        return;
    }

    let rowNum = 0;
    sessions.forEach((s, idx) => {
        const tr = document.createElement('tr');
        tr.dataset.sessionId = s.id;

        const isBreak = s.session_type === 'break';
        const isOther = s.session_type === 'other';
        const isRace  = s.session_type === 'race';
        if (!isBreak) rowNum++;

        // Build the badges cell — lit for enabled, dimmed for applicable-but-off
        let badgesHtml = '';
        if (!isBreak && !isOther) {
            const b = (cls, label, active) =>
                `<span class="badge ${active ? cls : 'badge-dim'}" title="${label}">${label}</span>`;

            if (isRace) {
                const isRolling = s.start_type === 'rolling';
                badgesHtml += b('badge-rolling',  'R',   isRolling) + ' ';
                badgesHtml += b('badge-standing', 'S',   !isRolling) + ' ';
                badgesHtml += b('badge-yes',      'GFL', s.has_green_flag_lap) + ' ';
            }
            badgesHtml += b('badge-pits', 'Pit', s.has_pit_stops) + ' ';
            if (isRace || appConfig.sc_on_non_race) {
                badgesHtml += b('badge-sc', 'SC', s.has_safety_car) + ' ';
            }
            if (liveSnatchAvailable || s.has_live_snatch) {
                badgesHtml += b('badge-ls', 'LS', s.has_live_snatch);
            }
            badgesHtml = badgesHtml.trim() || '—';
        }

        tr.innerHTML = `
            <td>${isBreak ? '' : rowNum}</td>
            <td>${escHtml(s.series_name)}</td>
            <td>${escHtml(sessionLabel(s))}</td>
            <td class="mono">${s.planned_start}</td>
            <td>${s.planned_duration_minutes}'</td>
            <td style="white-space:nowrap">${badgesHtml}</td>
            <td class="col-actions" style="white-space:nowrap">
                <button class="btn btn-sm btn-secondary btn-sess-up"   data-id="${s.id}" ${idx === 0 ? 'disabled' : ''}>▲</button>
                <button class="btn btn-sm btn-secondary btn-sess-down" data-id="${s.id}" ${idx === sessions.length - 1 ? 'disabled' : ''}>▼</button>
                <button class="btn btn-sm btn-primary   btn-sess-edit" data-id="${s.id}">Edit</button>
                <button class="btn btn-sm btn-danger    btn-sess-del"  data-id="${s.id}">Delete</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.btn-sess-edit').forEach(btn =>
        btn.addEventListener('click', () => openSessionModal(parseInt(btn.dataset.id, 10))));
    tbody.querySelectorAll('.btn-sess-del').forEach(btn =>
        btn.addEventListener('click', () => deleteSession(parseInt(btn.dataset.id, 10))));
    tbody.querySelectorAll('.btn-sess-up').forEach(btn =>
        btn.addEventListener('click', () => moveSession(parseInt(btn.dataset.id, 10), 'up')));
    tbody.querySelectorAll('.btn-sess-down').forEach(btn =>
        btn.addEventListener('click', () => moveSession(parseInt(btn.dataset.id, 10), 'down')));
}

// ---------------------------------------------------------------------------
// Session reordering
// ---------------------------------------------------------------------------

async function moveSession(sessionId, direction) {
    const idx = currentSessions.findIndex(s => s.id === sessionId);
    if (idx === -1) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= currentSessions.length) return;

    [currentSessions[idx], currentSessions[swapIdx]] = [currentSessions[swapIdx], currentSessions[idx]];
    const order = currentSessions.map((s, i) => ({ id: s.id, sort_order: (i + 1) * 10 }));

    try {
        await RDT.reorderSessions(currentEventId, order);
        currentSessions.forEach((s, i) => { s.sort_order = (i + 1) * 10; });
        const event = await RDT.getEvent(currentEventId);
        renderSessionsTable(currentSessions, event.effective_gfl_minutes || 0);
    } catch (err) {
        showAlert('sessions-alert', `Reorder failed: ${err.message}`, 'danger');
        selectEvent(currentEventId);
    }
}

// ---------------------------------------------------------------------------
// Session modal (add / edit)
// ---------------------------------------------------------------------------

/**
 * Return the next available session number for a given type,
 * based on the current session list. (item 4)
 */
function getNextSessionNumber(type) {
    if (type === 'break') return 1;
    const nums = currentSessions
        .filter(s => s.session_type === type)
        .map(s => s.session_number || 0);
    return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

/**
 * For new sessions, auto-set the type number to the next available. (item 4)
 * Does nothing when editing an existing session.
 */
function updateSessionNumberDefault() {
    if (editingSessionId) return;
    const type = getValue('sess-type');
    if (type !== 'break') {
        setValue('sess-number', getNextSessionNumber(type));
    }
}

async function openSessionModal(sessionId) {
    editingSessionId = sessionId;
    const title = document.getElementById('modal-session-title');

    if (sessionId) {
        // Editing existing session
        const s = currentSessions.find(s => s.id === sessionId);
        if (!s) return;
        title.textContent = 'Edit Session';
        setValue('sess-series',    s.series_name);
        setValue('sess-type',      s.session_type);
        setValue('sess-number',    s.session_number);
        setValue('sess-start',     s.planned_start);
        setValue('sess-duration',  s.planned_duration_minutes);
        setValue('sess-starttype', s.start_type || 'standing');
        setCheck('sess-gfl',       s.has_green_flag_lap);
        setCheck('sess-pits',      s.has_pit_stops);
        setCheck('sess-sc',        s.has_safety_car);
        setCheck('sess-ls',        s.has_live_snatch);
        setValue('sess-notes',     s.session_notes || '');
    } else {
        // Adding new session
        title.textContent = 'Add Session';
        ['sess-series','sess-start','sess-notes'].forEach(id => setValue(id, ''));
        setValue('sess-type',      'race');
        setValue('sess-number',    getNextSessionNumber('race'));   // item 4: auto-increment
        setValue('sess-duration',  '20');
        setValue('sess-starttype', 'standing');
        setCheck('sess-gfl',  true);   // GFL defaults to checked for new race sessions
        setCheck('sess-pits', false);
        setCheck('sess-sc',   true);   // SC defaults to checked where available
        setCheck('sess-ls',   false);
    }

    updateSessionFormVisibility();
    hideAlert('modal-session-alert');
    document.getElementById('session-modal-overlay').classList.remove('hidden');
    document.getElementById('sess-series').focus();
}

function closeSessionModal() {
    document.getElementById('session-modal-overlay').classList.add('hidden');
    editingSessionId = null;
}

/** Return the GFL minutes for the currently-selected layout (0 if none). */
async function getCurrentGflMinutes() {
    const layoutSel = document.getElementById('event-layout');
    const opt = layoutSel?.selectedOptions[0];
    return opt ? parseInt(opt.dataset.gfl, 10) || 0 : 0;
}

/**
 * Show/hide form fields based on session type. (item 1)
 * - Race:       show start-type row (has S/R, GFL, Pits)
 * - Practice/Q: show non-starttype row (GFL, Pits, no S/R)
 * - Break:      hide both; hide session number
 */
function updateSessionFormVisibility() {
    const type    = getValue('sess-type');
    const isRace  = type === 'race';
    const isBreak = type === 'break';

    const raceRow    = document.getElementById('sess-starttype-row');
    const nonRaceRow = document.getElementById('sess-nonstarttype-row');
    const numGroup   = document.getElementById('sess-number-group');

    if (raceRow)    raceRow.classList.toggle('hidden',  !isRace);
    if (nonRaceRow) nonRaceRow.classList.toggle('hidden', isRace || isBreak || type === 'other');
    if (numGroup)   numGroup.classList.toggle('hidden',  isBreak);

    // SC checkbox: race row is always visible for races; show in non-race row only if
    // gfl_on_non_race config is true (and session is practice/qualifying)
    const scNonRaceGroup = document.getElementById('sess-sc-nonrace-group');
    if (scNonRaceGroup) {
        scNonRaceGroup.classList.toggle('hidden',
            isRace || isBreak || type === 'other' || !appConfig.sc_on_non_race);
    }

    // LS checkbox: race/practice/qualifying (not break/other), and only when LS-licensed
    const lsGroup = document.getElementById('sess-ls-group');
    if (lsGroup) lsGroup.classList.toggle('hidden', isBreak || type === 'other' || !liveSnatchAvailable);

    // LS alt checkbox: non-race row equivalent, same conditions but only shown when non-race
    const lsNonRaceGroup = document.getElementById('sess-ls-nonrace-group');
    if (lsNonRaceGroup) {
        lsNonRaceGroup.classList.toggle('hidden', isRace || isBreak || type === 'other' || !liveSnatchAvailable);
    }

    // Update series placeholder to hint at the slot name for breaks
    const seriesInput = document.getElementById('sess-series');
    if (seriesInput) {
        seriesInput.placeholder = isBreak
            ? 'e.g. Lunch, Driver Briefing, Red Mist Cup'
            : 'e.g. Formula Ford 1600, Clio Cup, MINI Challenge';
    }

}

async function saveSession() {
    const sessionType = getValue('sess-type');
    const isBreak = sessionType === 'break';

    const seriesName = getValue('sess-series').trim() || (isBreak ? 'Break' : '');

    const data = {
        event_id:                 currentEventId,
        series_name:              seriesName,
        session_type:             sessionType,
        session_number:           isBreak ? 1 : (parseInt(getValue('sess-number'), 10) || 1),
        planned_start:            getValue('sess-start'),
        planned_duration_minutes: parseInt(getValue('sess-duration'), 10),
        // start_type only meaningful for race sessions
        start_type:               (!isBreak && sessionType === 'race') ? getValue('sess-starttype') : null,
        // GFL only applies to races; practice/qualifying never have a separate formation lap
        has_green_flag_lap:       sessionType === 'race' ? getCheck('sess-gfl') : false,
        has_pit_stops:            (isBreak || sessionType === 'other') ? false : getCheck('sess-pits'),
        has_safety_car:           (sessionType === 'race' || appConfig.sc_on_non_race) && !isBreak && sessionType !== 'other' ? getCheck('sess-sc') : false,
        has_live_snatch:          (isBreak || sessionType === 'other') ? false : getCheck('sess-ls'),
        session_notes:            getValue('sess-notes').trim() || null,
    };

    if (!data.series_name || !data.session_type || !data.planned_start || !data.planned_duration_minutes) {
        showAlert('modal-session-alert', 'Series/name, type, start time and duration are required.', 'warning');
        return;
    }

    const btn = document.getElementById('modal-session-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        if (editingSessionId) {
            await RDT.updateSession(editingSessionId, data);
        } else {
            await RDT.createSession(data);
        }
        closeSessionModal();
        const event = await RDT.getEvent(currentEventId);
        currentSessions = event.sessions || [];
        renderSessionsTable(currentSessions, event.effective_gfl_minutes || 0);
    } catch (err) {
        showAlert('modal-session-alert', `Error: ${err.message}`, 'danger');
    } finally {
        btn.disabled = false; btn.textContent = 'Save Session';
    }
}

async function deleteSession(id) {
    const s = currentSessions.find(s => s.id === id);
    if (!confirm(`Delete ${s ? `${s.series_name} — ${sessionLabel(s)}` : `session #${id}`}?`)) return;
    try {
        await RDT.deleteSession(id);
        currentSessions = currentSessions.filter(s => s.id !== id);
        const gfl = await getCurrentGflMinutes();
        renderSessionsTable(currentSessions, gfl);
    } catch (err) {
        showAlert('sessions-alert', `Could not delete: ${err.message}`, 'danger');
    }
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function sessionLabel(session) {
    if (session.session_type === 'break') return 'Break';
    if (session.session_type === 'other') return 'Other' + (session.session_number || 1);
    const prefixes = { practice: 'FP', qualifying: 'Q', race: 'Race' };
    return `${prefixes[session.session_type] || session.session_type}${session.session_number}`;
}

const getValue = id => (document.getElementById(id) || {}).value || '';
const setValue = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
const getCheck = id => !!(document.getElementById(id) || {}).checked;
const setCheck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showAlert(id, msg, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `alert alert-${type}`;
    el.textContent = msg;
    el.classList.remove('hidden');
    if (type === 'success') setTimeout(() => el.classList.add('hidden'), 4000);
}
function hideAlert(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
}
