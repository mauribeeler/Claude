/*
 * plan-core.js — the whole room-allocation model, with no DOM and no network.
 *
 * This module is loaded by BOTH the browser (as an ES module) and the Netlify
 * function. Keeping one copy is what makes shared editing trustworthy: the
 * optimistic result you see locally is produced by exactly the same code the
 * server uses to decide the real answer, so the two cannot drift.
 *
 * Every exported operation is pure: it takes a state, returns a NEW state, and
 * never mutates its argument. That is what lets the server retry an operation
 * against fresher state after a write collision without any cleanup.
 */

export const SCHEMA_VERSION = 2;

export const STARTING_PEOPLE = [
  "Amelia", "Charles", "Courtney", "Graham", "Hannah", "Henry", "JJ", "Joel",
  "Mantas", "Nick", "Tim", "Tom", "Huxley", "Mauricio", "Minnie", "Toby", "John"
];

/* Invited but already said no — they stay on the list, marked Not going. */
const NOT_GOING_AT_START = ["Toby", "John"];

/* Zermatt, Sunday 31 Jan to Friday 5 Feb 2027 — five nights. */
export const TRIP_START = "2027-01-31";
export const TRIP_END = "2027-02-05";

/*
 * `beds` applies to dorm-type rooms, whose size isn't implied by a layout.
 * `autoFill: false` keeps a room out of Suggested Allocation — the Female
 * Dormitory is a specific booking, not a bed the algorithm may hand to anyone.
 */
export const ROOM_BLUEPRINT = [
  { id: "double1",    name: "Double Room 1",    type: "double", mode: "twin" },
  { id: "double2",    name: "Double Room 2",    type: "double", mode: "twin" },
  { id: "family",     name: "Family Room",      type: "family", mode: "fourSingles" },
  { id: "dorm",       name: "Dormitory",        type: "dorm",   mode: "standard", beds: 6 },
  { id: "femaleDorm", name: "Female Dormitory", type: "dorm",   mode: "standard", beds: 1, autoFill: false }
];

/* Hannah booked directly into the female dormitory, so the plan starts with
   her in it, pinned so Suggested Allocation leaves her alone. */
const FEMALE_DORM_OCCUPANT = "Hannah";

/* Default sizes only. Real capacity is always counted from a room's beds, so
   two rooms of the same type can be different sizes. */
export const DEFAULT_BEDS = { double: 2, family: 4, dorm: 6 };

export const ROOM_MODES = {
  double: [
    { value: "twin",   label: "Twin — 2 single beds" },
    { value: "couple", label: "Couple — 1 double bed" }
  ],
  family: [
    { value: "fourSingles",          label: "4 single beds" },
    { value: "doublePlusTwoSingles", label: "Double bed + 2 singles" }
  ],
  dorm: []
};

export const MAX_NAME = 40;
export const MAX_NOTE = 500;
export const MAX_PEOPLE = 60;

/* --------------------------------------------------------------------------
   ids + cloning
   -------------------------------------------------------------------------- */

