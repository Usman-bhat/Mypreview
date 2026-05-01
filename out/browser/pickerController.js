"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PickerController = void 0;
const inspectorModel_1 = require("./inspectorModel");
class PickerController {
    session;
    maxOuterHtmlLength;
    constructor(session, maxOuterHtmlLength) {
        this.session = session;
        this.maxOuterHtmlLength = maxOuterHtmlLength;
    }
    async inspectPoint(x, y, currentUrl) {
        try {
            const located = await this.session.send("DOM.getNodeForLocation", {
                x,
                y,
                includeUserAgentShadowDOM: true,
                ignorePointerEventsNone: true,
            });
            return this.inspectNode(located.nodeId, currentUrl, located.backendNodeId);
        }
        catch {
            return undefined;
        }
    }
    async inspectNode(nodeId, currentUrl, backendNodeId) {
        try {
            const [describedNode, resolvedNode, computedStyles, boxModel] = await Promise.all([
                this.session.send("DOM.describeNode", { nodeId, depth: 0 }),
                this.session.send("DOM.resolveNode", { nodeId }),
                this.session.send("CSS.getComputedStyleForNode", { nodeId }),
                this.session.send("DOM.getBoxModel", { nodeId }),
            ]);
            const runtimePayload = await this.session.send("Runtime.callFunctionOn", {
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
            const runtimeValue = runtimePayload.result?.value;
            if (!runtimeValue) {
                return undefined;
            }
            const computedStyleMap = computedStyles.computedStyle.reduce((accumulator, style) => {
                accumulator[style.name] = style.value;
                return accumulator;
            }, {});
            const box = boxFromModel(boxModel.model.border);
            return (0, inspectorModel_1.buildInspectorData)({
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
            }, this.maxOuterHtmlLength);
        }
        catch {
            return undefined;
        }
    }
}
exports.PickerController = PickerController;
function boxFromModel(borderQuad) {
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
//# sourceMappingURL=pickerController.js.map