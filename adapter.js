/*\
title: $:/plugins/rimir/mindmap-elixir/adapter.js
type: application/javascript
module-type: mindmapengine

mind-elixir engine adapter for rimir/mindmap. Implements the mindmapengine
contract so any <$mindmap> widget can render via mind-elixir.

Capabilities:
  applyOps  = false    (always full update in v1)
  focus     = true
  expand    = true
  drag      = true
  edit      = false    (mind-elixir's built-in editing emits ops back; we
                       expose them as Op events but classify the adapter
                       itself as non-edit until the contract proves stable)

\*/

"use strict";

// The bundled mind-elixir IIFE references browser globals (document, window)
// at top level, so we cannot require() it eagerly — that would crash the
// server-side module loader. Lazy-load on first init(), which only runs in
// the browser.
var MELib = null;
var MindElixirCtor = null;

function loadLibrary() {
    if (MELib) { return MELib; }
    MELib = require("$:/plugins/rimir/mindmap-elixir/lib/mind-elixir.umd.js");
    MindElixirCtor = (MELib && MELib.default) ? MELib.default : MELib;
    return MELib;
}

var ENGINE_NAME = "MindElixir";

function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

// Pick black or white text for legibility on the supplied background. Returns
// null when the input is not a parseable hex / rgb colour — the caller leaves
// the foreground unset so mind-elixir's theme default applies.
function contrastingForeground(bg) {
    if (!bg || typeof bg !== "string") { return null; }
    var s = bg.trim();
    var r, g, b;
    var m = s.match(/^#([0-9a-f]{3})$/i);
    if (m) {
        r = parseInt(m[1][0] + m[1][0], 16);
        g = parseInt(m[1][1] + m[1][1], 16);
        b = parseInt(m[1][2] + m[1][2], 16);
    } else {
        m = s.match(/^#([0-9a-f]{6})$/i);
        if (m) {
            r = parseInt(m[1].substring(0, 2), 16);
            g = parseInt(m[1].substring(2, 4), 16);
            b = parseInt(m[1].substring(4, 6), 16);
        } else {
            m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
            if (!m) { return null; }
            r = parseInt(m[1], 10); g = parseInt(m[2], 10); b = parseInt(m[3], 10);
        }
    }
    // Relative luminance (sRGB, simplified — no gamma expansion since we just
    // need a robust threshold).
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? "#222" : "#fff";
}

// MDOM → mind-elixir node-data tree.
//
// `core:icon` becomes a mind-elixir `icons` array entry — rendered in a
// separate non-editable `<span class="icons">` next to the topic. This keeps
// the editable label clean, so `finishEdit` round-trips the pure label back
// to us with no emoji-in-slug surprises.
function toMENode(mnode) {
    if (!mnode) { return null; }
    var attrs = mnode.attrs || {};
    if (attrs["core:hidden"]) { return null; }
    var meNode = {
        id: mnode.id,
        topic: mnode.label || ""
    };
    // Build the icon stack. Flag-driven decoration writes `mx:icons` as a
    // pipe-separated list in descending-priority order (highest-priority
    // glyph on the left). `core:icon` (the producer-emitted single icon)
    // joins on the RIGHT so the producer's intrinsic icon never displaces
    // the user-authored flag icons.
    var iconStack = [];
    if (attrs["mx:icons"]) {
        var parts = String(attrs["mx:icons"]).split("|");
        for (var ii = 0; ii < parts.length; ii++) {
            var p = parts[ii];
            if (p) { iconStack.push(p); }
        }
    }
    if (attrs["core:icon"]) { iconStack.push(attrs["core:icon"]); }
    if (iconStack.length > 0) { meNode.icons = iconStack; }
    if (mnode.body) { meNode.note = mnode.body; }
    if (attrs["core:color"]) {
        meNode.style = meNode.style || {};
        meNode.style.background = attrs["core:color"];
        var fg = contrastingForeground(attrs["core:color"]);
        if (fg) { meNode.style.color = fg; }
    }
    // Flag-driven typography & decoration. Each block guards on non-empty
    // so empty strings never pollute meNode.style — mind-elixir's renderer
    // would otherwise serialise them into the inline style attribute.
    if (attrs["mx:text-color"]) {
        meNode.style = meNode.style || {};
        // Overrides any auto-contrast colour the bg-driven branch chose.
        meNode.style.color = attrs["mx:text-color"];
    }
    if (attrs["mx:font-weight"]) {
        meNode.style = meNode.style || {};
        meNode.style.fontWeight = attrs["mx:font-weight"];
    }
    if (attrs["mx:font-style"]) {
        meNode.style = meNode.style || {};
        meNode.style.fontStyle = attrs["mx:font-style"];
    }
    if (attrs["mx:text-transform"]) {
        meNode.style = meNode.style || {};
        meNode.style.textTransform = attrs["mx:text-transform"];
    }
    if (attrs["mx:opacity"] !== undefined && attrs["mx:opacity"] !== null && attrs["mx:opacity"] !== "") {
        meNode.style = meNode.style || {};
        meNode.style.opacity = String(attrs["mx:opacity"]);
    }
    if (attrs["mx:font-size-scale"]) {
        meNode.style = meNode.style || {};
        // Mind-elixir applies its own base size; an `em` multiplier keeps the
        // rule independent of the theme's chosen pixel size.
        meNode.style.fontSize = String(attrs["mx:font-size-scale"]) + "em";
    }
    if (attrs["mx:border"]) {
        meNode.style = meNode.style || {};
        // `outline` rather than `border` — the topic bubble already uses
        // `border` for its focus ring; using outline keeps our decoration
        // additive instead of clobbering the engine's chrome.
        meNode.style.outline = String(attrs["mx:border"]);
        meNode.style.outlineOffset = "2px";
    }
    if (attrs["mx:tags"]) { meNode.tags = attrs["mx:tags"]; }
    if (attrs["mx:hyperLink"]) { meNode.hyperLink = attrs["mx:hyperLink"]; }
    if (attrs["core:collapsed"]) { meNode.expanded = false; }
    if (attrs["mx:expanded"] === true) { meNode.expanded = true; }
    if (attrs["mx:expanded"] === false) { meNode.expanded = false; }
    var children = mnode.children || [];
    var meChildren = [];
    for (var i = 0; i < children.length; i++) {
        var child = toMENode(children[i]);
        if (child) { meChildren.push(child); }
    }
    if (meChildren.length > 0) { meNode.children = meChildren; }
    return meNode;
}

function toMEData(mdom) {
    var nodeData = toMENode(mdom.root) || { id: "__empty__", topic: "(empty)" };
    var data = { nodeData: nodeData };
    if (mdom.crossLinks && mdom.crossLinks.length > 0) {
        // mind-elixir's linkData is keyed by an id pair string. We emit it for
        // round-trip preservation only; the adapter does not yet draw the
        // crossLinks itself (would require a custom canvas pass).
        data.linkData = {};
        for (var i = 0; i < mdom.crossLinks.length; i++) {
            var link = mdom.crossLinks[i];
            var key = link.from + "::" + link.to;
            data.linkData[key] = {
                id: key,
                from: link.from,
                to: link.to,
                label: link.label || ""
            };
        }
    }
    return data;
}

// Resolve "the nearest enclosing parent id" for a moveNode event. mind-elixir
// passes the affected node object but no parent reference; walk our cached
// composite to find it.
function findParentId(root, targetId) {
    if (!root) { return null; }
    var children = root.children || [];
    for (var i = 0; i < children.length; i++) {
        if (children[i].id === targetId) { return root.id; }
        var hit = findParentId(children[i], targetId);
        if (hit) { return hit; }
    }
    return null;
}

// Constructor. The widget calls `new Engine(wiki)`.
function Engine(wiki) {
    this.wiki = wiki;
    this.me = null;
    this.element = null;
    this.callbacks = {};       // event name → [fn]
    this.lastMdom = null;
    this.options = null;
    this._busHandler = null;
    this._suspendOps = false;  // widget toggles this around structural applyOps
    this._idIndex = null;      // id → true map of nodes in lastMdom
    this._lastSelectedId = null;
    this._keydownHandler = null;
    this._structural = false;  // widget sets via setStructural; gates Tab/Enter intercept
    // Host policy: when false, the adapter swallows Tab/Enter (and other
    // native creation gestures) so the user can't accidentally produce
    // placeholder nodes on a view that has no place to persist them. Default
    // true — engine retains its native behavior.
    this._allowNodeCreation = true;
}

Engine.prototype.name = ENGINE_NAME;

Engine.prototype.capabilities = {
    applyOps: false,
    focus: true,
    expand: true,
    drag: true,
    edit: true
};

Engine.prototype.on = function (event, fn) {
    if (!event || typeof fn !== "function") { return; }
    this.callbacks[event] = this.callbacks[event] || [];
    this.callbacks[event].push(fn);
};

Engine.prototype._emit = function (event, payload) {
    var arr = this.callbacks[event];
    if (!arr) { return; }
    for (var i = 0; i < arr.length; i++) {
        try { arr[i](payload); } catch (e) { console.error("[mindmap-elixir] callback error", e); }
    }
};

// Widget calls this around structural applyOps so the cascade of wiki change
// events (and any synthetic mind-elixir operations they cause) doesn't loop
// ops back to the producer.
Engine.prototype.setSuspendOps = function (flag) {
    this._suspendOps = !!flag;
};

// Widget tells the engine whether the producer is structural (writes back to
// real tiddlers). When true, the adapter intercepts Tab/Enter keypresses so
// mind-elixir doesn't create an internal placeholder node before our popup
// has a chance to capture the user's label.
Engine.prototype.setStructural = function (flag) {
    this._structural = !!flag;
};

// Host policy: when false, the adapter blocks native node-creation gestures
// at the keydown capture-phase BEFORE mind-elixir's own handler runs. Used
// by views whose producer cannot persist new nodes (e.g. grouped-tree, where
// structural-volatile axis groupings have no tiddler-of-origin to inherit
// from). The default is true; only setStructural-style adapters need this.
Engine.prototype.setAllowNodeCreation = function (flag) {
    this._allowNodeCreation = !!flag;
};

// Look up the parent id of a given node id in the cached MDOM. Used by the
// keydown intercept to derive the new sibling's parent (Enter creates a
// sibling of the selected node, so the parent we want is the selected
// node's parent).
function findParentInMdom(node, targetId) {
    if (!node) { return null; }
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) {
        if (children[i].id === targetId) { return node.id; }
        var hit = findParentInMdom(children[i], targetId);
        if (hit) { return hit; }
    }
    return null;
}

// Find a node by id in the cached MDOM, then count its descendants (total
// across the subtree, NOT including the node itself). Used to size the
// delete-confirm message.
function countSubtree(node) {
    if (!node || !node.children) { return 0; }
    var n = node.children.length;
    for (var i = 0; i < node.children.length; i++) {
        n += countSubtree(node.children[i]);
    }
    return n;
}
function findInMdom(node, targetId) {
    if (!node) { return null; }
    if (node.id === targetId) { return node; }
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) {
        var hit = findInMdom(children[i], targetId);
        if (hit) { return hit; }
    }
    return null;
}
function countDescendantsInMdom(root, targetId) {
    var n = findInMdom(root, targetId);
    return n ? countSubtree(n) : 0;
}

