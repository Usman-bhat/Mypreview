"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocsSearchClient = void 0;
const vscode = __importStar(require("vscode"));
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
class DocsSearchClient {
    configuration;
    constructor(configuration) {
        this.configuration = configuration;
    }
    static fromConfiguration() {
        return new DocsSearchClient(vscode.workspace.getConfiguration("myDocs"));
    }
    getConfiguredSources() {
        const configured = this.configuration.get("defaultDocs", []);
        return configured.filter((source) => source?.name && source?.baseUrl);
    }
    async search(request) {
        const endpoint = this.configuration.get("searchEndpoint", "").trim();
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
        const apiKey = this.configuration.get("apiKey", "").trim();
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
        const payload = (await response.json());
        const rawItems = Array.isArray(payload)
            ? payload
            : payload.results ?? payload.items ?? payload.hits ?? [];
        const results = rawItems
            .map((item) => this.normalizeResult(item, request.source))
            .filter((item) => Boolean(item));
        return {
            query: request.query,
            source: request.source,
            results,
        };
    }
    normalizeResult(rawItem, fallbackSource) {
        if (!rawItem || typeof rawItem !== "object") {
            return undefined;
        }
        const candidate = rawItem;
        const title = this.pickString(candidate.title, candidate.name, candidate.heading) ?? "Untitled result";
        const snippet = this.pickString(candidate.snippet, candidate.summary, candidate.description, candidate.content) ??
            "No snippet available.";
        const url = this.pickString(candidate.url, candidate.href, candidate.link);
        if (!url) {
            return undefined;
        }
        const source = this.pickString(candidate.source, candidate.sourceName, candidate.provider) ??
            fallbackSource?.name ??
            this.deriveSourceFromUrl(url);
        return {
            title,
            snippet,
            url,
            source,
        };
    }
    pickString(...values) {
        for (const value of values) {
            if (typeof value === "string" && value.trim()) {
                return value.trim();
            }
        }
        return undefined;
    }
    deriveSourceFromUrl(url) {
        try {
            return new URL(url).hostname;
        }
        catch {
            return "search";
        }
    }
}
exports.DocsSearchClient = DocsSearchClient;
//# sourceMappingURL=docsSearchClient.js.map