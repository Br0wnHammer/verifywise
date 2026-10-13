import { describe, it, expect, vi } from "vitest";
import { replaceShareLink } from "../replaceShareLink";

const LINKS = [
  { id: 1, is_enabled: true },
  { id: 2, is_enabled: false },
  { id: 3, is_enabled: true },
];

describe("replaceShareLink", () => {
  it("creates the new link before disabling the enabled old ones", async () => {
    const calls: string[] = [];
    const outcome = await replaceShareLink({
      existingLinks: LINKS,
      createLink: async () => {
        calls.push("create");
        return "https://share/new";
      },
      disableLink: async (id) => {
        calls.push(`disable ${id}`);
      },
    });
    expect(outcome).toBe("replaced");
    expect(calls).toEqual(["create", "disable 1", "disable 3"]);
  });

  it("leaves the old links alone when the new link is not created", async () => {
    const disableLink = vi.fn();
    const outcome = await replaceShareLink({
      existingLinks: LINKS,
      createLink: async () => "",
      disableLink,
    });
    expect(outcome).toBe("not-created");
    expect(disableLink).not.toHaveBeenCalled();
  });

  it("tries every old link and reports when some stay active", async () => {
    const disableLink = vi.fn(async (id: number) => {
      if (id === 1) throw new Error("500");
    });
    const outcome = await replaceShareLink({
      existingLinks: LINKS,
      createLink: async () => "https://share/new",
      disableLink,
    });
    expect(outcome).toBe("old-links-still-active");
    expect(disableLink).toHaveBeenCalledTimes(2);
    expect(disableLink).toHaveBeenCalledWith(3);
  });
});
