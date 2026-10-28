// Servers/services/intakeLiveChecks/__tests__/formBudget.test.ts
jest.mock("../../../utils/logger/fileLogger", () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const store = new Map<string, number>();
const incr = jest.fn(async (key: string) => {
  const next = (store.get(key) ?? 0) + 1;
  store.set(key, next);
  return next;
});
const expire = jest.fn(async () => 1);

jest.mock("../../../database/redis", () => ({
  __esModule: true,
  default: {
    incr: (key: string) => incr(key),
    expire: (key: string, seconds: number) => expire(key, seconds),
  },
}));

import {
  consumeFormBudget,
  formBudgetKey,
  FORM_BUDGET_PER_HOUR,
  REDIS_TIMEOUT_MS,
} from "../formBudget";

const NOW = new Date("2026-10-28T14:35:00.000Z");

beforeEach(() => {
  store.clear();
  incr.mockClear();
  expire.mockClear();
});

describe("formBudgetKey", () => {
  it("names the endpoint, the form and the UTC hour", () => {
    expect(formBudgetKey(42, "checks", NOW)).toBe("intake:livechecks:checks:42:2026102814");
    expect(formBudgetKey(42, "prefill", new Date("2026-10-28T15:00:00.000Z"))).toBe(
      "intake:livechecks:prefill:42:2026102815",
    );
  });
});

describe("consumeFormBudget", () => {
  it("exports the per-form hourly caps and the Redis time limit", () => {
    expect(FORM_BUDGET_PER_HOUR).toEqual({ checks: 300, prefill: 20 });
    expect(REDIS_TIMEOUT_MS).toBe(300);
  });

  it("allows the 300th call in an hour and refuses the 301st", async () => {
    for (let i = 1; i < 300; i++) await consumeFormBudget(7, "checks", 300, NOW);
    expect(await consumeFormBudget(7, "checks", 300, NOW)).toBe(true);
    expect(await consumeFormBudget(7, "checks", 300, NOW)).toBe(false);
  });

  it("sets a one hour expiry on the first hit only", async () => {
    await consumeFormBudget(7, "prefill", 20, NOW);
    await consumeFormBudget(7, "prefill", 20, NOW);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith("intake:livechecks:prefill:7:2026102814", 3600);
  });

  it("counts each form, endpoint and hour separately", async () => {
    for (let i = 0; i < 20; i++) await consumeFormBudget(7, "prefill", 20, NOW);
    expect(await consumeFormBudget(7, "prefill", 20, NOW)).toBe(false);
    expect(await consumeFormBudget(8, "prefill", 20, NOW)).toBe(true);
    expect(await consumeFormBudget(7, "checks", 300, NOW)).toBe(true);
    expect(await consumeFormBudget(7, "prefill", 20, new Date("2026-10-28T15:01:00Z"))).toBe(true);
  });

  it("refuses when Redis errors", async () => {
    incr.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await consumeFormBudget(7, "checks", 300, NOW)).toBe(false);
  });

  describe("with a Redis that never answers", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    // Settles the promise's state without waiting on it.
    const settled = async (p: Promise<boolean>) => {
      let value: boolean | undefined;
      void p.then((v) => (value = v));
      await Promise.resolve();
      await Promise.resolve();
      return value;
    };

    it("refuses at 300 ms, not before", async () => {
      incr.mockImplementationOnce(() => new Promise<number>(() => undefined));
      const pending = consumeFormBudget(7, "checks", 300, NOW);
      await jest.advanceTimersByTimeAsync(REDIS_TIMEOUT_MS - 1);
      expect(await settled(pending)).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(false);
    });

    it("still allows the call when only the expiry hangs", async () => {
      expire.mockImplementationOnce(() => new Promise<number>(() => undefined));
      const pending = consumeFormBudget(9, "checks", 300, NOW);
      await jest.advanceTimersByTimeAsync(REDIS_TIMEOUT_MS);
      expect(await pending).toBe(true);
    });
  });
});
