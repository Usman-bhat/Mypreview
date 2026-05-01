(function () {
  const vscode = acquireVsCodeApi();
  const summary = document.getElementById("summary");
  const resultsRoot = document.getElementById("results");

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderResult(result, index) {
    return `
      <article class="result-card">
        <div class="result-index">${index + 1}</div>
        <div class="result-body">
          <h2>${escapeHtml(result.title)}</h2>
          <p>${escapeHtml(result.snippet)}</p>
          <div class="meta">
            <span>${escapeHtml(result.source)}</span>
            <span>${escapeHtml(result.url)}</span>
          </div>
          <div class="actions">
            <button data-action="preview" data-url="${escapeHtml(result.url)}">Open in Browser Workbench</button>
            <button data-action="external" data-url="${escapeHtml(result.url)}">Open Externally</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderState(state) {
    const label = state.source ? `${state.source.name} — ${state.query}` : state.query;
    summary.textContent = `${state.results.length} result(s) for ${label}`;
    resultsRoot.innerHTML = state.results.length
      ? state.results.map(renderResult).join("")
      : '<div class="empty">No results returned from the configured endpoint.</div>';
    vscode.setState(state);
  }

  window.addEventListener("message", function (event) {
    if (event.data.type === "docsResults.state") {
      renderState(event.data.payload);
    }
  });

  resultsRoot.addEventListener("click", function (event) {
    const target = event.target.closest("button[data-action]");
    if (!target) {
      return;
    }

    const type = target.dataset.action === "preview" ? "docsResults.openPreview" : "docsResults.openExternal";
    vscode.postMessage({
      type,
      payload: {
        url: target.dataset.url,
      },
    });
  });

  vscode.postMessage({ type: "docsResults.ready" });
})();
