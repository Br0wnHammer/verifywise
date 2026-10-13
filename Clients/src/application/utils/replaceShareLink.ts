export type ReplaceShareLinkOutcome = "not-created" | "replaced" | "old-links-still-active";

interface ReplaceShareLinkArgs {
  /** The resource's share links as they were before the replacement. */
  existingLinks: { id: number; is_enabled: boolean }[];
  /** Creates the new link; resolves to a falsy value when creation failed. */
  createLink: () => Promise<unknown>;
  disableLink: (id: number) => Promise<unknown>;
}

/**
 * Replaces a resource's share links with a new one. The new link is created
 * first, so a failure leaves the old links working; only then are the old
 * enabled links disabled, all of them attempted even if some fail.
 */
export async function replaceShareLink({
  existingLinks,
  createLink,
  disableLink,
}: ReplaceShareLinkArgs): Promise<ReplaceShareLinkOutcome> {
  if (!(await createLink())) return "not-created";

  const results = await Promise.allSettled(
    existingLinks.filter((link) => link.is_enabled).map((link) => disableLink(link.id)),
  );
  return results.some((result) => result.status === "rejected")
    ? "old-links-still-active"
    : "replaced";
}
