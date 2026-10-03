/*
 * Tests for the shared plan model and the Netlify function that fronts it.
 *
 * The concurrency block is the important one: it proves that two people
 * editing at the same time both keep their change, which is the whole reason
 * the server takes operations rather than whole documents.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  initialState, applyOp, getStats, validateState, createSlotsForRoom,
  personById, roomById, normalizePlan, syncAssignments, PlanError, clone,
  roomCapacity, roomOccupancy, migratePlan
} from "../public/plan-core.js";

import { handleRequest } from "../netlify/functions/plan.mjs";

/* ---------------------------------------------------------------------------
   A fake Netlify Blobs store with real compare-and-swap semantics.
   --------------------------------------------------------------------------- */
function fakeStore() {
  let entry = null;          // { data, etag }
  let counter = 0;
  const store = {
    writes: 0,
    collisions: 0,
    async getWithMetadata() {
      return entry ? { data: clone(entry.data), etag: entry.etag } : null;
    },
    async setJSON(key, data, opts = {}) {
      store.writes += 1;
      if (opts.onlyIfNew && entry) { store.collisions += 1; return { modified: false }; }
      if (opts.onlyIfMatch && (!entry || entry.etag !== opts.onlyIfMatch)) {
        store.collisions += 1;
        return { modified: false };
      }
      counter += 1;
      entry = { data: clone(data), etag: `etag-${counter}` };
      return { modified: true, etag: entry.etag };
    },
    /* Let a test wedge another writer in between read and write. */
    _forceWrite(data) {
      counter += 1;
      entry = { data: clone(data), etag: `etag-${counter}` };
    },
    _peek() { return entry; }
  };
  return store;
}

