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
    private readonly trace?: (message: string, data?: unknown) => void,
  ) {}

  public async inspectPoint(x: number, y: number, currentUrl: string): Promise<ElementInspectorData | undefined> {
    try {
      // Make sure the DOM agent has populated its node id table — without
      // this, `DOM.getNodeForLocation` can return nodeId: 0 on the first
      // call after a navigation.
      await this.session.send("DOM.getDocument", { depth: 0 }).catch(() => undefined);

      const located = await this.session.send<NodeForLocationResponse>("DOM.getNodeForLocation", {
        x,
        y,
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: true,
      });
      this.trace?.("picker.getNodeForLocation.ok", { x, y, located });

      let nodeId = located.nodeId;
      if (!nodeId && located.backendNodeId) {
        const desc = await this.session.send<DescribeNodeResponse>("DOM.describeNode", { backendNodeId: located.backendNodeId, depth: 0 });
        nodeId = desc.node.nodeId;
        this.trace?.("picker.describeFromBackendNodeId.ok", { backendNodeId: located.backendNodeId, nodeId });
      }

      if (!nodeId) {
        this.trace?.("picker.noNodeAtLocation", { x, y, located });
        return undefined;
      }

      return this.inspectNode(nodeId, currentUrl, located.backendNodeId);
    } catch (error) {
      this.trace?.("picker.inspectPoint.error", { x, y, error: formatPickerError(error) });
      return undefined;
    }
  }

  public async inspectNode(
    nodeId: number,
    currentUrl: string,
    backendNodeId?: number,
  ): Promise<ElementInspectorData | undefined> {
    try {
      // Required: describe + resolve. If either fails, the node is gone.
      const describedNode = await this.session.send<DescribeNodeResponse>("DOM.describeNode", { nodeId, depth: 0 });
      const resolvedNode = await this.session.send<ResolveNodeResponse>("DOM.resolveNode", { nodeId });

      // Optional: computed styles and box model. Off-screen / 0-sized
      // elements throw on getBoxModel; elements without computed styles
      // (e.g. SVG fragments) throw on getComputedStyleForNode. Don't let
      // those side issues abort the whole pick.
      const [computedStyles, boxModel] = await Promise.all([
        this.session
          .send<ComputedStyleResponse>("CSS.getComputedStyleForNode", { nodeId })
          .catch((error) => {
            this.trace?.("picker.computedStyle.error", { nodeId, error: formatPickerError(error) });
            return undefined;
          }),
        this.session
          .send<BoxModelResponse>("DOM.getBoxModel", { nodeId })
          .catch((error) => {
            this.trace?.("picker.boxModel.error", { nodeId, error: formatPickerError(error) });
            return undefined;
          }),
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
        this.trace?.("picker.runtimeCallReturnedNoValue", { nodeId });
        return undefined;
      }

      const computedStyleMap = (computedStyles?.computedStyle ?? []).reduce<Record<string, string>>(
        (accumulator, style) => {
          accumulator[style.name] = style.value;
          return accumulator;
        },
        {},
      );

      const box = boxModel
        ? boxFromModel(boxModel.model.border)
        : { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };

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
    } catch (error) {
      this.trace?.("picker.inspectNode.error", { nodeId, error: formatPickerError(error) });
      return undefined;
    }
  }
}

function formatPickerError(error: unknown): string {
  return error instanceof Error ? `${error.message}` : String(error);
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
