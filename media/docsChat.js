(function () {
  const vscode = acquireVsCodeApi();
  const historyRoot = document.getElementById("history");
  const questionInput = document.getElementById("questionInput");
  const askButton = document.getElementById("askButton");
  const sourceSelect = document.getElementById("sourceSelect");
  const busyText = document.getElementById("busyText");

  let state = vscode.getState() || {
    history: [],
    sources: [],
    busy: false,
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderSources(sources) {
    const previousValue = sourceSelect.value;
    const options = ['<option value="">All configured sources</option>'].concat(
      sources.map(function (source) {
        return `<option value="${escapeHtml(source.name)}">${escapeHtml(source.name)}</option>`;
      }),
    );
    sourceSelect.innerHTML = options.join("");
    sourceSelect.value = sources.some(function (source) {
      return source.name === previousValue;
    })
      ? previousValue
      : "";
  }

  function renderHistory(history) {
    historyRoot.innerHTML = history.length
      ? history
          .map(function (turn) {
            const citations = turn.citations.length
              ? `<ul class="citations">${turn.citations
                  .map(function (citation) {
                    return `<li>
                      <button class="citation-link" data-url="${escapeHtml(citation.url)}">${escapeHtml(
                        citation.title,
                      )}</button>
                      <span>${escapeHtml(citation.source)}</span>
                    </li>`;
                  })
                  .join("")}</ul>`
              : '<p class="empty-citations">No citations returned.</p>';

            return `<article class="turn">
              <div class="turn-meta">
                <span>${escapeHtml(turn.sourceName || "All sources")}</span>
                <span>${escapeHtml(new Date(turn.createdAt).toLocaleString())}</span>
              </div>
              <h2>${escapeHtml(turn.question)}</h2>
              <pre>${escapeHtml(turn.answerSummary)}</pre>
              ${citations}
            </article>`;
          })
          .join("")
      : '<div class="empty-state">Ask a docs question to build a searchable history inside the editor.</div>';
  }

  function render(nextState) {
    state = nextState;
    renderSources(state.sources || []);
    renderHistory(state.history || []);
    busyText.classList.toggle("hidden", !state.busy);
    askButton.disabled = Boolean(state.busy);
    vscode.setState(state);
  }

  askButton.addEventListener("click", function () {
    vscode.postMessage({
      type: "docsChat.ask",
      payload: {
        question: questionInput.value,
        sourceName: sourceSelect.value || undefined,
      },
    });
    questionInput.value = "";
  });

  questionInput.addEventListener("keydown", function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      askButton.click();
    }
  });

  historyRoot.addEventListener("click", function (event) {
    const button = event.target.closest("button[data-url]");
    if (!button) {
      return;
    }

    vscode.postMessage({
      type: "docsChat.openPreview",
      payload: {
        url: button.dataset.url,
      },
    });
  });

  window.addEventListener("message", function (event) {
    if (event.data.type === "docsChat.state") {
      render(event.data.payload);
    }
  });

  vscode.postMessage({ type: "docsChat.ready" });
})();