let seq = 0;
export function uid(prefix) {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${rand}`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* An operation that the caller got wrong (full room, unknown person, …).
   Carries an HTTP-ish status so the function layer can answer sensibly. */
export class PlanError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PlanError";
    this.status = status;
  }
}

/* --------------------------------------------------------------------------
   slot generation
   -------------------------------------------------------------------------- */

function makeSlot(type, label) {
  return {
    id: uid("s"),
    type,
    capacity: type === "sharedDouble" ? 2 : 1,
    label,
    occupants: []
  };
}

export function createSlotsForRoom(roomType, mode, beds) {
  if (roomType === "double") {
    return mode === "couple"
      ? [makeSlot("sharedDouble", "Double bed")]
      : [makeSlot("single", "Single bed 1"), makeSlot("single", "Single bed 2")];
  }
  if (roomType === "family") {
    return mode === "doublePlusTwoSingles"
      ? [makeSlot("sharedDouble", "Double bed"), makeSlot("single", "Single bed 1"), makeSlot("single", "Single bed 2")]
      : [1, 2, 3, 4].map((i) => makeSlot("single", `Single bed ${i}`));
  }
  // Dorms carry their own size, so a one-bed dorm is as valid as a six-bunk one.
  const count = Math.max(1, Math.min(30, Number(beds) || DEFAULT_BEDS.dorm));
  if (count === 1) return [makeSlot("single", "Bed")];
  return Array.from({ length: count }, (_, i) => makeSlot("single", `Bunk ${i + 1}`));
}

export function defaultModeFor(roomType) {
  if (roomType === "double") return "twin";
  if (roomType === "family") return "fourSingles";
  return "standard";
}

export function validModesFor(roomType) {
  const list = ROOM_MODES[roomType] || [];
  return list.length ? list.map((m) => m.value) : ["standard"];
}

/* Counted from the beds themselves, never looked up by type — that is what
   lets the Female Dormitory hold one person while the Dormitory holds six. */
export function roomCapacity(room) {
  return room.slots.reduce((n, s) => n + s.capacity, 0);
}

export function roomOccupancy(room) {
  return room.slots.reduce((n, s) => n + s.occupants.length, 0);
}

export function makePerson(name) {
  return { id: uid("p"), name, confirmed: false, declined: false, note: "", pairWith: null, pinned: false, assignment: null };
}

/*
 * Three states, stored as two flags so plans saved before "Not going"
 * existed (no `declined` field) read correctly as before:
 *   going     confirmed && !declined
 *   invited   !confirmed && !declined   (asked, no answer yet)
 *   notGoing  declined
 */
export const STATUSES = ["going", "invited", "notGoing"];

export function statusOf(person) {
  if (person.declined) return "notGoing";
  return person.confirmed ? "going" : "invited";
}

/* People who still need somewhere to sleep: everyone except those not going. */
export const needsBed = (person) => !person.declined;

export function roomFromBlueprint(b) {
  return {
    id: b.id,
    name: b.name,
    type: b.type,
    mode: b.mode,
    beds: b.beds ?? DEFAULT_BEDS[b.type],
    autoFill: b.autoFill !== false,
    slots: createSlotsForRoom(b.type, b.mode, b.beds)
  };
}

export function initialState() {
  const state = {
    version: SCHEMA_VERSION,
    tripName: "Ski Trip 2027 — Zermatt",
    startDate: TRIP_START,
    endDate: TRIP_END,
    people: STARTING_PEOPLE.map(makePerson),
    rooms: ROOM_BLUEPRINT.map(roomFromBlueprint)
  };

  // Hannah's female-dorm place is already booked, so it is part of the
  // starting plan and pinned — Suggested Allocation must not move her.
  const hannah = state.people.find((p) => p.name === FEMALE_DORM_OCCUPANT);
  const femaleDorm = state.rooms.find((r) => r.id === "femaleDorm");
  if (hannah && femaleDorm && femaleDorm.slots.length) {
    femaleDorm.slots[0].occupants = [hannah.id];
    hannah.pinned = true;
  }
  state.people.forEach((p) => { if (NOT_GOING_AT_START.includes(p.name)) p.declined = true; });

  state.migrations = {};
  Object.keys(MIGRATIONS).forEach((k) => { state.migrations[k] = true; });
  return syncAssignments(state);
}

/* --------------------------------------------------------------------------
   migrations
   --------------------------------------------------------------------------

   A stored plan always wins over initialState(), so once a shared plan exists
   a redeploy can never change it. These bring an older stored plan up to date.

   Each one runs AT MOST ONCE, recorded in state.migrations. That matters: if
   the organiser later removes a person or room on purpose, it must stay
   removed rather than reappearing on the next page load.
   -------------------------------------------------------------------------- */

const MIGRATIONS = {
  /* Trip dates were added after the first plans were saved. */
  dates2027(state) {
    if (state.startDate && state.endDate) return false;
    state.startDate = state.startDate || TRIP_START;
    state.endDate = state.endDate || TRIP_END;
    return true;
  },

  /* Mauricio (the organiser) was added to the roster later. */
  organiser2027(state) {
    if (state.people.some((p) => p.name.trim().toLowerCase() === "mauricio")) return false;
    state.people.push(makePerson("Mauricio"));
    return true;
  },

  /* Minnie was added to the roster later. */
  guestMinnie2027(state) {
    if (state.people.some((p) => p.name.trim().toLowerCase() === "minnie")) return false;
    state.people.push(makePerson("Minnie"));
    return true;
  },

  /*
   * Toby and John said no after plans were already saved. They stay on the
   * list as Not going (bed freed, note kept). Exact name match, so JJ is
   * untouched.
   */
  removeTobyJohn2027(state) {
    const leaving = state.people.filter((p) => isNotGoingAtStart(p) && !p.declined);
    leaving.forEach((p) => markNotGoingIn(state, p));
    if (leaving.length) syncAssignments(state);
    return leaving.length > 0;
  },

  /*
   * An earlier version deleted Toby and John outright. Put them back as
   * Not going wherever that happened.
   */
  tobyJohnNotGoing2027(state) {
    let changed = false;
    for (const name of NOT_GOING_AT_START) {
      let p = state.people.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
      if (!p) {
        p = makePerson(name);
        state.people.push(p);
        changed = true;
      }
      if (!p.declined) {
        markNotGoingIn(state, p);
        changed = true;
      }
    }
    if (changed) syncAssignments(state);
    return changed;
  },

  /* The Female Dormitory and Hannah's booking were added later. */
  femaleDorm2027(state) {
    const exists = state.rooms.some((r) => r.id === "femaleDorm" || /female/i.test(r.name));
    if (exists) return false;
    const blueprint = ROOM_BLUEPRINT.find((b) => b.id === "femaleDorm");
    if (!blueprint) return false;
    const room = roomFromBlueprint(blueprint);
    state.rooms.push(room);

    const hannah = state.people.find((p) => p.name === FEMALE_DORM_OCCUPANT);
    if (hannah && !hannah.assignment) {
      room.slots[0].occupants = [hannah.id];
      hannah.pinned = true;
    }
    return true;
  }
};

/**
 * Bring a stored plan up to date. Returns the names of the migrations that
 * actually changed something, so the caller knows whether to persist.
 */
export function migratePlan(state) {
  if (!state.migrations || typeof state.migrations !== "object") state.migrations = {};
  const applied = [];
  for (const [key, run] of Object.entries(MIGRATIONS)) {
    if (state.migrations[key]) continue;
    if (run(state)) applied.push(key);
    state.migrations[key] = true;   // stamped either way, so it never repeats
  }
  return applied;
}

/* --------------------------------------------------------------------------
   lookups
   -------------------------------------------------------------------------- */

export const personById = (state, id) => state.people.find((p) => p.id === id) || null;
export const roomById = (state, id) => state.rooms.find((r) => r.id === id) || null;
export const slotById = (room, id) => room.slots.find((s) => s.id === id) || null;

/*
 * Slots are the single source of truth for occupancy; person.assignment is a
 * mirror. Rebuilding it here means a merged or imported state can never carry
 * a person in two beds, or a bed pointing at someone who has left the trip.
 */
export function syncAssignments(state) {
  const seen = new Set();
  state.people.forEach((p) => { p.assignment = null; });

  state.rooms.forEach((room) => {
    room.slots.forEach((slot) => {
      const kept = [];
      slot.occupants.forEach((pid) => {
        const person = personById(state, pid);
        if (!person || seen.has(pid)) return;
        seen.add(pid);
        kept.push(pid);
        person.assignment = { roomId: room.id, slotId: slot.id };
      });
      slot.occupants = kept;
    });
  });

  state.people.forEach((p) => {
    if (!p.pairWith) return;
    const other = personById(state, p.pairWith);
    if (!other || other.id === p.id || other.pairWith !== p.id) p.pairWith = null;
  });

  return state;
}

export function assignmentLabel(state, person) {
  if (!person.assignment) return null;
  const room = roomById(state, person.assignment.roomId);
  if (!room) return null;
  const slot = slotById(room, person.assignment.slotId);
  if (!slot) return null;
  const mates = slot.occupants
    .filter((id) => id !== person.id)
    .map((id) => personById(state, id)?.name ?? "?");
  return `${room.name} · ${slot.label}${mates.length ? ` (with ${mates.join(", ")})` : ""}`;
}

/* --------------------------------------------------------------------------
   derived stats
   -------------------------------------------------------------------------- */

export function getStats(state) {
  let confirmed = 0, assigned = 0, confirmedUnassigned = 0, notGoing = 0;
  state.people.forEach((p) => {
    if (p.declined) { notGoing += 1; return; }
    if (p.confirmed) confirmed += 1;
    if (p.assignment) assigned += 1;
    else if (p.confirmed) confirmedUnassigned += 1;
  });

  const total = state.people.length;
  const stillComing = total - notGoing;   // going or not answered yet
  const beds = state.rooms.reduce((n, r) => n + roomCapacity(r), 0);
  const occupied = state.rooms.reduce((n, r) => n + roomOccupancy(r), 0);

  return {
    total,
    going: confirmed,
    invited: stillComing - confirmed,
    notGoing,
    stillComing,
    confirmed,
    notConfirmed: stillComing - confirmed,
    assigned,
    unassigned: stillComing - assigned,
    beds,
    occupied,
    spacesRemaining: Math.max(0, beds - occupied),
    confirmedUnassigned,
    occupancyPct: beds > 0 ? Math.round((occupied / beds) * 100) : 0,
    // People who say they're not going don't need a bed.
    overCapacityBy: Math.max(0, stillComing - beds)
  };
}

/* --------------------------------------------------------------------------
   validation
   -------------------------------------------------------------------------- */

export function validateState(state) {
  const issues = [];
  const placements = new Map();

  state.rooms.forEach((room) => {
    const cap = roomCapacity(room);
    const occ = roomOccupancy(room);

    if (!validModesFor(room.type).includes(room.mode)) {
      issues.push({ level: "error", roomId: room.id, text: `${room.name} has an unrecognised layout (${room.mode}).` });
    }
    if (occ > cap) {
      issues.push({ level: "error", roomId: room.id, text: `${room.name} holds ${occ} people but only sleeps ${cap}. Move ${occ - cap} out.` });
    }

    room.slots.forEach((slot) => {
      if (slot.occupants.length > slot.capacity) {
        issues.push({
          level: "error", roomId: room.id, slotId: slot.id,
          text: `${room.name} · ${slot.label} has ${slot.occupants.length} people in a ${slot.capacity}-person bed.`
        });
      }
      slot.occupants.forEach((pid) => {
        if (!personById(state, pid)) {
          issues.push({ level: "error", roomId: room.id, text: `${room.name} · ${slot.label} refers to someone who is no longer on the trip.` });
          return;
        }
        placements.set(pid, (placements.get(pid) || 0) + 1);
      });
    });
  });

  placements.forEach((count, pid) => {
    if (count > 1) {
      issues.push({ level: "error", text: `${personById(state, pid)?.name ?? "Someone"} is in ${count} beds at once.` });
    }
  });

  const stats = getStats(state);

  if (stats.overCapacityBy > 0) {
    issues.push({
      level: "error",
      text: `${stats.stillComing} people coming or yet to reply, but only ${stats.beds} beds — ${stats.overCapacityBy} more ${stats.overCapacityBy === 1 ? "bed is" : "beds are"} needed.`
    });
  }

  if (stats.confirmedUnassigned > 0) {
    const names = state.people.filter((p) => p.confirmed && !p.assignment).map((p) => p.name);
    issues.push({
      level: "warn",
      text: `${stats.confirmedUnassigned} confirmed ${stats.confirmedUnassigned === 1 ? "person has" : "people have"} no bed: ${names.join(", ")}.`
    });
  }

  return issues;
}

/* --------------------------------------------------------------------------
   import normalisation
   -------------------------------------------------------------------------- */

export function normalizePlan(data) {
  if (!data || typeof data !== "object") throw new PlanError("That isn't a plan object.");
  if (!Array.isArray(data.people)) throw new PlanError("Missing a 'people' array.");
  if (!Array.isArray(data.rooms)) throw new PlanError("Missing a 'rooms' array.");
  if (data.people.length > MAX_PEOPLE) throw new PlanError(`That plan has more than ${MAX_PEOPLE} people.`);

  const usedIds = new Set();

  const people = data.people.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new PlanError(`Person #${i + 1} is not an object.`);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) throw new PlanError(`Person #${i + 1} has no name.`);
    const id = typeof raw.id === "string" && raw.id && !usedIds.has(raw.id) ? raw.id : uid("p");
    usedIds.add(id);
    return {
      id,
      name: name.slice(0, MAX_NAME),
      confirmed: raw.confirmed === true && raw.declined !== true,
      declined: raw.declined === true,
      note: typeof raw.note === "string" ? raw.note.slice(0, MAX_NOTE) : "",
      pairWith: typeof raw.pairWith === "string" ? raw.pairWith : null,
      pinned: raw.pinned === true,
      assignment: null
    };
  });

  const rooms = data.rooms.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new PlanError(`Room #${i + 1} is not an object.`);
    if (!DEFAULT_BEDS[raw.type]) throw new PlanError(`Room #${i + 1} has unknown type '${raw.type}'.`);
    const mode = validModesFor(raw.type).includes(raw.mode) ? raw.mode : defaultModeFor(raw.type);

    const beds = Number.isFinite(Number(raw.beds)) && Number(raw.beds) > 0
      ? Math.min(30, Math.round(Number(raw.beds)))
      : DEFAULT_BEDS[raw.type];

    let slots;
    if (Array.isArray(raw.slots) && raw.slots.length) {
      slots = raw.slots.map((rs, j) => {
        const stype = rs && rs.type === "sharedDouble" ? "sharedDouble" : "single";
        const slot = makeSlot(stype, rs && typeof rs.label === "string" && rs.label
          ? rs.label
          : (stype === "sharedDouble" ? "Double bed" : `Bed ${j + 1}`));
        if (rs && typeof rs.id === "string" && rs.id) slot.id = rs.id;
        slot.occupants = Array.isArray(rs?.occupants) ? rs.occupants.filter((x) => typeof x === "string") : [];
        return slot;
      });
    } else {
      slots = createSlotsForRoom(raw.type, mode, beds);
    }

    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : uid("r"),
      name: typeof raw.name === "string" && raw.name ? raw.name.slice(0, 60) : `Room ${i + 1}`,
      type: raw.type,
      mode,
      beds,
      autoFill: raw.autoFill !== false,
      slots
    };
  });

  if (!rooms.length) throw new PlanError("A plan needs at least one room.");

  const validDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

  return syncAssignments({
    version: SCHEMA_VERSION,
    tripName: typeof data.tripName === "string" && data.tripName ? data.tripName : "Ski Trip 2027 — Zermatt",
    startDate: validDate(data.startDate) ? data.startDate : TRIP_START,
    endDate: validDate(data.endDate) ? data.endDate : TRIP_END,
    migrations: (data.migrations && typeof data.migrations === "object") ? { ...data.migrations } : {},
    people,
    rooms
  });
}

