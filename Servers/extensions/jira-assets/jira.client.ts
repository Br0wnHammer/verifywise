/**
 * Thin fetch-based wrapper around the JIRA Service Management Assets API.
 *
 * Supports both cloud (api.atlassian.com/jsm/assets/workspace/{id}/v1) and
 * datacenter (`{baseUrl}/rest/insight/1.0`) deployments. All authentication
 * is Basic email:api_token.
 *
 * SSRF hardening: the datacenter path composes URLs from a user-provided
 * `baseUrl`, and `workspaceId` is user-provided even on cloud. Both go
 * through `utils/safeOutboundUrl.ts` before hitting `fetch()` — protocol
 * check, cloud-metadata block, ReDoS-safe trailing-slash trim.
 */

import { assertSafeOutboundUrl, safeFetch } from "../../utils/safeOutboundUrl";
import {
  EXTERNAL_SYNC_DEADLINE_MS,
  describeFetchError,
  requestSignal,
} from "../../utils/outboundFetch.utils";

export type JiraDeploymentType = "cloud" | "datacenter";

// JIRA workspace IDs are UUIDs (e.g. "12345678-1234-1234-1234-123456789012").
// Constrained here so a malicious value can't inject additional path
// segments into the composed cloud URL.
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

/** Objects requested per page when listing an object type. */
export const PAGE_SIZE = 50;
/** Hard stop: 500 pages × 50 = 25,000 objects. Past this the fetch is incomplete. */
export const MAX_PAGES = 500;
/** Per-request timeout for every call to Jira. */
export const REQUEST_TIMEOUT_SECONDS = 30;
/** Cap for the single-page import picker listing (GET .../objects). */
export const PICKER_MAX_RESULTS = 1000;

/**
 * Jira (or the network path to it) failed: non-2xx response, timeout, DNS,
 * TLS. Controllers map it to 502 with this message.
 */
export class JiraUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraUpstreamError";
  }
}

export interface ObjectFetchResult {
  objects: JiraObject[];
  /** True only when the API confirmed the last page (see getAllObjects). */
  complete: boolean;
  /** Set when the overall deadline stopped the walk. */
  stoppedReason?: "deadline";
}

/** A finite number from an API field, or null when it is absent or not numeric. */
function knownNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface JiraSchema {
  id: string;
  name: string;
  objectSchemaKey?: string;
  description?: string;
}

export interface JiraObjectType {
  id: string;
  name: string;
  description?: string;
  iconId?: string;
  objectCount?: number;
}

export interface JiraAttribute {
  id: string;
  name: string;
  type: number;
  typeValue?: string;
  defaultType?: unknown;
  description?: string;
}

export interface JiraObject {
  id: string;
  objectKey: string;
  label: string;
  objectType: { id: string; name: string };
  attributes: Array<{
    objectAttributeValues: Array<{ value: unknown; displayValue?: string }>;
    objectTypeAttribute: { id: string; name: string };
  }>;
  created: string;
  updated: string;
}

export class JiraAssetsClient {
  private baseUrl: string;
  private workspaceId: string;
  private authHeader: string;
  private deploymentType: JiraDeploymentType;

