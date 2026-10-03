import {
  applyOp, initialState, getStats, validateState, syncAssignments,
  personById, roomById, slotById, assignmentLabel, roomCapacity, roomOccupancy,
  ROOM_MODES, PlanError, clone
} from "./plan-core.js";

/* ===============================================================
   1. RUNTIME STATE
   =============================================================== */

/*
 * `state` is the plan. In shared mode the server owns it and we hold the last
 * copy it gave us, plus an etag so writes can detect that someone else got
 * there first. In local mode there is no server and this page is the only copy.
 */
let state = initialState();
let etag = null;
let meta = {};
let syncMode = "connecting";       // connecting | shared | local | offline
let inFlight = 0;
let actor = "";
let passcode = "";
let lastRenderedSignature = "";

const ui = { filter: "all", search: "" };

const POLL_MS = 6000;
const NOTE_DEBOUNCE_MS = 700;
const API = "/api/plan";

/* The viewer's own name and the shared passcode are the only things kept in
   this browser. The plan itself always lives on the server. */
const store = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* private mode */ } }
};

/* ===============================================================
   2. TRANSPORT
   =============================================================== */

async function apiFetch(method, body) {
  const headers = { "content-type": "application/json" };
  if (passcode) headers["x-trip-passcode"] = passcode;

  const res = await fetch(API, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store"
  });

  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const err = new Error(payload?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = payload?.code;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function adopt(payload) {
  if (!payload || !payload.state) return;
  state = syncAssignments(payload.state);
  etag = payload.etag ?? null;
  meta = {
    updatedAt: payload.updatedAt ?? null,
    updatedBy: payload.updatedBy ?? null,
    lastChange: payload.lastChange ?? null
  };
}

async function loadPlan({ silent = false } = {}) {
  // Opened straight from disk (the standalone single-file copy): there is no
  // server to talk to, so go local without a doomed request and a scary error.
  if (typeof location !== "undefined" && location.protocol === "file:") {
    if (syncMode === "connecting") { syncMode = "local"; state = initialState(); }
    if (!silent) render();
    return false;
  }
  try {
    const payload = await apiFetch("GET");
    adopt(payload);
    syncMode = "shared";
    render();
    return true;
  } catch (err) {
    if (err.status === 401) {
      syncMode = "offline";
      render();
      askPasscode(err.payload?.passcodeRequired);
      return false;
    }
    /*
     * No usable API. Rather than showing a broken page, fall back to a
     * local-only plan so the tool still works — but say so plainly, because
     * in local mode nothing is shared and nothing is saved.
     */
    if (syncMode === "connecting") {
      syncMode = "local";
      state = initialState();
    } else {
      syncMode = "offline";
    }
    if (!silent) render();
    return false;
  }
}

/*
 * Every change goes through here. We apply it locally first so the UI responds
 * instantly, then send the operation. The server's answer is authoritative and
 * replaces whatever we guessed — including when it rejects the change because
 * someone else took the bed first.
 */
/* Resolves true if the change was saved, false if it wasn't. */
async function dispatch(op, { optimistic = true } = {}) {
  if (syncMode === "local") {
    try {
      const result = applyOp(state, op);
      state = result.state;
      render();
      if (result.message) toast(result.message);
      return true;
    } catch (err) {
      toast(err instanceof PlanError ? err.message : "That didn't work.");
      return false;
    }
  }

  const rollback = { state: clone(state), etag, meta: { ...meta } };

  if (optimistic) {
    try {
      state = applyOp(state, op).state;
      render();
    } catch (err) {
      // Invalid against our own copy; let the server have the final word
      // only if it might disagree, otherwise stop here.
      if (err instanceof PlanError) { toast(err.message); return false; }
      throw err;
    }
  }

  inFlight += 1;
  renderSyncBar();

  try {
    const payload = await apiFetch("POST", { op, actor });
    adopt(payload);
    syncMode = "shared";
    render();
    if (payload.message) toast(payload.message);
    return true;
  } catch (err) {
    if (err.status === 401) {
      state = rollback.state; etag = rollback.etag; meta = rollback.meta;
      syncMode = "offline";
      render();
      askPasscode(true);
      return false;
    }
    if (err.payload?.state) {
      // The server rejected it and handed back the live plan — show reality.
      adopt(err.payload);
      syncMode = "shared";
      render();
      toast(err.message);
      return false;
    }
    state = rollback.state; etag = rollback.etag; meta = rollback.meta;
    syncMode = "offline";
    render();
    toast(err.message || "Could not reach the plan — your change was not saved.");
    return false;
  } finally {
    inFlight -= 1;
    renderSyncBar();
  }
}

let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden || syncMode === "local" || inFlight > 0) return;
    loadPlan({ silent: true });
  }, POLL_MS);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && syncMode !== "local") loadPlan({ silent: true });
});
window.addEventListener("focus", () => {
  if (syncMode !== "local") loadPlan({ silent: true });
});

/* ===============================================================
   3. DOM REFERENCES
   =============================================================== */

