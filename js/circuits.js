/**
 * js/circuits.js
 * =============================================================================
 * Circuit and layout management page logic.
 *
 * Allows the Clerk of the Course to:
 *  - Add, edit and delete circuits (venues) with their default curfew times
 *  - Add, edit and delete circuit layouts (e.g. GP, National, Indy)
 *    each with its own green flag lap duration and grid assembly time
 * =============================================================================
 */

'use strict';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    await ensurePin();
    await loadCircuits();

    document.getElementById('circuit-save-btn').addEventListener('click', saveCircuit);
    document.getElementById('circuit-list-body').addEventListener('click', handleCircuitListClick);
    document.getElementById('layout-save-btn').addEventListener('click', saveLayout);
    document.getElementById('layout-cancel-btn').addEventListener('click', cancelLayoutEdit);
});

// ---------------------------------------------------------------------------
// PIN management
// ---------------------------------------------------------------------------

async function ensurePin() {
    if (RDT.isOpsMode()) return;
    while (true) {
        const pin = prompt('Circuit management requires the Operations PIN.\nEnter PIN (or Cancel to go back):');
        if (!pin) { window.location.href = '/setup.html'; return; }
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
// Circuits
// ---------------------------------------------------------------------------

async function loadCircuits() {
    try {
        const circuits = await RDT.getCircuits();
        renderCircuitManagement(circuits);
    } catch (err) {
        showAlert('setup-alert', `Failed to load circuits: ${err.message}`, 'danger');
    }
}

function renderCircuitManagement(circuitList) {
    const tbody = document.getElementById('circuit-list-body');
    tbody.innerHTML = '';

    circuitList.forEach(c => {
        // Circuit header row
        const tr = document.createElement('tr');
        tr.className = 'circuit-header-row';
        tr.innerHTML = `
            <td colspan="3" style="background:var(--clr-primary-light);padding:.4rem .75rem">
                <strong>${escHtml(c.name)}</strong>
                <span style="font-size:.8rem;color:var(--clr-text-muted)"> — curfew ${c.default_curfew_time}</span>
                <span style="float:right;display:flex;gap:.4rem">
                    <button class="btn btn-sm btn-secondary btn-edit-circuit"
                            data-id="${c.id}" data-name="${escHtml(c.name)}"
                            data-curfew="${c.default_curfew_time}">Edit Circuit</button>
                    <button class="btn btn-sm btn-danger btn-del-circuit"
                            data-id="${c.id}">Delete</button>
                    <button class="btn btn-sm btn-primary btn-add-layout"
                            data-circuit-id="${c.id}" data-circuit-name="${escHtml(c.name)}">+ Layout</button>
                </span>
            </td>
        `;
        tbody.appendChild(tr);

        // Layout rows
        if (c.layouts && c.layouts.length > 0) {
            c.layouts.forEach(l => {
                const lr = document.createElement('tr');
                lr.className = 'layout-row';
                lr.innerHTML = `
                    <td style="padding:.3rem .75rem .3rem 2rem;color:var(--clr-text-muted);font-size:.85rem">
                        ${escHtml(l.layout_name)}
                    </td>
                    <td style="padding:.3rem .5rem;font-size:.85rem">
                        <span class="mono">GFL ${l.green_flag_lap_minutes} min / Grid ${l.grid_minutes || 5} min</span>
                    </td>
                    <td style="padding:.3rem .5rem">
                        <button class="btn btn-sm btn-secondary btn-edit-layout"
                                data-id="${l.id}" data-circuit-id="${c.id}"
                                data-name="${escHtml(l.layout_name)}"
                                data-gfl="${l.green_flag_lap_minutes}"
                                data-grid="${l.grid_minutes || 5}">Edit</button>
                        <button class="btn btn-sm btn-danger btn-del-layout"
                                data-id="${l.id}" data-name="${escHtml(l.layout_name)}">Delete</button>
                    </td>
                `;
                tbody.appendChild(lr);
            });
        } else {
            const empty = document.createElement('tr');
            empty.innerHTML = `<td colspan="3" style="padding:.3rem .75rem 0.3rem 2rem;font-size:.82rem;color:var(--clr-text-muted)">No layouts defined yet — add at least one.</td>`;
            tbody.appendChild(empty);
        }
    });
}

async function handleCircuitListClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.classList.contains('btn-edit-circuit')) {
        setValue('circuit-name-input',   btn.dataset.name);
        setValue('circuit-curfew-input', btn.dataset.curfew);
        document.getElementById('circuit-save-btn').dataset.editId = btn.dataset.id;
        document.getElementById('circuit-name-input').focus();
    }

    if (btn.classList.contains('btn-del-circuit')) {
        if (!confirm('Delete this circuit and all its layouts?\nLayouts in use by events cannot be deleted.')) return;
        try {
            await RDT.deleteCircuit(btn.dataset.id);
            await loadCircuits();
            showAlert('circuit-alert', 'Circuit deleted.', 'success');
        } catch (err) {
            showAlert('circuit-alert', `Could not delete: ${err.message}`, 'danger');
        }
    }

    if (btn.classList.contains('btn-add-layout')) {
        showLayoutForm(parseInt(btn.dataset.circuitId, 10), btn.dataset.circuitName, null);
    }

    if (btn.classList.contains('btn-edit-layout')) {
        showLayoutForm(
            parseInt(btn.dataset.circuitId, 10),
            null,
            { id: parseInt(btn.dataset.id, 10), layout_name: btn.dataset.name,
              gfl: parseInt(btn.dataset.gfl, 10), grid: parseInt(btn.dataset.grid, 10) || 5 }
        );
    }

    if (btn.classList.contains('btn-del-layout')) {
        if (!confirm(`Delete layout "${btn.dataset.name}"?`)) return;
        try {
            await RDT.deleteLayout(btn.dataset.id);
            await loadCircuits();
            showAlert('circuit-alert', 'Layout deleted.', 'success');
        } catch (err) {
            showAlert('circuit-alert', `Could not delete: ${err.message}`, 'danger');
        }
    }
}