// Walk the cached lastMdom and build an id-existence index. Re-built on each
// update() so id-guarded ops always check against the current snapshot.
function buildIdIndex(node, index) {
    if (!node) { return; }
    if (node.id) { index[node.id] = true; }
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) { buildIdIndex(children[i], index); }
}
Engine.prototype._rebuildIdIndex = function () {
    var index = Object.create(null);
    if (this.lastMdom && this.lastMdom.root) { buildIdIndex(this.lastMdom.root, index); }
    this._idIndex = index;
};

Engine.prototype.init = function (element, mdom, options) {
    loadLibrary();
    if (!MindElixirCtor) {
        throw new Error("mind-elixir library failed to load");
    }
    this.element = element;
    this.lastMdom = deepClone(mdom);
    this._rebuildIdIndex();
    this.options = options || {};

    // mind-elixir replaces the host element's children, so make sure the
    // container is empty and has a definite size.
    while (element.firstChild) { element.removeChild(element.firstChild); }

    var meOptions = {
        el: element,
        direction: MELib.SIDE != null ? MELib.SIDE : 2,
        draggable: true,
        contextMenu: true,
        toolBar: true,
        keypress: true,
        editable: true
    };
    // Pass through any options the user supplied on the view.
    for (var key in this.options) {
        if (Object.prototype.hasOwnProperty.call(this.options, key)) {
            meOptions[key] = this.options[key];
        }
    }
    // We always own `el` — never let the user override it.
    meOptions.el = element;

    this.me = new MindElixirCtor(meOptions);
    // me.init can synchronously fire operation events (e.g. expandNode for
    // any node whose initial state is collapsed). Suspend the bus during the
    // bootstrap so they don't leak into the overlay store before any user
    // gesture has happened.
    this._suspendOpsDuringRefresh = true;
    try {
        this.me.init(toMEData(this.lastMdom));
    } finally {
        this._suspendOpsDuringRefresh = false;
    }
    this._applyTooltips();

    var self = this;
    if (this.me.bus && typeof this.me.bus.addListener === "function") {
        this._busHandler = function (operation) { self._handleOperation(operation); };
        this.me.bus.addListener("operation", this._busHandler);
        // mind-elixir v5.11 fires `selectNodes` (plural) with an array of
        // selected nodeObjs. The primary is the last element; falling back to
        // the first if needed.
        this.me.bus.addListener("selectNodes", function (nodes) {
            if (self._suppressSelectEvents) { return; }
            var primary = (nodes && nodes.length) ? nodes[nodes.length - 1] : null;
            self._lastSelectedId = primary && primary.id;
            self._emit("select", primary && primary.id);
        });
        // Kept for forward-compat if a future mind-elixir version emits the
        // singular event.
        this.me.bus.addListener("selectNode", function (node) {
            if (self._suppressSelectEvents) { return; }
            self._lastSelectedId = node && node.id;
            self._emit("select", node && node.id);
        });
        // Empty-canvas click / outside-node click — clear selection state so
        // any consumer-side affordances (e.g. action buttons) can hide.
        // Mind-elixir also fires this synchronously during refresh()
        // teardown; the _suppressSelectEvents flag (set by update()) gates
        // those so they don't propagate as real deselects.
        this.me.bus.addListener("unselectNodes", function () {
            if (self._suppressSelectEvents) { return; }
            self._lastSelectedId = null;
            self._emit("select", null);
        });
        this.me.bus.addListener("unselectNode", function () {
            if (self._suppressSelectEvents) { return; }
            self._lastSelectedId = null;
            self._emit("select", null);
        });
        // Collapse/expand. mind-elixir fires this as a TOP-LEVEL bus event
        // (not under "operation"), with the affected nodeObj as the single
        // argument. Its `.expanded` property reflects the new state. We
        // translate to a `setAttr core:collapsed` op so the overlay store
        // persists the change — otherwise collapse experiments vanish on
        // the next refresh (engine state is rebuilt from base + overlay
        // ops; if the op never made it into overlay, the producer's
        // initial-collapsed config wins again).
        this.me.bus.addListener("expandNode", function (nodeObj) {
            if (self._suspendOps || self._suspendOpsDuringRefresh) { return; }
            if (!nodeObj || !nodeObj.id) { return; }
            // Drop stale ids (DOM-flight gestures during a cascade refresh).
            if (self._idIndex && !self._idIndex[nodeObj.id]) { return; }
            var collapsed = (nodeObj.expanded === false);
            self._emit("op", {
                op: "setAttr",
                id: nodeObj.id,
                key: "core:collapsed",
                value: collapsed ? true : null   // null clears the attr
            });
        });
    }

    // Document-level capture-phase keydown intercept. Two distinct concerns:
    //
    //   1. F2 (structural views only) — open the full editor for the
    //      selected node. mind-elixir's native F2 enters inline-rename which
    //      bypasses our popup-edit-modal, so we preempt it.
    //   2. Tab / Enter (when allowNodeCreation is false) — block mind-
    //      elixir's native placeholder-creation path entirely. Used by
    //      grouped-tree and other producers that have no way to persist a
    //      new node (synthetic axis grouping has no tiddler of origin).
    //
    // Both branches share the same "are we eligible to intercept" prelude:
    // event originated inside our canvas, not inside an editable widget,
    // no modifier soup. The capture phase fires before mind-elixir's own
    // listener, so preventDefault here wins.
    this._keydownHandler = function (ev) {
        if (ev.defaultPrevented) { return; }
        // Only react to events that originated inside our canvas element.
        if (!self.element || !self.element.contains(ev.target)) { return; }
        // Don't intercept while user is typing inside the input-box (rename)
        // or any other editable surface.
        if (ev.target && ev.target.id === "input-box") { return; }
        if (ev.target && ev.target.tagName === "INPUT") { return; }
        if (ev.target && ev.target.tagName === "TEXTAREA") { return; }
        if (ev.target && ev.target.isContentEditable) { return; }
        var isPlainKey = !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
        // Tab / Enter creation block: gated on allowNodeCreation, no structural
        // requirement (the toggle is about whether the engine should respond
        // to native creation gestures at all). Pressing the key with no
        // selection still gets blocked — mind-elixir would otherwise create
        // a root sibling.
        if (!self._allowNodeCreation && isPlainKey && (ev.key === "Tab" || ev.key === "Enter")) {
            ev.preventDefault();
            ev.stopPropagation();
            if (typeof ev.stopImmediatePropagation === "function") {
                ev.stopImmediatePropagation();
            }
            return;
        }
        // F2 → request-edit. Only meaningful on structural views; for non-
        // structural the producer has no real tiddler to edit.
        if (!self._structural) { return; }
        if (ev.key !== "F2" || !isPlainKey) { return; }
        var selected = self._lastSelectedId;
        if (!selected && self.me && self.me.currentNode) {
            var cn = self.me.currentNode;
            selected = (cn.nodeObj && cn.nodeObj.id) || cn.id || null;
        }
        if (!selected) { return; }
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === "function") {
            ev.stopImmediatePropagation();
        }
        self._emit("op", { op: "requestEditNode", id: selected });
    };
    var doc = this.element && this.element.ownerDocument || document;
    doc.addEventListener("keydown", this._keydownHandler, true);
    this._keydownDoc = doc;
};

