import { BrowserSession } from "./browserSession";
import { buildInspectorData } from "./inspectorModel";
import { ElementInspectorData } from "./types";

interface NodeForLocationResponse {
  nodeId: number;
  backendNodeId?: number;
}

interface DescribeNodeResponse {
  node: {
    nodeId: number;
    backendNodeId?: number;
    nodeName: string;
    attributes?: string[];
  };
}

interface ResolveNodeResponse {
  object: {
    objectId: string;
  };
}

interface ComputedStyleResponse {
  computedStyle: Array<{
    name: string;
    value: string;
  }>;
}

interface BoxModelResponse {
  model: {
    border: number[];
    width: number;
    height: number;
  };
}

interface RuntimeValueResponse {
  result?: {
    value?: unknown;
  };
}

interface RuntimeInspectorValue {
  selector: string;
  outerHtml: string;
  textSnippet: string;
  tagName: string;
  attributes: Record<string, string>;
}

export class PickerController {
  public constructor(
    private readonly session: BrowserSession,
    private readonly maxOuterHtmlLength: number,
  ) {}

  public async inspectPoint(x: number, y: number, currentUrl: string): Promise<ElementInspectorData | undefined> {
    try {
      const located = await this.session.send<NodeForLocationResponse>("DOM.getNodeForLocation", {
        x,
        y,
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: true,
      });

      return this.inspectNode(located.nodeId, currentUrl, located.backendNodeId);
    } catch {
      return undefined;
    }
  }

  public async inspectNode(
    nodeId: number,
    currentUrl: string,
    backendNodeId?: number,
  ): Promise<ElementInspectorData | undefined> {
    try {
      const [describedNode, resolvedNode, computedStyles, boxModel] = await Promise.all([
        this.session.send<DescribeNodeResponse>("DOM.describeNode", { nodeId, depth: 0 }),
        this.session.send<ResolveNodeResponse>("DOM.resolveNode", { nodeId }),
        this.session.send<ComputedStyleResponse>("CSS.getComputedStyleForNode", { nodeId }),
        this.session.send<BoxModelResponse>("DOM.getBoxModel", { nodeId }),
      ]);

      const runtimePayload = await this.session.send<RuntimeValueResponse>("Runtime.callFunctionOn", {
        objectId: resolvedNode.object.objectId,
        returnByValue: true,
        functionDeclaration: `function(maxOuterHtmlLength) {
          const el = this;
          const attributes = {};
          for (const attribute of Array.from(el.attributes || []).slice(0, 12)) {
            attributes[attribute.name] = attribute.value;
          }

          function buildSelector(element) {
            const parts = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE) {
              let part = current.localName || current.tagName.toLowerCase();
              if (!part) {
                break;
              }

              if (current.id) {
                part += '#' + CSS.escape(current.id);
                parts.unshift(part);
                break;
              }

              const classes = Array.from(current.classList || []).slice(0, 2);
              if (classes.length) {
                part += classes.map((name) => '.' + CSS.escape(name)).join('');
              }

              let index = 1;
              let sibling = current;
              while ((sibling = sibling.previousElementSibling)) {
                if (sibling.localName === current.localName) {
                  index += 1;
                }
              }

              const hasSameTypeSibling = !!current.previousElementSibling || !!current.nextElementSibling;
              if (hasSameTypeSibling) {
                part += ':nth-of-type(' + index + ')';
              }

              parts.unshift(part);
              current = current.parentElement;
            }

            return parts.join(' > ');
          }

          return {
            attributes,
            outerHtml: (el.outerHTML || '').slice(0, maxOuterHtmlLength * 2),
            selector: buildSelector(el),
            tagName: (el.tagName || '').toLowerCase(),
            textSnippet: (el.innerText || el.textContent || '').trim().slice(0, 400),
          };
        }`,
        arguments: [{ value: this.maxOuterHtmlLength }],
      });

      const runtimeValue = runtimePayload.result?.value as RuntimeInspectorValue | undefined;
      if (!runtimeValue) {
        return undefined;
      }

      const computedStyleMap = computedStyles.computedStyle.reduce<Record<string, string>>((accumulator, style) => {
        accumulator[style.name] = style.value;
        return accumulator;
      }, {});

      const box = boxFromModel(boxModel.model.border);

      return buildInspectorData(
        {
          nodeId: describedNode.node.nodeId,
          backendNodeId: backendNodeId ?? describedNode.node.backendNodeId,
          url: currentUrl,
          tagName: runtimeValue.tagName || describedNode.node.nodeName.toLowerCase(),
          selector: runtimeValue.selector,
          outerHtml: runtimeValue.outerHtml,
          textSnippet: runtimeValue.textSnippet,
          attributes: runtimeValue.attributes,
          computedStyles: computedStyleMap,
          box,
        },
        this.maxOuterHtmlLength,
      );
    } catch {
      return undefined;
    }
  }
}

function boxFromModel(borderQuad: number[]) {
  const xs = borderQuad.filter((_, index) => index % 2 === 0);
  const ys = borderQuad.filter((_, index) => index % 2 === 1);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    top,
    left,
    right,
    bottom,
  };
}
