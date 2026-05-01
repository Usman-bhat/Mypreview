(function () {
  var vscode = acquireVsCodeApi();

  var urlInput = document.getElementById("urlInput");
  var backButton = document.getElementById("backButton");
  var forwardButton = document.getElementById("forwardButton");
  var reloadButton = document.getElementById("reloadButton");
  var menuPickElement = document.getElementById("menuPickElement");
  var menuToggleTerminal = document.getElementById("menuToggleTerminal");
  var menuToggleSidebar = document.getElementById("menuToggleSidebar");
  var moreButton = document.getElementById("moreButton");
  var moreMenu = document.getElementById("moreMenu");
  var screenshotButton = document.getElementById("screenshotButton");
  var captureAreaButton = document.getElementById("captureAreaButton");
  var menuScreenshot = document.getElementById("menuScreenshot");
  var menuAreaScreenshot = document.getElementById("menuAreaScreenshot");
  var menuHardReload = document.getElementById("menuHardReload");
  var menuCopyUrl = document.getElementById("menuCopyUrl");
  var menuClearHistory = document.getElementById("menuClearHistory");
  var menuClearCookies = document.getElementById("menuClearCookies");
  var menuClearCache = document.getElementById("menuClearCache");
  var menuToggleDevTools = document.getElementById("menuToggleDevTools");
  var menuToggleCssInspector = document.getElementById("menuToggleCssInspector");
  var zoomIn = document.getElementById("zoomIn");
  var zoomOut = document.getElementById("zoomOut");
  var zoomReset = document.getElementById("zoomReset");
  var zoomLevel = document.getElementById("zoomLevel");
  var stage = document.getElementById("stage");
  var browserFrame = document.getElementById("browserFrame");
  var emptyState = document.getElementById("emptyState");
  var messageBar = document.getElementById("messageBar");
  var selectionsBar = document.getElementById("selectionsBar");
  var selectionsList = document.getElementById("selectionsList");
  var clearSelections = document.getElementById("clearSelections");
  var pickButton = document.getElementById("pickButton");
  
  var inspectHoverBox = document.getElementById("inspectHoverBox");
  var inspectTooltip = document.getElementById("inspectTooltip");
  
  // Cursor-style panels
  var elementSelector = document.getElementById("elementSelector");
  var elementSelectorInfo = document.getElementById("elementSelectorInfo");
  var cssInspector = document.getElementById("cssInspector");
  var cssInspectorContent = document.getElementById("cssInspectorContent");
  var devTools = document.getElementById("devTools");
  var devToolsContent = document.getElementById("devToolsContent");
  var contextMenu = document.getElementById("contextMenu");

  var persisted = vscode.getState() || {};
  var currentUrl = persisted.url || (urlInput ? urlInput.value.trim() : "") || "";
  var selections = persisted.selections || [];
  var defaultEmptyStateMessage = emptyState ? emptyState.textContent : "Enter a URL to start browsing.";
  
  // State management
  var selectedElement = null;
  var cssHistory = [];
  var cssHistoryIndex = -1;
  var devToolsTab = 'console';
  var contextMenuTarget = null;

  var menuOpen = false;
  var currentZoom = 1;
  var pickMode = false;
  var hasLoadedFrame = false;
  
  // To avoid redundant CDP resize calls
  var lastWidth = 0;
  var lastHeight = 0;
  var lastFrameReportAt = 0;

  // Area capture drag state
  var areaCaptureMode = false;
  var areaDragStart = null;
  var areaDragOverlay = null;

  function post(type, payload) {
    if (typeof vscode !== 'undefined' && vscode.postMessage) {
      vscode.postMessage({ type: type, payload: payload });
    }
  }
  
  // Cursor-style API bridge
  function cursorBridge(action, data) {
    const allowedActions = [
      "element-selected", "element-updated", "element-picked", 
      "area-screenshot-selected", "style-changes-confirmed", 
      "css-inspector-style-change", "open-url-side-group", 
      "open-url-new-tab", "focus-composer-input", 
      "css-inspector-undo", "css-inspector-redo", 
      "show-dialog", "show-dialog-dummy", 
      "passkey-request-stalled", "browser-error-action"
    ];
    
    if (allowedActions.includes(action)) {
      post("cursor.bridge", { action: action, data: data });
    }
  }

  function persist() {
    vscode.setState({ url: currentUrl, selections: selections });
  }

  function updateZoomLabel() {
    if (zoomLevel) zoomLevel.textContent = Math.round(currentZoom * 100) + "%";
  }

  function hasRenderedFrame() {
    return hasLoadedFrame;
  }

  function showEmptyState(message) {
    if (emptyState) {
      emptyState.textContent = message || defaultEmptyStateMessage;
      emptyState.classList.remove("hidden");
    }
    if (browserFrame) {
      browserFrame.classList.add("hidden");
    }
  }

  function showLoadingPlaceholder(url) {
    if (hasRenderedFrame()) {
      emptyState.classList.add("hidden");
      browserFrame.classList.remove("hidden");
      return;
    }

    showEmptyState(url ? "Loading " + url + "..." : "Loading...");
  }

  function openMenu() {
    menuOpen = true;
    moreMenu.classList.remove("hidden");
  }

  function closeMenu() {
    menuOpen = false;
    moreMenu.classList.add("hidden");
  }

  function toggleMenu() {
    if (menuOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  function resizeBackend() {
    var rect = stage.getBoundingClientRect();
    var w = Math.round(rect.width / currentZoom);
    var h = Math.round(rect.height / currentZoom);
    if (w > 0 && h > 0 && (w !== lastWidth || h !== lastHeight)) {
      lastWidth = w;
      lastHeight = h;
      post("browser.resize", { width: w, height: h });
    }
  }

  window.addEventListener("resize", function() {
     resizeBackend();
  });

  /* ══════════════════════════════════════════
     Element Picker — Manus-style injection
     ══════════════════════════════════════════ */
  function enablePickMode() {
    pickMode = true;
    // Highlight both toolbar button and menu button if present
    if (pickButton) pickButton.classList.add("active");
    if (menuPickElement) menuPickElement.classList.add("active");
    stage.classList.add("pick-active");
    elementSelector.classList.remove("hidden");
    // Hide old CDP overlay — the injected script draws its own highlight inside the page
    inspectHoverBox.classList.add("hidden");
    inspectTooltip.classList.add("hidden");
    // Show instructional banner
    messageBar.textContent = '\u2B50 Pick mode: click any element in the browser to insert its HTML at your editor cursor. Press Escape to cancel.';
    messageBar.dataset.kind = '';
    messageBar.classList.remove('hidden');
    post("browser.togglePickMode", { active: true });
    cursorBridge("element-picked", { mode: 'enabled' });
  }

  function disablePickMode() {
    pickMode = false;
    if (pickButton) pickButton.classList.remove("active");
    if (menuPickElement) menuPickElement.classList.remove("active");
    stage.classList.remove("pick-active");
    elementSelector.classList.add("hidden");
    inspectHoverBox.classList.add("hidden");
    inspectTooltip.classList.add("hidden");
    messageBar.classList.add('hidden');
    post("browser.togglePickMode", { active: false });
    cursorBridge("element-picked", { mode: 'disabled' });
  }

  /* ── Selection chips ── */
  function renderSelections() {
    selectionsList.innerHTML = "";
    if (selections.length === 0) {
      selectionsBar.classList.add("hidden");
      return;
    }
    selectionsBar.classList.remove("hidden");

    selections.forEach(function (sel, idx) {
      var chip = document.createElement("div");
      chip.className = "selection-chip";
      chip.title = sel.selector;

      var tagSpan = document.createElement("span");
      tagSpan.className = "chip-tag";
      tagSpan.textContent = "<" + sel.tag + ">";
      chip.appendChild(tagSpan);

      if (sel.id) {
        var idSpan = document.createElement("span");
        idSpan.className = "chip-id";
        idSpan.textContent = "#" + sel.id;
        chip.appendChild(idSpan);
      }

      if (sel.classes && sel.classes.length > 0) {
        var clsSpan = document.createElement("span");
        clsSpan.className = "chip-class";
        clsSpan.textContent = "." + sel.classes.slice(0, 2).join(".");
        chip.appendChild(clsSpan);
      }

      if (sel.text && !sel.id && sel.classes.length === 0) {
        var textSpan = document.createElement("span");
        textSpan.className = "chip-text";
        textSpan.textContent = '"' + sel.text.substring(0, 30) + '"';
        chip.appendChild(textSpan);
      }

      var removeBtn = document.createElement("button");
      removeBtn.className = "chip-remove";
      removeBtn.textContent = "\u00d7";
      removeBtn.addEventListener("click", function () {
        removeSelection(idx);
      });
      chip.appendChild(removeBtn);

      chip.addEventListener("click", function (e) {
        if (e.target === removeBtn) return;
        navigator.clipboard.writeText(sel.selector).then(function () {
          messageBar.textContent = "Copied: " + sel.selector;
          messageBar.dataset.kind = "";
          messageBar.classList.remove("hidden");
          setTimeout(function () { messageBar.classList.add("hidden"); }, 2000);
        });
      });

      selectionsList.appendChild(chip);
    });
  }

  function addSelection(info) {
    var exists = selections.some(function (s) { return s.selector === info.selector; });
    if (exists) return;
    selections.push(info);
    persist();
    renderSelections();
  }

  function removeSelection(idx) {
    selections.splice(idx, 1);
    persist();
    renderSelections();
    post("browser.selectionsChanged", { selections: selections });
  }

  clearSelections.addEventListener("click", function () {
    selections = [];
    persist();
    renderSelections();
    post("browser.selectionsChanged", { selections: selections });
  });

  /* Cursor-style CSS Inspector */
  function openCssInspector(element) {
    selectedElement = element;
    cssInspector.classList.add("open");
    renderCssInspector(element);
  }

  function closeCssInspector() {
    cssInspector.classList.remove("open");
    selectedElement = null;
  }

  function renderCssInspector(element) {
    if (!element) return;
    
    const styles = element.computedStyles || {};
    let html = "";
    
    // Key CSS properties
    const keyProperties = [
      "color", "backgroundColor", "fontFamily", "fontSize", "fontWeight",
      "display", "position", "width", "height", "margin", "padding",
      "border", "borderRadius", "boxShadow", "transform", "opacity"
    ];
    
    keyProperties.forEach(prop => {
      const value = styles[prop] || "";
      html += `
        <div class="css-property">
          <div class="css-property-name">${prop}</div>
          <div class="css-property-value">
            <input class="css-property-input" data-property="${prop}" value="${value}" />
            <span class="css-property-unit"></span>
          </div>
        </div>
      `;
    });
    
    cssInspectorContent.innerHTML = html;
    
    // Add input listeners
    cssInspectorContent.querySelectorAll(".css-property-input").forEach(input => {
      input.addEventListener("input", function() {
        const prop = this.dataset.property;
        const value = this.value;
        updateCssProperty(prop, value);
      });
    });
  }

  function updateCssProperty(property, value) {
    if (!selectedElement) return;
    
    // Save to history for undo/redo
    const currentState = JSON.parse(JSON.stringify(cssHistory));
    cssHistory = cssHistory.slice(0, cssHistoryIndex + 1);
    cssHistory.push({
      element: selectedElement,
      property: property,
      oldValue: selectedElement.computedStyles[property] || "",
      newValue: value
    });
    cssHistoryIndex++;
    
    // Update the element
    selectedElement.computedStyles[property] = value;
    
    // Apply the change via CDP
    post("browser.updateStyle", {
      selector: selectedElement.selector,
      property: property,
      value: value
    });
    
    cursorBridge("css-inspector-style-change", {
      selector: selectedElement.selector,
      property: property,
      value: value
    });
  }

  function undoCssChange() {
    if (cssHistoryIndex < 0) return;
    
    const change = cssHistory[cssHistoryIndex];
    if (change && change.element) {
      updateCssProperty(change.property, change.oldValue);
      cssHistoryIndex--;
      
      // Re-render inspector
      renderCssInspector(change.element);
    }
    
    cursorBridge("css-inspector-undo", { undone: true });
  }

  function redoCssChange() {
    if (cssHistoryIndex >= cssHistory.length - 1) return;
    
    cssHistoryIndex++;
    const change = cssHistory[cssHistoryIndex];
    if (change && change.element) {
      updateCssProperty(change.property, change.newValue);
      
      // Re-render inspector
      renderCssInspector(change.element);
    }
    
    cursorBridge("css-inspector-redo", { redone: true });
  }

  /* Enhanced Element Selection */
  function updateElementSelector(element) {
    if (!element) {
      elementSelectorInfo.textContent = "No element selected";
      return;
    }
    
    const tag = element.nodeName ? element.nodeName.toLowerCase() : "";
    const id = element.id ? "#" + element.id : "";
    const classes = element.classes && element.classes.length > 0 ? "." + element.classes.slice(0, 2).join(".") : "";
    const selector = element.selector || tag + id + classes;
    
    elementSelectorInfo.textContent = selector;
    selectedElement = element;
  }

  /* Dev Tools */
  function openDevTools() {
    devTools.classList.add("open");
    updateDevToolsContent();
  }

  function closeDevTools() {
    devTools.classList.remove("open");
  }

  function updateDevToolsContent() {
    let content = "";
    
    switch (devToolsTab) {
      case "console":
        content = "// Console output will appear here\\n// Use cursorBridge('show-dialog', {...}) to send messages\\n";
        break;
      case "network":
        content = "// Network requests will appear here\\n// Monitor fetch/XHR activity\\n";
        break;
      case "elements":
        content = "// DOM tree will appear here\\n// Interactive element inspector\\n";
        break;
    }
    
    devToolsContent.textContent = content;
  }

  /* Context Menu */
  function showContextMenu(x, y, element) {
    contextMenuTarget = element;
    contextMenu.style.left = x + "px";
    contextMenu.style.top = y + "px";
    contextMenu.classList.remove("hidden");
  }

  function hideContextMenu() {
    contextMenu.classList.add("hidden");
    contextMenuTarget = null;
  }

  /* ══════════════════════════════════════════
     Navigation
     ══════════════════════════════════════════ */
  function navigate(url) {
    if (!url) return;
    currentUrl = url;
    urlInput.value = url;

    showLoadingPlaceholder(url);
    stage.classList.add("loading");
    messageBar.classList.add("hidden");

    if (pickMode) disablePickMode();

    persist();
    post("browser.navigate", { url: url });
  }

  function navigateFromInput() {
    var raw = urlInput.value.trim();
    if (!raw) return;
    navigate(raw);
  }

  /* ── Interaction Events ── */
  function getCoordinates(e) {
     var rect = browserFrame.getBoundingClientRect();
     var x = (e.clientX - rect.left) / currentZoom;
     var y = (e.clientY - rect.top) / currentZoom;
     return { x: x, y: y };
  }

  browserFrame.addEventListener("mousemove", function(e) {
     if (areaCaptureMode && areaDragStart) {
       updateAreaDragOverlay(e);
       return;
     }
     var coords = getCoordinates(e);
     post("browser.mousemove", coords);
  });
  
  browserFrame.addEventListener("mousedown", function(e) {
     if (areaCaptureMode) {
       areaDragStart = getCoordinates(e);
       showAreaDragOverlay(e);
       return;
     }
     e.preventDefault();
  });
  
  browserFrame.addEventListener("mouseup", function(e) {
     if (areaCaptureMode && areaDragStart) {
       var end = getCoordinates(e);
       var x = Math.min(areaDragStart.x, end.x);
       var y = Math.min(areaDragStart.y, end.y);
       var w = Math.abs(end.x - areaDragStart.x);
       var h = Math.abs(end.y - areaDragStart.y);
       hideAreaDragOverlay();
       areaCaptureMode = false;
       areaDragStart = null;
       browserFrame.style.cursor = '';
       stage.style.cursor = '';
       messageBar.classList.add('hidden');
       if (w > 5 && h > 5) {
         post("browser.captureArea", { x: x, y: y, width: w, height: h });
       }
       return;
     }
  });
  
  browserFrame.addEventListener("click", function(e) {
     if (areaCaptureMode) return; // handled by mouseup
     var coords = getCoordinates(e);
     post("browser.click", coords);
  });

  function showAreaDragOverlay(e) {
    if (!areaDragOverlay) {
      areaDragOverlay = document.createElement('div');
      areaDragOverlay.style.cssText = 'position:absolute;border:2px dashed #007fd4;background:rgba(0,127,212,0.12);pointer-events:none;z-index:200;';
      stage.appendChild(areaDragOverlay);
    }
    areaDragOverlay.style.display = 'block';
    areaDragOverlay.style.left = areaDragStart.x + 'px';
    areaDragOverlay.style.top = areaDragStart.y + 'px';
    areaDragOverlay.style.width = '0px';
    areaDragOverlay.style.height = '0px';
  }

  function updateAreaDragOverlay(e) {
    if (!areaDragOverlay || !areaDragStart) return;
    var cur = getCoordinates(e);
    var x = Math.min(areaDragStart.x, cur.x);
    var y = Math.min(areaDragStart.y, cur.y);
    var w = Math.abs(cur.x - areaDragStart.x);
    var h = Math.abs(cur.y - areaDragStart.y);
    areaDragOverlay.style.left = x + 'px';
    areaDragOverlay.style.top = y + 'px';
    areaDragOverlay.style.width = w + 'px';
    areaDragOverlay.style.height = h + 'px';
  }

  function hideAreaDragOverlay() {
    if (areaDragOverlay) areaDragOverlay.style.display = 'none';
  }

  stage.addEventListener("mouseleave", function() {
      inspectHoverBox.classList.add("hidden");
      inspectTooltip.classList.add("hidden");
  });

  browserFrame.addEventListener("wheel", function(e) {
     e.preventDefault();
     post("browser.wheel", { deltaX: e.deltaX, deltaY: e.deltaY });
  });

  /* ── Nav buttons ── */
  backButton.addEventListener("click", function () {
    post("browser.goBack");
  });

  forwardButton.addEventListener("click", function () {
    post("browser.goForward");
  });

  reloadButton.addEventListener("click", function () {
    post("browser.reload");
  });

  urlInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      navigateFromInput();
    }
  });

  urlInput.addEventListener("focus", function () {
    urlInput.select();
  });

  /* ── Toolbar actions ── */
  if (pickButton) {
    pickButton.addEventListener("click", function () {
      if (pickMode) disablePickMode();
      else enablePickMode();
    });
  }

  if (menuPickElement) {
    menuPickElement.addEventListener("click", function () {
      closeMenu();
      if (pickMode) disablePickMode();
      else enablePickMode();
    });
  }

  if (menuToggleTerminal) {
    menuToggleTerminal.addEventListener("click", function () { closeMenu(); post("browser.toggleTerminal"); });
  }
  
  if (menuToggleSidebar) {
    menuToggleSidebar.addEventListener("click", function () { closeMenu(); post("browser.toggleSidebar"); });
  }

  /* ── More menu ── */
  moreButton.addEventListener("click", function (event) {
    event.stopPropagation();
    event.preventDefault();
    toggleMenu();
  });

  document.addEventListener("click", function (event) {
    if (!menuOpen) return;
    var insideMenu = moreMenu.contains(event.target);
    var onButton = event.target === moreButton || moreButton.contains(event.target);
    if (!insideMenu && !onButton) {
      closeMenu();
    }
  });

  /* ── Menu items ── */
  function takeScreenshot() {
    closeMenu();
    post("browser.takeScreenshot");
  }

  function enterAreaCaptureMode() {
    closeMenu();
    areaCaptureMode = true;
    browserFrame.style.cursor = 'crosshair';
    stage.style.cursor = 'crosshair';
    messageBar.textContent = 'Drag to select an area to capture. Press Escape to cancel.';
    messageBar.dataset.kind = '';
    messageBar.classList.remove('hidden');
  }

  if (screenshotButton) {
    screenshotButton.addEventListener("click", takeScreenshot);
  }

  if (captureAreaButton) {
    captureAreaButton.addEventListener("click", enterAreaCaptureMode);
  }

  if (menuScreenshot) {
    menuScreenshot.addEventListener("click", takeScreenshot);
  }

  if (menuAreaScreenshot) {
    menuAreaScreenshot.addEventListener("click", enterAreaCaptureMode);
  }

  menuHardReload.addEventListener("click", function () {
    closeMenu();
    post("browser.hardReload");
  });

  menuCopyUrl.addEventListener("click", function () {
    closeMenu();
    post("browser.copyUrl");
  });

  menuClearHistory.addEventListener("click", function () {
    closeMenu();
    post("browser.clearBrowsingHistory");
  });

  menuClearCookies.addEventListener("click", function () {
    closeMenu();
    post("browser.clearCookies");
  });

  menuClearCache.addEventListener("click", function () {
    closeMenu();
    post("browser.clearCache");
  });

  if (menuToggleDevTools) {
    menuToggleDevTools.addEventListener("click", function () {
      closeMenu();
      if (devTools.classList.contains("open")) {
         closeDevTools();
      } else {
         devTools.classList.add("open");
      }
    });
  }

  if (menuToggleCssInspector) {
    menuToggleCssInspector.addEventListener("click", function () {
      closeMenu();
      if (cssInspector.classList.contains("open")) {
         closeCssInspector();
      } else {
         cssInspector.classList.add("open");
      }
    });
  }

  /* ── Zoom ── */
  function applyZoom() {
    browserFrame.style.transform = "scale(" + currentZoom + ")";
    browserFrame.style.transformOrigin = "0 0";
    // We let normal image act its size, but scaling shrinks or grows it.
    // We should notify backend to resize to match our inner container.
    resizeBackend();
    updateZoomLabel();
  }

  zoomIn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (currentZoom < 3) currentZoom = Math.round((currentZoom + 0.1) * 10) / 10;
    applyZoom();
  });

  zoomOut.addEventListener("click", function (e) {
    e.stopPropagation();
    if (currentZoom > 0.3) currentZoom = Math.round((currentZoom - 0.1) * 10) / 10;
    applyZoom();
  });

  zoomReset.addEventListener("click", function (e) {
    e.stopPropagation();
    currentZoom = 1;
    applyZoom();
  });

  /* Cursor-style Panel Event Listeners */
  // CSS Inspector
  document.getElementById("cssInspectorClose").addEventListener("click", closeCssInspector);
  document.getElementById("cssInspectorApply").addEventListener("click", function() {
    cursorBridge("style-changes-confirmed", { element: selectedElement });
  });
  document.getElementById("cssInspectorReset").addEventListener("click", function() {
    if (selectedElement) {
      renderCssInspector(selectedElement);
    }
  });
  document.getElementById("cssInspectorUndo").addEventListener("click", undoCssChange);
  document.getElementById("cssInspectorRedo").addEventListener("click", redoCssChange);

  // Element Selector
  document.getElementById("elementSelectBtn").addEventListener("click", function() {
    if (selectedElement) {
      addSelection(selectedElement);
      cursorBridge("element-selected", { element: selectedElement });
    }
  });
  document.getElementById("elementInspectBtn").addEventListener("click", function() {
    if (selectedElement) {
      openCssInspector(selectedElement);
    }
  });
  document.getElementById("elementCopyBtn").addEventListener("click", function() {
    if (selectedElement && selectedElement.selector) {
      navigator.clipboard.writeText(selectedElement.selector).then(function() {
        messageBar.textContent = "Copied: " + selectedElement.selector;
        messageBar.dataset.kind = "";
        messageBar.classList.remove("hidden");
        setTimeout(function() { messageBar.classList.add("hidden"); }, 2000);
      });
    }
  });

  // Dev Tools
  document.getElementById("devToolsClose").addEventListener("click", closeDevTools);
  
  document.querySelectorAll(".dev-tools-tab").forEach(tab => {
    tab.addEventListener("click", function() {
      document.querySelectorAll(".dev-tools-tab").forEach(t => t.classList.remove("active"));
      this.classList.add("active");
      devToolsTab = this.dataset.tab;
      updateDevToolsContent();
    });
  });

  // Context Menu
  document.getElementById("ctxInspect").addEventListener("click", function() {
    if (contextMenuTarget) {
      openCssInspector(contextMenuTarget);
    }
    hideContextMenu();
  });
  
  document.getElementById("ctxCopySelector").addEventListener("click", function() {
    if (contextMenuTarget && contextMenuTarget.selector) {
      navigator.clipboard.writeText(contextMenuTarget.selector);
    }
    hideContextMenu();
  });
  
  document.getElementById("ctxCopyStyles").addEventListener("click", function() {
    if (contextMenuTarget && contextMenuTarget.computedStyles) {
      const styles = JSON.stringify(contextMenuTarget.computedStyles, null, 2);
      navigator.clipboard.writeText(styles);
    }
    hideContextMenu();
  });
  
  document.getElementById("ctxEditStyles").addEventListener("click", function() {
    if (contextMenuTarget) {
      openCssInspector(contextMenuTarget);
    }
    hideContextMenu();
  });
  
  document.getElementById("ctxScreenshot").addEventListener("click", function() {
    if (contextMenuTarget) {
      post("browser.captureArea", { selector: contextMenuTarget.selector });
      cursorBridge("area-screenshot-selected", { element: contextMenuTarget });
    }
    hideContextMenu();
  });

  /* Cursor-style Keyboard Shortcuts */
  document.addEventListener("keydown", function (event) {
    // Handle Escape for panels
    if (event.key === "Escape") {
      if (areaCaptureMode) {
        areaCaptureMode = false;
        areaDragStart = null;
        hideAreaDragOverlay();
        browserFrame.style.cursor = '';
        stage.style.cursor = '';
        messageBar.classList.add('hidden');
        return;
      }
      if (menuOpen) { closeMenu(); return; }
      if (pickMode) { disablePickMode(); return; }
      if (!cssInspector.classList.contains("hidden")) { closeCssInspector(); return; }
      if (!devTools.classList.contains("hidden")) { closeDevTools(); return; }
      if (!contextMenu.classList.contains("hidden")) { hideContextMenu(); return; }
    }
    
    // Cursor-style shortcuts (matching Cursor's implementation)
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const metaKey = isMac ? event.metaKey : event.ctrlKey;
    const altKey = event.altKey;
    const shiftKey = event.shiftKey;
    
    if (metaKey && !shiftKey && !altKey) {
      switch (event.key.toLowerCase()) {
        case "r":
          event.preventDefault();
          post("browser.reload");
          break;
        case "l":
          event.preventDefault();
          urlInput.focus();
          urlInput.select();
          break;
        case "t":
          event.preventDefault();
          post("browser.newTab");
          break;
        case "i":
          event.preventDefault();
          openDevTools();
          break;
        case "b":
          event.preventDefault();
          post("browser.toggleSidebar");
          break;
        case "w":
          event.preventDefault();
          post("browser.closeTab");
          break;
        case "=":
        case "+":
          event.preventDefault();
          if (currentZoom < 3) currentZoom = Math.round((currentZoom + 0.1) * 10) / 10;
          applyZoom();
          break;
        case "-":
          event.preventDefault();
          if (currentZoom > 0.3) currentZoom = Math.round((currentZoom - 0.1) * 10) / 10;
          applyZoom();
          break;
        case "0":
          event.preventDefault();
          currentZoom = 1;
          applyZoom();
          break;
        case "z":
          event.preventDefault();
          if (selectedElement && cssInspector.classList.contains("open")) {
            undoCssChange();
          }
          break;
        case "a":
          event.preventDefault();
          post("browser.selectAll");
          break;
        case "[":
          event.preventDefault();
          post("browser.goBack");
          break;
        case "]":
          event.preventDefault();
          post("browser.goForward");
          break;
        case "d":
          event.preventDefault();
          post("browser.toggleBookmark");
          break;
      }
    }
    
    if (metaKey && shiftKey && !altKey) {
      switch (event.key.toLowerCase()) {
        case "i":
          event.preventDefault();
          openDevTools();
          break;
        case "z":
          event.preventDefault();
          if (selectedElement && cssInspector.classList.contains("open")) {
            redoCssChange();
          }
          break;
      }
    }
    
    if (altKey && !metaKey && !shiftKey) {
      switch (event.key.toLowerCase()) {
        case "arrowleft":
          event.preventDefault();
          post("browser.goBack");
          break;
        case "arrowright":
          event.preventDefault();
          post("browser.goForward");
          break;
      }
    }
    
    if (!metaKey && !shiftKey && !altKey) {
      switch (event.key.toLowerCase()) {
        case "f5":
          event.preventDefault();
          post("browser.reload");
          break;
        case "f12":
          event.preventDefault();
          openDevTools();
          break;
      }
    }
    
    // Only send if focus is on browserFrame or stage, not inputs
    if (document.activeElement === urlInput) return;
    
    // Ignore meta keys that are for VS Code itself
    if (event.metaKey && (event.key === "c" || event.key === "v" || event.key === "x")) return;
    
    post("browser.keydown", { key: event.key, code: event.code, text: event.key.length === 1 ? event.key : "" });
  });
  
  document.addEventListener("keyup", function (event) {
    if (document.activeElement === urlInput) return;
    post("browser.keyup", { key: event.key, code: event.code });
  });

  /* ── Incoming messages from extension ── */
  window.addEventListener("message", function (event) {
    var msg = event.data;
    
    if (!msg || !msg.type) {
      return;
    }

    if (msg.type === "browser.navigate") {
      if (msg.payload && msg.payload.url) {
        currentUrl = msg.payload.url;
        urlInput.value = currentUrl;
        persist();
        showLoadingPlaceholder(currentUrl);
        stage.classList.add("loading");
      }
    } else if (msg.type === "browser.togglePickMode") {
      // Extension can also send this back to forcibly deactivate pick mode
      // (e.g. after the injected script reported a successful pick).
      if (msg.payload && !msg.payload.active && pickMode) {
        disablePickMode();
      }
    } else if (msg.type === "browser.screenshot") {
      // Ensure the browser frame is visible
      browserFrame.style.display = 'block';
      browserFrame.style.visibility = 'visible';
      
      // payload is { mime: str, base64: str, dataUrl: str }
      if (msg.payload && msg.payload.dataUrl && msg.payload.dataUrl.startsWith('data:')) {
         browserFrame.onload = function() {
            // Image loaded successfully
            hasLoadedFrame = true;
            browserFrame.classList.remove("hidden");
            emptyState.textContent = defaultEmptyStateMessage;
            emptyState.classList.add("hidden");
            stage.classList.remove("loading");
            var now = Date.now();
            if (now - lastFrameReportAt > 5000) {
              lastFrameReportAt = now;
              post("browser.frameLoaded", {
                currentUrl: currentUrl,
                dataUrlLength: msg.payload.dataUrl.length,
                naturalWidth: browserFrame.naturalWidth,
                naturalHeight: browserFrame.naturalHeight,
                loadedAt: new Date(now).toISOString()
              });
            }
         };
         
         browserFrame.onerror = function(error) {
            // Image load error
            messageBar.textContent = "Error: Failed to display screenshot (possible CSP issue).";
            messageBar.dataset.kind = "error";
            messageBar.classList.remove("hidden");
            stage.classList.remove("loading");
            if (!hasRenderedFrame()) {
              showEmptyState("Unable to display the page preview.");
            }
         };
         
         browserFrame.src = msg.payload.dataUrl;
      } else {
         // Handle invalid or missing screenshot data
         if (!currentUrl) {
            // Show empty state if no URL is set
            showEmptyState(defaultEmptyStateMessage);
            stage.classList.remove("loading");
         } else if (!hasRenderedFrame()) {
            showEmptyState("Waiting for the page preview...");
         }
      }
    } else if (msg.type === "browser.inspectHover") {
      // In pick mode, the injected script draws its own overlay — suppress the CDP one.
      if (pickMode) return;
      var p = msg.payload;
      if (!p || !p.box) {
         if (inspectHoverBox) inspectHoverBox.classList.add("hidden");
         if (inspectTooltip) inspectTooltip.classList.add("hidden");
      } else {
         var box = p.box; // [x1, y1, x2, y2, x3, y3, x4, y4]
         var node = p.node;
         
         var minX = Math.min(box[0], box[2], box[4], box[6]) * currentZoom;
         var maxX = Math.max(box[0], box[2], box[4], box[6]) * currentZoom;
         var minY = Math.min(box[1], box[3], box[5], box[7]) * currentZoom;
         var maxY = Math.max(box[1], box[3], box[5], box[7]) * currentZoom;
         var width = maxX - minX;
         var height = maxY - minY;
         
         inspectHoverBox.style.left = minX + "px";
         inspectHoverBox.style.top = minY + "px";
         inspectHoverBox.style.width = width + "px";
         inspectHoverBox.style.height = height + "px";
         inspectHoverBox.classList.remove("hidden");
         
         var tag = node.nodeName ? node.nodeName.toLowerCase() : "";
         var id = "";
         var cls = "";
         if (node.attributes) {
            for (var i = 0; i < node.attributes.length; i+=2) {
               if (node.attributes[i] === "id") id = node.attributes[i+1];
               if (node.attributes[i] === "class") cls = node.attributes[i+1].trim().split(" ")[0];
            }
         }
         var label = tag;
         if (id) label += "#" + id;
         else if (cls) label += "." + cls;
         label += " " + Math.round(width/currentZoom) + "×" + Math.round(height/currentZoom);
         
         inspectTooltip.textContent = label;
         var ttTop = minY - 26;
         if (ttTop < 4) ttTop = minY + height + 4;
         inspectTooltip.style.left = Math.max(4, minX) + "px";
         inspectTooltip.style.top = ttTop + "px";
         inspectTooltip.classList.remove("hidden");
         
         // Update element selector with current element
         if (pickMode) {
            var elementInfo = {
               nodeName: tag,
               id: id,
               classes: cls ? [cls] : [],
               selector: label.split(" ")[0],
               computedStyles: p.computedStyles || {},
               box: box
            };
            updateElementSelector(elementInfo);
         }
      }
    } else if (msg.type === "browser.elementSelected") {
      // Handle element selection from CDP
      var element = msg.payload;
      if (element) {
         updateElementSelector(element);
         cursorBridge("element-updated", { element: element });
      }
    } else if (msg.type === "browser.contextMenu") {
      // Show context menu at position
      var coords = msg.payload;
      if (coords && coords.element) {
         showContextMenu(coords.x, coords.y, coords.element);
      }
    } else if (msg.type === "browser.devToolsMessage") {
      // Handle dev tools messages
      if (devToolsContent && msg.payload && msg.payload.message) {
         devToolsContent.textContent += msg.payload.message + "\\n";
         devToolsContent.scrollTop = devToolsContent.scrollHeight;
      }
    } else if (msg.type === "cursor.bridge.response") {
      // Responses are intentionally ignored unless the UI needs to display them.
    } else if (msg.type === "browser.areaScreenshot") {
      // Show screenshot in a lightbox overlay
      var p = msg.payload || {};
      if (p.dataUrl) {
        showScreenshotLightbox(p.dataUrl);
      }
    } else if (msg.type === "browser.state") {
      var p = msg.payload || {};
      if (p.error) {
        messageBar.textContent = p.error;
        messageBar.dataset.kind = "error";
        messageBar.classList.remove("hidden");
        stage.classList.remove("loading");
        if (!hasRenderedFrame()) {
          showEmptyState("Unable to load " + currentUrl + ".");
        }
      } else if (p.warning) {
        messageBar.textContent = p.warning;
        messageBar.dataset.kind = "warning";
        messageBar.classList.remove("hidden");
      } else {
        messageBar.classList.add("hidden");
        if (!currentUrl && !hasRenderedFrame()) {
          showEmptyState(defaultEmptyStateMessage);
        }
      }
    }
  });

  /* ── Init ── */
  renderSelections();
  
  // Try to resize backend initially
  setTimeout(resizeBackend, 100);

  if (currentUrl) {
    showLoadingPlaceholder(currentUrl);
    stage.classList.add("loading");
  }

  post("browser.ready");

  /* ── Screenshot Lightbox ── */
  function showScreenshotLightbox(dataUrl) {
    // Remove any existing lightbox
    var existing = document.getElementById('screenshotLightbox');
    if (existing) existing.remove();

    var lb = document.createElement('div');
    lb.id = 'screenshotLightbox';
    lb.style.cssText = [
      'position:fixed;top:0;left:0;right:0;bottom:0;',
      'background:rgba(0,0,0,0.85);z-index:9999;',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'gap:12px;'
    ].join('');

    var img = document.createElement('img');
    img.src = dataUrl;
    img.style.cssText = 'max-width:90%;max-height:75vh;border-radius:4px;box-shadow:0 8px 32px rgba(0,0,0,0.6);';

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';

    var copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy to Clipboard';
    copyBtn.style.cssText = 'padding:8px 16px;background:#0e639c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
    copyBtn.addEventListener('click', function() {
      // Convert dataUrl to blob and write to clipboard
      fetch(dataUrl).then(function(r) { return r.blob(); }).then(function(blob) {
        navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]).then(function() {
          copyBtn.textContent = 'Copied!';
          setTimeout(function() { copyBtn.textContent = 'Copy to Clipboard'; }, 1500);
        }).catch(function() {
          // Fallback: just copy the URL string
          navigator.clipboard.writeText(dataUrl);
          copyBtn.textContent = 'URL Copied!';
          setTimeout(function() { copyBtn.textContent = 'Copy to Clipboard'; }, 1500);
        });
      });
    });

    var downloadBtn = document.createElement('a');
    downloadBtn.textContent = 'Download';
    downloadBtn.href = dataUrl;
    downloadBtn.download = 'screenshot-' + Date.now() + '.png';
    downloadBtn.style.cssText = 'padding:8px 16px;background:#3c3c3c;color:#ccc;border:none;border-radius:4px;cursor:pointer;font-size:13px;text-decoration:none;display:inline-block;';

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ Close';
    closeBtn.style.cssText = 'padding:8px 16px;background:transparent;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;font-size:13px;';
    closeBtn.addEventListener('click', function() { lb.remove(); });

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(downloadBtn);
    btnRow.appendChild(closeBtn);

    lb.appendChild(img);
    lb.appendChild(btnRow);

    lb.addEventListener('click', function(e) {
      if (e.target === lb) lb.remove();
    });

    document.body.appendChild(lb);
  }
})();