// Walk the MDOM and copy each node's `core:tooltip` attribute onto the
// corresponding DOM element's `title=` (native browser tooltip on hover).
// Called after every init() and update() so tooltips track the current tree.
function walkMdom(node, fn) {
    if (!node) { return; }
    fn(node);
    var children = node.children || [];
    for (var i = 0; i < children.length; i++) { walkMdom(children[i], fn); }
}
Engine.prototype._applyTooltips = function () {
    if (!this.me || typeof this.me.findEle !== "function") { return; }
    if (!this.lastMdom || !this.lastMdom.root) { return; }
    var me = this.me;
    walkMdom(this.lastMdom.root, function (n) {
        var attrs = n.attrs || {};
        var el;
        try { el = me.findEle(n.id); } catch (e) { return; }
        if (!el) { return; }
        // findEle returns the me-tpc element directly (mind-elixir v5.11);
        // setting title on it puts the tooltip on the topic bubble.
        // Combine producer-emitted core:tooltip with flag-decoration tooltips
        // (one line per matching rule that declared mm.flag-tooltip). Order:
        // structural info first, decoration second — so hovers feel "node
        // summary, then state".
        var tipParts = [];
        if (attrs["core:tooltip"]) { tipParts.push(String(attrs["core:tooltip"])); }
        if (attrs["mx:flag-tooltip"]) { tipParts.push(String(attrs["mx:flag-tooltip"])); }
        if (tipParts.length > 0) {
            el.setAttribute("title", tipParts.join("\n"));
        } else if (el.hasAttribute && el.hasAttribute("title")) {
            el.removeAttribute("title");
        }
        // Forward mindmap-namespace decoration attrs to data-* on the DOM so
        // wiki-level CSS can style without engine-specific knowledge.
        //   mm:has-slides → data-mm-has-slides="yes"
        //                   (used by slides-only mode to highlight nodes that
        //                    own slides directly vs. ancestors that don't)
        if (attrs["mm:has-slides"]) {
            el.setAttribute("data-mm-has-slides", "yes");
        } else if (el.hasAttribute && el.hasAttribute("data-mm-has-slides")) {
            // Clear stale attr left over from a previous render where this node
            // had slides but no longer does (e.g. the last slide was deleted).
            el.removeAttribute("data-mm-has-slides");
        }
        //   gt:leaf-count → data-mm-leaf-count="<N>"
        //                   (descendant-leaf count for grouped-tree synthetic
        //                    nodes; CSS renders it as " (N)" only while the
        //                    node is collapsed, so the badge disappears once
        //                    children are visible).
        if (attrs["gt:leaf-count"] !== undefined && attrs["gt:leaf-count"] !== null) {
            el.setAttribute("data-mm-leaf-count", String(attrs["gt:leaf-count"]));
        } else if (el.hasAttribute && el.hasAttribute("data-mm-leaf-count")) {
            el.removeAttribute("data-mm-leaf-count");
        }
        //   mx:flags → data-mm-flags="<space-separated>"
        //              CSS hook for flag-driven styling. Token-list matching
        //              with [data-mm-flags~="name"] keeps individual flags
        //              independently selectable. Absent when no rule matches
        //              (rather than empty-string) so [data-mm-flags] selectors
        //              don't false-positive.
        if (attrs["mx:flags"]) {
            el.setAttribute("data-mm-flags", String(attrs["mx:flags"]));
        } else if (el.hasAttribute && el.hasAttribute("data-mm-flags")) {
            el.removeAttribute("data-mm-flags");
        }
        //   mx:flag-classes → data-mm-flag-classes="<space-separated>"
        //                     Custom class tokens contributed by individual
        //                     flag rules. Author-controlled escape hatch.
        if (attrs["mx:flag-classes"]) {
            el.setAttribute("data-mm-flag-classes", String(attrs["mx:flag-classes"]));
        } else if (el.hasAttribute && el.hasAttribute("data-mm-flag-classes")) {
            el.removeAttribute("data-mm-flag-classes");
        }
        //   core:synthetic → data-mm-synthetic="yes"
        //                    Distinguishes grouped-tree chain/axis nodes from
        //                    tiddler-backed leaves so CSS can tone aggregated
        //                    flags down (e.g. show only the icon, suppress
        //                    border) without affecting leaf-level styling.
        if (attrs["core:synthetic"] === true) {
            el.setAttribute("data-mm-synthetic", "yes");
        } else if (el.hasAttribute && el.hasAttribute("data-mm-synthetic")) {
            el.removeAttribute("data-mm-synthetic");
        }
        //   mm:label-status → data-mm-label-status="undefined"
        //                     Stamped by the producer when the chosen label
        //                     field has no value. CSS uses it to surface a
        //                     muted secondary line (the leaf-segment title)
        //                     above the "UNDEFINED" topic.
        if (attrs["mm:label-status"]) {
            el.setAttribute("data-mm-label-status", String(attrs["mm:label-status"]));
        } else if (el.hasAttribute && el.hasAttribute("data-mm-label-status")) {
            el.removeAttribute("data-mm-label-status");
        }
        //   mm:label-fallback-title → data-mm-fallback-title="<leaf segment>"
        //                             The would-have-been label when the
        //                             chosen field is empty. Rendered as a
        //                             ::before pseudo-element so the editable
        //                             topic text stays clean.
        if (attrs["mm:label-fallback-title"]) {
            el.setAttribute("data-mm-fallback-title", String(attrs["mm:label-fallback-title"]));
        } else if (el.hasAttribute && el.hasAttribute("data-mm-fallback-title")) {
            el.removeAttribute("data-mm-fallback-title");
        }
    });
};

