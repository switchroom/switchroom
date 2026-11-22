"""Browser-handoff viewer copy. No emails, tokens, or VNC passwords."""
from __future__ import annotations

from datetime import datetime
import html
import json
import sys
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

sys.path.insert(0, str(Path(__file__).resolve().parent))
from public_config import brand, canonical_public_url, local_tz

OG_TITLE = "Secure browser sign-in"
END_BUTTON = "End takeover"


def _brand_markup() -> str:
    return f'<div class="brand">{html.escape(brand(), quote=True)}</div>'

_STYLE = (
    "*{box-sizing:border-box}"
    "body{margin:0;background:#0E1013;color:#FAF7EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px}"
    "a{color:#8AB4F8}"
    "header{height:56px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid #23282f}"
    "header .brand{font-weight:600;letter-spacing:.02em}"
    "header .ctx{color:#B8B3A7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    "header .grow{flex:1}"
    ".pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid #23282f;color:#B8B3A7}"
    ".pill::before{content:'';width:8px;height:8px;border-radius:50%;background:#7A7F87}"
    ".pill.ok::before{background:#3DDC84}.pill.warn::before{background:#F5B942}.pill.bad::before{background:#F0544F}"
    "#timer.warn{color:#F5B942;font-weight:600}#timer.bad{color:#F0544F;font-weight:600}"
    "button,input{background:transparent;color:#FAF7EF;border:1px solid #3A414B;border-radius:8px;padding:8px 12px;font:inherit}"
    "button{cursor:pointer}button:hover{border-color:#8AB4F8}button:focus-visible{outline:2px solid #8AB4F8;outline-offset:2px}"
    "button:disabled{opacity:.5;cursor:default}"
    "button.danger{border-color:#F0544F;color:#F0544F}button.danger:hover{background:#F0544F;color:#0E1013}"
    "button.primary{background:#8AB4F8;color:#0E1013;border-color:#8AB4F8}"
    "#paste-box{display:none;width:220px}#paste-box.show{display:inline-block}"
    "#extend{display:none}#extend.show{display:inline-block}"
    "iframe{position:absolute;inset:56px 0 0 0;width:100%;height:calc(100% - 56px);border:0}"
    ".overlay{position:absolute;inset:56px 0 0 0;display:none;align-items:center;justify-content:center;background:rgba(14,16,19,.92);z-index:2}"
    ".overlay.show{display:flex}"
    "dialog{max-width:460px;padding:0;border:0;border-radius:14px;background:transparent;color:#FAF7EF}"
    "dialog::backdrop{background:rgba(14,16,19,.92)}"
    ".card{max-width:460px;padding:28px;border:1px solid #23282f;border-radius:14px;background:#14171C;line-height:1.5}"
    ".card h1{font-size:18px;margin:0 0 12px}.card p{margin:0 0 10px;color:#D9D4C7}.card .row{display:flex;gap:10px;margin-top:18px}"
    "@media (max-width:720px){header .ctx,#fit{display:none}}"
)