const req = (method, body, headers = {}) => new Request("https://example.test/api/plan", {
  method,
  headers: { "content-type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body)
});

const post = async (store, op, actor = "Tester", headers = {}) => {
  const res = await handleRequest(req("POST", { op, actor }, headers), store);
  return { res, body: await res.json() };
};

/* ===========================================================================
   Model
   =========================================================================== */

test("boots with the 15 names and the five rooms", () => {
  const s = initialState();
  assert.equal(s.people.length, 15);
  assert.equal(s.people[0].name, "Amelia");
  assert.equal(s.people.at(-1).name, "Minnie");
  assert.ok(s.people.every((p) => !p.confirmed && p.note === ""));
  assert.deepEqual(s.rooms.map((r) => r.name),
    ["Double Room 1", "Double Room 2", "Family Room", "Dormitory", "Female Dormitory"]);
  assert.deepEqual(s.rooms.map((r) => r.slots.length), [2, 2, 4, 6, 1]);
});

test("Hannah starts in the Female Dormitory, pinned, and nobody else is placed", () => {
  const s = initialState();
  const hannah = s.people.find((p) => p.name === "Hannah");
  const femaleDorm = roomById(s, "femaleDorm");

  assert.equal(femaleDorm.slots[0].occupants[0], hannah.id);
  assert.equal(hannah.assignment.roomId, "femaleDorm");
  assert.equal(hannah.pinned, true, "her booking is pinned, not an allocation choice");
  assert.equal(roomCapacity(femaleDorm), 1, "a one-bed dorm, not the default six");
  assert.equal(s.people.filter((p) => p.assignment).length, 1, "only Hannah is placed");
});

test("15 people fit the 15 beds exactly, so there is no shortfall", () => {
  const s = initialState();
  const stats = getStats(s);
  assert.equal(stats.beds, 15, "2 + 2 + 4 + 6 + 1");
  assert.equal(stats.total, 15);
  assert.equal(stats.overCapacityBy, 0);
  assert.equal(validateState(s).filter((i) => /nowhere to sleep/.test(i.text)).length, 0);
});

test("Toby and John are not on the list, and JJ is", () => {
  const names = initialState().people.map((p) => p.name);
  assert.ok(!names.includes("Toby"));
  assert.ok(!names.includes("John"));
  assert.ok(names.includes("JJ"));
});

test("a 16th person is flagged as having nowhere to sleep", () => {
  let s = initialState();
  s = applyOp(s, { type: "addPerson", params: { name: "Bruno" } }).state;
  assert.equal(getStats(s).overCapacityBy, 1);
  assert.ok(validateState(s).some((i) => i.level === "error" && /nowhere to sleep/.test(i.text)));
});

test("the trip runs 31 Jan to 5 Feb 2027", () => {
  const s = initialState();
  assert.equal(s.startDate, "2027-01-31");
  assert.equal(s.endDate, "2027-02-05");
  const nights = Math.round((Date.parse(s.endDate) - Date.parse(s.startDate)) / 86400000);
  assert.equal(nights, 5);
});

test("trip dates can be changed, and nonsense is refused", () => {
  let s = initialState();
  s = applyOp(s, { type: "setTripDates", params: { startDate: "2027-02-01", endDate: "2027-02-07" } }).state;
  assert.equal(s.startDate, "2027-02-01");
  for (const bad of [{ startDate: "31/01/2027", endDate: "2027-02-05" },
                     { startDate: "2027-02-05", endDate: "2027-01-31" },
                     { startDate: "2027-02-05", endDate: "2027-02-05" }]) {
    assert.throws(() => applyOp(s, { type: "setTripDates", params: bad }), PlanError);
  }
});

test("adding a room adds beds and clears the shortfall", () => {
  let s = initialState();
  s = applyOp(s, { type: "addPerson", params: { name: "Bruno" } }).state;
  s = applyOp(s, { type: "addPerson", params: { name: "Rosa" } }).state;
  assert.equal(getStats(s).overCapacityBy, 2);
  s = applyOp(s, { type: "addRoom", params: { name: "Twin Room 3", type: "double" } }).state;
  assert.equal(s.rooms.length, 6);
  assert.equal(getStats(s).beds, 17);
  assert.equal(getStats(s).overCapacityBy, 0, "17 people now have somewhere to sleep");
  assert.equal(validateState(s).filter((i) => /nowhere to sleep/.test(i.text)).length, 0);
});

test("a new room is used by Suggested Allocation", () => {
  let s = initialState();
  s = applyOp(s, { type: "addPerson", params: { name: "Bruno" } }).state;
  s = applyOp(s, { type: "addPerson", params: { name: "Rosa" } }).state;
  s = applyOp(s, { type: "addRoom", params: { name: "Twin Room 4", type: "double" } }).state;
  s.people.forEach((p) => { p.confirmed = true; });
  s = applyOp(s, { type: "suggest", params: {} }).state;
  assert.equal(getStats(s).assigned, 17, "everyone including Mauricio and Minnie gets a bed");
  assert.equal(getStats(s).confirmedUnassigned, 0);
});

test("a dorm can be resized, keeping whoever fits", () => {
  let s = initialState();
  s.people.forEach((p) => { p.confirmed = true; });
  s = applyOp(s, { type: "suggest", params: {} }).state;
  const dorm = roomById(s, "dorm");
  assert.equal(roomOccupancy(dorm), 6);

  s = applyOp(s, { type: "setRoomBeds", params: { roomId: "dorm", beds: 7 } }).state;
  assert.equal(roomCapacity(roomById(s, "dorm")), 7);
  assert.equal(roomOccupancy(roomById(s, "dorm")), 6, "nobody displaced by growing it");
  assert.equal(getStats(s).beds, 16);
});

test("shrinking a dorm keeps the people visible rather than dropping them", () => {
  let s = initialState();
  s.people.forEach((p) => { p.confirmed = true; });
  s = applyOp(s, { type: "suggest", params: {} }).state;
  const before = roomOccupancy(roomById(s, "dorm"));

  const out = applyOp(s, { type: "setRoomBeds", params: { roomId: "dorm", beds: 2 } });
  s = out.state;
  assert.equal(roomOccupancy(roomById(s, "dorm")), before, "everyone is still accounted for");
  assert.match(out.message, /no longer fit/);
  assert.ok(validateState(s).some((i) => i.level === "error"), "and it is flagged as over capacity");
});

test("only dorms take a bed count", () => {
  const s = initialState();
  assert.throws(() => applyOp(s, { type: "setRoomBeds", params: { roomId: "double1", beds: 3 } }), PlanError);
});

test("removing a room frees its occupants rather than losing them", () => {
  let s = initialState();
  s.people.forEach((p) => { p.confirmed = true; });
  s = applyOp(s, { type: "suggest", params: {} }).state;
  const before = getStats(s).assigned;

  const out = applyOp(s, { type: "removeRoom", params: { roomId: "dorm" } });
  s = out.state;
  assert.equal(s.rooms.length, 4);
  assert.equal(getStats(s).assigned, before - 6);
  assert.match(out.message, /need a new bed/);
  assert.equal(validateState(s).filter((i) => /two beds|beds at once/.test(i.text)).length, 0);
});

test("rooms can be renamed and taken out of auto-fill", () => {
  let s = initialState();
  s = applyOp(s, { type: "renameRoom", params: { roomId: "dorm", name: "Boys' Bunk Room" } }).state;
  assert.equal(roomById(s, "dorm").name, "Boys' Bunk Room");

  s = applyOp(s, { type: "setRoomAutoFill", params: { roomId: "dorm", autoFill: false } }).state;
  s.people.forEach((p) => { p.confirmed = true; });
  s = applyOp(s, { type: "suggest", params: {} }).state;
  assert.equal(roomOccupancy(roomById(s, "dorm")), 0, "excluded room stays empty");
});

test("dates and room settings survive an export/import round trip", () => {
  let s = initialState();
  s = applyOp(s, { type: "addRoom", params: { name: "Attic Twin", type: "dorm", beds: 2 } }).state;
  s = applyOp(s, { type: "setTripDates", params: { startDate: "2027-01-30", endDate: "2027-02-06" } }).state;

  const back = normalizePlan(JSON.parse(JSON.stringify(s)));
  assert.equal(back.startDate, "2027-01-30");
  assert.equal(back.endDate, "2027-02-06");
  assert.equal(back.rooms.length, 6);
  assert.equal(back.rooms.find((r) => r.name === "Attic Twin").slots.length, 2);
  assert.equal(back.rooms.find((r) => r.id === "femaleDorm").autoFill, false);
  assert.equal(back.people.find((p) => p.name === "Hannah").pinned, true);
});

test("slot shapes follow room type and mode", () => {
  assert.equal(createSlotsForRoom("double", "couple").length, 1);
  assert.equal(createSlotsForRoom("double", "couple")[0].capacity, 2);
  assert.deepEqual(
    createSlotsForRoom("family", "doublePlusTwoSingles").map((s) => s.type),
    ["sharedDouble", "single", "single"]
  );
});

test("applyOp never mutates the state it is given", () => {
  const s = initialState();
  const before = JSON.stringify(s);
  applyOp(s, { type: "setConfirmed", params: { personId: s.people[0].id, confirmed: true } });
  assert.equal(JSON.stringify(s), before);
});

test("a single bed refuses a second person, and a full room refuses a third", () => {
  let s = initialState();
  const [a, b, c] = s.people;
  const d1 = roomById(s, "double1");

  s = applyOp(s, { type: "assign", params: { personId: a.id, roomId: "double1", slotId: d1.slots[0].id } }).state;
  assert.throws(
    () => applyOp(s, { type: "assign", params: { personId: b.id, roomId: "double1", slotId: d1.slots[0].id } }),
    (e) => e instanceof PlanError && /already taken/.test(e.message)
  );

  s = applyOp(s, { type: "assign", params: { personId: b.id, roomId: "double1", slotId: d1.slots[1].id } }).state;
  assert.throws(
    () => applyOp(s, { type: "assign", params: { personId: c.id, roomId: "double1", slotId: d1.slots[0].id } }),
    (e) => e instanceof PlanError && /full|taken/.test(e.message)
  );
});

test("moving someone empties the bed they left", () => {
  let s = initialState();
  const a = s.people[0];
  const d1 = roomById(s, "double1");
  s = applyOp(s, { type: "assign", params: { personId: a.id, roomId: "double1", slotId: d1.slots[0].id } }).state;
  s = applyOp(s, { type: "assign", params: { personId: a.id, roomId: "dorm", slotId: roomById(s, "dorm").slots[0].id } }).state;

  assert.equal(roomById(s, "double1").slots[0].occupants.length, 0);
  const appearances = s.rooms.flatMap((r) => r.slots).filter((sl) => sl.occupants.includes(a.id)).length;
  assert.equal(appearances, 1);
  assert.equal(validateState(s).filter((i) => /beds at once/.test(i.text)).length, 0);
});

test("a shared double holds exactly two", () => {
  let s = initialState();
  s = applyOp(s, { type: "setRoomMode", params: { roomId: "double2", mode: "couple" } }).state;
  const slotId = roomById(s, "double2").slots[0].id;
  s = applyOp(s, { type: "assign", params: { personId: s.people[0].id, roomId: "double2", slotId } }).state;
  s = applyOp(s, { type: "assign", params: { personId: s.people[1].id, roomId: "double2", slotId } }).state;
  assert.equal(roomById(s, "double2").slots[0].occupants.length, 2);
  assert.throws(() => applyOp(s, { type: "assign", params: { personId: s.people[2].id, roomId: "double2", slotId } }), PlanError);
});

test("layout changes keep everyone, and keep couples together", () => {
  let s = initialState();
  s = applyOp(s, { type: "setRoomMode", params: { roomId: "double2", mode: "couple" } }).state;
  const slotId = roomById(s, "double2").slots[0].id;
  s = applyOp(s, { type: "assign", params: { personId: s.people[0].id, roomId: "double2", slotId } }).state;
  s = applyOp(s, { type: "assign", params: { personId: s.people[1].id, roomId: "double2", slotId } }).state;

  s = applyOp(s, { type: "setRoomMode", params: { roomId: "double2", mode: "twin" } }).state;
  assert.equal(roomById(s, "double2").slots.length, 2);
  assert.equal(roomById(s, "double2").slots.flatMap((sl) => sl.occupants).length, 2);

  s = applyOp(s, { type: "setRoomMode", params: { roomId: "double2", mode: "couple" } }).state;
  assert.equal(roomById(s, "double2").slots[0].occupants.length, 2, "twin -> couple regroups the pair");
});

test("family room keeps all four through a layout change", () => {
  let s = initialState();
  const fam = roomById(s, "family");
  [0, 1, 2, 3].forEach((i) => {
    s = applyOp(s, { type: "assign", params: { personId: s.people[i].id, roomId: "family", slotId: fam.slots[i].id } }).state;
  });
  s = applyOp(s, { type: "setRoomMode", params: { roomId: "family", mode: "doublePlusTwoSingles" } }).state;

  const after = roomById(s, "family");
  assert.equal(after.slots.length, 3);
  assert.equal(after.slots.flatMap((sl) => sl.occupants).length, 4);
  assert.equal(after.slots[0].occupants.length, 2);
  assert.equal(validateState(s).filter((i) => i.level === "error" && /person bed/.test(i.text)).length, 0);
});

test("confirmed people with no bed are flagged", () => {
  let s = initialState();
  s = applyOp(s, { type: "setConfirmed", params: { personId: s.people[0].id, confirmed: true } }).state;
  assert.equal(getStats(s).confirmedUnassigned, 1);
  assert.ok(validateState(s).some((i) => i.level === "warn" && /no bed/.test(i.text)));
});

test("suggested allocation seats all 15, with nobody left out", () => {
  let s = initialState();
  s.people.forEach((p) => { p.confirmed = true; });
  s = applyOp(s, { type: "suggest", params: {} }).state;

  const stats = getStats(s);
  assert.equal(stats.assigned, 15, "every bed used");
  assert.equal(stats.confirmedUnassigned, 0, "everyone has a bed");
  assert.ok(stats.occupied <= stats.beds);
  assert.equal(validateState(s).filter((i) => i.level === "error" && !/nowhere to sleep/.test(i.text)).length, 0);
  assert.ok(s.rooms.filter((r) => r.type === "double").every((r) => r.mode === "twin"), "no pairs means no couple rooms");
});

test("Suggested Allocation leaves Hannah in the female dorm and puts nobody else there", () => {
  let s = initialState();
  s.people.forEach((p) => { p.confirmed = true; });
  const hannahId = s.people.find((p) => p.name === "Hannah").id;

  s = applyOp(s, { type: "suggest", params: {} }).state;

  const femaleDorm = roomById(s, "femaleDorm");
  assert.deepEqual(femaleDorm.slots[0].occupants, [hannahId], "still hers, and hers alone");
  assert.equal(personById(s, hannahId).assignment.roomId, "femaleDorm");
});

test("a room marked autoFill:false is never filled by the algorithm", () => {
  let s = initialState();
  // Free the female dorm, then allocate: it must stay empty rather than
  // absorb whoever is left over.
  const hannahId = s.people.find((p) => p.name === "Hannah").id;
  s = applyOp(s, { type: "setPinned", params: { personId: hannahId, pinned: false } }).state;
  s = applyOp(s, { type: "unassign", params: { personId: hannahId } }).state;
  s.people.forEach((p) => { p.confirmed = true; });

  s = applyOp(s, { type: "suggest", params: {} }).state;

  assert.equal(roomOccupancy(roomById(s, "femaleDorm")), 0, "left for a specific booking");
  assert.equal(getStats(s).assigned, 14, "the other 14 beds are filled");
});

test("the female dorm can still be filled by hand", () => {
  let s = initialState();
  const hannahId = s.people.find((p) => p.name === "Hannah").id;
  s = applyOp(s, { type: "setPinned", params: { personId: hannahId, pinned: false } }).state;
  s = applyOp(s, { type: "unassign", params: { personId: hannahId } }).state;

  const slotId = roomById(s, "femaleDorm").slots[0].id;
  const amelia = s.people.find((p) => p.name === "Amelia");
  s = applyOp(s, { type: "assign", params: { personId: amelia.id, roomId: "femaleDorm", slotId } }).state;
  assert.deepEqual(roomById(s, "femaleDorm").slots[0].occupants, [amelia.id]);
});

test("the one-bed female dorm refuses a second person", () => {
  const s = initialState();
  const slotId = roomById(s, "femaleDorm").slots[0].id;
  assert.throws(
    () => applyOp(s, { type: "assign", params: { personId: s.people[0].id, roomId: "femaleDorm", slotId } }),
    (e) => e instanceof PlanError && /taken|full/.test(e.message)
  );
});

test("Reset allocations empties every bed but keeps booked places", () => {
  let s = initialState();
  s.people.forEach((p) => { p.confirmed = true; });
  s = applyOp(s, { type: "suggest", params: {} }).state;
  assert.equal(getStats(s).assigned, 15);

  s = applyOp(s, { type: "resetAllocations", params: {} }).state;
  const hannah = s.people.find((p) => p.name === "Hannah");
  assert.equal(getStats(s).assigned, 1, "only the pinned booking remains");
  assert.equal(hannah.assignment.roomId, "femaleDorm");
});

test("unpinning lets a booking be cleared like any other", () => {
  let s = initialState();
  const hannahId = s.people.find((p) => p.name === "Hannah").id;
  s = applyOp(s, { type: "setPinned", params: { personId: hannahId, pinned: false } }).state;
  s = applyOp(s, { type: "resetAllocations", params: {} }).state;
  assert.equal(getStats(s).assigned, 0);
});

test("pinning someone with no bed is refused with a clear reason", () => {
  const s = initialState();
  const huxley = s.people.find((p) => p.name === "Huxley");
  assert.throws(
    () => applyOp(s, { type: "setPinned", params: { personId: huxley.id, pinned: true } }),
    (e) => e instanceof PlanError && /before pinning/.test(e.message)
  );
});

test("suggested allocation seats pairs together and confirmed people first", () => {
  let s = initialState();
  const P = s.people;
  P[0].confirmed = P[1].confirmed = P[2].confirmed = P[3].confirmed = true;
  P[0].pairWith = P[1].id; P[1].pairWith = P[0].id;
  P[2].pairWith = P[3].id; P[3].pairWith = P[2].id;
  for (let i = 4; i < 10; i++) P[i].confirmed = true;

  s = applyOp(s, { type: "suggest", params: {} }).state;

  const together = (a, b) => s.rooms.some((r) => r.slots.some((sl) => sl.occupants.includes(a) && sl.occupants.includes(b)));
  assert.equal(roomById(s, "double1").mode, "couple");
  assert.equal(roomById(s, "double2").mode, "couple");
  assert.ok(together(P[0].id, P[1].id));
  assert.ok(together(P[2].id, P[3].id));
  assert.ok(s.people.filter((p) => p.confirmed).every((p) => p.assignment), "all confirmed seated before anyone else");
  assert.equal(getStats(s).assigned, 15);
});

test("a third pair takes the family room double bed", () => {
  let s = initialState();
  const P = s.people;
  // Deliberately avoid Hannah (index 4): she is pinned in the female dorm and
  // so cannot be half of a couple.
  const couples = [[0, 1], [2, 3], [6, 7]];
  couples.flat().forEach((i) => { P[i].confirmed = true; });
  couples.forEach(([a, b]) => { P[a].pairWith = P[b].id; P[b].pairWith = P[a].id; });

  s = applyOp(s, { type: "suggest", params: {} }).state;
  assert.equal(roomById(s, "family").mode, "doublePlusTwoSingles");
  assert.ok(roomById(s, "family").slots[0].occupants.includes(P[6].id));
  assert.ok(getStats(s).occupied <= 15);
});

test("a pinned person is never paired off into a double room", () => {
  let s = initialState();
  const hannah = s.people.find((p) => p.name === "Hannah");
  const henry = s.people.find((p) => p.name === "Henry");
  // Even if someone sets them as bed-sharers, Hannah's booking wins.
  hannah.pairWith = henry.id;
  henry.pairWith = hannah.id;
  s.people.forEach((p) => { p.confirmed = true; });

  s = applyOp(s, { type: "suggest", params: {} }).state;

  assert.equal(personById(s, hannah.id).assignment.roomId, "femaleDorm");
  const sharing = s.rooms.some((r) => r.slots.some((sl) =>
    sl.occupants.includes(hannah.id) && sl.occupants.includes(henry.id)));
  assert.equal(sharing, false, "they are not put in a bed together");
  assert.ok(personById(s, henry.id).assignment, "Henry still gets his own bed");
});

test("people can be added and removed", () => {
  let s = initialState();
  s = applyOp(s, { type: "addPerson", params: { name: "Bruno" } }).state;
  assert.equal(s.people.length, 16);
  assert.equal(getStats(s).overCapacityBy, 1, "16 people against 15 beds");

  const bruno = s.people.at(-1);
  s = applyOp(s, { type: "assign", params: { personId: bruno.id, roomId: "dorm", slotId: roomById(s, "dorm").slots[0].id } }).state;
  s = applyOp(s, { type: "deletePerson", params: { personId: bruno.id } }).state;

  assert.equal(s.people.length, 15);
  assert.equal(roomById(s, "dorm").slots[0].occupants.length, 0, "deleting frees their bed");
});

test("deleting someone already gone is a no-op, not an error", () => {
  const s = initialState();
  assert.doesNotThrow(() => applyOp(s, { type: "deletePerson", params: { personId: "ghost" } }));
});

test("pairing is mutual and exclusive", () => {
  let s = initialState();
  const [a, b, c] = s.people;
  s = applyOp(s, { type: "setPair", params: { personId: a.id, otherId: b.id } }).state;
  assert.equal(personById(s, a.id).pairWith, b.id);
  assert.equal(personById(s, b.id).pairWith, a.id);

  s = applyOp(s, { type: "setPair", params: { personId: a.id, otherId: c.id } }).state;
  assert.equal(personById(s, b.id).pairWith, null, "b is released when a re-pairs");
  assert.equal(personById(s, c.id).pairWith, a.id);
});

test("import rejects rubbish and heals duplicate or dangling occupants", () => {
  for (const bad of [null, {}, { people: [] }, { people: [{ name: "" }], rooms: [] },
                     { people: [{ name: "X" }], rooms: [{ type: "nope" }] }]) {
    assert.throws(() => normalizePlan(bad), PlanError);
  }

  const healed = normalizePlan({
    people: [{ id: "x", name: "Solo" }],
    rooms: [{ id: "r1", name: "R", type: "double", mode: "twin", slots: [
      { type: "single", occupants: ["x", "ghost"] },
      { type: "single", occupants: ["x"] }
    ] }]
  });
  assert.deepEqual(healed.rooms[0].slots.flatMap((s) => s.occupants), ["x"]);
  assert.equal(validateState(healed).filter((i) => i.level === "error").length, 0);
});

test("export/import round trips without loss", () => {
  let s = initialState();
  s = applyOp(s, { type: "setConfirmed", params: { personId: s.people[0].id, confirmed: true } }).state;
  s = applyOp(s, { type: "setNote", params: { personId: s.people[0].id, note: "Arrives Saturday" } }).state;
  s = applyOp(s, { type: "setRoomMode", params: { roomId: "double1", mode: "couple" } }).state;
  s = applyOp(s, { type: "assign", params: { personId: s.people[0].id, roomId: "double1", slotId: roomById(s, "double1").slots[0].id } }).state;

  const shape = (x) => JSON.stringify({
    p: x.people.map((p) => [p.name, p.confirmed, p.note, !!p.assignment]),
    r: x.rooms.map((r) => [r.mode, r.slots.map((sl) => sl.occupants.length)])
  });
  assert.equal(shape(normalizePlan(JSON.parse(JSON.stringify(s)))), shape(s));
});

test("unknown operations are refused", () => {
  assert.throws(() => applyOp(initialState(), { type: "drop database" }), PlanError);
});

/* ===========================================================================
   Migrations — bringing an already-stored plan up to date
   =========================================================================== */

/* A plan as it was saved before Mauricio, the dates and the female dorm. */
const legacyPlan = () => ({
  version: 2,
  tripName: "Ski Trip 2027 — Zermatt",
  people: ["Amelia", "Hannah", "Toby"].map((n, i) => ({
    id: `p${i}`, name: n, confirmed: false, note: "", pairWith: null, assignment: null
  })),
  rooms: [{
    id: "dorm", name: "Dormitory", type: "dorm", mode: "standard", beds: 6, autoFill: true,
    slots: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, type: "single", capacity: 1, label: `Bunk ${i + 1}`, occupants: [] }))
  }]
});