const el = {
  stats: document.getElementById("stats"),
  meter: document.getElementById("meter"),
  meterWrap: document.getElementById("meter-wrap"),
  capacityPill: document.getElementById("capacity-pill"),
  alerts: document.getElementById("alerts"),
  tabs: document.getElementById("tabs"),
  peopleList: document.getElementById("people-list"),
  peopleCount: document.getElementById("people-count"),
  rooms: document.getElementById("rooms"),
  search: document.getElementById("search"),
  newPerson: document.getElementById("new-person"),
  backdrop: document.getElementById("backdrop"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  modalFoot: document.getElementById("modal-foot"),
  modalClose: document.getElementById("modal-close"),
  toast: document.getElementById("toast"),
  syncDot: document.getElementById("sync-dot"),
  syncWho: document.getElementById("sync-who")
};

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ===============================================================
   4. RENDER
   =============================================================== */

const FILTERS = [
  { key: "all", label: "All" },
  { key: "confirmed", label: "Confirmed" },
  { key: "notConfirmed", label: "Not confirmed" },
  { key: "assigned", label: "Assigned" },
  { key: "unassigned", label: "Unassigned" }
];

function matchesFilter(p, key) {
  if (key === "confirmed") return p.confirmed;
  if (key === "notConfirmed") return !p.confirmed;
  if (key === "assigned") return !!p.assignment;
  if (key === "unassigned") return !p.assignment;
  return true;
}

function visiblePeople() {
  const q = ui.search.trim().toLowerCase();
  return state.people.filter((p) => {
    if (!matchesFilter(p, ui.filter)) return false;
    if (!q) return true;
    return p.name.toLowerCase().includes(q) || (p.note || "").toLowerCase().includes(q);
  });
}

function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  if (secs < 90) return "a minute ago";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/* "Sun 31 Jan – Fri 5 Feb 2027 · 5 nights" */
function formatDates(state) {
  if (!state.startDate || !state.endDate) return "";
  const a = new Date(state.startDate + "T00:00:00");
  const b = new Date(state.endDate + "T00:00:00");
  if (Number.isNaN(a) || Number.isNaN(b)) return "";
  const day = (d) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const nights = Math.round((b - a) / 86400000);
  return `${day(a)} – ${day(b)} ${b.getFullYear()} · ${nights} night${nights === 1 ? "" : "s"}`;
}

function renderDates() {
  const node = document.getElementById("trip-dates");
  if (!node) return;
  const text = formatDates(state);
  node.textContent = text;
  node.hidden = !text;
}

function renderSyncBar() {
  const dot = el.syncDot;
  if (inFlight > 0) {
    dot.className = "sync-dot saving";
    dot.textContent = "Saving…";
  } else if (syncMode === "shared") {
    dot.className = "sync-dot live";
    dot.textContent = "Shared — everyone sees this";
  } else if (syncMode === "local") {
    dot.className = "sync-dot local";
    dot.textContent = "This device only — not saved";
  } else if (syncMode === "offline") {
    dot.className = "sync-dot offline";
    dot.textContent = "Can't reach the plan";
  } else {
    dot.className = "sync-dot";
    dot.textContent = "Connecting…";
  }

  const bits = [];
  if (actor) bits.push(`You are <strong>${esc(actor)}</strong>`);
  if (syncMode === "shared" && meta.updatedBy) {
    bits.push(`last change by ${esc(meta.updatedBy)} ${esc(relativeTime(meta.updatedAt))}`);
  }
  if (syncMode === "local") {
    bits.push("changes are lost when you close this tab");
  }
  el.syncWho.innerHTML = bits.join(" · ");
}

function renderStats(stats) {
  const cells = [
    { k: "People invited", v: stats.total, cls: "" },
    { k: "Confirmed", v: stats.confirmed, cls: stats.confirmed ? "is-ok" : "" },
    { k: "Beds taken", v: stats.occupied, cls: "" },
    { k: "Beds available", v: stats.spacesRemaining, cls: stats.spacesRemaining === 0 ? "is-pend" : "is-ok" }
  ];
  el.stats.innerHTML = cells.map((c) =>
    `<div class="stat ${c.cls}"><span class="k">${esc(c.k)}</span><span class="v">${esc(c.v)}</span></div>`
  ).join("");

  el.meter.style.width = `${Math.min(100, stats.occupancyPct)}%`;
  el.meter.style.background = stats.occupancyPct >= 100 ? "var(--ok)" : (stats.occupancyPct > 0 ? "var(--accent)" : "transparent");
  el.meterWrap.setAttribute("aria-label", `Occupancy ${stats.occupancyPct} percent — ${stats.occupied} of ${stats.beds} beds filled`);
  el.capacityPill.textContent = `${stats.occupied} / ${stats.beds} beds filled`;
}

function renderAlerts(issues) {
  if (!issues.length) {
    el.alerts.innerHTML = '<div class="alert alert-ok"><span class="ico" aria-hidden="true">✓</span><p>No problems. Everyone confirmed has a bed and no room is over capacity.</p></div>';
    return;
  }
  const errs = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level !== "error");
  el.alerts.innerHTML = [...errs, ...warns].map((i) => {
    const cls = i.level === "error" ? "alert-err" : "alert-warn";
    const ico = i.level === "error" ? "!" : "•";
    return `<div class="alert ${cls}"><span class="ico" aria-hidden="true">${ico}</span><p>${esc(i.text)}</p></div>`;
  }).join("");
}

