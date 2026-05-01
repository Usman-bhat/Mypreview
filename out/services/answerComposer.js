"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.composeAnswer = composeAnswer;
/**
 * This module intentionally avoids any LLM dependency.
 *
 * To plug in a real model later, replace composeAnswer with a function that:
 * 1. takes DocsSearchResponse
 * 2. calls your LLM provider
 * 3. returns the same ChatTurn shape used by the chat panel
 */
function composeAnswer(response) {
    const topResults = response.results.slice(0, 5);
    if (!topResults.length) {
        return {
            question: response.query,
            answerSummary: "No matching results came back from the configured search endpoint.",
            citations: [],
            sourceName: response.source?.name,
        };
    }
    const lead = response.source
        ? `Top matches from ${response.source.name} for "${response.query}":`
        : `Top matches for "${response.query}":`;
    const bulletLines = topResults.map((result, index) => {
        const snippet = result.snippet.replace(/\s+/g, " ").trim();
        return `${index + 1}. ${result.title} (${result.source}) — ${snippet}`;
    });
    return {
        question: response.query,
        answerSummary: [lead, ...bulletLines].join("\n"),
        citations: topResults,
        sourceName: response.source?.name,
    };
}
//# sourceMappingURL=answerComposer.js.map