test("a stored plan gains the organiser, Minnie, the dates and the female dorm", () => {
  const s = legacyPlan();
  const applied = migratePlan(s);
  assert.deepEqual(applied.sort(), ["dates2027", "femaleDorm2027", "guestMinnie2027", "organiser2027", "removeTobyJohn2027"]);
  assert.ok(s.people.some((p) => p.name === "Mauricio"));
  assert.ok(s.people.some((p) => p.name === "Minnie"));
  assert.equal(s.startDate, "2027-01-31");
  assert.ok(s.rooms.some((r) => r.id === "femaleDorm"));
  assert.equal(s.people.find((p) => p.name === "Hannah").pinned, true, "and Hannah takes her booked bed");
});

test("a plan that already has Mauricio only gains Minnie", () => {
  const s = legacyPlan();
  s.people.push({ id: "pm", name: "Mauricio", confirmed: false, note: "", pairWith: null, assignment: null });
  const applied = migratePlan(s);
  assert.deepEqual(applied.sort(), ["dates2027", "femaleDorm2027", "guestMinnie2027", "removeTobyJohn2027"]);
  assert.equal(s.people.filter((p) => p.name === "Mauricio").length, 1, "not duplicated");
  assert.ok(s.people.some((p) => p.name === "Minnie"));
});