VIEWER_JS = r"""
<script>
(function () {
  var cfg = window.__handoff || {};
  var scope = cfg.scope || "";
  var frame = document.getElementById("viewer");
  var status = document.getElementById("status");
  var timer = document.getElementById("timer");
  var box = document.getElementById("paste-box");
  var extendBtn = document.getElementById("extend");
  var endBtn = document.getElementById("end");
  var modeBtn = document.getElementById("mode");
  var fitBtn = document.getElementById("fit");
  var intro = document.getElementById("intro");
  var done = document.getElementById("done");
  var doneTitle = document.getElementById("done-title");
  var doneText = document.getElementById("done-text");
  var endConfirmation = document.getElementById("end-confirmation");
  var endConfirm = document.getElementById("end-confirm");
  var endCancel = document.getElementById("end-cancel");
  var mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  var state = {mode: "takeover", started: false, ended: false, connected: false, fit: true, sending: false, ending: false};
  var deadline = performance.now() + (cfg.remaining || 0) * 1000;
  var capDeadline = performance.now() + (cfg.maxRemaining || 0) * 1000;

  function setStatus(text, cls) {
    if (!status) return;
    status.textContent = text;
    status.className = "pill" + (cls ? " " + cls : "");
  }
  function ui() {
    try { return frame && frame.contentWindow && frame.contentWindow.UI || null; } catch (e) { return null; }
  }
  function rfb() {
    var u = ui();
    return u && u.rfb ? u.rfb : null;
  }
  function post(path) {
    return fetch(scope + path, {method: "POST", credentials: "same-origin", headers: {"Origin": window.location.origin}});
  }
  function finish(kind) {
    state.ended = true;
    if (kind === "expired") {
      doneTitle.textContent = "This sign-in link has expired";
      doneText.textContent = "Reply in the Slack thread and the agent will send a fresh link.";
    } else {
      doneTitle.textContent = "Takeover ended";
      doneText.textContent = "You can close this tab. Reply in the original Slack thread to let the agent know you are done.";
    }
    done.classList.add("show");
    setStatus(kind === "expired" ? "Expired" : "Ended", "bad");
    try { var r = rfb(); if (r) r.disconnect(); } catch (e) {}
  }

  // ---- expose noVNC internals inside the iframe --------------------------
  function expose() {
    try {
      var doc = frame && frame.contentDocument;
      if (!doc || doc.getElementById("sr-expose")) return;
      var s = doc.createElement("script");
      s.id = "sr-expose";
      s.type = "module";
      s.textContent = "import UI from '" + scope + "/app/ui.js'; import keysyms from '" + scope + "/core/input/keysymdef.js'; window.UI = UI; window.keysyms = keysyms;";
      doc.head.appendChild(s);
    } catch (e) {}
  }
  var bound = null;
  function bind() {
    expose();
    var r = rfb();
    if (!r || r === bound) return;
    bound = r;
    try { r.showDotCursor = true; } catch (e) {}
    r.addEventListener("connect", function () {
      state.connected = true;
      setStatus("Connected", "ok");
      // A fresh RFB after an auto-reconnect has no lock and no viewOnly; re-assert both.
      resyncMode();
    });
    r.addEventListener("disconnect", function (e) {
      state.connected = false;
      if (state.ended) return;
      var clean = e && e.detail && e.detail.clean;
      setStatus(clean ? "Disconnected" : "Connection lost, reconnecting", clean ? "bad" : "warn");
    });
    r.addEventListener("clipboard", function (e) {
      var t = e && e.detail && e.detail.text;
      if (!t || !navigator.clipboard || !navigator.clipboard.writeText) return;
      navigator.clipboard.writeText(t).catch(function () {});
    });
    var u = ui();
    if (u && u.connected) {
      // The connect event already fired before this poll attached the listener.
      state.connected = true;
      setStatus("Connected", "ok");
      resyncMode();
    }
  }

  // ---- keys and clipboard ------------------------------------------------
  function lookup(u) {
    try {
      var ks = frame.contentWindow.keysyms;
      if (ks && typeof ks.lookup === "function") return ks.lookup(u);
    } catch (e) {}
    if (u === 10 || u === 13) return 0xff0d;
    if (u === 9) return 0xff09;
    if (u < 0x20) return 0;
    if (u < 0x100) return u;
    return 0x01000000 + u;
  }
  function releaseModifiers(r) {
    r.sendKey(0xffe1, "ShiftLeft", false);
    r.sendKey(0xffe3, "ControlLeft", false);
    r.sendKey(0xffe9, "AltLeft", false);
    r.sendKey(0xffeb, "MetaLeft", false);
  }
  function sendCtrl(r, ch) {
    releaseModifiers(r);
    r.sendKey(0xffe3, "ControlLeft", true);
    r.sendKey(ch.charCodeAt(0), "Key" + ch.toUpperCase(), true);
    r.sendKey(ch.charCodeAt(0), "Key" + ch.toUpperCase(), false);
    r.sendKey(0xffe3, "ControlLeft", false);
  }
  function typeText(text) {
    if (!text || state.sending) return;
    var r = rfb();
    if (!r || typeof r.sendKey !== "function") {
      setStatus("Wait for Connected, then try again", "warn");
      return;
    }
    state.sending = true;
    setStatus("Typing", "warn");
    if (typeof r.focus === "function") r.focus();
    releaseModifiers(r);
    var i = 0;
    function next() {
      if (i >= text.length) {
        state.sending = false;
        setStatus(state.connected ? "Connected" : "Disconnected", state.connected ? "ok" : "bad");
        return;
      }
      var ks = lookup(text.charCodeAt(i++));
      if (ks) r.sendKey(ks);
      setTimeout(next, 12);
    }
    setTimeout(next, 30);
  }
  function latin1(text) {
    for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) return false;
    return true;
  }
  var clearTimer = null;
  function pasteText(text) {
    if (!text) return;
    var r = rfb();
    if (!r || typeof r.clipboardPasteFrom !== "function" || !latin1(text)) { typeText(text); return; }
    if (typeof r.focus === "function") r.focus();
    r.clipboardPasteFrom(text);
    setTimeout(function () { sendCtrl(r, "v"); }, 40);
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(function () { try { r.clipboardPasteFrom(" "); } catch (e) {} }, 2000);
  }
  function showBox(placeholder) {
    if (!box) return;
    box.placeholder = placeholder || "Paste here, then Enter";
    box.classList.add("show");
    box.value = "";
    box.focus();
  }
  function pasteFromLocal() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) {
        if (t) pasteText(t); else showBox();
      }).catch(function () { showBox("Press " + (mac ? "Cmd" : "Ctrl") + "+V here, then Enter"); });
    } else {
      showBox();
    }
  }
  function armFrame() {
    expose();
    try {
      var doc = frame && frame.contentDocument;
      var win = frame && frame.contentWindow;
      if (!doc || !win || win.__srArmed) return;
      win.__srArmed = true;
      ["noVNC_control_bar_anchor", "noVNC_control_bar", "noVNC_status"].forEach(function (id) {
        var el = doc.getElementById(id);
        if (el) el.style.display = "none";
      });
      win.addEventListener("keydown", function (e) {
        var combo = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
        if (!combo || e.altKey) return;
        var key = (e.key || "").toLowerCase();
        if (key.length !== 1 || key < "a" || key > "z") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (key === "v") { pasteFromLocal(); return; }
        if (key === "w" || key === "q" || key === "n" || key === "t") return;
        var r = rfb();
        if (r) sendCtrl(r, key);
      }, true);
      win.addEventListener("paste", function (e) {
        var t = e.clipboardData && e.clipboardData.getData("text/plain");
        if (!t) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        pasteText(t);
      }, true);
    } catch (e) {}
  }
  if (frame) {
    frame.addEventListener("load", armFrame);
    setInterval(function () { armFrame(); bind(); }, 500);
  }
  var pasteBtn = document.getElementById("paste");
  if (pasteBtn) pasteBtn.addEventListener("click", function (e) { e.preventDefault(); pasteFromLocal(); });
  var typeBtn = document.getElementById("type");
  if (typeBtn) typeBtn.addEventListener("click", function (e) { e.preventDefault(); showBox("Type or paste, then Enter"); });
  if (box) {
    box.addEventListener("paste", function (e) {
      var t = e.clipboardData && e.clipboardData.getData("text/plain");
      e.stopImmediatePropagation();
      if (t) {
        e.preventDefault();
        box.value = "";
        box.classList.remove("show");
        pasteText(t);
      }
    });
    box.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { box.value = ""; box.classList.remove("show"); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      var t = box.value;
      box.value = "";
      box.classList.remove("show");
      typeText(t);
    });
  }

  // ---- fit / actual size -------------------------------------------------
  if (fitBtn) fitBtn.addEventListener("click", function () {
    state.fit = !state.fit;
    fitBtn.textContent = state.fit ? "Actual size" : "Fit to window";
    var u = ui();
    try {
      u.forceSetting("resize", state.fit ? "scale" : "off");
      u.forceSetting("view_clip", !state.fit);
      u.applyResizeMode();
      u.updateViewClip();
    } catch (e) {}
  });

  // ---- take control / observe ---------------------------------------------
  function setMode(mode) {
    state.mode = mode;
    state.started = true;
    if (modeBtn) modeBtn.textContent = mode === "takeover" ? "Switch to observe" : "Take control";
    return resyncMode();
  }
  function resyncMode() {
    if (!state.started || state.ended) return Promise.resolve();
    try { var r = rfb(); if (r) r.viewOnly = state.mode !== "takeover"; } catch (e) {}
    return post(state.mode === "takeover" ? "/takeover" : "/observe").catch(function () {});
  }
  if (modeBtn) modeBtn.addEventListener("click", function () {
    setMode(state.mode === "takeover" ? "observe" : "takeover");
  });
  function applyServerMode(mode) {
    if (state.ended || (mode !== "observe" && mode !== "takeover") || mode === state.mode) return;
    state.mode = mode;
    state.started = true;
    if (modeBtn) modeBtn.textContent = mode === "takeover" ? "Switch to observe" : "Take control";
    try { var r = rfb(); if (r) r.viewOnly = state.mode !== "takeover"; } catch (e) {}
    if (mode === "observe") setStatus("Watching", "ok");
  }
  function pollMode() {
    if (state.ended || !scope) return;
    fetch(scope + "/mode", {credentials: "same-origin"}).then(function (res) {
      return res.ok ? res.text() : "";
    }).then(function (text) {
      applyServerMode((text || "").trim());
    }).catch(function () {});
  }
  setInterval(pollMode, 1500);
  pollMode();
  var introKey = "sr-intro-v1";
  var seen = false;
  try { seen = window.localStorage.getItem(introKey) === "1"; } catch (e) {}
  function start(mode) {
    try { window.localStorage.setItem(introKey, "1"); } catch (e) {}
    intro.classList.remove("show");
    setMode(mode);
  }
  var takeBtn = document.getElementById("intro-take");
  var watchBtn = document.getElementById("intro-watch");
  if (takeBtn) takeBtn.addEventListener("click", function () { start("takeover"); });
  if (watchBtn) watchBtn.addEventListener("click", function () { start("observe"); });
  if (seen) { setMode("takeover"); } else { intro.classList.add("show"); }

  // ---- countdown and extend ------------------------------------------------
  function fmt(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" : "") + r;
  }
  function tick() {
    if (state.ended) return;
    var left = (deadline - performance.now()) / 1000;
    var capLeft = (capDeadline - performance.now()) / 1000;
    if (timer) {
      timer.textContent = fmt(left) + " left";
      timer.className = left <= 120 ? "bad" : left <= 300 ? "warn" : "";
    }
    if (extendBtn) extendBtn.classList.toggle("show", left <= 300 && capLeft - left > 30);
    if (left <= 0) finish("expired");
  }
  setInterval(tick, 1000);
  tick();
  if (extendBtn) extendBtn.addEventListener("click", function () {
    extendBtn.disabled = true;
    post("/extend").then(function (res) { return res.ok ? res.json() : null; }).then(function (data) {
      if (data && typeof data.remaining === "number") {
        deadline = performance.now() + data.remaining * 1000;
        if (typeof data.max_remaining === "number") capDeadline = performance.now() + data.max_remaining * 1000;
        tick();
      }
    }).catch(function () {}).finally(function () { extendBtn.disabled = false; });
  });

  // ---- end takeover ----------------------------------------------------------
  function closeEndConfirmation() {
    if (!endConfirmation || !endConfirmation.open) return;
    endConfirmation.close();
    if (endBtn) endBtn.focus();
  }
  function confirmEnd() {
    if (state.ending || state.ended) return;
    state.ending = true;
    closeEndConfirmation();
    endBtn.disabled = true;
    if (endConfirm) endConfirm.disabled = true;
    endBtn.textContent = "Ending";
    post("/end").then(function (res) {
      if (!res.ok) throw new Error("end failed");
      finish("ended");
      if (res.headers && res.headers.get("X-Checkpoint-Outcome") === "no_live_session") {
        doneText.textContent = "The browser session was already closed, so this End could not save it. Reply in the original Slack thread and ask the agent to verify your sign-in.";
      }
    }).catch(function () {
      state.ending = false;
      endBtn.disabled = false;
      if (endConfirm) endConfirm.disabled = false;
      endBtn.textContent = cfg.endLabel;
      setStatus("Could not end takeover. Try again.", "bad");
    });
  }
  if (endBtn) endBtn.addEventListener("click", function () {
    if (state.ending || state.ended) return;
    if (!endConfirmation || !endConfirmation.showModal) { confirmEnd(); return; }
    endConfirmation.showModal();
    if (endCancel) endCancel.focus();
  });
  if (endConfirm) endConfirm.addEventListener("click", confirmEnd);
  if (endCancel) endCancel.addEventListener("click", closeEndConfirmation);
  if (endConfirmation) endConfirmation.addEventListener("keydown", function (e) {
    if (e.key !== "Tab") return;
    // Chromium keeps the dialog scope but can put focus on dialog chrome after
    // its final control. Cycle the actual controls for deterministic keyboard use.
    if (e.shiftKey && document.activeElement === endCancel) {
      e.preventDefault(); endConfirm.focus();
    } else if (!e.shiftKey && document.activeElement === endConfirm) {
      e.preventDefault(); endCancel.focus();
    }
  });
  if (endConfirmation) endConfirmation.addEventListener("cancel", function (e) {
    e.preventDefault();
    closeEndConfirmation();
  });
  window.addEventListener("beforeunload", function (e) {
    if (state.ended || state.mode !== "takeover") return;
    e.preventDefault();
    e.returnValue = "";
  });
})();
</script>
"""


