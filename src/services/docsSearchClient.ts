import * as vscode from "vscode";

import { DocSource, DocsSearchRequest, DocsSearchResponse, DocsSearchResult } from "../types";

interface SearchEndpointPayload {
  results?: unknown[];
  items?: unknown[];
  hits?: unknown[];
}

/**
 * Provider-agnostic search client.
 *
 * Change this file when you want to swap the placeholder HTTP contract for:
 * - Algolia DocSearch
 * - Meilisearch
 * - a private docs API
 * - a general web search provider
 *
 * The rest of the extension only consumes the normalized DocsSearchResponse.
 */
export class DocsSearchClient {
  public constructor(private readonly configuration: vscode.WorkspaceConfiguration) {}

  public static fromConfiguration(): DocsSearchClient {
    return new DocsSearchClient(vscode.workspace.getConfiguration("myDocs"));
  }

  public getConfiguredSources(): DocSource[] {
    const configured = this.configuration.get<DocSource[]>("defaultDocs", []);
    return configured.filter((source) => source?.name && source?.baseUrl);
  }

  public async search(request: DocsSearchRequest): Promise<DocsSearchResponse> {
    const endpoint = this.configuration.get<string>("searchEndpoint", "").trim();

    if (!endpoint) {
      throw new Error("myDocs.searchEndpoint is empty. Configure a search API endpoint first.");
    }

    const apiUrl = new URL(endpoint);
    apiUrl.searchParams.set("q", request.query);
    apiUrl.searchParams.set("limit", String(request.limit ?? 8));

    if (request.source) {
      apiUrl.searchParams.set("sourceName", request.source.name);
      apiUrl.searchParams.set("sourceBaseUrl", request.source.baseUrl);
    }

    const apiKey = this.configuration.get<string>("apiKey", "").trim();
    const headers = new Headers({
      Accept: "application/json",
    });

    if (apiKey) {
      headers.set("x-api-key", apiKey);
      headers.set("Authorization", `Bearer ${apiKey}`);
    }

    const response = await fetch(apiUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Search endpoint responded with ${response.status} ${response.statusText}.`);
    }

    const payload = (await response.json()) as SearchEndpointPayload | unknown[];
    const rawItems = Array.isArray(payload)
      ? payload
      : payload.results ?? payload.items ?? payload.hits ?? [];

    const results = rawItems
      .map((item) => this.normalizeResult(item, request.source))
      .filter((item): item is DocsSearchResult => Boolean(item));

    return {
      query: request.query,
      source: request.source,
      results,
    };
  }

  private normalizeResult(rawItem: unknown, fallbackSource?: DocSource): DocsSearchResult | undefined {
    if (!rawItem || typeof rawItem !== "object") {
      return undefined;
    }

    const candidate = rawItem as Record<string, unknown>;
    const title = this.pickString(candidate.title, candidate.name, candidate.heading) ?? "Untitled result";
    const snippet =
      this.pickString(candidate.snippet, candidate.summary, candidate.description, candidate.content) ??
      "No snippet available.";
    const url = this.pickString(candidate.url, candidate.href, candidate.link);

    if (!url) {
      return undefined;
    }

    const source =
      this.pickString(candidate.source, candidate.sourceName, candidate.provider) ??
      fallbackSource?.name ??
      this.deriveSourceFromUrl(url);

    return {
      title,
      snippet,
      url,
      source,
    };
  }

  private pickString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    return undefined;
  }

  private deriveSourceFromUrl(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "search";
    }
  }
}