test("Toby and John are removed from a saved plan, freeing their beds", () => {
  const s = legacyPlan();
  s.people.push({ id: "pj", name: "John", confirmed: true, note: "", pairWith: "p0", assignment: null },
                { id: "pjj", name: "JJ", confirmed: true, note: "", pairWith: null, assignment: null });
  s.people[0].pairWith = "pj";                          // Amelia paired with John
  s.rooms[0].slots[0].occupants = ["p2"];               // Toby in bunk 1
  s.rooms[0].slots[1].occupants = ["pj"];               // John in bunk 2
  syncAssignments(s);

  migratePlan(s);
  const names = s.people.map((p) => p.name);
  assert.ok(!names.includes("Toby") && !names.includes("John"));
  assert.ok(names.includes("JJ"), "JJ is not John");
  assert.equal(s.rooms[0].slots[0].occupants.length, 0, "Toby's bunk is free");
  assert.equal(s.rooms[0].slots[1].occupants.length, 0, "John's bunk is free");
  assert.equal(s.people.find((p) => p.name === "Amelia").pairWith, null, "Amelia's pairing with John is cleared");
});

test("a Toby added back later is not removed again", () => {
  const s = legacyPlan();
  migratePlan(s);
  s.people.push({ id: "t2", name: "Toby", confirmed: false, note: "", pairWith: null, assignment: null });
  migratePlan(s);
  assert.ok(s.people.some((p) => p.name === "Toby"));
});