function renderTabs() {
  const counts = {
    all: state.people.length,
    confirmed: state.people.filter((p) => p.confirmed).length,
    notConfirmed: state.people.filter((p) => !p.confirmed).length,
    assigned: state.people.filter((p) => !!p.assignment).length,
    unassigned: state.people.filter((p) => !p.assignment).length
  };
  el.tabs.innerHTML = FILTERS.map((f) => {
    const on = ui.filter === f.key;
    return `<button class="tab" type="button" role="tab" aria-selected="${on}" data-action="filter" data-filter="${f.key}">${esc(f.label)} <span class="n">${counts[f.key]}</span></button>`;
  }).join("");
}

function renderPeople() {
  const list = visiblePeople();
  el.peopleCount.textContent = list.length === state.people.length
    ? `${state.people.length} on the trip`
    : `${list.length} of ${state.people.length}`;

  if (!list.length) {
    el.peopleList.innerHTML = '<li class="empty">No one matches that filter.</li>';
    return;
  }

  el.peopleList.innerHTML = list.map((p) => {
    const where = assignmentLabel(state, p);
    const flag = p.confirmed && !p.assignment;

    const pairOptions = ['<option value="">— nobody —</option>'].concat(
      state.people.filter((o) => o.id !== p.id).map((o) =>
        `<option value="${esc(o.id)}"${p.pairWith === o.id ? " selected" : ""}>${esc(o.name)}</option>`)
    ).join("");

    return `<li class="person${flag ? " flag" : ""}" data-person="${esc(p.id)}">
      <div class="person-top">
        <div class="person-id">
          <div class="person-name">${esc(p.name)}</div>
          <div class="person-where${where ? "" : " none"}">${where ? esc(where) : "No bed assigned"}${p.pinned && where ? ' <span class="pill pill-ok">Booked</span>' : ""}</div>
        </div>
        <button class="toggle" type="button" data-action="toggle-confirm" data-person="${esc(p.id)}" aria-pressed="${p.confirmed}">
          <span class="dot" aria-hidden="true"></span>${p.confirmed ? "Confirmed" : "Not confirmed"}
        </button>
      </div>
      <div class="person-actions no-print">
        <button class="btn btn-sm" type="button" data-action="assign" data-person="${esc(p.id)}">${p.assignment ? "Move" : "Assign"}</button>
        ${p.assignment ? `<button class="btn btn-sm" type="button" data-action="unassign" data-person="${esc(p.id)}">Remove from bed</button>` : ""}
        ${p.assignment ? `<button class="btn btn-sm${p.pinned ? " btn-pinned" : ""}" type="button" data-action="toggle-pin" data-person="${esc(p.id)}" aria-pressed="${!!p.pinned}" title="${p.pinned ? "Booked — allocation leaves this bed alone" : "Pin this bed as already booked"}">${p.pinned ? "📌 Booked" : "Pin as booked"}</button>` : ""}
        <button class="btn btn-sm btn-danger" type="button" data-action="delete-person" data-person="${esc(p.id)}">Delete</button>
        <span class="pair-row">
          <label for="pair_${esc(p.id)}">Shares bed with</label>
          <select id="pair_${esc(p.id)}" data-action="pair" data-person="${esc(p.id)}" aria-label="Bed-sharing partner for ${esc(p.name)}">${pairOptions}</select>
        </span>
      </div>
      <div class="person-note">
        <label class="sr-only" for="note_${esc(p.id)}">Note for ${esc(p.name)}</label>
        <textarea class="note-input" id="note_${esc(p.id)}" rows="1" maxlength="500" placeholder="Notes (flights, arrival time…)" data-action="note" data-person="${esc(p.id)}">${esc(noteDrafts.has(p.id) ? noteDrafts.get(p.id).value : p.note)}</textarea>
        <span class="note-status${noteDrafts.get(p.id)?.state === "saved" ? " saved" : ""}${noteDrafts.get(p.id)?.state === "error" ? " err" : ""}" id="ns_${esc(p.id)}" aria-live="polite">${esc(noteStatusText(noteDrafts.get(p.id)?.state))}</span>
      </div>
    </li>`;
  }).join("");
}

