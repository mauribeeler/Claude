import {
  applyOp, initialState, getStats, validateState, syncAssignments,
  personById, roomById, slotById, assignmentLabel, roomCapacity, roomOccupancy,
  ROOM_MODES, PlanError, clone,
  travelOf, hasFlights, travelBoard, legIsEmpty, sanitizeLeg, LEG_FIELDS
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
async function dispatch(op, { optimistic = true } = {}) {
  if (syncMode === "local") {
    try {
      const result = applyOp(state, op);
      state = result.state;
      render();
      if (result.message) toast(result.message);
    } catch (err) {
      toast(err instanceof PlanError ? err.message : "That didn't work.");
    }
    return;
  }

  const rollback = { state: clone(state), etag, meta: { ...meta } };

  if (optimistic) {
    try {
      state = applyOp(state, op).state;
      render();
    } catch (err) {
      // Invalid against our own copy; let the server have the final word
      // only if it might disagree, otherwise stop here.
      if (err instanceof PlanError) { toast(err.message); return; }
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
  } catch (err) {
    if (err.status === 401) {
      state = rollback.state; etag = rollback.etag; meta = rollback.meta;
      syncMode = "offline";
      render();
      askPasscode(true);
      return;
    }
    if (err.payload?.state) {
      // The server rejected it and handed back the live plan — show reality.
      adopt(err.payload);
      syncMode = "shared";
      render();
      toast(err.message);
      return;
    }
    state = rollback.state; etag = rollback.etag; meta = rollback.meta;
    syncMode = "offline";
    render();
    toast(err.message || "Could not reach the plan — your change was not saved.");
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
  { key: "unassigned", label: "No bed" },
  { key: "noFlights", label: "No flights" }
];

function matchesFilter(p, key) {
  if (key === "confirmed") return p.confirmed;
  if (key === "notConfirmed") return !p.confirmed;
  if (key === "assigned") return !!p.assignment;
  if (key === "unassigned") return !p.assignment;
  if (key === "noFlights") return !hasFlights(p);
  return true;
}

/* Search matches flight numbers and airports too, so "EZY8191" or "GVA"
   finds everyone on that flight or landing there. */
function searchText(p) {
  const t = travelOf(p);
  return [p.name, p.note, t.outbound.flight, t.outbound.from, t.outbound.to,
          t.inbound.flight, t.inbound.from, t.inbound.to].join(" ").toLowerCase();
}

function visiblePeople() {
  const q = ui.search.trim().toLowerCase();
  return state.people.filter((p) => {
    if (!matchesFilter(p, ui.filter)) return false;
    return !q || searchText(p).includes(q);
  });
}

/* "Sun 31 Jan" */
function fmtDay(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/* "Sun 31 Jan · EZY8191 LGW → GVA · lands 09:55" — whatever is known, in that order. */
function legSummary(leg, direction) {
  if (legIsEmpty(leg)) return "";
  const route = leg.from || leg.to ? `${leg.from || "?"} → ${leg.to || "?"}` : "";
  const time = direction === "outbound"
    ? (leg.arrive ? `lands ${leg.arrive}` : leg.depart ? `departs ${leg.depart}` : "")
    : (leg.depart ? `departs ${leg.depart}` : leg.arrive ? `lands ${leg.arrive}` : "");
  return [fmtDay(leg.date), [leg.flight, route].filter(Boolean).join(" "), time].filter(Boolean).join(" · ");
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
    bits.push("changes are lost when you close this tab — Print / PDF keeps a copy");
  }
  el.syncWho.innerHTML = bits.join(" · ");
}

function renderStats(stats) {
  const cells = [
    { k: "Total people", v: stats.total, cls: "" },
    { k: "Confirmed", v: stats.confirmed, cls: stats.confirmed ? "is-ok" : "" },
    { k: "Not confirmed", v: stats.notConfirmed, cls: stats.notConfirmed ? "is-pend" : "" },
    { k: "Assigned", v: stats.assigned, cls: "" },
    { k: "Unassigned", v: stats.unassigned, cls: stats.unassigned ? "is-pend" : "" },
    { k: "Spaces left", v: stats.spacesRemaining, cls: stats.spacesRemaining === 0 ? "is-pend" : "" },
    { k: "Confirmed, no bed", v: stats.confirmedUnassigned, cls: stats.confirmedUnassigned ? "is-err" : "is-ok" },
    { k: "Occupancy", v: `${stats.occupancyPct}%`, cls: "" }
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
    unassigned: state.people.filter((p) => !p.assignment).length,
    noFlights: state.people.filter((p) => !hasFlights(p)).length
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
    el.peopleList.innerHTML = state.people.length
      ? '<li class="empty">No one matches that filter.</li>'
      : '<li class="empty">Nobody on the list yet. Tap <strong>+ Add person</strong> to start.</li>';
    return;
  }

  /*
   * One tappable summary per person; everything else (flights, notes, bed
   * sharing, delete) lives in the details sheet. The row only keeps the two
   * things people do constantly: confirm, and choose a bed.
   */
  el.peopleList.innerHTML = list.map((p) => {
    const where = assignmentLabel(state, p);
    const t = travelOf(p);
    const out = legSummary(t.outbound, "outbound");
    const home = legSummary(t.inbound, "inbound");
    const id = esc(p.id);

    const flightLines = out || home
      ? `${out ? `<span class="person-line"><span class="lbl">Out</span><span>${esc(out)}</span></span>` : ""}
         ${home ? `<span class="person-line"><span class="lbl">Home</span><span>${esc(home)}</span></span>` : ""}`
      : `<span class="person-line none"><span class="lbl">Flights</span><span>Not added yet</span></span>`;

    // The summary below the name is also tappable, for convenience on phones.
    // Keyboard users reach the same sheet through the name button, so the
    // summary itself doesn't need to be a second focusable control.
    return `<li class="person${p.confirmed && !p.assignment ? " flag" : ""}" data-person="${id}">
      <div class="person-head">
        <button class="person-name" type="button" data-action="edit-person" data-person="${id}" title="Open ${esc(p.name)}'s details">${esc(p.name)}</button>
        <button class="toggle" type="button" data-action="toggle-confirm" data-person="${id}" aria-pressed="${p.confirmed}" aria-label="${esc(p.name)}: ${p.confirmed ? "confirmed, tap to unconfirm" : "not confirmed, tap to confirm"}">
          <span class="dot" aria-hidden="true"></span>${p.confirmed ? "Confirmed" : "Not confirmed"}
        </button>
      </div>
      <div class="person-details" data-action="edit-person" data-person="${id}">
        <span class="person-line${where ? "" : " warn"}"><span class="lbl">Bed</span><span>${where ? esc(where) : "No bed yet"}${p.pinned && where ? ' <span class="pill pill-ok">Booked</span>' : ""}</span></span>
        ${flightLines}
        ${p.note ? `<span class="person-line note"><span class="lbl">Note</span><span>${esc(p.note)}</span></span>` : ""}
      </div>
      <div class="person-actions no-print">
        <button class="btn btn-sm" type="button" data-action="edit-person" data-person="${id}">Edit details &amp; flights</button>
        <button class="btn btn-sm" type="button" data-action="assign" data-person="${id}">${p.assignment ? "Move bed" : "Choose bed"}</button>
        <button class="btn btn-sm btn-quiet-danger" type="button" data-action="delete-person" data-person="${id}" aria-label="Delete ${esc(p.name)}">Delete</button>
      </div>
    </li>`;
  }).join("");
}

/* Arrivals and departures by day, with everyone on the same flight grouped,
   so transfers up to Zermatt can be planned from one screen. */
function renderFlights() {
  const node = document.getElementById("flights");
  const countNode = document.getElementById("flights-count");
  if (!node) return;
  const board = travelBoard(state);
  const total = state.people.length;

  countNode.textContent = `${board.withFlights} of ${total} added`;
  countNode.className = `pill ${board.withFlights === total && total ? "pill-ok" : "pill-neutral"}`;

  const names = (people) => people.map((x) =>
    `<button class="linkish" type="button" data-action="edit-person" data-person="${esc(x.id)}">${esc(x.name)}</button>`
  ).join("");

  const column = (title, days, kindDefault, emptyText) => {
    const body = days.length ? days.map((day) => `
      <div class="board-day">
        <h4>${esc(day.date ? fmtDay(day.date) : "Date not set")}</h4>
        <ul class="board-list">
          ${day.groups.map((g) => `
            <li class="board-row">
              <span class="time">${esc(g.time || "--:--")}<small>${g.time ? (g.timeKind === "arrive" ? "lands" : "departs") : "time tbc"}</small></span>
              <span class="what">${g.flight ? `<strong>${esc(g.flight)}</strong> ` : ""}${g.from || g.to ? esc(`${g.from || "?"} → ${g.to || "?"}`) : (g.flight ? "" : "Flight details partial")}</span>
              <span class="who">${names(g.people)}<span class="count">${g.people.length > 1 ? `${g.people.length} people` : ""}</span></span>
            </li>`).join("")}
        </ul>
      </div>`).join("") : `<p class="board-empty">${emptyText}</p>`;
    return `<div class="board-col"><h3>${title}</h3>${body}</div>`;
  };

  if (!board.withFlights) {
    node.innerHTML = `<p class="board-empty">No flights added yet. Tap anyone in the list and fill in <strong>Flying out</strong> and <strong>Flying home</strong> — people on the same flight are grouped here automatically, which makes planning the transfer up to Zermatt much easier.</p>`;
    return;
  }

  node.innerHTML = `
    <div class="board">
      ${column("Arrivals", board.arrivals, "arrive", "No outbound flights yet.")}
      ${column("Departures", board.departures, "depart", "No return flights yet.")}
    </div>
    ${board.missing.length ? `<p class="missing"><strong>Still to add flights (${board.missing.length}):</strong> ${names(board.missing)}</p>` : `<p class="missing all-in">Everyone's flights are in.</p>`}`;
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
  if (signature !== lastRenderedSignature) {
    lastRenderedSignature = signature;
    withPreservedFocus(() => {
      renderTabs();
      renderPeople();
      renderRooms(issues);
      renderFlights();
    });
  }
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

  el.modalBody.oninput = null;
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
  el.modalBody.oninput = null;
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
   8. PERSON DETAILS SHEET — add, edit and delete people in one place
   =============================================================== */

const AIRPORTS = [
  ["GVA", "Geneva"], ["ZRH", "Zurich"], ["BSL", "Basel"], ["MXP", "Milan Malpensa"],
  ["LHR", "London Heathrow"], ["LGW", "London Gatwick"], ["STN", "London Stansted"],
  ["LTN", "London Luton"], ["LCY", "London City"], ["BRS", "Bristol"], ["MAN", "Manchester"],
  ["BHX", "Birmingham"], ["EDI", "Edinburgh"], ["GLA", "Glasgow"], ["DUB", "Dublin"],
  ["SOU", "Southampton"], ["EXT", "Exeter"]
];

const LEG_LABELS = {
  flight: ["Flight no.", "text", "e.g. EZY8191"],
  date: ["Date", "date", ""],
  from: ["From", "text", "e.g. LGW"],
  to: ["To", "text", "e.g. GVA"],
  depart: ["Departs", "time", ""],
  arrive: ["Lands", "time", ""]
};

function legFieldsHtml(legKey, leg) {
  return LEG_FIELDS.map((f) => {
    const [label, type, placeholder] = LEG_LABELS[f];
    const id = `pe-${legKey}-${f}`;
    const extra = type === "text"
      ? ` placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="characters"${f === "from" || f === "to" ? ' list="pe-airports"' : ""} maxlength="${f === "flight" ? 12 : 40}"`
      : "";
    return `<div class="field"><label for="${id}">${label}</label>
      <input class="input" id="${id}" type="${type}" value="${esc(leg[f])}" data-leg="${legKey}" data-field="${f}"${extra}></div>`;
  }).join("");
}

function readLeg(legKey) {
  const leg = {};
  LEG_FIELDS.forEach((f) => { leg[f] = document.getElementById(`pe-${legKey}-${f}`)?.value ?? ""; });
  return sanitizeLeg(leg);
}

/**
 * The details sheet. personId = null opens it for adding someone new.
 * On save it sends only what actually changed, so it can't overwrite an edit
 * someone else made to a different field while this sheet was open.
 */
function openPersonEditor(personId) {
  const person = personId ? personById(state, personId) : null;
  if (personId && !person) { toast("That person is no longer on the trip."); return; }
  const isNew = !person;

  const snap = person ? {
    name: person.name,
    confirmed: !!person.confirmed,
    note: person.note || "",
    travel: travelOf(person),
    pairWith: person.pairWith || "",
    pinned: !!person.pinned
  } : { name: "", confirmed: false, note: "", travel: travelOf(null), pairWith: "", pinned: false };

  const where = person ? assignmentLabel(state, person) : null;
  const pairOptions = ['<option value="">Nobody</option>'].concat(
    state.people.filter((o) => !person || o.id !== person.id).map((o) =>
      `<option value="${esc(o.id)}"${snap.pairWith === o.id ? " selected" : ""}>${esc(o.name)}</option>`)
  ).join("");

  const bedSection = isNew ? "" : `
    <fieldset class="sheet-group">
      <legend>Bed</legend>
      <p class="sheet-text">${where ? esc(where) : "Not in a bed yet — use <strong>Choose bed</strong> in the list."}</p>
      ${person.assignment ? `<label class="check"><input type="checkbox" id="pe-pinned"${snap.pinned ? " checked" : ""}>
        <span>Bed is already booked — Suggested Allocation won't move ${esc(person.name)}</span></label>` : ""}
      <div class="field"><label for="pe-pair">Shares a bed with</label>
        <select class="input" id="pe-pair">${pairOptions}</select>
        <span class="field-help">Couples are put in a double bed by Suggested Allocation.</span></div>
    </fieldset>`;

  openModal({
    title: isNew ? "Add a person" : person.name,
    bodyHtml: `
      <div class="field"><label for="pe-name">Name</label>
        <input class="input" id="pe-name" type="text" maxlength="40" autocomplete="off" value="${esc(snap.name)}" placeholder="Their name">
        <span class="field-msg" id="pe-name-msg" role="status"></span></div>

      <fieldset class="sheet-group">
        <legend>Coming?</legend>
        <div class="seg">
          <label><input type="radio" name="pe-status" value="yes"${snap.confirmed ? " checked" : ""}><span>Confirmed</span></label>
          <label><input type="radio" name="pe-status" value="no"${snap.confirmed ? "" : " checked"}><span>Not confirmed yet</span></label>
        </div>
      </fieldset>

      <fieldset class="sheet-group">
        <legend>Flying out <button class="linkish leg-clear" type="button" data-clear-leg="outbound">Clear</button></legend>
        <div class="leg-grid">${legFieldsHtml("outbound", snap.travel.outbound)}</div>
      </fieldset>

      <fieldset class="sheet-group">
        <legend>Flying home <button class="linkish leg-clear" type="button" data-clear-leg="inbound">Clear</button></legend>
        <div class="leg-grid">${legFieldsHtml("inbound", snap.travel.inbound)}</div>
      </fieldset>

      <div class="field"><label for="pe-note">Notes</label>
        <textarea class="input note-area" id="pe-note" maxlength="300" placeholder="Driving instead, arriving late, needs a lower bunk…">${esc(snap.note)}</textarea></div>

      ${bedSection}

      <datalist id="pe-airports">${AIRPORTS.map(([code, city]) => `<option value="${code}">${city}</option>`).join("")}</datalist>`,
    buttons: [
      ...(isNew ? [] : [{ label: "Delete person", variant: "btn-danger", onClick: () => confirmDelete(person.id) }]),
      { label: "Cancel", onClick: closeModal },
      { label: isNew ? "Add to trip" : "Save", variant: "btn-primary", onClick: save }
    ]
  });

  const nameInput = document.getElementById("pe-name");
  const nameMsg = document.getElementById("pe-name-msg");

  // Duplicate names are allowed (two Toms happen) but worth a heads-up.
  const checkName = () => {
    const v = nameInput.value.trim().toLowerCase();
    const clash = v && state.people.some((o) => o.name.trim().toLowerCase() === v && (!person || o.id !== person.id));
    nameMsg.textContent = clash ? `There's already someone called ${nameInput.value.trim()} — fine if it's a different person.` : "";
    nameMsg.className = "field-msg warn";
  };
  nameInput.addEventListener("input", checkName);

  // Typing any flight detail fills the date with the trip's first or last day,
  // which is right for almost everyone and saves a fiddly date picker.
  // Property handlers (not addEventListener) so they're replaced, not stacked,
  // each time a sheet opens; closeModal clears them.
  el.modalBody.oninput = (ev) => {
    const legKey = ev.target.getAttribute?.("data-leg");
    const field = ev.target.getAttribute?.("data-field");
    if (!legKey || field === "date" || !ev.target.value) return;
    const dateInput = document.getElementById(`pe-${legKey}-date`);
    if (dateInput && !dateInput.value) {
      dateInput.value = legKey === "outbound" ? (state.startDate || "") : (state.endDate || "");
    }
  };

  el.modalBody.onclick = (ev) => {
    const legKey = ev.target.getAttribute?.("data-clear-leg");
    if (!legKey) return;
    LEG_FIELDS.forEach((f) => { const n = document.getElementById(`pe-${legKey}-${f}`); if (n) n.value = ""; });
    document.getElementById(`pe-${legKey}-flight`)?.focus();
  };

  if (isNew) nameInput.focus();

  async function save() {
    const name = nameInput.value.trim();
    if (!name) {
      nameMsg.textContent = "A name is needed.";
      nameMsg.className = "field-msg err";
      nameInput.focus();
      return;
    }
    const confirmed = document.querySelector('input[name="pe-status"]:checked')?.value === "yes";
    const note = document.getElementById("pe-note").value;
    const travel = { outbound: readLeg("outbound"), inbound: readLeg("inbound") };

    if (isNew) {
      closeModal();
      await dispatch({ type: "addPerson", params: { name, confirmed, note, travel } }, { optimistic: false });
      return;
    }

    const patch = {};
    if (name !== snap.name) patch.name = name;
    if (confirmed !== snap.confirmed) patch.confirmed = confirmed;
    if (note !== snap.note) patch.note = note;
    const legChanged = (k) => JSON.stringify(travel[k]) !== JSON.stringify(snap.travel[k]);
    if (legChanged("outbound") || legChanged("inbound")) {
      patch.travel = {};
      if (legChanged("outbound")) patch.travel.outbound = travel.outbound;
      if (legChanged("inbound")) patch.travel.inbound = travel.inbound;
    }

    const ops = [];
    if (Object.keys(patch).length) ops.push({ type: "updatePerson", params: { personId: person.id, ...patch } });

    const pairSel = document.getElementById("pe-pair");
    if (pairSel && pairSel.value !== snap.pairWith) {
      ops.push({ type: "setPair", params: { personId: person.id, otherId: pairSel.value || null } });
    }
    const pinBox = document.getElementById("pe-pinned");
    if (pinBox && pinBox.checked !== snap.pinned) {
      ops.push({ type: "setPinned", params: { personId: person.id, pinned: pinBox.checked } });
    }

    closeModal();
    if (!ops.length) { toast("Nothing changed."); return; }
    // One at a time, so each lands on top of the last rather than racing it.
    for (const op of ops) await dispatch(op);
  }
}

function confirmDelete(personId) {
  const dp = personById(state, personId);
  if (!dp) return;
  confirmDialog(
    `Delete ${dp.name}?`,
    `${dp.name} will be taken off the trip, out of any bed, and their flight details removed${syncMode === "shared" ? " — for everyone" : ""}. This can't be undone.`,
    "Delete",
    () => dispatch({ type: "deletePerson", params: { personId } })
  );
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
  if (action === "edit-person") { openPersonEditor(personId); return; }
  if (action === "edit-room") { openRoomEditor(roomId); return; }
  if (action === "assign") { openAssignPicker(personId); return; }
  if (action === "unassign") { dispatch({ type: "unassign", params: { personId } }); return; }
  if (action === "fill-slot") { openSlotPicker(roomId, slotId); return; }
  if (action === "delete-person") confirmDelete(personId);
});

document.addEventListener("change", (ev) => {
  const node = ev.target;
  const action = node.getAttribute?.("data-action");
  if (action === "mode") {
    dispatch({ type: "setRoomMode", params: { roomId: node.getAttribute("data-room"), mode: node.value } });
  }
});

el.search.addEventListener("input", () => {
  ui.search = el.search.value;
  render();
});

document.getElementById("btn-add-person").addEventListener("click", () => openPersonEditor(null));

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
