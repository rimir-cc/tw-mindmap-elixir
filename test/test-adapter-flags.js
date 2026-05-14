/*\
title: $:/plugins/rimir/mindmap-elixir/test/test-adapter-flags.js
type: application/javascript
tags: [[$:/tags/test-spec]]

Pins for the MDOM → mind-elixir nodeData translation of the flag-decoration
attribute family. Exercises `toMENode` directly via the module's test-only
export — no DOM / engine instance required.

\*/

"use strict";

describe("mindmap-elixir-adapter-flags", function () {
    var adapter = require("$:/plugins/rimir/mindmap-elixir/adapter.js");
    var toMENode = adapter._toMENode;

    function leaf(attrs) {
        return { id: "n", label: "Node", attrs: attrs || {}, children: [] };
    }

    it("maps mx:text-color → style.color", function () {
        var me = toMENode(leaf({ "mx:text-color": "#445566" }));
        expect(me.style && me.style.color).toBe("#445566");
    });

    it("maps mx:font-weight → style.fontWeight", function () {
        var me = toMENode(leaf({ "mx:font-weight": "bold" }));
        expect(me.style && me.style.fontWeight).toBe("bold");
    });

    it("maps mx:font-style → style.fontStyle", function () {
        var me = toMENode(leaf({ "mx:font-style": "italic" }));
        expect(me.style && me.style.fontStyle).toBe("italic");
    });

    it("maps mx:text-transform → style.textTransform", function () {
        var me = toMENode(leaf({ "mx:text-transform": "uppercase" }));
        expect(me.style && me.style.textTransform).toBe("uppercase");
    });

    it("maps mx:opacity → style.opacity (stringified)", function () {
        var me = toMENode(leaf({ "mx:opacity": "0.5" }));
        expect(me.style && me.style.opacity).toBe("0.5");
    });

    it("maps mx:border → style.outline (NOT border — avoids focus-ring clash)", function () {
        var me = toMENode(leaf({ "mx:border": "2px solid #d04444" }));
        expect(me.style && me.style.outline).toBe("2px solid #d04444");
        expect(me.style && me.style.border).toBeUndefined();
        expect(me.style && me.style.outlineOffset).toBe("2px");
    });

    it("maps mx:font-size-scale → style.fontSize as em multiplier", function () {
        var me = toMENode(leaf({ "mx:font-size-scale": "1.2" }));
        expect(me.style && me.style.fontSize).toBe("1.2em");
    });

    it("merges mx:icons before core:icon (decoration wins leftmost)", function () {
        var me = toMENode(leaf({ "mx:icons": "🔥|⏰", "core:icon": "📌" }));
        expect(me.icons).toEqual(["🔥", "⏰", "📌"]);
    });

    it("uses only core:icon when mx:icons absent (preserves legacy behaviour)", function () {
        var me = toMENode(leaf({ "core:icon": "📌" }));
        expect(me.icons).toEqual(["📌"]);
    });

    it("emits no icons when neither attr is set", function () {
        var me = toMENode(leaf({}));
        expect(me.icons).toBeUndefined();
    });

    it("empty mx:opacity does NOT pollute style.opacity", function () {
        var me = toMENode(leaf({ "mx:opacity": "" }));
        expect(me.style && me.style.opacity).toBeUndefined();
    });

    it("mx:text-color overrides the auto-contrast color from core:color", function () {
        var me = toMENode(leaf({ "core:color": "#000000", "mx:text-color": "#ff0000" }));
        // Background derived from core:color stays; explicit text-color wins.
        expect(me.style.background).toBe("#000000");
        expect(me.style.color).toBe("#ff0000");
    });

    // The DOM `title=` merging happens in `_applyTooltips`, which needs a
    // real mind-elixir instance to walk findEle()/setAttribute on. Cover the
    // pure merge logic directly with a small DOM stub so the contract is
    // pinned without an engine instance.
    describe("_applyTooltips title= merging", function () {
        // Build a fake mind-elixir whose findEle() returns a per-id stub
        // element with setAttribute / removeAttribute / hasAttribute.
        function makeFakeEngine(mdom) {
            var attrs = Object.create(null);   // id → { name → value }
            function elFor(id) {
                attrs[id] = attrs[id] || Object.create(null);
                var bag = attrs[id];
                return {
                    setAttribute: function (n, v) { bag[n] = v; },
                    removeAttribute: function (n) { delete bag[n]; },
                    hasAttribute: function (n) { return Object.prototype.hasOwnProperty.call(bag, n); }
                };
            }
            return {
                me: { findEle: function (id) { return elFor(id); } },
                lastMdom: mdom,
                _attrs: attrs,
                _applyTooltips: adapter.prototype._applyTooltips
            };
        }

        it("renders core:tooltip alone when no flag tooltip is set", function () {
            var mdom = { root: { id: "x", attrs: { "core:tooltip": "Project alpha" }, children: [] } };
            var stub = makeFakeEngine(mdom);
            stub._applyTooltips.call(stub);
            expect(stub._attrs.x.title).toBe("Project alpha");
        });

        it("renders mx:flag-tooltip alone when core:tooltip is missing", function () {
            var mdom = { root: { id: "x", attrs: { "mx:flag-tooltip": "🔥 Critical" }, children: [] } };
            var stub = makeFakeEngine(mdom);
            stub._applyTooltips.call(stub);
            expect(stub._attrs.x.title).toBe("🔥 Critical");
        });

        it("combines both with core first, flags below (newline-separated)", function () {
            var mdom = { root: { id: "x", attrs: {
                "core:tooltip": "Project alpha",
                "mx:flag-tooltip": "⏰ Overdue\n🔥 Critical"
            }, children: [] } };
            var stub = makeFakeEngine(mdom);
            stub._applyTooltips.call(stub);
            expect(stub._attrs.x.title).toBe("Project alpha\n⏰ Overdue\n🔥 Critical");
        });

        it("does not set title= when neither tooltip is present", function () {
            var mdom = { root: { id: "x", attrs: {}, children: [] } };
            var stub = makeFakeEngine(mdom);
            stub._applyTooltips.call(stub);
            expect(stub._attrs.x.title).toBeUndefined();
        });
    });
});