/* --------------------------------------------------------------------------
   mutations — each returns a new state
   -------------------------------------------------------------------------- */

function removeAssignmentIn(state, personId) {
  state.rooms.forEach((room) => {
    room.slots.forEach((slot) => {
      slot.occupants = slot.occupants.filter((id) => id !== personId);
    });
  });
  const p = personById(state, personId);
  if (p) p.assignment = null;
}

const isNotGoingAtStart = (p) =>
  NOT_GOING_AT_START.some((n) => n.toLowerCase() === p.name.trim().toLowerCase());

/* Not going: no bed, no pin, and nobody left waiting to share with them. */
function markNotGoingIn(state, p) {
  p.confirmed = false;
  p.declined = true;
  removeAssignmentIn(state, p.id);
  p.pinned = false;
  if (p.pairWith) {
    const partner = personById(state, p.pairWith);
    if (partner && partner.pairWith === p.id) partner.pairWith = null;
  }
  state.people.forEach((x) => { if (x.pairWith === p.id) x.pairWith = null; });
  p.pairWith = null;
}

function assignIn(state, personId, roomId, slotId) {
  const person = personById(state, personId);
  if (!person) throw new PlanError("That person is no longer on the trip.", 409);
  const room = roomById(state, roomId);
  if (!room) throw new PlanError("That room no longer exists.", 409);
  const slot = slotById(room, slotId);
  if (!slot) throw new PlanError("That bed no longer exists — the room layout may have changed.", 409);
  if (person.declined) throw new PlanError(`${person.name} is marked as not going. Change that first to give them a bed.`, 409);

  if (slot.occupants.includes(personId)) return `${person.name} is already there.`;

  if (slot.occupants.length >= slot.capacity) {
    throw new PlanError(`${slot.label} in ${room.name} is already taken.`, 409);
  }
  if (roomOccupancy(room) >= roomCapacity(room)) {
    throw new PlanError(`${room.name} is already full.`, 409);
  }

  removeAssignmentIn(state, personId);
  slot.occupants.push(personId);
  person.assignment = { roomId: room.id, slotId: slot.id };
  return `${person.name} → ${room.name} · ${slot.label}`;
}

