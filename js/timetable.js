/**
 * js/timetable.js
 * =============================================================================
 * Main timetable page logic.
 *
 * Timing model
 * ============
 * planned_start = the planned race/session START time (when racing begins).
 *
 * Scheduled:
 *   _schedFinish  = planned_start + planned_duration_minutes
 *   _schedTidy    = next_planned_start − _schedFinish  (gap after this session)
 *
 * Predicted (cascade):
 *   _predStart    = actual_start_time                       if entered
 *              OR   actual_green_flag_time + gfl_minutes    if GFL in progress
 *              OR   prev._predFinish + effTidy              cascade
 *   _predFinish   = actual_finish_time                      if entered
 *              OR   _predStart + effDuration
 *   effDuration   = duration_override_minutes ?? planned_duration_minutes
 *   effTidy       = prev.tidy_override_minutes ?? prev._schedTidy
 *
 * Advised (race sessions only):
 *   _advisedGflStart = _predStart − gfl_minutes  (has_green_flag_lap only)
 *   _advisedGrid     = _advisedGflStart − grid_minutes
 *                   OR _predStart − grid_minutes  (no GFL)
 *
 * Gap:
 *   _variance = _predStart − planned_start        (+ late, − early)
 *   _slip     = _predStart(N) − finish(N-1)        actual tidy achieved
 *   _diff     = _slip − prev._schedTidy            + over, − under scheduled
 *
 * NOTE ON PLANNED_START SEMANTICS
 * ================================
 * planned_start is the session/race start, NOT the formation lap start.
 * For races with a formation lap, the advised GFL start = planned_start − gfl_minutes.
 * If you previously entered planned_start as the GFL start time, update with:
 *   UPDATE sessions s
 *   JOIN events e ON e.id = s.event_id
 *   JOIN circuit_layouts cl ON cl.id = e.circuit_layout_id
 *   SET s.planned_start = ADDTIME(s.planned_start,
 *       SEC_TO_TIME(COALESCE(e.gfl_minutes_override, cl.green_flag_lap_minutes) * 60))
 *   WHERE s.session_type = 'race' AND s.has_green_flag_lap = 1;
 * =============================================================================
 */

