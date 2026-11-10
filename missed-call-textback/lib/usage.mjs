/**
 * Per-business usage metering.
 *
 * Counters are keyed `usage:b:<businessId>:<metric>:<periodStart>`, so a
 * business id is structurally part of every read and write — the same
 * property that makes lead storage tenant-safe. There is no code path
 * that reads a usage counter without naming whose it is.
 *
 * Increments go through Redis INCR, which is atomic, so two webhook
 * deliveries landing in different lambdas at the same moment cannot lose
 * a count to a read-modify-write race. The file store is single-threaded
 * and mirrors the same shape.
 *
 * What is counted, and what deliberately is not:
 *
 * - `leads` counts a completed lead, once. Not a message, not a
 *   conversation turn.
 * - `messages` counts an outbound WhatsApp message Meta ACCEPTED. A send
 *   that failed is not usage: the business got nothing, and billing them
 *   for our failure is the kind of thing that is very hard to notice and
 *   very expensive to be wrong about.
 * - A webhook redelivery of a message id we have already processed never
 *   reaches the counting code at all, because the idempotency check in
 *   routes/webhook.mjs drops it first. Meta retries aggressively; counting
 *   those would inflate every busy tenant's usage.
 */

export const METRICS = ["leads", "messages"];

export function isValidMetric(metric) {
  return METRICS.includes(metric);
}

/**
 * The calendar month, in UTC, that a moment falls in.
 *
 * UTC rather than the business's timezone on purpose: a counter whose
 * period boundary moves with a tenant's configured timezone would shift
 * if they ever edited it, silently rewriting history.
 */
export function currentPeriod(now = new Date()) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return {
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(end).toISOString(),
  };
}

export function usageKey(businessId, metric, periodStart) {
  if (!businessId) throw new Error("usage is always per business");
  if (!isValidMetric(metric)) throw new Error(`unknown usage metric: ${metric}`);
  return `usage:b:${businessId}:${metric}:${periodStart}`;
}

export function createUsageService(store, { clock = () => new Date() } = {}) {
  return {
    currentPeriod: () => currentPeriod(clock()),

    /** The current period's count for one metric. */
    async count(businessId, metric) {
      const { periodStart } = currentPeriod(clock());
      return (await store.getUsage?.(usageKey(businessId, metric, periodStart))) ?? 0;
    },

    /** Every metric for this business, this period. */
    async summary(businessId) {
      const period = currentPeriod(clock());
      const counts = {};
      for (const metric of METRICS) {
        counts[metric] = (await store.getUsage?.(usageKey(businessId, metric, period.periodStart))) ?? 0;
      }
      return { businessId, ...period, counts };
    },

    /** Atomically adds to a counter and returns the new total. */
    async record(businessId, metric, by = 1) {
      const { periodStart } = currentPeriod(clock());
      return store.incrementUsage(usageKey(businessId, metric, periodStart), by);
    },

    /**
     * Total for one metric from the month that `sinceIso` falls in up to
     * now. Used for the free month, which can straddle two calendar
     * months: "25 leads in your first month" must not become 25 + 25.
     */
    async countSince(businessId, metric, sinceIso) {
      const since = new Date(sinceIso);
      if (Number.isNaN(since.getTime())) return this.count(businessId, metric);
      const now = clock();
      let total = 0;
      let cursor = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1);
      const last = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      while (cursor <= last) {
        const periodStart = new Date(cursor).toISOString();
        total += (await store.getUsage?.(usageKey(businessId, metric, periodStart))) ?? 0;
        const d = new Date(cursor);
        cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      }
      return total;
    },

    /** Like check(), but counting everything since `sinceIso` (see countSince). */
    async checkSince(businessId, metric, entitlements, sinceIso) {
      const limitKey = LIMIT_FOR[metric];
      const limit = entitlements?.limits?.[limitKey] ?? null;
      const used = await this.countSince(businessId, metric, sinceIso);
      if (limit === null || limit === undefined) {
        return { allowed: true, used, limit: null, remaining: null, metric };
      }
      return { allowed: used < limit, used, limit, remaining: Math.max(0, limit - used), metric };
    },

    /**
     * Whether one more of `metric` is within the business's limit.
     *
     * Checked BEFORE the billable operation, never after — the point is
     * to avoid doing the work, not to discover afterwards that we should
     * not have. A null limit means unlimited.
     */
    async check(businessId, metric, entitlements) {
      const limitKey = LIMIT_FOR[metric];
      const limit = entitlements?.limits?.[limitKey] ?? null;
      const used = await this.count(businessId, metric);

      if (limit === null || limit === undefined) {
        return { allowed: true, used, limit: null, remaining: null, metric };
      }
      return {
        allowed: used < limit,
        used,
        limit,
        remaining: Math.max(0, limit - used),
        metric,
      };
    },
  };
}

const LIMIT_FOR = { leads: "leadsPerMonth", messages: "messagesPerMonth" };