test("migrations never run twice", () => {
  const s = legacyPlan();
  migratePlan(s);
  const afterFirst = JSON.stringify(s);
  assert.deepEqual(migratePlan(s), [], "second pass changes nothing");
  assert.equal(JSON.stringify(s), afterFirst);
});

test("someone removed on purpose is not resurrected", () => {
  const s = legacyPlan();
  migratePlan(s);
  s.people = s.people.filter((p) => p.name !== "Mauricio");
  migratePlan(s);
  assert.equal(s.people.some((p) => p.name === "Mauricio"), false);
});

test("Minnie, removed on purpose, is not resurrected either", () => {
  const s = legacyPlan();
  migratePlan(s);
  s.people = s.people.filter((p) => p.name !== "Minnie");
  migratePlan(s);
  assert.equal(s.people.some((p) => p.name === "Minnie"), false);
});

test("a room deleted on purpose is not resurrected", () => {
  const s = legacyPlan();
  migratePlan(s);
  s.rooms = s.rooms.filter((r) => r.id !== "femaleDorm");
  migratePlan(s);
  assert.equal(s.rooms.some((r) => r.id === "femaleDorm"), false);
});

test("a plan that already has everything is left alone", () => {
  const s = initialState();
  const before = JSON.stringify(s);
  assert.deepEqual(migratePlan(s), []);
  assert.equal(JSON.stringify(s), before);
});