def _page(title: str, body: str) -> str:
    return (
        "<!doctype html><html lang=\"en\"><head>"
        f"<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>{OG_TITLE}</title><meta property=\"og:title\" content=\"{OG_TITLE}\">"
        f"<style>{_STYLE}</style></head><body><header>{_brand_markup()}</header>"
        f"<div class=\"overlay show\"><div class=\"card\"><h1>{title}</h1>{body}</div></div>"
        "</body></html>"
    )


_STATUS_COPY = {
    "unknown": (
        "This sign-in link isn't valid",
        "<p>It may have been replaced by a newer link. Reply in the Slack thread and the agent will send a fresh one.</p>",
    ),
    "wrong_account": (
        "That Google account isn't approved for this link",
        "<p>Switch to the account the agent addressed, then open the link again. If you don't have one, reply in the Slack thread.</p>",
    ),
    "expired": (
        "This sign-in link has expired",
        "<p>Links last a short time for safety. Reply in the Slack thread and the agent will send a fresh one.</p>",
    ),
    "ended": (
        "Takeover ended",
        "<p>You can close this tab. Reply in the original Slack thread to let the agent know you are done.</p>",
    ),
    "revoked": (
        "This sign-in link was replaced",
        "<p>A newer link was issued. Use the latest one from the Slack thread.</p>",
    ),
    "denied": (
        "This link can't be opened right now",
        "<p>Reply in the Slack thread and the agent will send a fresh one.</p>",
    ),
    "no_session": (
        "Open the link from your Slack thread",
        "<p>This page only works with a sign-in link the agent sent you. There's nothing to do here on its own.</p>",
    ),
}


