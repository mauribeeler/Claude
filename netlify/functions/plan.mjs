/*
 * plan.mjs — the shared plan, stored in Netlify Blobs.
 *
 * Routes (all under /api/plan):
 *   GET  /api/plan          → current plan
 *   POST /api/plan          → { op: {type, params}, actor } → apply one operation
 *
 * Concurrency: the client sends an OPERATION ("confirm Toby"), never a whole
 * document. The server reads the current plan, applies the operation to it and
 * writes with `onlyIfMatch` on the etag it read. If someone else wrote in
 * between, the write is rejected and we retry against the fresher plan.
 *
 * That is what makes simultaneous editing safe: two people changing different
 * rooms both succeed, because each change is re-applied to whatever the latest
 * plan is, rather than one client's stale snapshot flattening the other's work.
 */

import { getStore } from "@netlify/blobs";
import { applyOp, initialState, PlanError, syncAssignments, normalizePlan, TRIP_START, TRIP_END } from "../../public/plan-core.js";

const STORE_NAME = "ski-trip";
const KEY = "plan-2027";
/* Enough attempts that a whole group tapping at once still all get through:
   each collision costs one attempt, so this must exceed the realistic number
   of simultaneous editors. */
const MAX_WRITE_ATTEMPTS = 15;
const MAX_BODY_BYTES = 512 * 1024;

/* Jittered backoff so colliding writers don't retry in lockstep and collide
   again — without it, a burst of edits re-races on every round. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt) => sleep(Math.round(Math.random() * (15 + attempt * 12)));

const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });

/*
 * Optional shared passcode. Set TRIP_PASSCODE in the Netlify UI to require it;
 * leave it unset and the plan is open to anyone with the link. Compared in
 * constant time so the endpoint can't be used as an oracle to guess it.
 */
function passcodeRequired() {
  return typeof process.env.TRIP_PASSCODE === "string" && process.env.TRIP_PASSCODE.length > 0;
}

function constantTimeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  // Compare over a fixed length so a wrong-length guess costs the same.
  const len = Math.max(x.length, y.length, 1);
  let diff = x.length === y.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= x.charCodeAt(i % (x.length || 1)) ^ y.charCodeAt(i % (y.length || 1));
  }
  return diff === 0;
}

function checkPasscode(req) {
  if (!passcodeRequired()) return true;
  const supplied = req.headers.get("x-trip-passcode") || "";
  return constantTimeEqual(supplied, process.env.TRIP_PASSCODE);
}

function envelope(state, meta) {
  return { state, meta };
}

function unpack(found) {
  const state = syncAssignments(found.data.state ?? found.data);

  /*
   * A plan stored before trip dates existed has none, and redeploying cannot
   * add them — the stored plan always wins over initialState(). Backfill the
   * dates only, because they are facts about the trip. People and rooms are
   * deliberately NOT backfilled: someone may have been removed on purpose,
   * and resurrecting them behind the organiser's back would be worse than
   * leaving the plan as they left it.
   */
  if (!state.startDate) state.startDate = TRIP_START;
  if (!state.endDate) state.endDate = TRIP_END;

  return { state, etag: found.etag, meta: found.data.meta ?? {} };
}

/*
 * Read the plan, creating it on first contact.
 *
 * The seed MUST be persisted, not just returned: person and slot ids are
 * generated fresh each time initialState() runs, so handing out an unsaved
 * plan would give every visitor different ids and their first change would be
 * rejected as referring to someone who isn't on the trip. `onlyIfNew` makes
 * the create atomic — if two people open the link simultaneously, one seeds it
 * and the other reads what was seeded, so both see identical ids.
 */
async function readPlan(store) {
  const found = await store.getWithMetadata(KEY, { type: "json" });
  if (found && found.data) return unpack(found);

  const seeded = initialState();
  const seedMeta = { updatedAt: new Date().toISOString(), updatedBy: null, lastChange: "Plan created." };
  const write = await store.setJSON(KEY, envelope(seeded, seedMeta), { onlyIfNew: true });

  if (write.modified) return { state: seeded, etag: write.etag, meta: seedMeta };

  const raced = await store.getWithMetadata(KEY, { type: "json" });
  if (raced && raced.data) return unpack(raced);
  return { state: seeded, etag: null, meta: seedMeta };
}

function publicPayload(state, meta, etag) {
  return {
    state,
    etag: etag ?? null,
    updatedAt: meta.updatedAt ?? null,
    updatedBy: meta.updatedBy ?? null,
    lastChange: meta.lastChange ?? null,
    passcodeRequired: passcodeRequired()
  };
}

/* Split from the default export so tests can drive it with a fake store. */
export async function handleRequest(req, store) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-trip-passcode"
      }
    });
  }

  if (!checkPasscode(req)) {
    return json({ error: "Wrong passcode.", code: "bad_passcode", passcodeRequired: true }, 401);
  }

  try {
    if (req.method === "GET") {
      const { state, etag, meta } = await readPlan(store);
      return json(publicPayload(state, meta, etag));
    }

    if (req.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }

    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: "That request is too large." }, 413);
    }

    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json({ error: "Body was not valid JSON." }, 400);
    }

    const op = body.op;
    if (!op || typeof op.type !== "string") {
      return json({ error: "Missing an operation." }, 400);
    }

    const actor = typeof body.actor === "string" && body.actor.trim()
      ? body.actor.trim().slice(0, 40)
      : "Someone";

    // Validate an imported plan before it can enter the retry loop, so a bad
    // import fails fast with a clear message instead of burning attempts.
    if (op.type === "replace") normalizePlan(op.params?.plan);

    let lastConflict = null;

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const { state, etag } = await readPlan(store);

      let applied;
      try {
        applied = applyOp(state, op);
      } catch (err) {
        if (err instanceof PlanError) {
          // The operation is invalid against the CURRENT plan — usually because
          // someone else took the bed first. Hand back the live plan so the
          // client can show what actually happened rather than guessing.
          const fresh = await readPlan(store);
          return json({
            error: err.message,
            code: "rejected",
            ...publicPayload(fresh.state, fresh.meta, fresh.etag)
          }, err.status || 409);
        }
        throw err;
      }

      const meta = {
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
        lastChange: applied.message || null
      };

      const write = await store.setJSON(
        KEY,
        envelope(applied.state, meta),
        etag ? { onlyIfMatch: etag } : { onlyIfNew: true }
      );

      if (write.modified) {
        return json({ ...publicPayload(applied.state, meta, write.etag), message: applied.message });
      }

      // Someone wrote first. Loop: re-read and re-apply against their version.
      lastConflict = "concurrent";
      await backoff(attempt);
    }

    const fresh = await readPlan(store);
    return json({
      error: "Too many people are editing at once. Your change was not saved — try again.",
      code: lastConflict || "busy",
      ...publicPayload(fresh.state, fresh.meta, fresh.etag)
    }, 503);

  } catch (err) {
    if (err instanceof PlanError) {
      return json({ error: err.message, code: "rejected" }, err.status || 400);
    }
    console.error("plan function failed", err);
    return json({ error: "The plan service hit an unexpected error." }, 500);
  }
}

export default async (req) => handleRequest(req, getStore(STORE_NAME));

export const config = { path: "/api/plan" };