/*
 * Move a room's occupants into a freshly generated set of beds, keeping
 * couples together where a shared double exists. Anyone who cannot be seated
 * is parked in the last bed so they stay visible (and trip the over-capacity
 * warning) rather than silently vanishing. Returns those ids.
 */
function reseatInto(room, groups, newSlots) {
  const sharedTargets = newSlots.filter((s) => s.type === "sharedDouble");
  let loose = [];

  groups.forEach((g) => {
    if (!g.shared) { loose = loose.concat(g.ids); return; }
    const target = sharedTargets.find((s) => s.occupants.length === 0);
    if (!target) { loose = loose.concat(g.ids); return; }
    target.occupants = g.ids.slice(0, target.capacity);
    loose = loose.concat(g.ids.slice(target.capacity));
  });

  const unseated = [];
  loose.forEach((pid) => {
    const target = newSlots.find((s) => s.occupants.length < s.capacity);
    if (target) target.occupants.push(pid);
    else unseated.push(pid);
  });

  if (unseated.length && newSlots.length) {
    newSlots[newSlots.length - 1].occupants.push(...unseated);
  }

  room.slots = newSlots;
  return unseated;
}

function occupantGroups(room) {
  return room.slots
    .filter((s) => s.occupants.length > 0)
    .map((s) => ({ shared: s.type === "sharedDouble" && s.occupants.length > 1, ids: s.occupants.slice() }));
}