function renderRooms(issues) {
  el.rooms.innerHTML = state.rooms.map((room) => {
    const cap = roomCapacity(room);
    const occ = roomOccupancy(room);
    const free = Math.max(0, cap - occ);
    const roomIssues = issues.filter((i) => i.roomId === room.id && i.level === "error");
    const badSlots = new Set(roomIssues.filter((i) => i.slotId).map((i) => i.slotId));

    const modes = ROOM_MODES[room.type] || [];
    const modeHtml = modes.length
      ? `<div class="room-mode no-print">
           <label for="mode_${esc(room.id)}">Layout</label>
           <select id="mode_${esc(room.id)}" data-action="mode" data-room="${esc(room.id)}">
             ${modes.map((m) => `<option value="${esc(m.value)}"${room.mode === m.value ? " selected" : ""}>${esc(m.label)}</option>`).join("")}
           </select>
         </div>`
      : "";

    const slotsHtml = room.slots.map((slot) => {
      const over = slot.occupants.length > slot.capacity || badSlots.has(slot.id);
      const filled = slot.occupants.length > 0;
      const canAdd = slot.occupants.length < slot.capacity && occ < cap;

      const chips = slot.occupants.length
        ? slot.occupants.map((pid) => {
            const p = personById(state, pid);
            const nm = p ? p.name : "Unknown";
            return `<span class="chip${p && !p.confirmed ? " unconf" : ""}">
              <span class="nm">${esc(nm)}</span>
              <button class="x no-print" type="button" data-action="unassign" data-person="${esc(pid)}" aria-label="Remove ${esc(nm)} from ${esc(slot.label)}">×</button>
            </span>`;
          }).join("")
        : '<span class="slot-empty">Empty</span>';

      return `<li class="slot${filled ? " filled" : ""}${over ? " over" : ""}">
        <div class="slot-top">
          <span class="slot-label">${esc(slot.label)} <span class="kind">· ${slot.type === "sharedDouble" ? "shares, max 2" : "1 person"}</span></span>
          <button class="btn btn-sm no-print" type="button" data-action="fill-slot" data-room="${esc(room.id)}" data-slot="${esc(slot.id)}"${canAdd ? "" : " disabled"}>+ Add</button>
        </div>
        <div class="occupants">${chips}</div>
      </li>`;
    }).join("");

    const statusPill = occ > cap
      ? '<span class="pill pill-err">Over capacity</span>'
      : (occ === cap ? '<span class="pill pill-ok">Full</span>' : `<span class="pill pill-neutral">${free} space${free === 1 ? "" : "s"} left</span>`);

    return `<article class="room${roomIssues.length ? " invalid" : ""}" aria-labelledby="rt_${esc(room.id)}">
      <div class="room-head">
        <div class="room-title-row">
          <h3 class="room-title" id="rt_${esc(room.id)}">${esc(room.name)}</h3>
          <div class="room-meta">${room.autoFill === false ? '<span class="pill pill-neutral" title="Suggested Allocation never fills this room">Booked separately</span>' : ""}<span class="pill pill-neutral">${occ} / ${cap}</span>${statusPill}</div>
        </div>${modeHtml}
      </div>
      <div class="room-mode no-print"><button class="btn btn-sm" type="button" data-action="edit-room" data-room="${esc(room.id)}">Edit room</button></div>
      ${roomIssues.length ? `<p class="room-warn">⚠ ${esc(roomIssues[0].text)}</p>` : ""}
      <ul class="slots">${slotsHtml}</ul>
    </article>`;
  }).join("");
}

/*
 * Polling rebuilds the list every few seconds, which would otherwise steal the
 * cursor out of whatever field someone is typing in. Remember where focus was
 * and put it back, caret position included.
 */
function withPreservedFocus(fn) {
  const active = document.activeElement;
  const id = active && active.id ? active.id : null;
  const start = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
  const end = active && typeof active.selectionEnd === "number" ? active.selectionEnd : null;

  fn();

  if (!id) return;
  const restored = document.getElementById(id);
  if (!restored) return;
  try {
    restored.focus({ preventScroll: true });
    if (start !== null && typeof restored.setSelectionRange === "function") {
      restored.setSelectionRange(start, end ?? start);
    }
  } catch { /* element type without selection support */ }
}

function render() {
  syncAssignments(state);
  const stats = getStats(state);
  const issues = validateState(state);

  renderSyncBar();
  renderDates();
  renderStats(stats);
  renderAlerts(issues);

  /*
   * Skip rebuilding the two big lists when nothing they show has changed.
   * Without this, a poll every six seconds would flicker the page and fight
   * anyone mid-edit even when the plan is untouched.
   */
  const signature = JSON.stringify([state, ui.filter, ui.search]);
  if (signature === lastRenderedSignature) return;

  /*
   * Someone is typing a note. Rebuilding the list would replace the box they
   * are typing in, losing whatever they typed since the last save and closing
   * the keyboard on a phone. Refresh everything else now and rebuild the
   * list as soon as they leave the box.
   */
  if (typingNote()) {
    renderTabs();
    renderRooms(issues);
    return;            // lastRenderedSignature left stale on purpose
  }

  lastRenderedSignature = signature;
  withPreservedFocus(() => {
    renderTabs();
    renderPeople();
    renderRooms(issues);
  });
  el.peopleList.querySelectorAll(".note-input").forEach(autosize);
}

/* ===============================================================
   5. MODAL + TOAST
   =============================================================== */

let lastFocused = null;

