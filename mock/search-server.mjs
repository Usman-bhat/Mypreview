import http from "node:http";

const PORT = 47831;

const catalog = [
  {
    title: "React: Conditional Rendering",
    snippet: "Learn how to render different UI depending on application state.",
    url: "https://react.dev/learn/conditional-rendering",
    source: "React Docs",
  },
  {
    title: "Next.js: Data Fetching Patterns",
    snippet: "Guide to server-side and client-side data fetching in the App Router.",
    url: "https://nextjs.org/docs/app/building-your-application/data-fetching",
    source: "Next.js Docs",
  },
  {
    title: "MDN: CSS Container Queries",
    snippet: "Use container queries to style components based on the size of their container.",
    url: "https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_container_queries",
    source: "MDN Web Docs",
  },
  {
    title: "SwiftUI: Stacks and Layout",
    snippet: "Use stacks to arrange views linearly in SwiftUI.",
    url: "https://developer.apple.com/documentation/swiftui/building-layouts-with-stack-views",
    source: "SwiftUI Docs",
  },
  {
    title: "Web.dev: Responsive Layouts",
    snippet: "Patterns for adaptive and responsive UI across breakpoints and containers.",
    url: "https://web.dev/learn/design",
    source: "web.dev",
  },
];

function scoreResult(result, query, sourceName) {
  const haystack = `${result.title} ${result.snippet} ${result.source}`.toLowerCase();
  let score = 0;
  for (const term of query.toLowerCase().split(/\s+/)) {
    if (term && haystack.includes(term)) {
      score += 1;
    }
  }

  if (sourceName && result.source.toLowerCase() === sourceName.toLowerCase()) {
    score += 4;
  }

  return score;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (url.pathname !== "/search") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const query = url.searchParams.get("q") ?? "";
  const sourceName = url.searchParams.get("sourceName") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? "8");

  const results = catalog
    .map((result) => ({ ...result, score: scoreResult(result, query, sourceName) }))
    .filter((result) => result.score > 0 || !query.trim())
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ score, ...result }) => result);

  response.writeHead(200, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify({ results }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock search server listening on http://127.0.0.1:${PORT}/search`);
});
