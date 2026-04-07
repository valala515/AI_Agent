/**
 * NMS Wellness Companion — Embed Script
 *
 * Usage (on any page):
 *   <script src="https://YOUR-SERVER/widget.js" defer></script>
 *
 * The script is an IIFE — it adds nothing to the global scope.
 * It injects a floating button + iframe into document.body.
 */
(function () {
  "use strict";

  // ── Derive base URL from the script tag's own src ─────────────────────────
  // Works whether hosted at localhost:3030 or a production domain.
  var script  = document.currentScript ||
    (function () {
      var tags = document.getElementsByTagName("script");
      return tags[tags.length - 1];
    })();
  var BASE = script ? script.src.replace(/\/widget\.js(\?.*)?$/, "") : "";

  // ── Read host-page config ─────────────────────────────────────────────────
  // The host page may set window.NMSWidget = { userId: "...", ... } before
  // loading this script. If omitted, a random guest ID is generated and
  // persisted in localStorage so it stays stable across page refreshes.
  var cfg    = window.NMSWidget || {};
  var userId = cfg.userId || (function () {
    var key     = "nms_guest_id";
    var stored  = localStorage.getItem(key);
    if (stored) return stored;
    var guestId = "guest-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(key, guestId);
    return guestId;
  })();

  // ── Build the iframe ───────────────────────────────────────────────────────
  var iframe = document.createElement("iframe");
  iframe.src   = BASE + "/widget-frame.html?userId=" + encodeURIComponent(userId);
  iframe.title = "NMS Wellness Companion";
  iframe.setAttribute("allow", "clipboard-write");
  iframe.style.cssText = [
    "position:fixed",
    "bottom:24px",
    "right:24px",
    "width:min(350px, calc(100vw - 24px))",
    "height:min(680px, calc(100vh - 32px))",
    "min-height:480px",
    "border:none",
    "border-radius:24px",
    "box-shadow:0 20px 60px rgba(34,35,35,0.14)",
    "z-index:2147483646",
    "display:none",
    "background:transparent",
    "transition:opacity 200ms ease, transform 200ms ease",
  ].join(";");

  // ── Build the floating bubble button ──────────────────────────────────────
  var bubble = document.createElement("button");
  bubble.setAttribute("aria-label", "Open NMS Wellness Companion");
  bubble.style.cssText = [
    "all:unset",                    // reset host-page button styles
    "position:fixed",
    "right:0",
    "width:76px",
    "height:76px",
    "border-radius:16px 0 0 16px",
    "overflow:hidden",
    "cursor:grab",
    "z-index:2147483647",
    "display:flex",
    "flex-direction:column",
    "align-items:center",
    "justify-content:center",
    "gap:5px",
    "background:white",
    "box-shadow:-4px 0 20px rgba(34,35,35,0.12)",
    "font-family:Satoshi,'Avenir Next','Segoe UI',Arial,sans-serif",
    "box-sizing:border-box",
  ].join(";");

  // Spinning gradient border — injected as an inner pseudo-layer via a div
  var gradRing = document.createElement("div");
  gradRing.style.cssText = [
    "position:absolute",
    "inset:-100%",
    "background:conic-gradient(from 0deg,#ef40ff,#ff4f00 30%,#ffaa00 50%,#ff4f00 70%,#ef40ff 100%)",
    "transform-origin:center",
    "animation:nms-spin 4s linear infinite",
    "z-index:0",
    "pointer-events:none",
  ].join(";");

  var gradFill = document.createElement("div");
  gradFill.style.cssText = [
    "position:absolute",
    "inset:2px 0 2px 2px",
    "background:white",
    "border-radius:14px 0 0 14px",
    "z-index:1",
    "pointer-events:none",
  ].join(";");

  var bubbleImg = document.createElement("img");
  bubbleImg.src = BASE + "/assets/newmindstart-mark.svg";
  bubbleImg.alt = "";
  bubbleImg.style.cssText = "position:relative;z-index:2;width:26px;height:26px;object-fit:contain;";

  var bubbleLabel = document.createElement("span");
  bubbleLabel.innerHTML = "NMS Wellness<br>Companion";
  bubbleLabel.style.cssText = [
    "position:relative",
    "z-index:2",
    "font-size:9px",
    "font-weight:600",
    "color:#ff4f00",
    "text-align:center",
    "line-height:1.4",
    "letter-spacing:0.02em",
    "pointer-events:none",
  ].join(";");

  bubble.appendChild(gradRing);
  bubble.appendChild(gradFill);
  bubble.appendChild(bubbleImg);
  bubble.appendChild(bubbleLabel);

  // Inject keyframe for the spinning gradient into the host page
  var style = document.createElement("style");
  style.textContent = "@keyframes nms-spin { to { transform: rotate(360deg); } }";
  document.head.appendChild(style);

  // ── Append both elements ───────────────────────────────────────────────────
  document.body.appendChild(bubble);
  document.body.appendChild(iframe);

  // ── Show / hide helpers ────────────────────────────────────────────────────
  function openWidget() {
    iframe.style.display = "block";
    bubble.style.display = "none";
  }

  function closeWidget() {
    iframe.style.display = "none";
    bubble.style.display = "flex";
  }

  // Listen for signals from the iframe
  window.addEventListener("message", function (e) {
    if (!e.data) return;
    if (e.data.type === "nms-widget-close") {
      closeWidget();
    }
    if (e.data.type === "nms-widget-resize") {
      iframe.style.height = e.data.collapsed
        ? "54px"
        : "min(680px, calc(100vh - 32px))";
    }
  });

  // ── Draggable bubble (vertical, snapped to right edge) ────────────────────
  var BUBBLE_TOP_KEY = "nms_bubble_top";
  var BUBBLE_H       = 76;
  var moved          = false;
  var startClientY, startTop;

  function defaultTop() { return window.innerHeight - BUBBLE_H - 72; }
  function clampTop(v)  { return Math.max(0, Math.min(window.innerHeight - BUBBLE_H, v)); }
  function setTop(v)    { bubble.style.top = clampTop(v) + "px"; }

  (function initPosition() {
    var saved = localStorage.getItem(BUBBLE_TOP_KEY);
    setTop(saved !== null ? Number(saved) : defaultTop());
  })();

  window.addEventListener("resize", function () {
    setTop(parseInt(bubble.style.top, 10));
  });

  // Mouse drag
  bubble.addEventListener("mousedown", function (e) {
    e.preventDefault();
    startClientY  = e.clientY;
    startTop      = parseInt(bubble.style.top, 10);
    moved         = false;
    bubble.style.cursor = "grabbing";

    function onMove(e) {
      var dy = e.clientY - startClientY;
      if (!moved && Math.abs(dy) > 4) moved = true;
      if (moved) setTop(startTop + dy);
    }
    function onUp() {
      bubble.style.cursor = "grab";
      if (moved) localStorage.setItem(BUBBLE_TOP_KEY, parseInt(bubble.style.top, 10));
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Touch drag
  bubble.addEventListener("touchstart", function (e) {
    startClientY = e.touches[0].clientY;
    startTop     = parseInt(bubble.style.top, 10);
    moved        = false;
  }, { passive: true });

  bubble.addEventListener("touchmove", function (e) {
    var dy = e.touches[0].clientY - startClientY;
    if (!moved && Math.abs(dy) > 4) moved = true;
    if (moved) { e.preventDefault(); setTop(startTop + dy); }
  }, { passive: false });

  bubble.addEventListener("touchend", function () {
    if (moved) localStorage.setItem(BUBBLE_TOP_KEY, parseInt(bubble.style.top, 10));
  });

  // Click to open (only if not a drag)
  bubble.addEventListener("click", function () {
    if (moved) return;
    openWidget();
  });

})();