  constructor(
    baseUrl: string,
    workspaceId: string,
    email: string,
    apiToken: string,
    deploymentType: JiraDeploymentType = "cloud",
  ) {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new Error("JIRA workspace ID has an invalid format");
    }
    // For datacenter, validate baseUrl now so the constructor fails fast
    // instead of every request. Cloud ignores baseUrl but we still normalize
    // to keep this.baseUrl predictable.
    if (deploymentType === "datacenter") {
      this.baseUrl = assertSafeOutboundUrl(baseUrl);
    } else {
      this.baseUrl = baseUrl.replace(/\/{1,32}$/, "");
    }
    this.workspaceId = workspaceId;
    this.deploymentType = deploymentType;
    const credentials = Buffer.from(`${email}:${apiToken}`).toString("base64");
    this.authHeader = `Basic ${credentials}`;
  }

  /**
   * One call to the Assets API, with a per-request timeout and an overall
   * deadline (EXTERNAL_SYNC_DEADLINE_MS unless the caller passes its own, as
   * getAllObjects does for the whole walk). Every failure becomes a
   * JiraUpstreamError with a readable reason; a deadline abort is rethrown
   * as-is so getAllObjects can tell it apart.
   */
  private async request<T>(
    endpoint: string,
    method: string = "GET",
    body?: any,
    deadline: AbortSignal = AbortSignal.timeout(EXTERNAL_SYNC_DEADLINE_MS),
  ): Promise<T> {
    // Both branches feed the composed URL through safeFetch so the
    // outbound call site lives in utils/safeOutboundUrl.ts, not here.
    // The cloud host is fixed (api.atlassian.com); the validation is
    // defence-in-depth in case someone later parameterises it.
    const rawUrl =
      this.deploymentType === "cloud"
        ? `https://api.atlassian.com/jsm/assets/workspace/${this.workspaceId}/v1/${endpoint}`
        : `${this.baseUrl}/rest/insight/1.0/${endpoint}`;
    let response: Response;
    try {
      response = await safeFetch(rawUrl, {
        method,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: requestSignal(REQUEST_TIMEOUT_SECONDS, deadline),
      });
    } catch (err) {
      if (deadline.aborted) throw err;
      throw new JiraUpstreamError(
        `Could not reach Jira: ${describeFetchError(err, REQUEST_TIMEOUT_SECONDS)}`,
      );
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new JiraUpstreamError(
        `Jira returned ${response.status}: ${errorText.slice(0, 500) || "no details"}`,
      );
    }
    return (await response.json()) as T;
  }

  async getSchemas(): Promise<JiraSchema[]> {
    if (this.deploymentType === "datacenter") {
      const result = await this.request<JiraSchema[]>("objectschema/list");
      return Array.isArray(result) ? result : [];
    }
    const result = await this.request<{ values: JiraSchema[] }>("objectschema/list");
    return result.values || [];
  }

  async getObjectTypes(schemaId: string): Promise<JiraObjectType[]> {
    if (this.deploymentType === "datacenter") {
      const result = await this.request<JiraObjectType[]>(
        `objectschema/${schemaId}/objecttypes/flat`,
      );
      return Array.isArray(result) ? result : [];
    }
    const result = await this.request<any>(`objectschema/${schemaId}/objecttypes`);
    if (Array.isArray(result)) return result;
    return result?.values || [];
  }

  async getAttributes(objectTypeId: string): Promise<JiraAttribute[]> {
    const result = await this.request<JiraAttribute[]>(`objecttype/${objectTypeId}/attributes`);
    return Array.isArray(result) ? result : [];
  }

  /** id→name map for an object type's attributes, attached to each object as `_attrIdToName`. */
  private async attributeNames(objectTypeId: string, deadline?: AbortSignal) {
    const result = await this.request<JiraAttribute[]>(
      `objecttype/${objectTypeId}/attributes`,
      "GET",
      undefined,
      deadline,
    );
    const attrIdToName: Record<string, string> = {};
    for (const attr of Array.isArray(result) ? result : []) attrIdToName[attr.id] = attr.name;
    return attrIdToName;
  }

  /**
   * One bounded page of objects, for the import picker. Never walks further
   * pages: at most PICKER_MAX_RESULTS objects (the server may cap lower).
   */
  async getObjectsPage(
    objectTypeId: string,
    maxResults: number = PICKER_MAX_RESULTS,
  ): Promise<JiraObject[]> {
    const limit = Math.min(Math.max(1, Math.floor(maxResults)), PICKER_MAX_RESULTS);
    if (this.deploymentType === "datacenter") {
      const iql = encodeURIComponent(`objectTypeId=${objectTypeId}`);
      const result = await this.request<any>(
        `iql/objects?objectSchemaId=${encodeURIComponent(this.workspaceId)}&iql=${iql}` +
          `&page=1&resultPerPage=${limit}&includeAttributes=true`,
      );
      return result?.objectEntries || [];
    }
    const attrIdToName = await this.attributeNames(objectTypeId);
    const result = await this.request<any>(
      `object/aql?startAt=0&maxResults=${limit}&includeAttributes=true`,
      "POST",
      { qlQuery: `objectTypeId = ${objectTypeId}` },
    );
    const objects: JiraObject[] = result?.values || [];
    for (const obj of objects) (obj as any)._attrIdToName = attrIdToName;
    return objects;
  }

  /**
   * Fetch every object of a type, following the Assets API pagination.
   *
   * - Cloud: `POST object/aql?startAt=&maxResults=&includeAttributes=true`
   *   with `{ qlQuery }`; the response carries `values`, `isLast`, `total`.
   *   The server may return fewer rows than asked for, so a short page proves
   *   nothing and the walk advances by the rows returned.
   * - Data Center: `GET iql/objects?...&page=&resultPerPage=`; the response
   *   carries `objectEntries`, `pageSize` (number of pages) and
   *   `totalFilterCount`.
   *
   * `complete` is true only when the API said so: `isLast === true`, the
   * reported page count reached, or a reported total reached. Totals that are
   * absent, null or not numeric count as unknown. Everything else — an empty
   * page with no proof of the end, MAX_PAGES, the overall deadline — returns
   * `complete: false`, and callers must not treat missing objects as deleted.
   */
  async getAllObjects(
    objectTypeId: string,
    options: { onPage?: () => Promise<void>; deadline?: AbortSignal } = {},
  ): Promise<ObjectFetchResult> {
    const deadline = options.deadline ?? AbortSignal.timeout(EXTERNAL_SYNC_DEADLINE_MS);
    const objects: JiraObject[] = [];
    try {
      if (this.deploymentType === "datacenter") {
        const iql = encodeURIComponent(`objectTypeId=${objectTypeId}`);
        for (let page = 1; page <= MAX_PAGES; page++) {
          const result = await this.request<any>(
            `iql/objects?objectSchemaId=${encodeURIComponent(this.workspaceId)}&iql=${iql}` +
              `&page=${page}&resultPerPage=${PAGE_SIZE}&includeAttributes=true`,
            "GET",
            undefined,
            deadline,
          );
          const entries: JiraObject[] = result?.objectEntries || [];
          objects.push(...entries);
          if (options.onPage) await options.onPage();
          const pageCount = knownNumber(result?.pageSize);
          const total = knownNumber(result?.totalFilterCount);
          if (pageCount !== null && pageCount > 0 && page >= pageCount) {
            return { objects, complete: true };
          }
          if (total !== null && objects.length >= total) return { objects, complete: true };
          if (entries.length === 0) return { objects, complete: false };
        }
        return { objects, complete: false };
      }

      const attrIdToName = await this.attributeNames(objectTypeId, deadline);
      let startAt = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await this.request<any>(
          `object/aql?startAt=${startAt}&maxResults=${PAGE_SIZE}&includeAttributes=true`,
          "POST",
          { qlQuery: `objectTypeId = ${objectTypeId}` },
          deadline,
        );
        const values: JiraObject[] = result?.values || [];
        for (const obj of values) (obj as any)._attrIdToName = attrIdToName;
        objects.push(...values);
        if (options.onPage) await options.onPage();
        if (result?.isLast === true) return { objects, complete: true };
        const total = knownNumber(result?.total);
        if (total !== null && objects.length >= total) return { objects, complete: true };
        if (values.length === 0) return { objects, complete: false };
        startAt += values.length;
      }
      return { objects, complete: false };
    } catch (err) {
      if (deadline.aborted) return { objects, complete: false, stoppedReason: "deadline" };
      throw err;
    }
  }

  async getObjectById(objectId: string): Promise<JiraObject> {
    return this.request<JiraObject>(`object/${objectId}`);
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.getSchemas();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