test("an existing female dorm under another name is not duplicated", () => {
  const s = legacyPlan();
  s.rooms.push({ id: "girls", name: "Female Bunk Room", type: "dorm", mode: "standard", beds: 2, autoFill: true,
    slots: [{ id: "g1", type: "single", capacity: 1, label: "Bunk 1", occupants: [] },
            { id: "g2", type: "single", capacity: 1, label: "Bunk 2", occupants: [] }] });
  migratePlan(s);
  assert.equal(s.rooms.filter((r) => /female/i.test(r.name)).length, 1);
});

/* ===========================================================================
   Function: routing, storage, auth
   =========================================================================== */

test("GET seeds the plan once, so everyone sees the same person ids", async () => {
  const store = fakeStore();
  const first = await (await handleRequest(req("GET"), store)).json();
  assert.equal(first.state.people.length, 15);
  assert.ok(first.etag, "the seed is persisted, not just returned");

  // A second visitor must get the SAME ids, or their first edit would be
  // rejected as referring to someone who isn't on the trip.
  const second = await (await handleRequest(req("GET"), store)).json();
  assert.deepEqual(second.state.people.map((p) => p.id), first.state.people.map((p) => p.id));
  assert.equal(second.etag, first.etag);
});

test("two visitors arriving at once still converge on one set of ids", async () => {
  const store = fakeStore();
  const [a, b] = await Promise.all([
    handleRequest(req("GET"), store).then((r) => r.json()),
    handleRequest(req("GET"), store).then((r) => r.json())
  ]);
  assert.deepEqual(a.state.people.map((p) => p.id), b.state.people.map((p) => p.id));
});

