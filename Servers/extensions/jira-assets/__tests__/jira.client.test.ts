import {
  JiraAssetsClient,
  JiraUpstreamError,
  MAX_PAGES,
  PAGE_SIZE,
  PICKER_MAX_RESULTS,
} from "../jira.client";
import { safeFetch } from "../../../utils/safeOutboundUrl";

jest.mock("../../../utils/safeOutboundUrl", () => ({
  safeFetch: jest.fn(),
  assertSafeOutboundUrl: jest.fn((url: string) => url.replace(/\/+$/, "")),
}));

const mockFetch = safeFetch as jest.Mock;

const ok = (body: unknown) => ({
  ok: true,
  json: async () => body,
  text: async () => "",
});

const objects = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: String(from + i), objectKey: `K-${from + i}` }));

const cloud = () => new JiraAssetsClient("https://x.atlassian.net", "ws-1", "a@b.co", "t", "cloud");
const datacenter = () =>
  new JiraAssetsClient("https://jira.example.com", "3", "user", "t", "datacenter");

/** Calls to the objects endpoint (cloud also fetches attribute definitions first). */
const objectCalls = () =>
  mockFetch.mock.calls.filter(([url]) => /object\/aql|iql\/objects/.test(String(url)));

/** Cloud: attribute definitions first, then the given object pages. */
function cloudPages(...pages: unknown[]) {
  mockFetch.mockResolvedValueOnce(ok([]));
  for (const page of pages) mockFetch.mockResolvedValueOnce(ok(page));
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("cloud pagination (startAt / maxResults / isLast)", () => {
  it("follows pages until isLast and reports a complete fetch", async () => {
    cloudPages(
      { values: objects(0, PAGE_SIZE), isLast: false, total: 70 },
      { values: objects(PAGE_SIZE, 20), isLast: true, total: 70 },
    );

    const result = await cloud().getAllObjects("42");

    expect(result.complete).toBe(true);
    expect(result.objects).toHaveLength(PAGE_SIZE + 20);
    const urls = objectCalls().map(([url]) => String(url));
    expect(urls[0]).toContain(`object/aql?startAt=0&maxResults=${PAGE_SIZE}`);
    expect(urls[1]).toContain(`startAt=${PAGE_SIZE}`);
    expect(JSON.parse(objectCalls()[0][1].body)).toEqual({ qlQuery: "objectTypeId = 42" });
  });

  it("sends a per-request abort signal", async () => {
    cloudPages({ values: objects(0, 1), isLast: true });

    await cloud().getAllObjects("42");

    expect(objectCalls()[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("completes when a known total is reached, advancing by rows returned", async () => {
    cloudPages({ values: objects(0, 25), total: 40 }, { values: objects(25, 15), total: 40 });

    const result = await cloud().getAllObjects("42");

    expect(result.complete).toBe(true);
    expect(result.objects).toHaveLength(40);
    expect(String(objectCalls()[1][0])).toContain("startAt=25");
  });

  it.each([null, undefined, "n/a"])(
    "treats total=%p as unknown: a short page is not proof of the end",
    async (total) => {
      cloudPages({ values: objects(0, 3), total }, { values: [], total });

      const result = await cloud().getAllObjects("42");

      expect(result.complete).toBe(false);
      expect(result.objects).toHaveLength(3);
    },
  );

  it("is incomplete when an empty page arrives before the reported total", async () => {
    cloudPages(
      { values: objects(0, PAGE_SIZE), isLast: false, total: 200 },
      { values: [], isLast: false, total: 200 },
    );

    expect((await cloud().getAllObjects("42")).complete).toBe(false);
  });

  it("calls onPage once per page so the sync can heartbeat", async () => {
    cloudPages(
      { values: objects(0, PAGE_SIZE), isLast: false },
      { values: objects(PAGE_SIZE, 1), isLast: true },
    );
    const onPage = jest.fn(async () => undefined);

    await cloud().getAllObjects("42", { onPage });

    expect(onPage).toHaveBeenCalledTimes(2);
  });

  it("stops at MAX_PAGES and reports the fetch as incomplete", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes("attributes")
        ? ok([])
        : ok({ values: objects(0, PAGE_SIZE), isLast: false }),
    );

    const result = await cloud().getAllObjects("42");

    expect(result.complete).toBe(false);
    expect(objectCalls()).toHaveLength(MAX_PAGES);
  });

  it("returns an incomplete fetch, flagged, when the overall deadline passes", async () => {
    const controller = new AbortController();
    mockFetch
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok({ values: objects(0, PAGE_SIZE), isLast: false }))
      .mockImplementationOnce(async () => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      });

    const result = await cloud().getAllObjects("42", { deadline: controller.signal });

    expect(result).toMatchObject({ complete: false, stoppedReason: "deadline" });
    expect(result.objects).toHaveLength(PAGE_SIZE);
  });
});

describe("data center pagination (page / resultPerPage / pageSize)", () => {
  it("requests every page up to the reported page count", async () => {
    mockFetch
      .mockResolvedValueOnce(
        ok({ objectEntries: objects(0, PAGE_SIZE), pageSize: 2, totalFilterCount: 60 }),
      )
      .mockResolvedValueOnce(
        ok({ objectEntries: objects(PAGE_SIZE, 10), pageSize: 2, totalFilterCount: 60 }),
      );

    const result = await datacenter().getAllObjects("42");

    expect(result.complete).toBe(true);
    expect(result.objects).toHaveLength(60);
    const urls = objectCalls().map(([url]) => String(url));
    expect(urls[0]).toContain(`page=1&resultPerPage=${PAGE_SIZE}`);
    expect(urls[1]).toContain("page=2");
    expect(urls[0]).toContain(`iql=${encodeURIComponent("objectTypeId=42")}`);
  });

  it.each([null, undefined, "?"])(
    "treats pageSize/totalFilterCount=%p as unknown: a short page is not proof of the end",
    async (unknown) => {
      mockFetch
        .mockResolvedValueOnce(
          ok({ objectEntries: objects(0, 3), pageSize: unknown, totalFilterCount: unknown }),
        )
        .mockResolvedValueOnce(
          ok({ objectEntries: [], pageSize: unknown, totalFilterCount: unknown }),
        );

      const result = await datacenter().getAllObjects("42");

      expect(result.complete).toBe(false);
      expect(result.objects).toHaveLength(3);
    },
  );

  it("is incomplete when a page comes back empty before the reported total", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ objectEntries: objects(0, PAGE_SIZE), totalFilterCount: 500 }))
      .mockResolvedValueOnce(ok({ objectEntries: [], totalFilterCount: 500 }));

    expect((await datacenter().getAllObjects("42")).complete).toBe(false);
  });
});