function openModal(opts) {
  lastFocused = document.activeElement;
  el.modalTitle.textContent = opts.title || "";
  el.modalBody.innerHTML = opts.bodyHtml || "";
  el.modalFoot.innerHTML = (opts.buttons || []).map((b, i) =>
    `<button class="btn ${b.variant || ""}" type="button" data-modal-btn="${i}">${esc(b.label)}</button>`
  ).join("");

  el.modalFoot.onclick = (ev) => {
    const btn = ev.target.closest("[data-modal-btn]");
    if (!btn) return;
    const def = (opts.buttons || [])[Number(btn.getAttribute("data-modal-btn"))];
    if (def && def.onClick) def.onClick();
    else closeModal();
  };

  el.modalBody.onclick = (ev) => {
    const pick = ev.target.closest("[data-pick]");
    if (!pick || pick.disabled) return;
    if (opts.onPick) opts.onPick(pick.getAttribute("data-pick"), pick);
  };

  el.backdrop.hidden = false;
  el.backdrop.dataset.dismissible = opts.dismissible === false ? "no" : "yes";
  document.body.style.overflow = "hidden";

  const target = el.modalBody.querySelector("input,textarea,button:not([disabled])") || el.modalClose;
  if (target) target.focus();
}

function closeModal() {
  el.backdrop.hidden = true;
  el.modalBody.innerHTML = "";
  el.modalFoot.innerHTML = "";
  el.modalBody.onclick = null;
  el.modalFoot.onclick = null;
  document.body.style.overflow = "";
  if (lastFocused && lastFocused.focus) { try { lastFocused.focus(); } catch { /* gone */ } }
  lastFocused = null;
}

el.modalClose.addEventListener("click", () => {
  if (el.backdrop.dataset.dismissible === "no") return;
  closeModal();
});
el.backdrop.addEventListener("mousedown", (ev) => {
  if (ev.target === el.backdrop && el.backdrop.dataset.dismissible !== "no") closeModal();
});

document.addEventListener("keydown", (ev) => {
  if (el.backdrop.hidden) return;
  if (ev.key === "Escape" && el.backdrop.dataset.dismissible !== "no") { ev.preventDefault(); closeModal(); return; }
  if (ev.key !== "Tab") return;
  const nodes = [...el.modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter((n) => n.offsetParent !== null || n === document.activeElement);
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
});

let toastTimer = null;
function toast(msg) {
  if (!msg) return;
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2800);
}

function confirmDialog(title, message, confirmLabel, onConfirm) {
  openModal({
    title,
    bodyHtml: `<p class="modal-note">${esc(message)}</p>`,
    buttons: [
      { label: "Cancel", onClick: closeModal },
      { label: confirmLabel, variant: "btn-danger", onClick: () => { closeModal(); onConfirm(); } }
    ]
  });
}

/* ===============================================================
   6. IDENTITY + PASSCODE
   =============================================================== */

function askWhoAmI({ force = false } = {}) {
  if (actor && !force) return;
  openModal({
    title: "Who are you?",
    dismissible: !!actor,
    bodyHtml:
      `<p class="modal-note">Everyone shares one plan, so your name is shown next to whatever you change. It stays on this device.</p>
       <label class="sr-only" for="actor-name">Your name</label>
       <input class="input" id="actor-name" type="text" maxlength="40" placeholder="e.g. Mario" value="${esc(actor)}" autocomplete="name">`,
    buttons: [{
      label: "Continue",
      variant: "btn-primary",
      onClick: () => {
        const value = document.getElementById("actor-name").value.trim().slice(0, 40);
        if (!value) { document.getElementById("actor-name").focus(); return; }
        actor = value;
        store.set("skitrip.actor", actor);
        closeModal();
        renderSyncBar();
      }
    }]
  });
  const input = document.getElementById("actor-name");
  if (input) input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); el.modalFoot.querySelector("[data-modal-btn]")?.click(); }
  });
}

function askPasscode(required) {
  if (!required) return;
  openModal({
    title: "Trip passcode",
    dismissible: false,
    bodyHtml:
      `<p class="modal-note">This plan is passcode-protected. Ask Mario for it — it's the same for everyone.</p>
       <label class="sr-only" for="passcode-input">Passcode</label>
       <input class="input" id="passcode-input" type="password" placeholder="Passcode" autocomplete="current-password">
       <p class="modal-note" id="passcode-msg"></p>`,
    buttons: [{
      label: "Unlock",
      variant: "btn-primary",
      onClick: async () => {
        const value = document.getElementById("passcode-input").value;
        const msg = document.getElementById("passcode-msg");
        if (!value) { document.getElementById("passcode-input").focus(); return; }
        passcode = value;
        const ok = await loadPlan({ silent: true });
        if (ok) {
          store.set("skitrip.passcode", passcode);
          closeModal();
          askWhoAmI();
        } else {
          msg.textContent = "That passcode wasn't accepted.";
          msg.style.color = "var(--err)";
        }
      }
    }]
  });
  const input = document.getElementById("passcode-input");
  if (input) input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); el.modalFoot.querySelector("[data-modal-btn]")?.click(); }
  });
}

/* ===============================================================
   7. PICKERS
   =============================================================== */