def status_page(kind: str) -> str:
    title, body = _STATUS_COPY.get(kind, _STATUS_COPY["denied"])
    return _page(title, body)


def is_slack_webview(user_agent: str) -> bool:
    return "slack" in (user_agent or "").lower()


def session_url(session_id: str | None, agent_id: str | None = None) -> str:
    return f"{canonical_public_url()}/{agent_id}/{session_id}" if session_id and agent_id else canonical_public_url()


def bounce_page(session_id: str | None = None, *, agent_id: str | None = None) -> str:
    link = session_url(session_id, agent_id)
    return _page(
        "Open this in Chrome or Safari",
        "<p>Slack's in-app browser can't show the remote session.</p>"
        f"<p><a href=\"{link}\">Open in Chrome</a></p>"
        f"<p>Or copy this link into Chrome or Safari on a laptop:<br><code>{link}</code></p>",
    )


def viewer_page(
    session_id: str | None = None,
    *,
    remaining: float | None = None,
    max_remaining: float | None = None,
    agent: str | None = None,
    agent_id: str | None = None,
) -> str:
    scope = f"/{agent_id}/{session_id}" if session_id and agent_id else ""
    viewer_src = f"{scope}/vnc.html?autoconnect=1&resize=scale&quality=9&view_only=1&reconnect=1&reconnect_delay=2000&show_dot=1&path={scope}/websockify"
    agent_label = html.escape(agent or "the agent", quote=True)
    cfg = json.dumps(
        {
            "scope": scope,
            "remaining": float(remaining) if remaining is not None else 0.0,
            "maxRemaining": float(max_remaining) if max_remaining is not None else (float(remaining) if remaining is not None else 0.0),
            "endLabel": END_BUTTON,
        },
        separators=(",", ":"),
    )
    return (
        "<!doctype html><html lang=\"en\"><head>"
        "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>{OG_TITLE}</title><meta property=\"og:title\" content=\"{OG_TITLE}\">"
        f"<style>{_STYLE}</style></head><body><header>{_brand_markup()}"
        f"<div class=\"ctx\">{agent_label}&#8217;s browser</div>"
        "<div id=\"status\" class=\"pill\" role=\"status\" aria-live=\"polite\">Connecting</div>"
        "<div id=\"timer\" aria-live=\"polite\"></div>"
        "<button type=\"button\" id=\"extend\">Need more time</button>"
        "<div class=\"grow\"></div>"
        "<button type=\"button\" id=\"fit\" title=\"Toggle between fit-to-window and actual size\">Actual size</button>"
        "<button type=\"button\" id=\"paste\" title=\"Paste your clipboard into the remote browser\">Paste</button>"
        "<button type=\"button\" id=\"type\" title=\"Type text into the remote browser one key at a time\">Type it in</button>"
        "<input id=\"paste-box\" type=\"password\" autocomplete=\"off\" spellcheck=\"false\" aria-label=\"Text to send to the remote browser\" placeholder=\"Paste here, then Enter\">"
        "<button type=\"button\" id=\"mode\">Switch to observe</button>"
        f"<button type=\"button\" id=\"end\" class=\"danger\">{END_BUTTON}</button>"
        "</header>"
        f"<script>window.__handoff={cfg};</script>"
        f"<iframe id=\"viewer\" title=\"Remote browser\" allow=\"clipboard-read; clipboard-write\" src=\"{viewer_src}\"></iframe>"
        "<div id=\"intro\" class=\"overlay\"><div class=\"card\">"
        f"<h1>You&#8217;re about to control {agent_label}&#8217;s browser</h1>"
        "<p>The agent is paused while you're here. Sign in or finish the step it got stuck on.</p>"
        "<p>Paste works: copy from your password manager and press "
        "<b>Ctrl+V</b> (or <b>Cmd+V</b> on a Mac). Choose a code or SMS if a site offers passkeys; those can't reach this browser.</p>"
        "<p>Reply in the original Slack thread when you're done so the agent can carry on. This tab stays open in observe so you can watch.</p>"
        "<div class=\"row\"><button type=\"button\" id=\"intro-take\" class=\"primary\">Take control</button>"
        "<button type=\"button\" id=\"intro-watch\">Just watch</button></div>"
        "</div></div>"
        "<div id=\"done\" class=\"overlay\"><div class=\"card\"><h1 id=\"done-title\">Takeover ended</h1><p id=\"done-text\"></p></div></div>"
        "<dialog id=\"end-confirmation\" aria-labelledby=\"end-confirmation-title\"><div class=\"card\">"
        "<h1 id=\"end-confirmation-title\">End takeover?</h1><p>The browser will be checkpointed before the agent can continue.</p>"
        "<div class=\"row\"><button type=\"button\" id=\"end-cancel\">Cancel</button><button type=\"button\" id=\"end-confirm\" class=\"danger\">End takeover</button></div></div></dialog>"
        f"{VIEWER_JS}"
        "</body></html>"
    )