async function saveCircuit() {
    const name   = getValue('circuit-name-input').trim();
    const curfew = getValue('circuit-curfew-input').trim();
    if (!name || !curfew) {
        showAlert('circuit-alert', 'Circuit name and curfew time are required.', 'warning');
        return;
    }
    const btn    = document.getElementById('circuit-save-btn');
    const editId = btn.dataset.editId;
    try {
        if (editId) {
            await RDT.updateCircuit(editId, { name, default_curfew_time: curfew });
            delete btn.dataset.editId;
        } else {
            await RDT.createCircuit({ name, default_curfew_time: curfew });
        }
        setValue('circuit-name-input', '');
        setValue('circuit-curfew-input', '');
        await loadCircuits();
        showAlert('circuit-alert', 'Circuit saved.', 'success');
    } catch (err) {
        showAlert('circuit-alert', `Error: ${err.message}`, 'danger');
    }
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

function showLayoutForm(circuitId, circuitName, existing) {
    const form = document.getElementById('layout-form');
    form.classList.remove('hidden');
    form.dataset.circuitId = circuitId;
    form.dataset.editId    = existing ? existing.id : '';

    const label = document.getElementById('layout-form-label');
    if (label) {
        label.textContent = existing
            ? 'Edit layout'
            : `Add layout${circuitName ? ' for ' + circuitName : ''}`;
    }
    setValue('layout-name-input', existing ? existing.layout_name : '');
    setValue('layout-gfl-input',  existing ? existing.gfl         : '2');
    setValue('layout-grid-input', existing ? (existing.grid || 5)  : '5');
    document.getElementById('layout-name-input').focus();
    hideAlert('circuit-alert');
}

function cancelLayoutEdit() {
    document.getElementById('layout-form').classList.add('hidden');
}

async function saveLayout() {
    const form       = document.getElementById('layout-form');
    const circuitId  = parseInt(form.dataset.circuitId, 10);
    const editId     = form.dataset.editId ? parseInt(form.dataset.editId, 10) : null;
    const layoutName = getValue('layout-name-input').trim();
    const gfl        = parseInt(getValue('layout-gfl-input'),  10) || 2;
    const grid       = parseInt(getValue('layout-grid-input'), 10) || 5;

    if (!layoutName) {
        showAlert('circuit-alert', 'Layout name is required.', 'warning');
        return;
    }

    try {
        if (editId) {
            await RDT.updateLayout(editId, { layout_name: layoutName, green_flag_lap_minutes: gfl, grid_minutes: grid });
        } else {
            await RDT.createLayout({ circuit_id: circuitId, layout_name: layoutName, green_flag_lap_minutes: gfl, grid_minutes: grid });
        }
        cancelLayoutEdit();
        await loadCircuits();
        showAlert('circuit-alert', 'Layout saved.', 'success');
    } catch (err) {
        showAlert('circuit-alert', `Error: ${err.message}`, 'danger');
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const getValue = id => (document.getElementById(id) || {}).value || '';
const setValue = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };

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