test("an operation is stored and echoed back with who did it", async () => {
  const store = fakeStore();
  const seed = await (await handleRequest(req("GET"), store)).json();
  const { res, body } = await post(store, { type: "setConfirmed", params: { personId: seed.state.people[0].id, confirmed: true } }, "Mario");

  assert.equal(res.status, 200);
  assert.equal(body.state.people[0].confirmed, true);
  assert.equal(body.updatedBy, "Mario");
  assert.ok(body.etag);

  const reread = await (await handleRequest(req("GET"), store)).json();
  assert.equal(reread.state.people[0].confirmed, true, "change survived a fresh read");
});

test("a rejected operation returns 409 and the live plan", async () => {
  const store = fakeStore();
  const seed = await (await handleRequest(req("GET"), store)).json();
  const d1 = seed.state.rooms.find((r) => r.id === "double1");

  await post(store, { type: "assign", params: { personId: seed.state.people[0].id, roomId: "double1", slotId: d1.slots[0].id } });
  const { res, body } = await post(store, { type: "assign", params: { personId: seed.state.people[1].id, roomId: "double1", slotId: d1.slots[0].id } });

  assert.equal(res.status, 409);
  assert.match(body.error, /already taken/);
  assert.ok(body.state, "hands back reality so the client can show it");
  assert.equal(body.state.rooms[0].slots[0].occupants.length, 1);
});

test("malformed requests are refused cleanly", async () => {
  const store = fakeStore();
  assert.equal((await handleRequest(req("PUT", {}), store)).status, 405);
  assert.equal((await handleRequest(req("POST", { actor: "x" }), store)).status, 400);

  const badJson = new Request("https://example.test/api/plan", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{not json"
  });
  assert.equal((await handleRequest(badJson, store)).status, 400);

  const { res } = await post(store, { type: "nope", params: {} });
  assert.equal(res.status, 400);
});

test("passcode gate blocks reads and writes when set", async () => {
  const store = fakeStore();
  process.env.TRIP_PASSCODE = "powder2027";
  try {
    assert.equal((await handleRequest(req("GET"), store)).status, 401);
    assert.equal((await handleRequest(req("GET", undefined, { "x-trip-passcode": "wrong" }), store)).status, 401);

    const ok = await handleRequest(req("GET", undefined, { "x-trip-passcode": "powder2027" }), store);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).passcodeRequired, true);

    const { res } = await post(store, { type: "addPerson", params: { name: "Nope" } });
    assert.equal(res.status, 401, "writes are gated too");
  } finally {
    delete process.env.TRIP_PASSCODE;
  }
});

test("no passcode set means the plan is open", async () => {
  const store = fakeStore();
  const res = await handleRequest(req("GET"), store);
  assert.equal((await res.json()).passcodeRequired, false);
});