// Translate a mind-elixir operation into our canonical Op vocabulary and
// emit it for the widget to append to the overlay store.
//
// mind-elixir's operation payload shapes (per v5.11 bundle):
//   moveNodeIn / moveNodeBefore / moveNodeAfter : { objs: [nodeObj, ...], toObj }
//   addChild / insertSibling / insertParent     : { obj: nodeObj }
//   finishEdit                                  : { obj: nodeObj, origin }
//   removeNodes                                 : { objs: [nodeObj, ...] }
//   moveUpNode / moveDownNode                   : { obj: nodeObj }
// After a structural change mind-elixir updates `nodeObj.parent` (a reference
// to the parent nodeObj), so we read it directly rather than guessing from a
// cached MDOM snapshot.
// Ops where the primary `obj` may legitimately carry an id that's NOT in our
// cached MDOM index (a freshly-generated placeholder from mind-elixir). The
// id-existence guard must skip these — addChild/insertSibling for placeholder
// creation, and finishEdit because the placeholder's first confirmation is a
// rename-of-unknown-id that we translate into an addNode op.
var NEW_NODE_OPS = {
    addChild: true,
    insertSibling: true,
    insertParent: true,
    finishEdit: true
};

Engine.prototype._handleOperation = function (op) {
    if (!op) { return; }
    if (this._suspendOps) { return; }
    // Internal during-refresh guard. Toggled by update() so the synthetic
    // operation events mind-elixir replays as it rebuilds the DOM (e.g.
    // expandNode for any node whose initial expanded=false in the data)
    // don't loop back to our overlay store. Distinct from _suspendOps which
    // the widget toggles externally around structural applyOps.
    if (this._suspendOpsDuringRefresh) { return; }
    var name = op.name;
    var primary = op.obj || (op.objs && op.objs[0]) || null;
    // Allow-node-creation veto: if the host disabled creation, drop any
    // operation that creates new nodes (mind-elixir's context-menu "Add
    // Child" / "Add Sibling" reach us this way, bypassing the keydown
    // intercept). Reset the canvas to our last-known MDOM so any in-memory
    // placeholder mind-elixir already produced disappears. finishEdit also
    // arrives for a fresh placeholder confirmation — block it here too.
    if (!this._allowNodeCreation && NEW_NODE_OPS[name]) {
        if (this.me && typeof this.me.refresh === "function" && this.lastMdom) {
            try {
                this._suppressSelectEvents = true;
                this.me.refresh(toMEData(this.lastMdom));
                this._applyTooltips();
            } finally {
                this._suppressSelectEvents = false;
            }
        }
        return;
    }
    // Id-existence guard: if the primary node isn't in our last-known MDOM,
    // the gesture targets a stale DOM node from a redraw in flight. Drop the
    // op rather than emit it against a phantom id. Skip the guard for ops
    // that create new nodes — their ids are by definition fresh.
    if (!NEW_NODE_OPS[name] && primary && primary.id && this._idIndex && !this._idIndex[primary.id]) {
        console.warn("[mindmap-elixir] dropping op with stale id:", primary.id, name);
        return;
    }
    var self = this;
    switch (name) {
        case "finishEdit":
            if (!primary || !primary.id) { break; }
            // If the id is in our cached MDOM, this is a rename of an
            // existing node. Otherwise it's mind-elixir's placeholder being
            // confirmed for the first time → emit addNode with the
            // user-typed label (so the produced tiddler title reflects what
            // they typed, not the placeholder's default).
            if (this._idIndex && this._idIndex[primary.id]) {
                this._emit("op", { op: "rename", id: primary.id, label: primary.topic || "" });
            } else {
                var addParent = primary.parent && primary.parent.id;
                if (!addParent) { break; }
                this._emit("op", {
                    op: "addNode",
                    parent: addParent,
                    node: { id: primary.id, label: primary.topic || "" }
                });
            }
            break;
        case "removeNode":
        case "removeNodes": {
            var nodes = op.objs || (primary ? [primary] : []);
            if (nodes.length === 0) { break; }
            // Confirm before propagating. mind-elixir has already removed the
            // node(s) from its internal tree by the time this event fires, so
            // a Cancel must re-sync the engine from our cached MDOM to
            // visually restore them.
            var msg;
            if (nodes.length === 1) {
                var lbl = (nodes[0] && nodes[0].topic) || (nodes[0] && nodes[0].id) || "node";
                var desc = countDescendantsInMdom(self.lastMdom && self.lastMdom.root, nodes[0].id);
                msg = desc > 0
                    ? "Delete \"" + lbl + "\" and " + desc + " descendant" + (desc === 1 ? "" : "s") + "?"
                    : "Delete \"" + lbl + "\"?";
            } else {
                msg = "Delete " + nodes.length + " selected nodes (with their descendants)?";
            }
            if (typeof window !== "undefined" && window.confirm && !window.confirm(msg)) {
                if (self.me && typeof self.me.refresh === "function") {
                    self.me.refresh(toMEData(self.lastMdom));
                    self._applyTooltips();
                }
                break;
            }
            nodes.forEach(function (n) {
                if (n && n.id) { self._emit("op", { op: "removeNode", id: n.id }); }
            });
            break;
        }
        case "addChild":
        case "insertSibling":
            // Intentionally a no-op: mind-elixir has created an in-memory
            // placeholder and opened inline-edit on it. We wait for the
            // follow-up `finishEdit` (when the user confirms the name) and
            // create the real tiddler then, so the title slug reflects what
            // the user typed rather than mind-elixir's "New Node" default.
            break;
        case "moveNodeIn":
        case "moveNodeBefore":
        case "moveNodeAfter":
        case "moveUpNode":
        case "moveDownNode": {
            // The moved nodes' .parent reference has been updated by mind-elixir
            // before this event fires, so it's the authoritative new parent.
            var moved = op.objs || (primary ? [primary] : []);
            moved.forEach(function (n) {
                if (!n || !n.id) { return; }
                var np = n.parent && n.parent.id;
                if (!np) { return; }
                self._emit("op", { op: "reparent", id: n.id, newParent: np });
                // Capture sibling ordering too: a reparent doesn't pin position
                // within the new parent's children, but a reorder does.
                if (n.parent && Array.isArray(n.parent.children)) {
                    var order = n.parent.children
                        .map(function (c) { return c && c.id; })
                        .filter(function (id) { return !!id; });
                    if (order.length > 1) {
                        self._emit("op", { op: "reorder", parent: np, order: order });
                    }
                }
            });
            break;
        }
        case "beginEdit":
        case "selectNode":
            // Informational only.
            break;
        default:
            // Forward unknown ops as a setAttr so they round-trip without loss.
            if (primary && primary.id) {
                this._emit("op", { op: "setAttr", id: primary.id, key: "mx:lastOp", value: name });
            }
    }
};