'use strict';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let currentEventId     = null;
let currentEvent       = null;
let _weatherSessionId  = null;
let refreshTimer       = null;
let countdownSecs      = 0;
let opsModeActive      = false;
const REFRESH_INTERVAL = 30;
const _dirtyRows       = new Set();

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    currentEventId = params.get('event') ? parseInt(params.get('event'), 10) : null;

    startClock();
    populateEventSelector();

    if (currentEventId) {
        loadEvent(currentEventId);
        scheduleAutoRefresh();
    }

    document.getElementById('event-select').addEventListener('change', e => {
        const id = parseInt(e.target.value, 10);
        if (id) window.location.href = `/?event=${id}`;
    });

    document.getElementById('btn-ops-mode').addEventListener('click', handleOpsModeToggle);
    document.getElementById('btn-refresh').addEventListener('click', () => {
        if (currentEventId) loadEvent(currentEventId);
    });

    const tbody = document.getElementById('session-rows');
    tbody.addEventListener('click', handleTimetableClick);
    tbody.addEventListener('input', handleTimetableInput);

    document.getElementById('wm-cancel').addEventListener('click', closeWeatherModal);
    document.getElementById('wm-save').addEventListener('click', saveWeatherNotes);
    document.getElementById('weather-modal-overlay').addEventListener('click', e => {
        if (e.target === document.getElementById('weather-modal-overlay')) closeWeatherModal();
    });
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------
function startClock() {
    function tick() {
        document.getElementById('clock').textContent = formatTimeHMS(new Date());
        if (currentEvent) updateCurfewPill(currentEvent.curfew_time);
    }
    tick();
    setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
// Auto-refresh
// ---------------------------------------------------------------------------
function scheduleAutoRefresh() {
    countdownSecs = REFRESH_INTERVAL;
    setInterval(() => {
        const el = document.getElementById('next-refresh');
        if (opsModeActive) {
            if (el) el.textContent = 'Auto-refresh paused (Ops Mode)';
            return;
        }
        countdownSecs = Math.max(0, countdownSecs - 1);
        if (el) el.textContent = `Next refresh in ${countdownSecs}s`;
    }, 1000);
    refreshTimer = setInterval(() => {
        if (opsModeActive) return;
        if (currentEventId) loadEvent(currentEventId);
        countdownSecs = REFRESH_INTERVAL;
    }, REFRESH_INTERVAL * 1000);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadEvent(id) {
    const spinner = document.getElementById('refresh-spinner');
    if (spinner) spinner.classList.add('spinning');
    try {
        const freshEvent = await RDT.getEvent(id);
        if (_dirtyRows.size > 0) {
            currentEvent = freshEvent;
            updateHeader(freshEvent);
            return;
        }
        currentEvent = freshEvent;
        renderTimetable(freshEvent);
        updateHeader(freshEvent);
        const el = document.getElementById('last-updated');
        if (el) el.textContent = `Last updated: ${formatTimeHMS(new Date())}`;
    } catch (err) {
        showPageError(`Failed to load timetable: ${err.message}`);
    } finally {
        if (spinner) spinner.classList.remove('spinning');
    }
}

async function populateEventSelector() {
    try {
        const events = await RDT.getEvents();
        const sel = document.getElementById('event-select');
        sel.innerHTML = '<option value="">— select event —</option>';
        events.forEach(ev => {
            const opt = document.createElement('option');
            opt.value = ev.id;
            opt.textContent = `${ev.event_date}  ${ev.name}`;
            if (ev.id === currentEventId) opt.selected = true;
            sel.appendChild(opt);
        });
    } catch (_) { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function updateHeader(event) {
    document.getElementById('event-name').textContent = event.name;
    const layoutStr = event.layout_name
        ? `${event.circuit_name} — ${event.layout_name}`
        : event.circuit_name;
    document.getElementById('event-meta').textContent =
        `${layoutStr} · ${formatDateGB(event.event_date)}`
        + ` · GFL ${event.effective_gfl_minutes}' / Grid ${event.effective_grid_minutes}'`;
    document.title = `${event.name} — Race Day Timetable`;
    updateCurfewPill(event.curfew_time);
}

function updateCurfewPill(curfewTime) {
    const pill = document.getElementById('curfew-pill');
    if (!pill || !curfewTime) return;
    const remaining = timeToMinutes(curfewTime) - nowAsMinutes();
    let label, cls;
    if (remaining < 0) {
        label = `CURFEW PASSED (${formatVariance(Math.abs(remaining))} over)`;
        cls   = 'danger';
    } else if (remaining <= 30) {
        label = `⚠ CURFEW ${curfewTime} — ${remaining} min`;
        cls   = 'warn';
    } else {
        const h = Math.floor(remaining / 60);
        const m = remaining % 60;
        label = `Curfew ${curfewTime} — ${h}h ${m}m`;
        cls   = '';
    }
    pill.textContent = label;
    pill.className   = `status-pill curfew-pill ${cls}`.trim();
}

// ---------------------------------------------------------------------------
// Timetable calculation
// ---------------------------------------------------------------------------

/**
 * Three-pass enrichment:
 *   Pass 1 — scheduled finish and tidy times (forward-only, no cascade)
 *   Pass 2 — predicted times, advised times, status (cascades through sessions)
 *   Pass 3 — slip and diff (requires pass 2 values from both sessions)
 */
function calculateTimetable(sessions, curfewTime, gflMinutes, gridMinutes) {
    const curfewMin = curfewTime ? timeToMinutes(curfewTime) : null;
    const gfl  = gflMinutes  || 0;
    const grid = gridMinutes || 0;

    const enriched = sessions.map(s => Object.assign({}, s));

    // === Pass 1: Scheduled times ===
    enriched.forEach(session => {
        const m = timeToMinutes(session.planned_start);
        session._schedStartMin  = m;
        session._schedFinishMin = m + session.planned_duration_minutes;
        session._schedFinish    = minutesToTime(session._schedFinishMin);
    });

    // Scheduled tidy = next session's planned start − this session's scheduled finish
    enriched.forEach((session, idx) => {
        session._schedTidy = (idx < enriched.length - 1)
            ? enriched[idx + 1]._schedStartMin - session._schedFinishMin
            : null;
    });

    // === Pass 2: Predicted times, advised, status ===
    let prevPredFinishMin = null;

    enriched.forEach((session, idx) => {
        const effDur = session.duration_override_minutes ?? session.planned_duration_minutes;
        session._effectiveDuration = effDur;

        const prev = idx > 0 ? enriched[idx - 1] : null;
        const effTidy = prev
            ? (prev.tidy_override_minutes ?? prev._schedTidy)
            : null;

        // Predicted start
        let predStartMin;
        if (session.actual_start_time) {
            predStartMin = timeToMinutes(session.actual_start_time);
        } else if (session.actual_green_flag_time && session.has_green_flag_lap && gfl > 0) {
            predStartMin = timeToMinutes(session.actual_green_flag_time) + gfl;
        } else if (prevPredFinishMin !== null && effTidy !== null) {
            predStartMin = prevPredFinishMin + effTidy;
        } else {
            predStartMin = session._schedStartMin;
        }
        session._predStartMin = predStartMin;
        session._predStart    = minutesToTime(predStartMin);

        // Predicted finish
        const predFinishMin = session.actual_finish_time
            ? timeToMinutes(session.actual_finish_time)
            : predStartMin + effDur;
        session._predFinishMin = predFinishMin;
        session._predFinish    = minutesToTime(predFinishMin);

        // Cascade:
        // - Active/completed sessions advance by their full finish time.
        // - Cancelled sessions are treated as zero-duration: the slot start
        //   is recorded so the tidy time AFTER the cancelled session still
        //   applies to the next session (freeing only the session duration,
        //   not the turnaround gap).
        prevPredFinishMin = (session.status === 'cancelled')
            ? predStartMin        // preserve slot position, drop only the duration
            : predFinishMin;      // normal advance

        // Advised times — race sessions only
        if (session.session_type === 'race') {
            if (session.has_green_flag_lap && gfl > 0) {
                session._advisedGflStart = minutesToTime(predStartMin - gfl);
                if (grid > 0) session._advisedGrid = minutesToTime(predStartMin - gfl - grid);
            } else if (grid > 0) {
                session._advisedGrid = minutesToTime(predStartMin - grid);
            }
        }

        // Variance
        session._variance = predStartMin - session._schedStartMin;

        // Status
        if (session.status === 'cancelled') {
            session._status = 'cancelled';
        } else if (session.status === 'red_flagged') {
            session._status = 'red_flagged';
        } else if (session.actual_finish_time) {
            session._status = 'completed';
        } else if (session.actual_start_time || session.status === 'active') {
            session._status = 'race_active';
        } else if (session.actual_green_flag_time && session.has_green_flag_lap) {
            session._status = 'gfl_active';
        } else {
            session._status = 'pending';
        }

        // Curfew proximity (positive = mins before curfew, negative = past)
        if (curfewMin !== null) {
            session._curfewGap = curfewMin - predFinishMin;
            if (session._curfewGap < 0) session._pastCurfew = true;
        }
    });

    // === Pass 3: Slip and Diff ===
    enriched.forEach((session, idx) => {
        if (idx === 0 || enriched[idx - 1]._status === 'cancelled') return;
        const prev = enriched[idx - 1];
        const prevFinishMin = prev.actual_finish_time
            ? timeToMinutes(prev.actual_finish_time)
            : prev._predFinishMin;
        if (prevFinishMin !== null) {
            session._slip = session._predStartMin - prevFinishMin;
            if (prev._schedTidy !== null) {
                session._diff = session._slip - prev._schedTidy;
            }
        }
    });

    // Running delay = variance of last non-cancelled session
    const active = enriched.filter(s => s._status !== 'cancelled');
    const runningDelay = active.length > 0 ? active[active.length - 1]._variance : 0;

    return { sessions: enriched, runningDelay };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderTimetable(event) {
    const gfl  = event.effective_gfl_minutes  || 0;
    const grid = event.effective_grid_minutes || 0;
    const { sessions, runningDelay } = calculateTimetable(
        event.sessions, event.curfew_time, gfl, grid
    );

    const tbody = document.getElementById('session-rows');
    tbody.innerHTML = '';
    let rowNum = 0;
    sessions.forEach(session => {
        if (session.session_type !== 'break') rowNum++;
        tbody.appendChild(buildSessionRow(session, rowNum));
    });

    updateVariancePill(runningDelay);
    const emptyMsg = document.getElementById('empty-message');
    if (emptyMsg) emptyMsg.classList.toggle('hidden', sessions.length > 0);
}

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------
/**
 * Column order (22 columns):
 *   # | Series | Session | Flags | Mins
 *   [Scheduled: Start | Finish | Tidy]
 *   [Actual:    Dur | GFL | Start | Finish]
 *   [Advised:   Grid | GFL]
 *   [Predicted: Start | Finish]
 *   [Gap:       Var | Slip | Diff]
 *   Tidy Ovr | Status | Ops
 */
function buildSessionRow(session, rowNum) {
    const tr = document.createElement('tr');
    tr.className = rowClass(session);
    tr.dataset.sessionId = session.id;

    const td = (html, cls = '') => {
        const el = document.createElement('td');
        el.className = cls;
        el.innerHTML = html;
        return el;
    };

    const isBreak = session.session_type === 'break';
    const isRace  = session.session_type === 'race';

    // Identity
    tr.appendChild(td(isBreak ? '' : rowNum, 'col-num'));
    tr.appendChild(td(escHtml(session.series_name), 'col-series'));
    tr.appendChild(td(escHtml(sessionLabel(session)), 'col-session'));
    tr.appendChild(buildFlagsCell(session));
    tr.appendChild(td(`${session.planned_duration_minutes}'`, 'col-mins'));

    // Scheduled group
    tr.appendChild(td(session.planned_start || '—', 'col-sched-start'));
    tr.appendChild(td(session._schedFinish  || '—', 'col-sched-finish'));
    tr.appendChild(td(
        session._schedTidy != null ? `${session._schedTidy}'` : '—',
        'col-sched-tidy'
    ));

    // Override group (inputs in ops mode)
    tr.appendChild(buildDurOvrCell(session));
    tr.appendChild(buildTidyOvrCell(session));

    // Actual group (inputs in ops mode)
    tr.appendChild(buildActGridCell(session));
    tr.appendChild(buildActGflCell(session));
    tr.appendChild(buildActStartCell(session));
    tr.appendChild(buildActFinishCell(session));

    // Advised group
    tr.appendChild(td(
        session._advisedGrid     || '',
        'col-adv-grid'
    ));
    tr.appendChild(td(
        session._advisedGflStart || '',
        'col-adv-gfl'
    ));

    // Predicted group
    tr.appendChild(buildPredStartCell(session));
    tr.appendChild(buildPredFinishCell(session));

    // Gap group
    tr.appendChild(buildVarCell(session));
    tr.appendChild(buildGapNumCell(session._slip, 'col-slip', false));
    tr.appendChild(buildGapNumCell(session._diff, 'col-diff', true));

    // Status
    tr.appendChild(td(statusChip(session), 'col-status'));

    // Ops
    tr.appendChild(buildOpsCell(session));

    return tr;
}

// ---------------------------------------------------------------------------
// Cell builders
// ---------------------------------------------------------------------------

function buildFlagsCell(session) {
    const el = document.createElement('td');
    el.className = 'col-badges';
    if (session.session_type === 'break' || session.session_type === 'other' || session.session_type === 'warmup') { el.textContent = ''; return el; }
    const parts = [];
    if (session.session_type === 'race') {
        if (session.start_type === 'rolling') {
            parts.push('<span class="badge badge-rolling" title="Rolling start">R</span>');
        } else if (session.start_type === 'standing') {
            parts.push('<span class="badge badge-standing" title="Standing start">S</span>');
        }
    }
    if (session.has_green_flag_lap) {
        parts.push('<span class="badge badge-yes" title="Formation lap">GFL</span>');
    }
    if (session.has_pit_stops) {
        parts.push('<span class="badge badge-pits" title="Pit stops">Pit</span>');
    }
    if (session.has_safety_car) {
        parts.push('<span class="badge badge-sc" title="Safety car">SC</span>');
    }
    if (session.has_live_snatch) {
        parts.push('<span class="badge badge-ls" title="Live snatch">LS</span>');
    }
    el.innerHTML = parts.length ? parts.join(' ') : '—';
    return el;
}

function buildDurOvrCell(session) {
    const el = document.createElement('td');
    el.className = 'col-dur-ovr';
    el.dataset.col = 'dur-ovr';
    const ovr = session.duration_override_minutes;
    const disp = ovr != null
        ? `<span class="plan-val">${session.planned_duration_minutes}'</span>${ovr}'`
        : '';
    el.innerHTML = `<span class="cell-disp">${disp}</span>`
        + `<input type="number" class="ops-field ops-dur-field" data-field="dur_override"`
        + ` min="1" max="999" placeholder="${session.planned_duration_minutes}"`
        + ` value="${ovr != null ? ovr : ''}">`;
    return el;
}

const NOW_BTN = '<button type="button" class="btn-now" title="Set to current time">⏱</button>';

function buildActGridCell(session) {
    const el = document.createElement('td');
    el.className = 'col-act-grid';
    el.dataset.col = 'act-grid';
    if (session.session_type !== 'race') {
        el.innerHTML = '<span class="cell-disp na-val"></span>';
        return el;
    }
    const val = session.actual_grid_time || '';
    el.innerHTML = `<span class="cell-disp">${val}</span>`
        + `<input type="time" class="ops-field" data-field="grid_time" value="${val}">${NOW_BTN}`;
    return el;
}

function buildActGflCell(session) {
    const el = document.createElement('td');
    el.className = 'col-act-gfl';
    el.dataset.col = 'act-gfl';
    if (!session.has_green_flag_lap) {
        el.innerHTML = '<span class="cell-disp na-val"></span>';
        return el;
    }
    const val = session.actual_green_flag_time || '';
    el.innerHTML = `<span class="cell-disp">${val}</span>`
        + `<input type="time" class="ops-field" data-field="gfl_time" value="${val}">${NOW_BTN}`;
    return el;
}

function buildActStartCell(session) {
    const el = document.createElement('td');
    el.className = 'col-act-start';
    el.dataset.col = 'act-start';
    const val = session.actual_start_time || '';
    el.innerHTML = `<span class="cell-disp">${val}</span>`
        + `<input type="time" class="ops-field" data-field="start_time" value="${val}">${NOW_BTN}`;
    return el;
}

function buildActFinishCell(session) {
    const el = document.createElement('td');
    el.className = 'col-act-finish';
    el.dataset.col = 'act-finish';
    const val = session.actual_finish_time || '';
    el.innerHTML = `<span class="cell-disp">${val}</span>`
        + `<input type="time" class="ops-field" data-field="finish_time" value="${val}">${NOW_BTN}`;
    return el;
}

function buildPredStartCell(session) {
    const el = document.createElement('td');
    el.className = 'col-pred-start';
    el.dataset.col = 'pred-start';
    const pred  = session._predStart;
    const sched = session.planned_start;
    let html;
    if (session.actual_start_time) {
        html = `<strong>${session.actual_start_time}</strong>`;
    } else if (pred && pred !== sched) {
        const cls = session._variance > 0 ? 'pred-time late' : 'pred-time early';
        html = `<span class="${cls}">${pred}</span>`;
    } else {
        html = pred || sched || '—';
    }
    el.innerHTML = html;
    return el;
}

function buildPredFinishCell(session) {
    const el = document.createElement('td');
    el.className = 'col-pred-finish';
    el.dataset.col = 'pred-finish';
    const pred  = session._predFinish;
    const sched = session._schedFinish;
    let html;
    if (session.actual_finish_time) {
        html = `<strong>${session.actual_finish_time}</strong>`;
    } else if (pred && pred !== sched) {
        const cls = session._variance > 0 ? 'pred-time late' : 'pred-time early';
        html = `<span class="${cls}">${pred}</span>`;
    } else {
        html = pred || '—';
    }
    el.innerHTML = html;
    // Curfew proximity shading for upcoming/active sessions
    const upcoming = session._status !== 'completed'
                  && session._status !== 'cancelled'
                  && session._status !== 'red_flagged';
    if (upcoming && session._curfewGap !== undefined) {
        const bg = curfewBg(session._curfewGap);
        if (bg) el.style.background = bg;
    }
    return el;
}

function buildVarCell(session) {
    const el = document.createElement('td');
    el.className = 'col-var';
    const v = session._variance;
    if (session._status === 'cancelled' || v === undefined || v === null) {
        el.textContent = '—';
        return el;
    }
    const r = Math.round(v);
    el.textContent = r === 0 ? '0' : (r > 0 ? `+${r}` : `${r}`);

    const upcoming = session._status === 'pending'
                  || session._status === 'race_active'
                  || session._status === 'gfl_active';
    if (!upcoming) return el;

    if (v < 0) {
        // Early: discrete text colour bands, no background
        const abs = Math.abs(r);
        el.style.color      = abs <= 15 ? '#166534'
                            : abs <= 20 ? '#92400e'
                                        : '#991b1b';
        el.style.fontWeight = '600';
    } else if (v > 0) {
        // Late: amber→red background gradient over 1–45 mins, dark text
        const t = Math.min(Math.max(v - 1, 0) / 44, 1);
        const [rr, gg, bb] = lerpRgb([245, 158, 11], [220, 38, 38], t);
        el.style.background = `rgba(${rr},${gg},${bb},0.40)`;
        el.style.color      = '#1a1a1a';
    }
    // v === 0: no styling — on time needs no signal
    return el;
}

/** Shared builder for Slip and Diff cells (signed integer minutes). */
function buildGapNumCell(val, cls, colorCode) {
    const el = document.createElement('td');
    el.className = cls;
    if (val === undefined || val === null) {
        el.innerHTML = '—';
        return el;
    }
    const r = Math.round(val);
    if (colorCode) {
        // Diff: + = tidy took longer than scheduled (bad), − = faster (good)
        if (Math.abs(r) < 1) {
            el.innerHTML = '<span style="color:var(--clr-success)">0</span>';
        } else if (r > 0) {
            el.innerHTML = `<span class="var-late-minor">+${r}</span>`;
        } else {
            el.innerHTML = `<span class="var-early">${r}</span>`;
        }
    } else {
        el.innerHTML = r >= 0 ? `+${r}` : `${r}`;
    }
    return el;
}

function buildTidyOvrCell(session) {
    const el = document.createElement('td');
    el.className = 'col-tidy-ovr';
    el.dataset.col = 'tidy-ovr';
    const ovr   = session.tidy_override_minutes;
    const sched = session._schedTidy;
    let disp = '';
    if (ovr != null) {
        disp = sched != null
            ? `<span class="plan-val">${sched}'</span>${ovr}'`
            : `${ovr}'`;
    }
    el.innerHTML = `<span class="cell-disp">${disp}</span>`
        + `<input type="number" class="ops-field ops-tidy-field" data-field="tidy_override"`
        + ` min="0" max="120" placeholder="${sched != null ? sched : ''}"`
        + ` value="${ovr != null ? ovr : ''}">`;
    return el;
}

function buildOpsCell(session) {
    const el = document.createElement('td');
    el.className = 'col-ops';
    const statuses = [
        ['pending',    'Pending'],
        ['active',     'Active'],
        ['completed',  'Completed'],
        ['red_flagged','Red Flag'],
        ['cancelled',  'Cancelled'],
    ];
    const opts = statuses.map(([v, l]) =>
        `<option value="${v}"${session.status === v ? ' selected' : ''}>${l}</option>`
    ).join('');
    el.innerHTML = `
        <div class="ops-controls">
            <div class="ops-btn-row">
                <select class="ops-field ops-status-select" data-field="status">${opts}</select>
                <button class="btn btn-sm btn-success btn-update-row">Update</button>
                <button class="btn btn-sm btn-secondary btn-notes-row" title="Session notes">📝</button>
            </div>
        </div>`;
    return el;
}

// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------
function handleTimetableClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.classList.contains('btn-update-row')) {
        const tr = btn.closest('tr');
        if (tr) saveInlineActuals(parseInt(tr.dataset.sessionId, 10), tr);
    }
    if (btn.classList.contains('btn-notes-row')) {
        const tr = btn.closest('tr');
        if (tr) openWeatherModal(parseInt(tr.dataset.sessionId, 10));
    }
    if (btn.classList.contains('btn-now')) {
        const input = btn.previousElementSibling;
        if (input && input.type === 'time') {
            const now = new Date();
            input.value = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
}

function handleTimetableInput(e) {
    if (!RDT.isOpsMode()) return;
    const input = e.target;
    if (!input.matches('.ops-field, [data-field]')) return;
    const tr = input.closest('tr');
    if (!tr || !tr.dataset.sessionId) return;
    const id = parseInt(tr.dataset.sessionId, 10);
    _dirtyRows.add(id);
    tr.classList.add('ops-dirty');
    showUnsavedBanner(true);
    // Live ripple on duration or tidy override changes
    if (input.dataset.field === 'dur_override' || input.dataset.field === 'tidy_override') {
        recalculatePreview();
    }
}

// ---------------------------------------------------------------------------
// Live preview recalculation
// ---------------------------------------------------------------------------
function recalculatePreview() {
    if (!currentEvent) return;
    const tbody = document.getElementById('session-rows');
    if (!tbody) return;

    const gfl  = currentEvent.effective_gfl_minutes  || 0;
    const grid = currentEvent.effective_grid_minutes || 0;

    // Build session list incorporating current in-form overrides
    const modifiedSessions = currentEvent.sessions.map(s => {
        const row     = tbody.querySelector(`tr[data-session-id="${s.id}"]`);
        if (!row) return s;
        const durVal  = row.querySelector('[data-field="dur_override"]')?.value.trim();
        const tidyVal = row.querySelector('[data-field="tidy_override"]')?.value.trim();
        const overrides = {};
        if (durVal  && !isNaN(parseInt(durVal,  10))) overrides.duration_override_minutes = parseInt(durVal,  10);
        if (tidyVal && !isNaN(parseInt(tidyVal, 10))) overrides.tidy_override_minutes     = parseInt(tidyVal, 10);
        return Object.keys(overrides).length ? Object.assign({}, s, overrides) : s;
    });

    const { sessions } = calculateTimetable(modifiedSessions, currentEvent.curfew_time, gfl, grid);

    sessions.forEach(session => {
        const row = tbody.querySelector(`tr[data-session-id="${session.id}"]`);
        if (!row) return;

        // Predicted start / finish
        const psCell = row.querySelector('.col-pred-start');
        if (psCell) psCell.innerHTML = buildPredStartCell(session).innerHTML;
        const pfCell = row.querySelector('.col-pred-finish');
        if (pfCell) pfCell.innerHTML = buildPredFinishCell(session).innerHTML;

        // Advised
        const agCell = row.querySelector('.col-adv-grid');
        if (agCell) agCell.textContent = session._advisedGrid     || '';
        const afCell = row.querySelector('.col-adv-gfl');
        if (afCell) afCell.textContent = session._advisedGflStart || '';

        // Gap
        const varCell = row.querySelector('.col-var');
        if (varCell) {
            const r = buildVarCell(session);
            varCell.innerHTML  = r.innerHTML;
            varCell.className  = r.className;
        }
        const slipCell = row.querySelector('.col-slip');
        if (slipCell) slipCell.innerHTML = buildGapNumCell(session._slip, 'col-slip', false).innerHTML;
        const diffCell = row.querySelector('.col-diff');
        if (diffCell) diffCell.innerHTML = buildGapNumCell(session._diff, 'col-diff', true).innerHTML;

        if (session._pastCurfew) row.classList.add('row-past-curfew');
        else                     row.classList.remove('row-past-curfew');
    });
}

// ---------------------------------------------------------------------------
// Inline save
// ---------------------------------------------------------------------------
async function saveInlineActuals(sessionId, tr) {
    if (!RDT.isOpsMode()) return;

    const gflInput    = tr.querySelector('[data-field="gfl_time"]');
    const gridInput   = tr.querySelector('[data-field="grid_time"]');
    const startInput  = tr.querySelector('[data-field="start_time"]');
    const durInput    = tr.querySelector('[data-field="dur_override"]');
    const finishInput = tr.querySelector('[data-field="finish_time"]');
    const tidyInput   = tr.querySelector('[data-field="tidy_override"]');
    const statusSel   = tr.querySelector('[data-field="status"]');

    const cached  = currentEvent?.sessions?.find(s => s.id === sessionId);
    const durVal  = durInput?.value.trim();
    const tidyVal = tidyInput?.value.trim();

    const data = {
        status:                    statusSel?.value   || 'pending',
        actual_grid_time:          gridInput?.value   || null,
        actual_green_flag_time:    gflInput?.value    || null,
        actual_start_time:         startInput?.value  || null,
        duration_override_minutes: durVal  ? parseInt(durVal,  10) : null,
        tidy_override_minutes:     tidyVal ? parseInt(tidyVal, 10) : null,
        actual_finish_time:        finishInput?.value || null,
        weather_notes:             cached?.weather_notes        || null,
        track_condition_end:       cached?.track_condition_end  || null,
    };

    const updateBtn = tr.querySelector('.btn-update-row');
    if (updateBtn) { updateBtn.disabled = true; updateBtn.textContent = '…'; }

    try {
        await RDT.updateActuals(sessionId, data);
        _dirtyRows.delete(sessionId);
        tr.classList.remove('ops-dirty');
        if (_dirtyRows.size === 0) showUnsavedBanner(false);
        await loadEvent(currentEventId);
    } catch (err) {
        showPageError(`Save failed for session ${sessionId}: ${err.message}`);
        if (updateBtn) { updateBtn.disabled = false; updateBtn.textContent = 'Update'; }
    }
}

// ---------------------------------------------------------------------------
// Weather / session notes modal
// ---------------------------------------------------------------------------
function openWeatherModal(sessionId) {
    if (!RDT.isOpsMode()) return;
    _weatherSessionId = sessionId;
    const s = currentEvent?.sessions?.find(s => s.id === sessionId);
    if (!s) return;
    document.getElementById('wm-title').textContent =
        `Notes — ${escHtml(s.series_name)} ${sessionLabel(s)}`;
    document.getElementById('wm-session-info').textContent =
        `${s.planned_start} · ${s.planned_duration_minutes} min · ${s.session_type}`;
    setValue('wm-track-condition', s.track_condition_end || '');
    setValue('wm-notes', s.weather_notes || '');
    hideEl('wm-error');
    document.getElementById('weather-modal-overlay').classList.remove('hidden');
    document.getElementById('wm-notes').focus();
}

function closeWeatherModal() {
    document.getElementById('weather-modal-overlay').classList.add('hidden');
    _weatherSessionId = null;
}

async function saveWeatherNotes() {
    if (!_weatherSessionId || !RDT.isOpsMode()) return;
    const s = currentEvent?.sessions?.find(s => s.id === _weatherSessionId);
    const saveBtn = document.getElementById('wm-save');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    hideEl('wm-error');
    const data = {
        status:                    s?.status                    || 'pending',
        actual_grid_time:          s?.actual_grid_time          || null,
        actual_green_flag_time:    s?.actual_green_flag_time    || null,
        actual_start_time:         s?.actual_start_time         || null,
        actual_finish_time:        s?.actual_finish_time        || null,
        duration_override_minutes: s?.duration_override_minutes ?? null,
        tidy_override_minutes:     s?.tidy_override_minutes     ?? null,
        track_condition_end:       getValue('wm-track-condition') || null,
        weather_notes:             getValue('wm-notes')           || null,
    };
    try {
        await RDT.updateActuals(_weatherSessionId, data);
        closeWeatherModal();
        await loadEvent(currentEventId);
    } catch (err) {
        showEl('wm-error', err.message);
    } finally {
        saveBtn.disabled = false; saveBtn.textContent = 'Save Notes';
    }
}

// ---------------------------------------------------------------------------
// Ops mode
// ---------------------------------------------------------------------------
async function handleOpsModeToggle() {
    if (RDT.isOpsMode()) {
        RDT.clearPin();
        opsModeActive = false;
        document.body.classList.remove('ops-active');
        const btn = document.getElementById('btn-ops-mode');
        btn.textContent = 'Ops Mode';
        btn.classList.remove('active');
        _dirtyRows.clear();
        showUnsavedBanner(false);
        // Resume countdown from now
        countdownSecs = REFRESH_INTERVAL;
        return;
    }
    const pin = prompt('Enter Operations PIN:');
    if (!pin) return;
    try {
        const ok = await RDT.verifyPin(pin);
        if (ok) {
            opsModeActive = true;
            document.body.classList.add('ops-active');
            const btn = document.getElementById('btn-ops-mode');
            btn.textContent = 'Ops Mode: ACTIVE (click to exit)';
            btn.classList.add('active');
        } else {
            alert('Incorrect PIN.  Ops mode not activated.');
        }
    } catch (err) {
        alert(`Error verifying PIN: ${err.message}`);
    }
}

// ---------------------------------------------------------------------------
// Status / variance helpers
// ---------------------------------------------------------------------------
/** Linear interpolation between two RGB triples. */
function lerpRgb(from, to, t) {
    return [
        Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t),
    ];
}


/**
 * Background colour for the predicted finish cell when near/past curfew.
 * Returns null if more than 20 mins before curfew.
 * Amber at 20 mins, deepening to red at and beyond curfew.
 */
function curfewBg(gap) {
    if (gap > 20) return null;
    const t = Math.max(0, Math.min(gap / 20, 1));   // 1 = 20 mins away, 0 = at/past curfew
    const [r, g, b] = lerpRgb([220, 38, 38], [217, 119, 6], t); // red → amber
    return `rgba(${r},${g},${b},0.32)`;
}

function rowClass(session) {
    if (session._status === 'completed')   return 'row-completed';
    if (session._status === 'race_active') return 'row-active';
    if (session._status === 'gfl_active')  return 'row-active';
    if (session._status === 'cancelled')   return 'row-cancelled';
    if (session.status  === 'red_flagged') return 'row-red-flagged';
    return '';
}

function statusChip(session) {
    const map = {
        completed:   ['chip-completed',   'Done'],
        race_active: ['chip-active',      'ACTIVE'],
        gfl_active:  ['chip-active',      'GFL'],
        cancelled:   ['chip-cancelled',   'Cancelled'],
        red_flagged: ['chip-red-flagged', 'Red Flag'],
        pending:     ['chip-pending',     'Pending'],
    };
    const [cls, label] = map[session._status] || ['chip-pending', 'Pending'];
    let html = `<span class="status-chip ${cls}">${label}</span>`;
    if (session._status === 'completed' && session.track_condition_end) {
        const condCls   = session.track_condition_end === 'wet' ? 'badge-track-wet' : 'badge-track-dry';
        const condLabel = session.track_condition_end === 'wet' ? 'Wet' : 'Dry';
        html += ` <span class="badge ${condCls}" title="Track condition at end of session">${condLabel}</span>`;
    }
    return html;
}

function sessionLabel(session) {
    if (session.session_type === 'break')  return '';
    if (session.session_type === 'other')  return 'Other'  + (session.session_number || 1);
    if (session.session_type === 'warmup') return 'WU' + (session.session_number || 1);
    const prefixes = { practice: 'FP', qualifying: 'Q', race: 'Race' };
    return `${prefixes[session.session_type] || session.session_type}${session.session_number}`;
}

function updateVariancePill(runningDelay) {
    const pill = document.getElementById('variance-pill');
    if (!pill) return;
    const abs = Math.abs(Math.round(runningDelay));
    let text, cls;
    if (abs < 2) {
        text = 'Running on time'; cls = 'on-time';
    } else if (runningDelay > 0) {
        text = `Running +${abs} min late`;
        cls  = runningDelay > 20 ? 'late-major' : 'late-minor';
    } else {
        text = `Running ${abs} min early`; cls = 'early';
    }
    pill.textContent = text;
    pill.className   = `status-pill ${cls}`;
}

// ---------------------------------------------------------------------------
// Unsaved banner / error helpers
// ---------------------------------------------------------------------------
function showUnsavedBanner(show) {
    const el = document.getElementById('unsaved-banner');
    if (el) el.classList.toggle('hidden', !show);
}

function showPageError(msg) {
    const el = document.getElementById('page-error');
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function showEl(id, msg) {
    const el = document.getElementById(id);
    if (el) { if (msg !== undefined) el.textContent = msg; el.classList.remove('hidden'); }
}
function hideEl(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Time utilities
// ---------------------------------------------------------------------------
function timeToMinutes(t) {
    if (!t) return null;
    const parts = String(t).split(':').map(Number);
    return parts[0] * 60 + (parts[1] || 0);
}

function minutesToTime(m) {
    if (m === null || m === undefined) return '';
    const total = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function nowAsMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
}

function formatTimeHMS(date) {
    return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map(n => String(n).padStart(2, '0')).join(':');
}

function formatVariance(v) {
    const r = Math.round(v);
    return r > 0 ? `+${r} min` : `${r} min`;
}

function formatDateGB(iso) {
    if (!iso) return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${months[m - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const getValue = id => (document.getElementById(id) || {}).value || '';
const setValue = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
