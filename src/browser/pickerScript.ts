export const PICKER_SCRIPT = `(() => {
  class ElementOverlay {
    constructor(options) {
      const style = options.style || {};
      this.overlay = document.createElement("div");
      this.overlay.className = options.className || "_ext-element-overlay";
      this.overlay.style.background = style.background || "rgba(0, 129, 242, 0.08)";
      this.overlay.style.borderColor = style.borderColor || "#0081f2";
      this.overlay.style.borderStyle = style.borderStyle || "solid";
      this.overlay.style.borderRadius = style.borderRadius || "1px";
      this.overlay.style.borderWidth = style.borderWidth || "1px";
      this.overlay.style.boxSizing = style.boxSizing || "border-box";
      this.overlay.style.cursor = style.cursor || "crosshair";
      this.overlay.style.margin = style.margin || "0px";
      this.overlay.style.padding = style.padding || "0px";
      this.overlay.style.pointerEvents = "auto";
      this.overlay.style.position = style.position || "absolute";
      this.overlay.style.zIndex = style.zIndex || "2147483647";

      this.shadowContainer = document.createElement("div");
      this.shadowContainer.className = "_ext-element-overlay-container";
      this.shadowContainer.style.left = "0px";
      this.shadowContainer.style.margin = "0px";
      this.shadowContainer.style.padding = "0px";
      this.shadowContainer.style.position = "absolute";
      this.shadowContainer.style.top = "0px";
    }

    addToDOM(parentElement, useShadowDOM) {
      this.usingShadowDOM = useShadowDOM;
      if (useShadowDOM) {
        this.shadowRoot = this.shadowContainer.attachShadow({ mode: "open" });
        parentElement.insertBefore(this.shadowContainer, parentElement.firstChild);
        this.shadowRoot.appendChild(this.overlay);
        return;
      }

      parentElement.appendChild(this.overlay);
    }

    removeFromDOM() {
      this.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      this.overlay.remove();
      if (this.usingShadowDOM) {
        this.shadowContainer.remove();
      }
    }

    captureCursor() {
      this.overlay.style.pointerEvents = "auto";
    }

    ignoreCursor() {
      this.overlay.style.pointerEvents = "none";
    }

    setBounds(bounds) {
      this.overlay.style.left = bounds.x + "px";
      this.overlay.style.top = bounds.y + "px";
      this.overlay.style.width = bounds.width + "px";
      this.overlay.style.height = bounds.height + "px";
    }
  }

  function getElementBounds(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: window.pageXOffset + rect.left,
      y: window.pageYOffset + rect.top,
      width: element.offsetWidth,
      height: element.offsetHeight
    };
  }

  class ElementPicker {
    constructor(overlayOptions) {
      this.active = false;
      this.overlay = new ElementOverlay(overlayOptions || {});
      this.handleMouseMove = (event) => {
        this.mouseX = event.clientX;
        this.mouseY = event.clientY;
      };
      this.handleClick = (event) => {
        if (this.target && this.options && this.options.onClick) {
          this.options.onClick(this.target, event);
        }
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
      };
      this.tick = () => {
        this.updateTarget();
        this.tickReq = window.requestAnimationFrame(this.tick);
      };
    }

    start(options) {
      if (this.active) {
        return false;
      }

      this.active = true;
      this.options = options;
      document.addEventListener("mousemove", this.handleMouseMove, true);
      document.addEventListener("click", this.handleClick, true);
      this.overlay.addToDOM(options.parentElement || document.body, options.useShadowDOM !== false);
      this.tick();
      return true;
    }

    stop() {
      this.active = false;
      this.options = undefined;
      document.removeEventListener("mousemove", this.handleMouseMove, true);
      document.removeEventListener("click", this.handleClick, true);
      this.overlay.removeFromDOM();
      this.target = undefined;
      this.mouseX = undefined;
      this.mouseY = undefined;
      if (this.tickReq) {
        window.cancelAnimationFrame(this.tickReq);
      }
    }

    updateTarget() {
      if (this.mouseX === undefined || this.mouseY === undefined) {
        return;
      }

      this.overlay.ignoreCursor();
      const newTarget = document.elementFromPoint(this.mouseX, this.mouseY);
      this.overlay.captureCursor();

      if (!newTarget || newTarget === this.target) {
        return;
      }

      if (this.options && this.options.elementFilter && !this.options.elementFilter(newTarget)) {
        this.target = undefined;
        this.overlay.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        return;
      }

      this.target = newTarget;
      this.overlay.setBounds(getElementBounds(newTarget));

      if (this.options && this.options.onHover) {
        this.options.onHover(newTarget);
      }
    }
  }

  function buildQuickSelector(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let part = current.localName || current.tagName.toLowerCase();
      if (!part) {
        break;
      }

      if (current.id) {
        part += "#" + CSS.escape(current.id);
        parts.unshift(part);
        break;
      }

      const classes = Array.from(current.classList || []).slice(0, 2);
      if (classes.length > 0) {
        part += classes.map((name) => "." + CSS.escape(name)).join("");
      }

      let siblingIndex = 1;
      let sibling = current;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.localName === current.localName) {
          siblingIndex += 1;
        }
      }

      if (current.previousElementSibling || current.nextElementSibling) {
        part += ":nth-of-type(" + siblingIndex + ")";
      }

      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function cleanupPicker() {
    if (window.__vsCodePickerInstance) {
      window.__vsCodePickerInstance.stop();
      window.__vsCodePickerInstance = undefined;
    }
    if (window.__vsCodePickerEscapeHandler) {
      document.removeEventListener("keydown", window.__vsCodePickerEscapeHandler, true);
      window.__vsCodePickerEscapeHandler = undefined;
    }
    window.__vsCodePickerActive = false;
  }

  window.StartVsCodePicker = function() {
    if (window.__vsCodePickerActive) {
      return;
    }

    window.__vsCodePickerActive = true;

    const picker = new ElementPicker({
      style: {
        background: "rgba(0, 129, 242, 0.08)",
        borderColor: "#0081f2"
      }
    });

    window.__vsCodePickerInstance = picker;

    const emitPayload = (payload) => {
      if (typeof window.__vscodePicker === "function") {
        window.__vscodePicker(JSON.stringify(payload));
      }
    };

    const stopAndEmitCancel = () => {
      cleanupPicker();
      emitPayload({ cancelled: true });
    };

    window.__vsCodePickerEscapeHandler = (event) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      stopAndEmitCancel();
    };

    document.addEventListener("keydown", window.__vsCodePickerEscapeHandler, true);

    picker.start({
      onHover: () => {},
      onClick: (element, event) => {
        const payload = {
          cancelled: false,
          classes: Array.from(element.classList || []),
          clientX: event.clientX,
          clientY: event.clientY,
          id: element.id || "",
          outerHTML: (element.outerHTML || "").slice(0, 50000),
          pageX: window.scrollX + event.clientX,
          pageY: window.scrollY + event.clientY,
          selector: buildQuickSelector(element),
          tag: (element.tagName || "").toLowerCase(),
          textSnippet: (element.innerText || element.textContent || "").trim().slice(0, 240)
        };

        cleanupPicker();
        emitPayload(payload);
      }
    });
  };

  window.StopVsCodePicker = function() {
    cleanupPicker();
  };
})();
`;