def _local_time(expires_at: float | None) -> str:
    if not expires_at:
        return ""
    try:
        try:
            zone = ZoneInfo(local_tz()) if local_tz() else None
        except (ZoneInfoNotFoundError, ValueError):
            zone = None  # unknown name: fall back to the system's local zone, never UTC
        moment = datetime.fromtimestamp(float(expires_at), zone)
        if zone is None:
            moment = moment.astimezone()
        # Humans never see bare UTC: "2:05pm AEDT".
        return moment.strftime("%-I:%M%p").lower() + " " + moment.strftime("%Z")
    except (OverflowError, OSError, ValueError):
        return ""


def slack_message(url: str, expires_at: float | None = None, *, agent: str | None = None) -> str:
    """Copy for the human. Holds the scoped link; never a fragment or a VNC password."""
    link = (url or "").split("#", 1)[0] or canonical_public_url()
    who = agent or "the agent"
    when = _local_time(expires_at)
    lines = [
        "*Browser sign-in needed*",
        f"{who} needs you to finish a sign-in in its browser. Open this on a laptop, in Chrome or Safari, not Slack's preview:",
        link,
        "1. Choose the Google account this link was sent to",
        "2. Sign in on the page you see. Paste works: copy from your password manager and press Ctrl+V (Cmd+V on a Mac)",
        "3. If the site offers a passkey or push approval, pick a code or SMS instead",
        f"4. Reply here when you're done so {who} can carry on. This tab stays open so you can watch. Press Take control to interrupt, or *{END_BUTTON}* to close",
    ]
    if when:
        lines.append(f"The link expires at {when}. Reply here if you need a new one.")
    lines.append("Never send passwords or codes in this chat.")
    return "\n".join(lines) + "\n"


def shell_page(user_agent: str, *, session_id: str, agent_id: str, **viewer_kwargs: object) -> str:
    if is_slack_webview(user_agent):
        return bounce_page(session_id, agent_id=agent_id)
    return viewer_page(session_id, agent_id=agent_id, **viewer_kwargs)  # type: ignore[arg-type]