describe("import picker page", () => {
  it("makes one bounded request on cloud and never walks further pages", async () => {
    cloudPages({ values: objects(0, 5), isLast: false, total: 5000 });

    const result = await cloud().getObjectsPage("42");

    expect(result).toHaveLength(5);
    expect(objectCalls()).toHaveLength(1);
    expect(String(objectCalls()[0][0])).toContain(`startAt=0&maxResults=${PICKER_MAX_RESULTS}`);
  });

  it("makes one bounded request on data center", async () => {
    mockFetch.mockResolvedValueOnce(ok({ objectEntries: objects(0, 2), pageSize: 9 }));

    await datacenter().getObjectsPage("42", 5000);

    expect(objectCalls()).toHaveLength(1);
    expect(String(objectCalls()[0][0])).toContain(`page=1&resultPerPage=${PICKER_MAX_RESULTS}`);
  });
});

describe("errors", () => {
  it("turns a non-2xx response into a JiraUpstreamError with the status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "bad creds" });

    await expect(cloud().getSchemas()).rejects.toThrow(JiraUpstreamError);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "bad creds" });
    await expect(cloud().getSchemas()).rejects.toThrow("Jira returned 401: bad creds");
  });

  it("turns a network failure into a JiraUpstreamError with the cause", async () => {
    mockFetch.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );

    await expect(cloud().getSchemas()).rejects.toThrow(
      "Could not reach Jira: fetch failed (ECONNREFUSED)",
    );
  });
});