function openAssignPicker(personId) {
  const person = personById(state, personId);
  if (!person) return;

  const html = state.rooms.map((room) => {
    const cap = roomCapacity(room);
    const occ = roomOccupancy(room);

    const slots = room.slots.map((slot) => {
      const here = slot.occupants.includes(personId);
      const roomFull = occ >= cap && !here;
      const slotFull = slot.occupants.length >= slot.capacity && !here;
      const disabled = here || slotFull || roomFull;
      const mates = slot.occupants.map((id) => personById(state, id)?.name ?? "?");
      const metaText = here ? "Currently here" : slotFull ? "Full" : roomFull ? "Room full" : `${slot.capacity - slot.occupants.length} free`;

      return `<button class="pick" type="button" data-pick="${esc(room.id)}|${esc(slot.id)}"${disabled ? " disabled" : ""}>
        <span class="lead"><span class="nm">${esc(slot.label)}</span>${mates.length ? `<span class="meta">${esc(mates.join(", "))}</span>` : ""}</span>
        <span class="meta">${esc(metaText)}</span>
      </button>`;
    }).join("");

    return `<div class="pick-group"><h3>${esc(room.name)} · ${occ}/${cap}</h3>${slots}</div>`;
  }).join("");

  openModal({
    title: `Where does ${person.name} sleep?`,
    bodyHtml: html,
    buttons: person.assignment
      ? [{ label: "Remove from bed", variant: "btn-danger", onClick: () => { closeModal(); dispatch({ type: "unassign", params: { personId } }); } },
         { label: "Close", onClick: closeModal }]
      : [{ label: "Close", onClick: closeModal }],
    onPick: (value) => {
      const [roomId, slotId] = value.split("|");
      closeModal();
      dispatch({ type: "assign", params: { personId, roomId, slotId } });
    }
  });
}

function openSlotPicker(roomId, slotId) {
  const room = roomById(state, roomId);
  if (!room) return;
  const slot = slotById(room, slotId);
  if (!slot) return;

  const row = (p) => {
    const where = assignmentLabel(state, p);
    return `<button class="pick" type="button" data-pick="${esc(p.id)}">
      <span class="lead"><span class="nm">${esc(p.name)}</span>
      <span class="pill ${p.confirmed ? "pill-ok" : "pill-pend"}">${p.confirmed ? "Confirmed" : "Pending"}</span></span>
      <span class="meta">${esc(where ? `Move from ${where.split(" (with")[0]}` : "No bed yet")}</span>
    </button>`;
  };

  const free = state.people.filter((p) => !p.assignment);
  const placed = state.people.filter((p) => p.assignment && !slot.occupants.includes(p.id));
  const freeConf = free.filter((p) => p.confirmed);
  const freePend = free.filter((p) => !p.confirmed);

  let html = "";
  if (freeConf.length) html += `<div class="pick-group"><h3>Confirmed, no bed yet</h3>${freeConf.map(row).join("")}</div>`;
  if (freePend.length) html += `<div class="pick-group"><h3>Not confirmed</h3>${freePend.map(row).join("")}</div>`;
  if (placed.length) html += `<div class="pick-group"><h3>Already in another bed — move them</h3>${placed.map(row).join("")}</div>`;
  if (!html) html = '<p class="modal-note">Everyone is already in this bed or there is no one left to place.</p>';

  openModal({
    title: `${room.name} · ${slot.label}`,
    bodyHtml: html,
    buttons: [{ label: "Close", onClick: closeModal }],
    onPick: (pid) => {
      closeModal();
      dispatch({ type: "assign", params: { personId: pid, roomId, slotId } });
    }
  });
}

function openAddRoom() {
  openModal({
    title: "Add a room",
    bodyHtml:
      `<p class="modal-note">Add a room you have actually booked. It counts towards the beds straight away.</p>
       <div class="field"><label for="new-room-name">Room name</label>
         <input class="input" id="new-room-name" type="text" maxlength="60" placeholder="e.g. Twin Room 3"></div>
       <div class="field"><label for="new-room-type">Type</label>
         <select class="input" id="new-room-type">
           <option value="double">Double — 2 beds (twin or one double)</option>
           <option value="family">Family — 4 beds</option>
           <option value="dorm">Dormitory — choose how many beds</option>
         </select></div>
       <div class="field" id="beds-field" hidden><label for="new-room-beds">How many beds</label>
         <input class="input" id="new-room-beds" type="number" min="1" max="30" value="6"></div>
       <p class="modal-note" id="add-room-msg"></p>`,
    buttons: [
      { label: "Cancel", onClick: closeModal },
      { label: "Add room", variant: "btn-primary", onClick: () => {
          const name = document.getElementById("new-room-name").value.trim();
          const type = document.getElementById("new-room-type").value;
          const beds = Number(document.getElementById("new-room-beds").value);
          const msg = document.getElementById("add-room-msg");
          if (!name) { msg.textContent = "Give the room a name."; msg.style.color = "var(--err)"; return; }
          closeModal();
          dispatch({ type: "addRoom", params: { name, type, beds } }, { optimistic: false });
        } }
    ]
  });
  const typeSel = document.getElementById("new-room-type");
  const bedsField = document.getElementById("beds-field");
  const sync = () => { bedsField.hidden = typeSel.value !== "dorm"; };
  typeSel.addEventListener("change", sync);
  sync();
}