Engine.prototype.update = function (mdom) {
    if (!this.me) { return; }
    var preservedId = this._lastSelectedId;
    this.lastMdom = deepClone(mdom);
    this._rebuildIdIndex();
    var data = toMEData(this.lastMdom);
    if (typeof this.me.refresh === "function") {
        // Mind-elixir.refresh fires unselectNodes synchronously as it tears
        // down the DOM, AND our subsequent focus() to restore the prior
        // selection fires selectNodes — both would propagate to consumer
        // listeners and clobber their state (e.g. clear the preview's
        // edit-mode on every keystroke). Suppress the entire window. Also
        // suppress operation events: refresh() may replay expandNode for any
        // node whose initial state is collapsed, which would loop back to
        // the overlay store via setAttr.
        this._suppressSelectEvents = true;
        this._suspendOpsDuringRefresh = true;
        try {
            this.me.refresh(data);
            this._applyTooltips();
            if (preservedId && this._idIndex && this._idIndex[preservedId]) {
                try { this.focus(preservedId); } catch (e) { /* ignore */ }
            }
        } finally {
            this._suppressSelectEvents = false;
            this._suspendOpsDuringRefresh = false;
        }
    } else {
        // Fallback: tear down and re-init.
        this.destroy();
        this.init(this.element, mdom, this.options);
    }
};

