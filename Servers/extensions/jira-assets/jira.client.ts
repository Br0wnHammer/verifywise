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

export type JiraDeploymentType = "cloud" | "datacenter";

// JIRA workspace IDs are UUIDs (e.g. "12345678-1234-1234-1234-123456789012").
// Constrained here so a malicious value can't inject additional path
// segments into the composed cloud URL.
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

/** Objects requested per page when listing an object type. */
export const PAGE_SIZE = 50;
/** Hard stop: 500 pages × 50 = 25,000 objects. Past this the fetch is incomplete. */
export const MAX_PAGES = 500;

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

  private async request<T>(endpoint: string, method: string = "GET", body?: any): Promise<T> {
    // Both branches feed the composed URL through safeFetch so the
    // outbound call site lives in utils/safeOutboundUrl.ts, not here.
    // The cloud host is fixed (api.atlassian.com); the validation is
    // defence-in-depth in case someone later parameterises it.
    const rawUrl =
      this.deploymentType === "cloud"
        ? `https://api.atlassian.com/jsm/assets/workspace/${this.workspaceId}/v1/${endpoint}`
        : `${this.baseUrl}/rest/insight/1.0/${endpoint}`;
    const response = await safeFetch(rawUrl, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`JIRA API error ${response.status}: ${errorText || "no details"}`);
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

  /** Every object of the type, across all pages. See `getAllObjects`. */
  async getObjects(objectTypeId: string): Promise<JiraObject[]> {
    return (await this.getAllObjects(objectTypeId)).objects;
  }

  /**
   * Fetch every object of a type, following the Assets API pagination.
   *
   * - Cloud: `POST object/aql?startAt=&maxResults=&includeAttributes=true`
   *   with `{ qlQuery }`; the response carries `values`, `isLast`, `total`.
   * - Data Center: `GET iql/objects?...&page=&resultPerPage=`; the response
   *   carries `objectEntries`, `pageSize` (number of pages) and
   *   `totalFilterCount`.
   *
   * `complete` is true only when the API itself said this was the last page
   * (isLast / page count / total reached) or a short page ended the list.
   * Anything else — hitting MAX_PAGES, an empty page before the reported
   * total — returns `complete: false`, and callers must not treat objects
   * missing from the result as deleted upstream.
   */
  async getAllObjects(
    objectTypeId: string,
    options: { onPage?: () => Promise<void> } = {},
  ): Promise<{ objects: JiraObject[]; complete: boolean }> {
    const objects: JiraObject[] = [];

    if (this.deploymentType === "datacenter") {
      const iql = encodeURIComponent(`objectTypeId=${objectTypeId}`);
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = await this.request<any>(
          `iql/objects?objectSchemaId=${encodeURIComponent(this.workspaceId)}&iql=${iql}` +
            `&page=${page}&resultPerPage=${PAGE_SIZE}&includeAttributes=true`,
        );
        const entries: JiraObject[] = result?.objectEntries || [];
        objects.push(...entries);
        if (options.onPage) await options.onPage();
        const pageCount = Number(result?.pageSize);
        const total = Number(result?.totalFilterCount);
        if (Number.isFinite(pageCount) && pageCount > 0 && page >= pageCount) {
          return { objects, complete: true };
        }
        if (Number.isFinite(total) && objects.length >= total) {
          return { objects, complete: true };
        }
        if (entries.length === 0) {
          // Empty page: complete only if nothing says there should be more.
          return { objects, complete: !(Number.isFinite(total) && objects.length < total) };
        }
        if (entries.length < PAGE_SIZE && !Number.isFinite(pageCount) && !Number.isFinite(total)) {
          return { objects, complete: true };
        }
      }
      return { objects, complete: false };
    }

    // Cloud: fetch attribute defs first to build id→name mapping, inject it
    // onto each object so the caller can resolve JIRA's cryptic attr ids to
    // human names when flattening.
    const attrDefs = await this.getAttributes(objectTypeId);
    const attrIdToName: Record<string, string> = {};
    for (const attr of attrDefs) attrIdToName[attr.id] = attr.name;

    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.request<any>(
        `object/aql?startAt=${startAt}&maxResults=${PAGE_SIZE}&includeAttributes=true`,
        "POST",
        { qlQuery: `objectTypeId = ${objectTypeId}` },
      );
      const values: JiraObject[] = result?.values || result?.objectEntries || [];
      for (const obj of values) (obj as any)._attrIdToName = attrIdToName;
      objects.push(...values);
      if (options.onPage) await options.onPage();
      const total = Number(result?.total);
      if (result?.isLast === true) return { objects, complete: true };
      if (values.length === 0) {
        return {
          objects,
          complete: result?.isLast !== false && !(Number.isFinite(total) && objects.length < total),
        };
      }
      if (result?.isLast === undefined) {
        if (Number.isFinite(total) && objects.length >= total) return { objects, complete: true };
        if (!Number.isFinite(total) && values.length < PAGE_SIZE) {
          return { objects, complete: true };
        }
      }
      // Advance by what came back, not by what was asked for, in case the
      // server caps maxResults below PAGE_SIZE.
      startAt += values.length;
    }
    return { objects, complete: false };
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
