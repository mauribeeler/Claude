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
  personById, roomById, normalizePlan, syncAssignments, PlanError, clone
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

test("boots with the 15 given names, nobody confirmed or assigned", () => {
  const s = initialState();
  assert.equal(s.people.length, 15);
  assert.equal(s.people[0].name, "Amelia");
  assert.equal(s.people.at(-1).name, "Huxley");
  assert.ok(s.people.every((p) => !p.confirmed && p.assignment === null && p.note === ""));
  assert.deepEqual(s.rooms.map((r) => r.mode), ["twin", "twin", "fourSingles", "standard"]);
  assert.deepEqual(s.rooms.map((r) => r.slots.length), [2, 2, 4, 6]);
});

test("14 beds against 15 people is reported as an error, not hidden", () => {
  const s = initialState();
  const stats = getStats(s);
  assert.equal(stats.beds, 14);
  assert.equal(stats.total, 15);
  assert.equal(stats.overCapacityBy, 1);
  assert.ok(validateState(s).some((i) => i.level === "error" && /nowhere to sleep/.test(i.text)));
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

test("suggested allocation fills 14 and leaves the 15th out", () => {
  let s = initialState();
  s.people.forEach((p) => { p.confirmed = true; });
  s = applyOp(s, { type: "suggest", params: {} }).state;

  const stats = getStats(s);
  assert.equal(stats.assigned, 14);
  assert.ok(stats.occupied <= stats.beds);
  assert.equal(validateState(s).filter((i) => i.level === "error" && !/nowhere to sleep/.test(i.text)).length, 0);
  assert.ok(s.rooms.filter((r) => r.type === "double").every((r) => r.mode === "twin"), "no pairs means no couple rooms");
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
  assert.equal(getStats(s).assigned, 14);
});

test("a third pair takes the family room double bed", () => {
  let s = initialState();
  const P = s.people;
  for (let i = 0; i < 6; i++) P[i].confirmed = true;
  for (let i = 0; i < 6; i += 2) { P[i].pairWith = P[i + 1].id; P[i + 1].pairWith = P[i].id; }

  s = applyOp(s, { type: "suggest", params: {} }).state;
  assert.equal(roomById(s, "family").mode, "doublePlusTwoSingles");
  assert.ok(roomById(s, "family").slots[0].occupants.includes(P[4].id));
  assert.ok(getStats(s).occupied <= 14);
});

test("people can be added and removed", () => {
  let s = initialState();
  s = applyOp(s, { type: "addPerson", params: { name: "Bruno" } }).state;
  assert.equal(s.people.length, 16);
  assert.equal(getStats(s).overCapacityBy, 2);

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