/*
 * Layout changes keep everyone who was in the room. Existing couples stay in a
 * shared double where the new layout has one; anyone who genuinely cannot be
 * re-seated is parked in the last bed so it shows up as an over-capacity
 * warning the organiser can resolve, rather than vanishing.
 */
function changeRoomModeIn(state, roomId, mode) {
  const room = roomById(state, roomId);
  if (!room) throw new PlanError("Room not found.", 409);
  if (!validModesFor(room.type).includes(mode)) throw new PlanError("Unsupported layout.");
  if (room.mode === mode) return "";

  const groups = occupantGroups(room);
  const newSlots = createSlotsForRoom(room.type, mode, room.beds);
  const unseated = reseatInto(room, groups, newSlots);

  room.mode = mode;
  syncAssignments(state);

  if (unseated.length) {
    const names = unseated.map((id) => personById(state, id)?.name ?? "?").join(", ");
    return `Layout changed, but ${names} no longer fit — resolve the highlighted bed.`;
  }
  return "Layout changed. Assignments kept.";
}

/*
 * Empty every bed and return rooms to their default layout — but a pinned
 * person is a confirmed booking, not an allocation choice, so they are put
 * straight back into the room they were in. Returns the ids it could not
 * re-seat (their room is gone or full).
 */
function resetAllocationsIn(state) {
  const pinned = state.people
    .filter((p) => p.pinned && p.assignment)
    .map((p) => ({ id: p.id, roomId: p.assignment.roomId }));

  state.rooms.forEach((room) => {
    const bp = ROOM_BLUEPRINT.find((b) => b.id === room.id);
    room.mode = bp ? bp.mode : defaultModeFor(room.type);
    room.slots = createSlotsForRoom(room.type, room.mode, room.beds ?? bp?.beds);
  });
  state.people.forEach((p) => { p.assignment = null; });

  const lost = [];
  pinned.forEach(({ id, roomId }) => {
    const room = roomById(state, roomId);
    // Slot ids are regenerated, so re-seat by room and take the first free bed.
    const slot = room && room.slots.find((s) => s.occupants.length < s.capacity);
    if (slot) slot.occupants.push(id);
    else lost.push(id);
  });

  syncAssignments(state);
  return lost;
}

