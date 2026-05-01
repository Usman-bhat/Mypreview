export interface DocSource {
  name: string;
  baseUrl: string;
}

export interface DocsSearchRequest {
  query: string;
  source?: DocSource;
  limit?: number;
}

export interface DocsSearchResult {
  title: string;
  snippet: string;
  url: string;
  source: string;
}

export interface DocsSearchResponse {
  query: string;
  source?: DocSource;
  results: DocsSearchResult[];
}

export interface SerializedPreviewPanel {
  id: string;
  url: string;
  pinned: boolean;
}

export interface ChatTurn {
  id: string;
  question: string;
  answerSummary: string;
  citations: DocsSearchResult[];
  sourceName?: string;
  createdAt: string;
}