/* ===========================================================================
   Concurrency — the reason this is operation-based
   =========================================================================== */

test("two people editing at once both keep their change", async () => {
  const store = fakeStore();
  const seed = await (await handleRequest(req("GET"), store)).json();
  const [toby, nick] = seed.state.people;

  // Fired together, resolved together: whoever loses the race is retried
  // against the winner's plan rather than overwriting it.
  const [a, b] = await Promise.all([
    post(store, { type: "setConfirmed", params: { personId: toby.id, confirmed: true } }, "Toby"),
    post(store, { type: "setNote", params: { personId: nick.id, note: "Driving up Friday" } }, "Nick")
  ]);

  assert.equal(a.res.status, 200);
  assert.equal(b.res.status, 200);

  const final = await (await handleRequest(req("GET"), store)).json();
  assert.equal(personById(final.state, toby.id).confirmed, true, "Toby's confirmation survived");
  assert.equal(personById(final.state, nick.id).note, "Driving up Friday", "Nick's note survived");
});

test("a write landing between read and write is retried, not clobbered", async () => {
  const store = fakeStore();
  const seed = await (await handleRequest(req("GET"), store)).json();
  const [amelia, charles] = seed.state.people;

  // Establish a stored plan.
  await post(store, { type: "setConfirmed", params: { personId: amelia.id, confirmed: true } }, "Mario");

  // Wedge a competing write in after the next read but before its write.
  const realGet = store.getWithMetadata.bind(store);
  let wedged = false;
  store.getWithMetadata = async (...args) => {
    const result = await realGet(...args);
    if (!wedged) {
      wedged = true;
      const rival = clone(result.data);
      rival.state.people.find((p) => p.id === charles.id).confirmed = true;
      store._forceWrite(rival);
    }
    return result;
  };

  const { res, body } = await post(store, { type: "setNote", params: { personId: amelia.id, note: "Flight 07:40" } }, "Mario");
  store.getWithMetadata = realGet;

  assert.equal(res.status, 200);
  assert.ok(store.collisions >= 1, "the collision really happened");
  assert.equal(personById(body.state, amelia.id).note, "Flight 07:40", "our change applied");
  assert.equal(personById(body.state, charles.id).confirmed, true, "the rival's change was NOT lost");
  assert.equal(personById(body.state, amelia.id).confirmed, true, "earlier state still intact");
});

test("ten simultaneous confirmations all land", async () => {
  const store = fakeStore();
  const seed = await (await handleRequest(req("GET"), store)).json();
  const ids = seed.state.people.slice(0, 10).map((p) => p.id);

  const results = await Promise.all(
    ids.map((id, i) => post(store, { type: "setConfirmed", params: { personId: id, confirmed: true } }, `Person${i}`))
  );
  assert.ok(results.every((r) => r.res.status === 200));

  const final = await (await handleRequest(req("GET"), store)).json();
  assert.equal(final.state.people.filter((p) => p.confirmed).length, 10);
});

test("racing for the same bed gives it to exactly one person", async () => {
  const store = fakeStore();
  const seed = await (await handleRequest(req("GET"), store)).json();
  const bunk = seed.state.rooms.find((r) => r.id === "dorm").slots[0].id;
  const contenders = seed.state.people.slice(0, 4);

  const results = await Promise.all(
    contenders.map((p) => post(store, { type: "assign", params: { personId: p.id, roomId: "dorm", slotId: bunk } }, p.name))
  );

  const winners = results.filter((r) => r.res.status === 200);
  assert.equal(winners.length, 1, "exactly one wins the bunk");
  assert.ok(results.filter((r) => r.res.status === 409).length === 3);

  const final = await (await handleRequest(req("GET"), store)).json();
  assert.equal(final.state.rooms.find((r) => r.id === "dorm").slots[0].occupants.length, 1);
  assert.equal(validateState(final.state).filter((i) => /beds at once/.test(i.text)).length, 0);
});

test("import replaces the shared plan for everyone", async () => {
  const store = fakeStore();
  await (await handleRequest(req("GET"), store)).json();
  const plan = { people: [{ id: "solo", name: "Solo", confirmed: true }],
                 rooms: [{ id: "dorm", name: "Dormitory", type: "dorm", mode: "standard" }] };

  const { res, body } = await post(store, { type: "replace", params: { plan } }, "Mario");
  assert.equal(res.status, 200);
  assert.equal(body.state.people.length, 1);

  const final = await (await handleRequest(req("GET"), store)).json();
  assert.equal(final.state.people[0].name, "Solo");
});

test("a malformed import is refused before it touches the stored plan", async () => {
  const store = fakeStore();
  const seed = await (await handleRequest(req("GET"), store)).json();
  await post(store, { type: "setConfirmed", params: { personId: seed.state.people[0].id, confirmed: true } });

  const { res } = await post(store, { type: "replace", params: { plan: { people: "nope" } } });
  assert.equal(res.status, 400);

  const final = await (await handleRequest(req("GET"), store)).json();
  assert.equal(final.state.people.length, 15, "stored plan untouched");
  assert.equal(final.state.people[0].confirmed, true);
});
