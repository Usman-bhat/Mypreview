import { ElementReference } from "./types";

function stableSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortKeys(item));
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = stableSortKeys((value as Record<string, unknown>)[key]);
        return accumulator;
      }, {});
  }

  return value;
}

export function serializeSelectionContext(references: ElementReference[]): string {
  const normalized = references.map((reference) => ({
    box: {
      bottom: round(reference.box.bottom),
      height: round(reference.box.height),
      left: round(reference.box.left),
      right: round(reference.box.right),
      top: round(reference.box.top),
      width: round(reference.box.width),
      x: round(reference.box.x),
      y: round(reference.box.y),
    },
    computedStyles: reference.computedStyles,
    computedStylesHash: reference.computedStylesHash,
    outerHtml: reference.outerHtml,
    selector: reference.selector,
    tagName: reference.tagName,
    textSnippet: reference.textSnippet,
    url: reference.url,
  }));

  const markdown = normalized.length
    ? normalized
        .map((reference, index) => {
          return [
            `### Element ${index + 1}`,
            `- URL: ${reference.url}`,
            `- Selector: \`${reference.selector}\``,
            `- Tag: \`${reference.tagName}\``,
            `- Box: ${reference.box.width}x${reference.box.height} at (${reference.box.x}, ${reference.box.y})`,
            `- Styles Hash: \`${reference.computedStylesHash}\``,
            reference.textSnippet ? `- Text: ${reference.textSnippet}` : undefined,
            "",
            "```html",
            reference.outerHtml,
            "```",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n")
    : "No pinned elements.";

  const json = JSON.stringify(stableSortKeys(normalized), null, 2);

  return [`# Browser Selection Context`, markdown, "## JSON", "```json", json, "```"].join("\n\n");
}

function round(value: number): number {
  return Number(value.toFixed(2));
}