function openRoomEditor(roomId) {
  const room = roomById(state, roomId);
  if (!room) return;
  const occ = roomOccupancy(room);

  openModal({
    title: `Edit ${room.name}`,
    bodyHtml:
      `<div class="field"><label for="room-name">Room name</label>
         <input class="input" id="room-name" type="text" maxlength="60" value="${esc(room.name)}"></div>
       ${room.type === "dorm"
          ? `<div class="field"><label for="room-beds">How many beds</label>
               <input class="input" id="room-beds" type="number" min="1" max="30" value="${roomCapacity(room)}"></div>`
          : `<p class="modal-note">This room's size comes from its layout, set on the room card.</p>`}
       <div class="field">
         <label for="room-autofill">Used by Suggested Allocation</label>
         <select class="input" id="room-autofill">
           <option value="yes"${room.autoFill !== false ? " selected" : ""}>Yes — fill it automatically</option>
           <option value="no"${room.autoFill === false ? " selected" : ""}>No — booked separately</option>
         </select>
       </div>
       <p class="modal-note">${occ ? `${occ} ${occ === 1 ? "person is" : "people are"} in this room. Deleting it leaves them without a bed.` : "This room is empty."}</p>`,
    buttons: [
      { label: "Delete room", variant: "btn-danger", onClick: () => {
          closeModal();
          confirmDialog(`Delete ${room.name}?`,
            occ ? `${occ} ${occ === 1 ? "person" : "people"} will lose their bed. This cannot be undone.`
                : "This cannot be undone.",
            "Delete room",
            () => dispatch({ type: "removeRoom", params: { roomId } }, { optimistic: false }));
        } },
      { label: "Cancel", onClick: closeModal },
      { label: "Save", variant: "btn-primary", onClick: () => {
          const name = document.getElementById("room-name").value.trim();
          const bedsInput = document.getElementById("room-beds");
          const autoFill = document.getElementById("room-autofill").value === "yes";
          closeModal();
          if (name && name !== room.name) dispatch({ type: "renameRoom", params: { roomId, name } }, { optimistic: false });
          if (bedsInput && Number(bedsInput.value) !== roomCapacity(room)) {
            dispatch({ type: "setRoomBeds", params: { roomId, beds: Number(bedsInput.value) } }, { optimistic: false });
          }
          if (autoFill !== (room.autoFill !== false)) {
            dispatch({ type: "setRoomAutoFill", params: { roomId, autoFill } }, { optimistic: false });
          }
        } }
    ]
  });
}

/* ===============================================================
   9. EVENT HANDLERS
   =============================================================== */

document.addEventListener("click", (ev) => {
  const node = ev.target.closest("[data-action]");
  if (!node) return;
  const action = node.getAttribute("data-action");
  const personId = node.getAttribute("data-person");
  const roomId = node.getAttribute("data-room");
  const slotId = node.getAttribute("data-slot");

  if (action === "filter") {
    ui.filter = node.getAttribute("data-filter");
    render();
    return;
  }
  if (action === "toggle-confirm") {
    const p = personById(state, personId);
    if (!p) return;
    dispatch({ type: "setConfirmed", params: { personId, confirmed: !p.confirmed } });
    return;
  }
  if (action === "toggle-pin") {
    const p = personById(state, personId);
    if (!p) return;
    dispatch({ type: "setPinned", params: { personId, pinned: !p.pinned } });
    return;
  }
  if (action === "edit-room") { openRoomEditor(roomId); return; }
  if (action === "assign") { openAssignPicker(personId); return; }
  if (action === "unassign") { dispatch({ type: "unassign", params: { personId } }); return; }
  if (action === "fill-slot") { openSlotPicker(roomId, slotId); return; }
  if (action === "delete-person") {
    const dp = personById(state, personId);
    if (!dp) return;
    confirmDialog(
      `Remove ${dp.name}?`,
      `${dp.name} will be taken off the trip list and out of any bed${syncMode === "shared" ? ", for everyone" : ""}. This cannot be undone.`,
      "Remove",
      () => dispatch({ type: "deletePerson", params: { personId } })
    );
  }
});

/*
 * Notes. What's typed is held in noteDrafts until the server has it, so a
 * save reply, a poll or someone else's change can't overwrite it. One save
 * per note at a time; anything typed during a save is sent straight after.
 */
const noteDrafts = new Map();   // personId -> { value, state, timer, inFlight, again }

function typingNote() {
  return document.activeElement?.getAttribute?.("data-action") === "note";
}

function isEditingNote(personId) {
  return typingNote() && document.activeElement.getAttribute("data-person") === personId;
}

function autosize(node) {
  node.style.height = "auto";
  node.style.height = `${node.scrollHeight + (node.offsetHeight - node.clientHeight)}px`;
}

function noteStatusText(stateName) {
  return { saving: "Saving…", saved: "Saved ✓", error: "Not saved — check your connection. Trying again…" }[stateName] || "";
}

function showNoteStatus(personId, stateName) {
  const node = document.getElementById(`ns_${personId}`);
  if (!node) return;
  node.textContent = noteStatusText(stateName);
  node.className = `note-status${stateName === "saved" ? " saved" : ""}${stateName === "error" ? " err" : ""}`;
}

async function saveNote(personId) {
  const d = noteDrafts.get(personId);
  if (!d) return;
  clearTimeout(d.timer);
  if (d.inFlight) { d.again = true; return; }

  const value = d.value;
  d.inFlight = true;
  d.state = "saving";
  showNoteStatus(personId, "saving");

  const ok = await dispatch({ type: "setNote", params: { personId, note: value } }, { optimistic: false });

  d.inFlight = false;
  if (noteDrafts.get(personId) !== d) return;

  if (!ok) {
    d.state = "error";
    showNoteStatus(personId, "error");
    d.timer = setTimeout(() => saveNote(personId), 4000);
    return;
  }
  if (d.again || d.value !== value) {   // they kept typing while it saved
    d.again = false;
    saveNote(personId);
    return;
  }

  d.state = "saved";
  showNoteStatus(personId, "saved");
  // Once they've left the box the draft can go: the plan's own copy is the
  // truth again, so a later edit by someone else will show.
  if (!isEditingNote(personId)) noteDrafts.delete(personId);
}

document.addEventListener("input", (ev) => {
  const node = ev.target;
  if (node.getAttribute?.("data-action") !== "note") return;
  const personId = node.getAttribute("data-person");
  autosize(node);

  const d = noteDrafts.get(personId) || { value: "", state: "", timer: null, inFlight: false, again: false };
  d.value = node.value;
  if (d.state !== "saving") { d.state = "typing"; showNoteStatus(personId, ""); }
  noteDrafts.set(personId, d);

  clearTimeout(d.timer);
  d.timer = setTimeout(() => saveNote(personId), NOTE_DEBOUNCE_MS);
});

document.addEventListener("focusout", (ev) => {
  const node = ev.target;
  if (node.getAttribute?.("data-action") !== "note") return;
  const personId = node.getAttribute("data-person");
  const d = noteDrafts.get(personId);
  if (d && (d.state === "typing" || d.state === "error")) saveNote(personId);   // leaving the box saves now
  else if (d && d.state === "saved") noteDrafts.delete(personId);
  // Catch up on changes made while they typed, once focus has settled, so
  // tapping straight into another note isn't interrupted.
  setTimeout(render, 0);
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => el.peopleList.querySelectorAll(".note-input").forEach(autosize), 120);
});

document.addEventListener("change", (ev) => {
  const node = ev.target;
  const action = node.getAttribute?.("data-action");
  if (action === "mode") {
    dispatch({ type: "setRoomMode", params: { roomId: node.getAttribute("data-room"), mode: node.value } });
    return;
  }
  if (action === "pair") {
    dispatch({ type: "setPair", params: { personId: node.getAttribute("data-person"), otherId: node.value || null } });
  }
});

el.search.addEventListener("input", () => {
  ui.search = el.search.value;
  render();
});

function addPersonFromInput() {
  const name = el.newPerson.value.trim();
  if (!name) { el.newPerson.focus(); return; }
  el.newPerson.value = "";
  dispatch({ type: "addPerson", params: { name } }, { optimistic: false });
  el.newPerson.focus();
}

document.getElementById("btn-add-person").addEventListener("click", addPersonFromInput);
el.newPerson.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); addPersonFromInput(); }
});

document.getElementById("btn-suggest").addEventListener("click", () => {
  confirmDialog(
    "Run suggested allocation?",
    `This clears every current bed assignment${syncMode === "shared" ? " for everyone" : ""} and rebuilds the plan: confirmed people first, bed-sharing pairs into the double rooms, then the family room, then the dormitory.`,
    "Allocate",
    () => dispatch({ type: "suggest", params: {} }, { optimistic: false })
  );
});

document.getElementById("btn-add-room").addEventListener("click", openAddRoom);
document.getElementById("btn-print").addEventListener("click", () => window.print());

document.getElementById("btn-whoami").addEventListener("click", () => askWhoAmI({ force: true }));
document.getElementById("btn-refresh").addEventListener("click", async () => {
  if (syncMode === "local") { toast("Not connected to a shared plan."); return; }
  await loadPlan();
  toast(syncMode === "shared" ? "Up to date." : "Still can't reach the plan.");
});

/* ===============================================================
   10. BOOT
   =============================================================== */

actor = store.get("skitrip.actor") || "";
passcode = store.get("skitrip.passcode") || "";

render();

(async () => {
  await loadPlan();
  if (syncMode === "shared") {
    askWhoAmI();
    startPolling();
  }
  // Keep "last change 3 min ago" honest without re-rendering the whole page.
  setInterval(renderSyncBar, 30000);
})();
