import { JiraAssetsClient, MAX_PAGES, PAGE_SIZE } from "../jira.client";
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

beforeEach(() => {
  mockFetch.mockReset();
});

describe("cloud pagination (startAt / maxResults / isLast)", () => {
  it("follows pages until isLast and reports a complete fetch", async () => {
    mockFetch
      .mockResolvedValueOnce(ok([])) // attribute definitions
      .mockResolvedValueOnce(ok({ values: objects(0, PAGE_SIZE), isLast: false, total: 70 }))
      .mockResolvedValueOnce(ok({ values: objects(PAGE_SIZE, 20), isLast: true, total: 70 }));

    const result = await cloud().getAllObjects("42");

    expect(result.complete).toBe(true);
    expect(result.objects).toHaveLength(PAGE_SIZE + 20);
    const urls = objectCalls().map(([url]) => String(url));
    expect(urls[0]).toContain(`object/aql?startAt=0&maxResults=${PAGE_SIZE}`);
    expect(urls[1]).toContain(`startAt=${PAGE_SIZE}`);
    expect(JSON.parse(objectCalls()[0][1].body)).toEqual({ qlQuery: "objectTypeId = 42" });
  });

  it("advances by what came back when the server caps the page size", async () => {
    mockFetch
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok({ values: objects(0, 25), total: 40 }))
      .mockResolvedValueOnce(ok({ values: objects(25, 15), total: 40 }));

    const result = await cloud().getAllObjects("42");

    expect(result).toMatchObject({ complete: true });
    expect(result.objects).toHaveLength(40);
    expect(String(objectCalls()[1][0])).toContain("startAt=25");
  });

  it("is incomplete when an empty page arrives before the reported total", async () => {
    mockFetch
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok({ values: objects(0, PAGE_SIZE), isLast: false, total: 200 }))
      .mockResolvedValueOnce(ok({ values: [], isLast: false, total: 200 }));

    const result = await cloud().getAllObjects("42");

    expect(result.complete).toBe(false);
  });

  it("calls onPage once per page so the sync can heartbeat", async () => {
    mockFetch
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok({ values: objects(0, PAGE_SIZE), isLast: false }))
      .mockResolvedValueOnce(ok({ values: objects(PAGE_SIZE, 1), isLast: true }));
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

  it("is incomplete when a page comes back empty before the reported total", async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ objectEntries: objects(0, PAGE_SIZE), totalFilterCount: 500 }))
      .mockResolvedValueOnce(ok({ objectEntries: [], totalFilterCount: 500 }));

    const result = await datacenter().getAllObjects("42");

    expect(result.complete).toBe(false);
  });

  it("treats a short page as the end when the server gives no totals", async () => {
    mockFetch.mockResolvedValueOnce(ok({ objectEntries: objects(0, 3) }));

    const result = await datacenter().getAllObjects("42");

    expect(result).toMatchObject({ complete: true });
    expect(result.objects).toHaveLength(3);
  });
});
