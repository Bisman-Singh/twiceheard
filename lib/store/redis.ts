import type { Intake } from "@/lib/intake/intake";
import { INTAKE_TTL_MS, type IntakeStore } from "@/lib/intake/store";
import type { CallRecord, CallStore } from "@/lib/postcall/record";

/**
 * The shared stores, over Redis.
 *
 * A phone call's tool requests can land on different serverless instances,
 * so the live intake, the taken appointment times and the finished call
 * records must live somewhere every instance sees. Claims use SET NX, which
 * Redis runs atomically, so two callers can never hold the same time.
 *
 * Only the handful of commands below are used, behind a narrow interface, so
 * the stores are tested against an in-memory stand-in and the real client is
 * wired in one place.
 */

export interface RedisLike {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, options?: { nx?: true; px?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  zadd(key: string, entry: { score: number; member: string }): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number, options: { rev: true }): Promise<string[]>;
}

const PREFIX = "twiceheard";
/** Taken times are remembered well past the booking horizon, then drop out on their own. */
const SLOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A webhook delivery id is remembered long enough to outlast every retry. */
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
/** Long enough for a caller to read their own chart after the call, and no longer. */
const OWNER_TTL_MS = 60 * 60 * 1000;

const keys = {
  intake: (id: string) => `${PREFIX}:intake:${id}`,
  slot: (clinicId: string, slotId: string) => `${PREFIX}:slot:${clinicId}:${slotId}`,
  slots: (clinicId: string) => `${PREFIX}:slots:${clinicId}`,
  call: (sessionId: string) => `${PREFIX}:call:${sessionId}`,
  calls: (clinicId: string) => `${PREFIX}:calls:${clinicId}`,
  delivery: (id: string) => `${PREFIX}:delivery:${id}`,
  owner: (sessionId: string) => `${PREFIX}:owner:${sessionId}`,
};

export function redisIntakeStore(redis: RedisLike): IntakeStore {
  return {
    async create(intake) {
      const created = await redis.set(keys.intake(intake.id), intake, {
        nx: true,
        px: INTAKE_TTL_MS,
      });
      return created !== null;
    },
    async get(id) {
      return redis.get<Intake>(keys.intake(id));
    },
    async save(intake) {
      await redis.set(keys.intake(intake.id), intake, { px: INTAKE_TTL_MS });
    },
    async claimSlot(clinicId, slotId, intakeId) {
      const key = keys.slot(clinicId, slotId);
      const claimed = await redis.set(key, intakeId, { nx: true, px: SLOT_TTL_MS });
      if (claimed === null) return (await redis.get<string>(key)) === intakeId;
      await redis.sadd(keys.slots(clinicId), slotId);
      return true;
    },
    async takenSlots(clinicId) {
      return new Set(await redis.smembers(keys.slots(clinicId)));
    },
  };
}

export function redisCallStore(redis: RedisLike): CallStore {
  return {
    async save(record) {
      await redis.set(keys.call(record.sessionId), record);
      await redis.zadd(keys.calls(record.clinicId), {
        score: record.processedAt,
        member: record.sessionId,
      });
    },
    async get(sessionId) {
      return redis.get<CallRecord>(keys.call(sessionId));
    },
    async list(clinicId, limit, offset = 0) {
      // Page through ids until enough records are found, so a deleted record never hides older ones.
      const found: CallRecord[] = [];
      for (let start = offset; limit > 0 && found.length < limit; start += limit) {
        const ids = await redis.zrange(keys.calls(clinicId), start, start + limit - 1, {
          rev: true,
        });
        const records = await Promise.all(ids.map((id) => redis.get<CallRecord>(keys.call(id))));
        found.push(...records.filter((record): record is CallRecord => record !== null));
        if (ids.length < limit) break;
      }
      return found.slice(0, limit);
    },
    async remove(clinicId, sessionId) {
      // Read first: the clinic on the record decides, not the clinic on the request.
      const record = await redis.get<CallRecord>(keys.call(sessionId));
      if (record?.clinicId !== clinicId) return false;
      await redis.del(keys.call(sessionId));
      // The id sits in the clinic's index as well as under its own key. Leaving the
      // index entry would keep a place in every page `list` counts through, so the
      // desk's later pages would slide by one against a row that no longer exists.
      await redis.zrem(keys.calls(clinicId), sessionId);
      return true;
    },
  };
}

/** True the first time a delivery id is seen, false for every retry after it. */
export type FirstDelivery = (deliveryId: string) => Promise<boolean>;

export function redisFirstDelivery(redis: RedisLike): FirstDelivery {
  return async (deliveryId) =>
    (await redis.set(keys.delivery(deliveryId), 1, { nx: true, px: DELIVERY_TTL_MS })) !== null;
}

export function memoryFirstDelivery(): FirstDelivery {
  const seen = new Set<string>();
  return async (deliveryId) => {
    if (seen.has(deliveryId)) return false;
    seen.add(deliveryId);
    return true;
  };
}

/**
 * Binds a platform session to the browser that started it.
 *
 * A session id is the only handle a caller has on their own call, so it is
 * claimed the moment the call goes live and every later request for that
 * call's chart must present the same claim. First claim wins, atomically, so
 * a second browser cannot take a call that is already someone's.
 */
export type ClaimSession = (sessionId: string, owner: string) => Promise<boolean>;

export function redisSessionOwner(redis: RedisLike): ClaimSession {
  return async (sessionId, owner) => {
    const key = keys.owner(sessionId);
    const claimed = await redis.set(key, owner, { nx: true, px: OWNER_TTL_MS });
    return claimed !== null || (await redis.get<string>(key)) === owner;
  };
}

export function memorySessionOwner(): ClaimSession {
  const owners = new Map<string, string>();
  return async (sessionId, owner) => {
    const held = owners.get(sessionId);
    if (held !== undefined) return held === owner;
    owners.set(sessionId, owner);
    return true;
  };
}