Engine.prototype.focus = function (nodeId) {
    if (!this.me || !nodeId) { return; }
    try {
        if (typeof this.me.selectNode === "function") {
            var node = (this.me.findEle && this.me.findEle(nodeId)) || null;
            if (node) { this.me.selectNode(node); }
        }
    } catch (e) { /* ignore */ }
};

Engine.prototype.expand = function (nodeId) {
    if (!this.me || !nodeId) { return; }
    if (typeof this.me.expandNode === "function") {
        try {
            var node = this.me.findEle && this.me.findEle(nodeId);
            if (node) { this.me.expandNode(node, true); }
        } catch (e) { /* ignore */ }
    }
};

Engine.prototype.collapse = function (nodeId) {
    if (!this.me || !nodeId) { return; }
    if (typeof this.me.expandNode === "function") {
        try {
            var node = this.me.findEle && this.me.findEle(nodeId);
            if (node) { this.me.expandNode(node, false); }
        } catch (e) { /* ignore */ }
    }
};

Engine.prototype.destroy = function () {
    if (this._keydownHandler && this._keydownDoc) {
        try { this._keydownDoc.removeEventListener("keydown", this._keydownHandler, true); } catch (e) { /* ignore */ }
        this._keydownHandler = null;
        this._keydownDoc = null;
    }
    if (this.me) {
        if (this._busHandler && this.me.bus && typeof this.me.bus.removeListener === "function") {
            try { this.me.bus.removeListener("operation", this._busHandler); } catch (e) { /* ignore */ }
        }
        if (typeof this.me.destroy === "function") {
            try { this.me.destroy(); } catch (e) { /* ignore */ }
        }
        this.me = null;
    }
    if (this.element) {
        while (this.element.firstChild) { this.element.removeChild(this.element.firstChild); }
    }
    this._busHandler = null;
    this.callbacks = {};
};

// The widget detects functions via `typeof Engine === "function"` and calls
// `new Engine(wiki)`. Export the constructor, overriding Function.name so
// findEngineByName() matches our declared engine name.
Object.defineProperty(Engine, "name", { value: ENGINE_NAME, configurable: true });
Engine.capabilities = Engine.prototype.capabilities;
module.exports = Engine;
// Test-only: pure translation helper, surfaced for unit tests so the MDOM →
// mind-elixir mapping for flag attrs can be pinned without bootstrapping the
// full engine instance + canvas.
module.exports._toMENode = toMENode;