/*
 * Suggested allocation: confirmed travellers first, mutual bed-sharing pairs
 * into the double rooms, then the family room, then the dormitory. Strangers
 * are never put in the same bed, and capacity is never exceeded.
 */
function suggestIn(state) {
  const lostPins = resetAllocationsIn(state);

  // Pinned people keep the bed they were put back into and take no further
  // part — their place is booked, not up for reallocation.
  // People not going are left out entirely.
  const queue = [
    ...state.people.filter((p) => !p.declined && p.confirmed && !p.assignment),
    ...state.people.filter((p) => !p.declined && !p.confirmed && !p.assignment)
  ];

  const taken = new Set();
  const pairs = [];
  const singles = [];

  queue.forEach((p) => {
    if (taken.has(p.id)) return;
    if (p.pairWith) {
      const other = personById(state, p.pairWith);
      // A partner who is pinned already has a bed and must not be re-seated.
      if (other && !other.assignment && !taken.has(other.id) && other.pairWith === p.id) {
        taken.add(p.id); taken.add(other.id);
        pairs.push([p, other]);
        return;
      }
    }
    taken.add(p.id);
    singles.push(p);
  });

  /* Rooms marked autoFill:false — the Female Dormitory — are specific
     bookings and are never filled by the algorithm. They can still be used
     manually. Rooms already holding a pinned person are left alone too, so
     switching a layout can never eject a booked bed. */
  const usable = state.rooms.filter((r) => r.autoFill !== false);
  const isEmpty = (r) => roomOccupancy(r) === 0;
  const doubles = usable.filter((r) => r.type === "double");
  const family = usable.find((r) => r.type === "family");
  const dorms = usable.filter((r) => r.type === "dorm");
  const usedDoubles = new Set();

  let pairIdx = 0;
  for (const room of doubles) {
    if (pairIdx >= pairs.length) break;
    if (!isEmpty(room)) continue;
    room.mode = "couple";
    room.slots = createSlotsForRoom(room.type, "couple", room.beds);
    room.slots[0].occupants = pairs[pairIdx].map((p) => p.id);
    usedDoubles.add(room.id);
    pairIdx += 1;
  }

  if (pairIdx < pairs.length && family && isEmpty(family)) {
    family.mode = "doublePlusTwoSingles";
    family.slots = createSlotsForRoom(family.type, "doublePlusTwoSingles", family.beds);
    family.slots[0].occupants = pairs[pairIdx].map((p) => p.id);
    pairIdx += 1;
  }

  // pairs we could not seat as a couple fall back to being individuals
  while (pairIdx < pairs.length) {
    singles.push(pairs[pairIdx][0], pairs[pairIdx][1]);
    pairIdx += 1;
  }

  const fillOrder = [
    ...doubles.filter((r) => !usedDoubles.has(r.id)),
    ...(family ? [family] : []),
    ...dorms
  ];

  let qi = 0;
  fillOrder.forEach((room) => {
    room.slots.forEach((slot) => {
      if (slot.type === "sharedDouble") return; // never sit strangers in one bed
      while (slot.occupants.length < slot.capacity && qi < singles.length) {
        if (roomOccupancy(room) >= roomCapacity(room)) return;
        slot.occupants.push(singles[qi].id);
        qi += 1;
      }
    });
  });

  syncAssignments(state);

  const leftOut = singles.length - qi;
  const seated = state.people.filter((p) => p.assignment).length;
  const parts = [`Allocated ${seated} people.`];
  if (leftOut > 0) parts.push(`${leftOut} left without a bed — not enough beds.`);
  if (lostPins.length) {
    const names = lostPins.map((id) => personById(state, id)?.name ?? "?").join(", ");
    parts.push(`Could not put ${names} back in their booked room.`);
  }
  return parts.join(" ");
}

/* --------------------------------------------------------------------------
   the operation table — the only way state ever changes
   -------------------------------------------------------------------------- */

const OPS = {
  setConfirmed(state, { personId, confirmed }) {
    const p = personById(state, personId);
    if (!p) throw new PlanError("That person is no longer on the trip.", 409);
    p.confirmed = confirmed === true;
    if (p.confirmed) p.declined = false;
    return `${p.name} marked ${p.confirmed ? "confirmed" : "not confirmed"}.`;
  },

  /*
   * Going / invited (no reply yet) / not going. Marking someone not going
   * frees their bed and ends any bed-sharing pairing, so the space shows as
   * available straight away.
   */
  setStatus(state, { personId, status }) {
    const p = personById(state, personId);
    if (!p) throw new PlanError("That person is no longer on the trip.", 409);
    if (!STATUSES.includes(status)) throw new PlanError("Unknown status.");

    p.confirmed = status === "going";
    p.declined = status === "notGoing";

    if (p.declined) {
      const hadBed = !!p.assignment;
      markNotGoingIn(state, p);
      return hadBed ? `${p.name} is not going — their bed is free.` : `${p.name} is not going.`;
    }
    return status === "going" ? `${p.name} is going.` : `${p.name} is invited — waiting to hear back.`;
  },

  setNote(state, { personId, note }) {
    const p = personById(state, personId);
    if (!p) throw new PlanError("That person is no longer on the trip.", 409);
    p.note = String(note ?? "").slice(0, MAX_NOTE);
    return "";
  },

  addPerson(state, { name, status }) {
    const clean = String(name ?? "").trim().slice(0, MAX_NAME);
    if (!clean) throw new PlanError("A name is required.");
    if (state.people.length >= MAX_PEOPLE) throw new PlanError(`This plan is capped at ${MAX_PEOPLE} people.`);
    const person = makePerson(clean);
    if (status === "going") person.confirmed = true;
    state.people.push(person);
    return status === "going" ? `${clean} added as going.` : `${clean} invited.`;
  },

  deletePerson(state, { personId }) {
    const p = personById(state, personId);
    if (!p) return ""; // already gone: someone else removed them, nothing to do
    removeAssignmentIn(state, personId);
    state.people = state.people.filter((x) => x.id !== personId);
    state.people.forEach((x) => { if (x.pairWith === personId) x.pairWith = null; });
    return `${p.name} removed from the trip.`;
  },

  setPair(state, { personId, otherId }) {
    const me = personById(state, personId);
    if (!me) throw new PlanError("That person is no longer on the trip.", 409);

    if (me.pairWith) {
      const prev = personById(state, me.pairWith);
      if (prev) prev.pairWith = null;
    }
    me.pairWith = null;

    if (otherId) {
      const other = personById(state, otherId);
      if (!other) throw new PlanError("That person is no longer on the trip.", 409);
      if (other.pairWith) {
        const otherPrev = personById(state, other.pairWith);
        if (otherPrev) otherPrev.pairWith = null;
      }
      me.pairWith = other.id;
      other.pairWith = me.id;
      return `${me.name} and ${other.name} are sharing a bed.`;
    }
    return "";
  },

  assign(state, { personId, roomId, slotId }) {
    return assignIn(state, personId, roomId, slotId);
  },

  unassign(state, { personId }) {
    const p = personById(state, personId);
    if (!p) return "";
    removeAssignmentIn(state, personId);
    return `${p.name} removed from their bed.`;
  },

  setRoomMode(state, { roomId, mode }) {
    return changeRoomModeIn(state, roomId, mode);
  },

  suggest(state) {
    return suggestIn(state);
  },

  resetAllocations(state) {
    const lost = resetAllocationsIn(state);
    return lost.length
      ? "All beds emptied. Booked places kept, except for those whose room no longer fits them."
      : "All beds emptied. Booked places kept.";
  },

  /* --- accommodation ---------------------------------------------------
     Rooms are data, not code: book a room, add it here, and the allocation
     picks it up. */

  addRoom(state, { name, type, beds, autoFill }) {
    const clean = String(name ?? "").trim().slice(0, 60);
    if (!clean) throw new PlanError("The room needs a name.");
    if (!DEFAULT_BEDS[type]) throw new PlanError(`'${type}' is not a room type.`);
    if (state.rooms.length >= 20) throw new PlanError("That's as many rooms as this plan holds.");

    const mode = defaultModeFor(type);
    const size = type === "dorm"
      ? Math.max(1, Math.min(30, Math.round(Number(beds)) || DEFAULT_BEDS.dorm))
      : DEFAULT_BEDS[type];

    state.rooms.push({
      id: uid("r"),
      name: clean,
      type,
      mode,
      beds: size,
      autoFill: autoFill !== false,
      slots: createSlotsForRoom(type, mode, size)
    });
    return `${clean} added — ${size} bed${size === 1 ? "" : "s"}.`;
  },

  renameRoom(state, { roomId, name }) {
    const room = roomById(state, roomId);
    if (!room) throw new PlanError("That room no longer exists.", 409);
    const clean = String(name ?? "").trim().slice(0, 60);
    if (!clean) throw new PlanError("The room needs a name.");
    room.name = clean;
    return "";
  },

  /* Change how many beds a dorm has. Occupants are re-seated, and anyone who
     no longer fits is parked visibly rather than dropped. */
  setRoomBeds(state, { roomId, beds }) {
    const room = roomById(state, roomId);
    if (!room) throw new PlanError("That room no longer exists.", 409);
    if (room.type !== "dorm") throw new PlanError(`${room.name}'s size is set by its layout, not a bed count.`);

    const size = Math.max(1, Math.min(30, Math.round(Number(beds))));
    if (!Number.isFinite(size)) throw new PlanError("That isn't a number of beds.");
    if (size === roomCapacity(room)) return "";

    const groups = occupantGroups(room);
    room.beds = size;
    const unseated = reseatInto(room, groups, createSlotsForRoom(room.type, room.mode, size));
    syncAssignments(state);

    if (unseated.length) {
      const names = unseated.map((id) => personById(state, id)?.name ?? "?").join(", ");
      return `${room.name} now has ${size} bed${size === 1 ? "" : "s"}, but ${names} no longer fit — move them.`;
    }
    return `${room.name} now has ${size} bed${size === 1 ? "" : "s"}.`;
  },

  setRoomAutoFill(state, { roomId, autoFill }) {
    const room = roomById(state, roomId);
    if (!room) throw new PlanError("That room no longer exists.", 409);
    room.autoFill = autoFill !== false;
    return room.autoFill
      ? `${room.name} will be used by Suggested Allocation.`
      : `${room.name} is booked separately and won't be filled automatically.`;
  },

  removeRoom(state, { roomId }) {
    const room = roomById(state, roomId);
    if (!room) return "";
    if (state.rooms.length <= 1) throw new PlanError("A plan needs at least one room.");
    const displaced = room.slots.flatMap((sl) => sl.occupants);
    state.rooms = state.rooms.filter((r) => r.id !== roomId);
    syncAssignments(state);
    return displaced.length
      ? `${room.name} removed — ${displaced.length} ${displaced.length === 1 ? "person needs" : "people need"} a new bed.`
      : `${room.name} removed.`;
  },

  setTripDates(state, { startDate, endDate }) {
    const valid = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
    if (!valid(startDate) || !valid(endDate)) throw new PlanError("Dates must look like 2027-01-31.");
    if (Date.parse(endDate) <= Date.parse(startDate)) throw new PlanError("The end date must be after the start date.");
    state.startDate = startDate;
    state.endDate = endDate;
    return "Trip dates updated.";
  },

  /* Pin someone whose bed is already booked — Suggested Allocation and
     Reset allocations both put them straight back rather than moving them. */
  setPinned(state, { personId, pinned }) {
    const p = personById(state, personId);
    if (!p) throw new PlanError("That person is no longer on the trip.", 409);
    p.pinned = pinned === true;
    if (p.pinned && !p.assignment) {
      throw new PlanError(`Give ${p.name} a bed before pinning it as booked.`);
    }
    return p.pinned ? `${p.name}'s bed is pinned as booked.` : `${p.name}'s bed is no longer pinned.`;
  },

  resetAll() {
    return { replaceWith: initialState(), message: "Everything reset." };
  },

  replace(state, { plan }) {
    return { replaceWith: normalizePlan(plan), message: "Plan imported." };
  }
};

export const OP_NAMES = Object.keys(OPS);

/**
 * Apply one operation to a state, returning a brand new state.
 * Never mutates `state`, so the server can safely retry against fresher data.
 */
export function applyOp(state, op) {
  if (!op || typeof op !== "object") throw new PlanError("Missing operation.");
  const handler = OPS[op.type];
  if (!handler) throw new PlanError(`Unknown operation '${op.type}'.`);

  const next = clone(state);
  const result = handler(next, op.params || {});

  if (result && typeof result === "object" && result.replaceWith) {
    return { state: syncAssignments(result.replaceWith), message: result.message || "" };
  }
  return { state: syncAssignments(next), message: typeof result === "string" ? result : "" };
}
