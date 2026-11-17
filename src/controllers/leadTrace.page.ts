/**
 * Self-contained Lead Trace page (vanilla HTML/CSS/JS), served at `/lead-trace`.
 *
 * Embedded as a string constant rather than a static asset so the TypeScript
 * build ships it with the compiled output — the build only compiles `src`, it
 * does not copy loose files. No framework, no bundler, no runtime dependency.
 *
 * The page itself carries no lead data; it calls the authenticated lifecycle API
 * (`GET /api/leads/:id/lifecycle`) with a bearer key the operator pastes in and
 * the browser stores locally. Served same-origin, so fetch uses a relative URL.
 */
export const LEAD_TRACE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lead Lifecycle</title>
<style>
  :root {
    --bg: #0f1420; --panel: #161c2b; --panel-2: #1c2436; --border: #2a3448;
    --text: #e6ebf5; --muted: #9aa7bd; --accent: #4f8cff;
    --ok: #37c98b; --ok-bg: #123426; --warn: #e5b84b; --warn-bg: #3a2f10;
    --err: #ff6b6b; --err-bg: #3a1620; --skip: #8b93a7; --skip-bg: #232a3a;
    --neutral: #6ea8fe; --neutral-bg: #16233f;
    --radius: 10px; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); line-height: 1.45; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 24px 16px 80px; }
  header h1 { font-size: 22px; margin: 0 0 4px; }
  header p { color: var(--muted); margin: 0 0 20px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  input[type=text], input[type=password] {
    width: 100%; background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 10px 12px; font-size: 14px; font-family: var(--mono);
  }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .row > .grow { flex: 1 1 320px; }
  button {
    background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 16px;
    font-size: 14px; cursor: pointer; font-family: var(--sans);
  }
  button.secondary { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .muted { color: var(--muted); font-size: 12px; }
  .keyrow { margin-bottom: 10px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .filters { display: flex; gap: 6px; flex-wrap: wrap; }
  .filters button { background: var(--panel-2); border: 1px solid var(--border); color: var(--muted); padding: 6px 12px; font-size: 13px; }
  .filters button.active { color: #fff; border-color: var(--accent); background: #1d2b4a; }
  .autorow { display: flex; align-items: center; gap: 8px; }
  .status-msg { padding: 28px 16px; text-align: center; color: var(--muted); }
  .status-msg.error { color: var(--err); }
  .status-msg strong { display: block; color: var(--text); margin-bottom: 4px; font-size: 15px; }

  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
  .summary-grid .k { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .summary-grid .v { font-size: 14px; font-family: var(--mono); word-break: break-all; margin-top: 2px; }

  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .b-ok { color: var(--ok); background: var(--ok-bg); }
  .b-warn { color: var(--warn); background: var(--warn-bg); }
  .b-err { color: var(--err); background: var(--err-bg); }
  .b-skip { color: var(--skip); background: var(--skip-bg); }
  .b-neutral { color: var(--neutral); background: var(--neutral-bg); }

  .banner { border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; font-size: 14px; }
  .banner.err { background: var(--err-bg); color: var(--err); border: 1px solid #5a2330; }
  .banner.ok { background: var(--ok-bg); color: var(--ok); border: 1px solid #1d4d38; }
  .banner.warn { background: var(--warn-bg); color: var(--warn); border: 1px solid #5a4a1a; }

  .timeline { position: relative; margin: 6px 0 0; padding: 0; list-style: none; }
  .ev { position: relative; padding: 0 0 4px 26px; }
  .ev::before { content: ""; position: absolute; left: 7px; top: 22px; bottom: -6px; width: 2px; background: var(--border); }
  .ev:last-child::before { display: none; }
  .dot { position: absolute; left: 0; top: 6px; width: 16px; height: 16px; border-radius: 50%; border: 3px solid var(--bg); }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
  .dot.err { background: var(--err); } .dot.skip { background: var(--skip); } .dot.neutral { background: var(--neutral); }
  .ev-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .ev-title { font-size: 15px; font-weight: 600; }
  .ev-time { color: var(--muted); font-size: 12px; font-family: var(--mono); }
  .ev-body { margin: 2px 0 14px; }
  .ev-line { font-size: 13px; }
  .ev-reason { font-size: 13px; color: var(--warn); font-family: var(--mono); }
  .ev.stop { background: #251018; border: 1px solid #5a2330; border-radius: 8px; padding: 10px 12px 4px 30px; }
  .ev.stop .dot { left: 8px; top: 14px; }
  .details { margin: 6px 0 0; }
  .details summary { cursor: pointer; color: var(--accent); font-size: 13px; }
  .meta { margin: 8px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; font-size: 12.5px; font-family: var(--mono); }
  .meta .mk { color: var(--muted); } .meta .mv { word-break: break-all; }
  footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 30px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Lead Lifecycle</h1>
    <p>Track the complete processing history of a lead &mdash; where it was received, decided, held, gated, called, and why it stopped.</p>
  </header>

  <div class="card">
    <div class="keyrow">
      <label for="key">API key (bearer, stored only in this browser)</label>
      <input id="key" type="password" placeholder="CALL_READ_API_KEY" autocomplete="off" />
    </div>
    <div class="row">
      <div class="grow">
        <label for="leadId">Lead ID</label>
        <input id="leadId" type="text" placeholder="a8deefc1-ce85-48d9-9b7d-56c7af3cfe0f" autocomplete="off" />
      </div>
      <button id="searchBtn">Search</button>
    </div>
    <p class="muted" style="margin:10px 0 0">Search is by Lead ID. This service stores no email or phone, so those are not searchable here.</p>
  </div>

  <div class="card">
    <div class="toolbar">
      <strong style="font-size:14px">Recent leads</strong>
      <div class="autorow">
        <label class="muted" style="margin:0">Limit
          <input id="listLimit" type="text" value="50" style="width:56px;display:inline-block;padding:4px 8px" /></label>
        <button class="secondary" id="loadListBtn">Load recent leads</button>
      </div>
    </div>
    <div id="listWrap"><p class="muted" style="margin:6px 0 0">Load the most recent leads to see each one's lifecycle state at a glance. Click a row to open its full timeline.</p></div>
  </div>

  <div id="result" class="hidden">
    <div class="toolbar">
      <div class="filters" id="filters">
        <button data-f="all" class="active">All</button>
        <button data-f="success">Success</button>
        <button data-f="rejected">Rejected</button>
        <button data-f="skipped">Skipped</button>
        <button data-f="call">Call</button>
      </div>
      <div class="autorow">
        <span class="muted" id="lastUpdated"></span>
        <label class="autorow" style="margin:0"><input type="checkbox" id="auto" /> <span class="muted">Auto</span></label>
        <button class="secondary" id="refreshBtn">Refresh</button>
      </div>
    </div>

    <div class="card" id="summary"></div>
    <div id="banner"></div>
    <div class="card">
      <ul class="timeline" id="timeline"></ul>
    </div>
  </div>

  <div id="statusMsg" class="status-msg hidden"></div>

  <footer>Lead Trace &middot; CallScheduler. Source of truth: the persistent lead_lifecycle_events table.</footer>
</div>

<script>
(function () {
  "use strict";
  var KEY_STORE = "leadTrace.apiKey";
  var $ = function (id) { return document.getElementById(id); };
  var keyEl = $("key"), idEl = $("leadId"), searchBtn = $("searchBtn"),
      refreshBtn = $("refreshBtn"), autoEl = $("auto"), resultEl = $("result"),
      summaryEl = $("summary"), timelineEl = $("timeline"), bannerEl = $("banner"),
      statusMsg = $("statusMsg"), lastUpdatedEl = $("lastUpdated"),
      loadListBtn = $("loadListBtn"), listWrap = $("listWrap"), listLimit = $("listLimit");
  var state = { leadId: null, data: null, filter: "all", timer: null };

  try { var saved = localStorage.getItem(KEY_STORE); if (saved) keyEl.value = saved; } catch (e) {}
  keyEl.addEventListener("change", function () { try { localStorage.setItem(KEY_STORE, keyEl.value.trim()); } catch (e) {} });

  // ---- helpers ----------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  // Category drives colour + filtering. Derived from event + status.
  function categoryOf(ev) {
    var e = ev.event || "", s = (ev.status || "").toLowerCase();
    if (e === "call_failed") return "rejected";
    if (e === "booked" || e === "status_reported" || e === "crm_note_delivered") return "success";
    if (s === "rejected" || s === "expired" || s === "failed") return "rejected";
    if (e === "lead_decision" && s === "skipped") return "skipped";
    if (e === "call_completed") {
      var o = (ev.reason || "").toUpperCase();
      return (o === "NOT_INTERESTED" || o === "WRONG_NUMBER" || o === "DO_NOT_CONTACT" || o === "NOT_REACHED") ? "rejected" : "success";
    }
    if (s === "passed" || s === "active" || s === "initiated" || s === "attempted") return "success";
    if (e === "lead_decision" && s === "eligible") return "success";
    if (e === "lead_received") return "neutral";
    if (s === "needs_review") return "warn";
    return "neutral";
  }
  var CAT_DOT = { success: "ok", rejected: "err", skipped: "skip", warn: "warn", neutral: "neutral" };
  var TITLES = {
    lead_received: "Lead Received", eligibility_checked: "Eligibility Checked",
    phone_checked: "Phone Checked", crm_gate_checked: "CRM Gate", hold_checked: "Hold Checked",
    lead_decision: "Lead Decision", call_attempt: "Call Attempt", retell_initiated: "Retell Call Initiated",
    call_failed: "Call Failed", call_completed: "Call Completed",
    booked: "Booked", status_reported: "Status Reported", crm_note_delivered: "CRM Note Delivered",
    lead_unavailable: "Lead Unavailable", already_decided: "Already Decided", calling_disabled: "Calling Disabled"
  };
  function titleFor(e) { return TITLES[e] || e; }
  // For the top filter: which bucket an event belongs to.
  function filterBucket(ev) {
    var cat = categoryOf(ev);
    if (state.filter === "all") return true;
    if (state.filter === "call") return ["call_attempt", "retell_initiated", "call_failed", "call_completed"].indexOf(ev.event) >= 0;
    if (state.filter === "success") return cat === "success";
    if (state.filter === "rejected") return cat === "rejected";
    if (state.filter === "skipped") return cat === "skipped";
    return true;
  }

  function badge(text, cls) { var b = el("span", "badge " + cls, text); return b; }

  // ---- rendering --------------------------------------------------------
  function renderSummary(lead) {
    summaryEl.innerHTML = "";
    if (!lead) { summaryEl.classList.add("hidden"); return; }
    summaryEl.classList.remove("hidden");
    var grid = el("div", "summary-grid");
    function cell(k, vNode) {
      var c = el("div");
      c.appendChild(el("div", "k", k));
      if (typeof vNode === "string") c.appendChild(el("div", "v", vNode));
      else { var w = el("div", "v"); w.appendChild(vNode); c.appendChild(w); }
      grid.appendChild(c);
    }
    cell("Lead", lead.leadId);
    var statusCls = lead.status === "COMPLETED" ? "b-ok"
      : lead.status === "SKIPPED" ? "b-skip"
      : lead.status === "FAILED" ? "b-err"
      : lead.status === "NEEDS_REVIEW" ? "b-warn" : "b-neutral";
    cell("Status", badge(lead.status || "UNKNOWN", statusCls));
    if (lead.currentStateLabel) {
      var stCls = lead.currentState === "BOOKED" ? "b-ok"
        : (lead.currentState === "CALL_FAILED" || lead.currentState === "PHONE_INVALID") ? "b-err"
        : (lead.currentState === "SKIPPED" || lead.currentState === "RECEIVED_NOT_PROCESSED") ? "b-skip"
        : (lead.currentState === "COMPLETED_NO_BOOKING" || lead.currentState === "STATUS_REPORTED" || lead.currentState === "CRM_NOTE_DELIVERED") ? "b-ok"
        : "b-neutral";
      cell("Lifecycle State", badge(lead.currentStateLabel, stCls));
    }
    if (lead.bookingStatus) cell("Booking", badge(lead.bookingStatus === "BOOKED" ? "Booked" : "No booking", lead.bookingStatus === "BOOKED" ? "b-ok" : "b-skip"));
    if (lead.stoppedReason) cell("Stopped Reason", lead.stoppedReason);
    if (lead.decisionReason) cell("Reason", lead.decisionReason);
    if (lead.crmRoute) cell("CRM Route", lead.crmRoute);
    if (lead.callerHoldUntil) {
      var active = new Date(lead.callerHoldUntil).getTime() > Date.now();
      cell("Caller Hold", badge(active ? "Active" : "Expired", active ? "b-ok" : "b-skip"));
    }
    if (lead.call && lead.call.retellCallId) cell("Retell Call", lead.call.retellCallId);
    if (lead.call && lead.call.outcome) cell("Call Outcome", lead.call.outcome);
    if (lead.createdAt) cell("Created", fmtTime(lead.createdAt));
    if (lead.updatedAt) cell("Last Updated", fmtTime(lead.updatedAt));
    summaryEl.appendChild(grid);
  }

  // Deterministic banner driven by the backend-derived current state (source of
  // truth), not by guessing from the last raw event. Never says "missed".
  function renderBanner(lead, events) {
    bannerEl.innerHTML = "";
    var state = lead ? lead.currentState : null;
    var label = lead ? lead.currentStateLabel : null;
    var reason = lead ? lead.stoppedReason : null;
    var cls = "warn";
    if (state === "BOOKED" || state === "COMPLETED_NO_BOOKING" || state === "STATUS_REPORTED" || state === "CRM_NOTE_DELIVERED") cls = "ok";
    else if (state === "CALL_FAILED" || state === "PHONE_INVALID" || state === "SKIPPED" || state === "RECEIVED_NOT_PROCESSED" || state === "NOT_RECEIVED") cls = "err";
    if (!label) {
      if (!events.length) return;
      var last = events[events.length - 1];
      label = "Last event: " + titleFor(last.event);
    }
    var b = el("div", "banner " + cls);
    b.textContent = label + (reason ? " \\u2014 " + reason : "");
    bannerEl.appendChild(b);
  }

  function renderTimeline(events) {
    timelineEl.innerHTML = "";
    var filtered = events.filter(filterBucket);
    if (!filtered.length) {
      timelineEl.appendChild(el("li", "muted", "No events match this filter."));
      return;
    }
    // Presentation-only dedupe: collapse CONSECUTIVE identical events (same
    // event+status+reason) into one row with a count. The underlying
    // lead_lifecycle_events rows are never destroyed; this only affects display,
    // so e.g. two back-to-back Call Completed rows show as "Call Completed (x2)".
    var shown = [];
    filtered.forEach(function (ev) {
      var prev = shown.length ? shown[shown.length - 1] : null;
      if (prev && prev.event === ev.event && (prev.status || "") === (ev.status || "") && (prev.reason || "") === (ev.reason || "")) {
        prev._count = (prev._count || 1) + 1;
        prev._lastAt = ev.createdAt;
        return;
      }
      var copy = {}; for (var k in ev) { if (Object.prototype.hasOwnProperty.call(ev, k)) copy[k] = ev[k]; }
      copy._count = 1;
      shown.push(copy);
    });
    // Index of the last stop event within the displayed list (for emphasis).
    var lastStop = -1;
    for (var i = 0; i < shown.length; i++) {
      var c = categoryOf(shown[i]);
      if (c === "rejected" || c === "skipped") lastStop = i;
    }
    shown.forEach(function (ev, idx) {
      var cat = categoryOf(ev);
      var li = el("li", "ev" + (idx === lastStop ? " stop" : ""));
      li.appendChild(el("span", "dot " + (CAT_DOT[cat] || "neutral")));
      var head = el("div", "ev-head");
      head.appendChild(el("span", "ev-title", titleFor(ev.event) + (ev._count > 1 ? " (x" + ev._count + ")" : "")));
      if (ev.status) {
        var bcls = cat === "success" ? "b-ok" : cat === "rejected" ? "b-err" : cat === "skipped" ? "b-skip" : cat === "warn" ? "b-warn" : "b-neutral";
        head.appendChild(badge(ev.status, bcls));
      }
      head.appendChild(el("span", "ev-time", fmtTime(ev.createdAt)));
      li.appendChild(head);
      var body = el("div", "ev-body");
      if (ev.detail) body.appendChild(el("div", "ev-line", ev.detail));
      if (ev.reason) body.appendChild(el("div", "ev-reason", "reason: " + ev.reason));
      if (ev.metadata && typeof ev.metadata === "object" && Object.keys(ev.metadata).length) {
        var det = el("details", "details");
        det.appendChild(el("summary", null, "View details"));
        var meta = el("div", "meta");
        Object.keys(ev.metadata).forEach(function (k) {
          var v = ev.metadata[k];
          if (v === null || v === undefined || v === "") return;
          meta.appendChild(el("span", "mk", k));
          meta.appendChild(el("span", "mv", typeof v === "object" ? JSON.stringify(v) : String(v)));
        });
        if (meta.childNodes.length) { det.appendChild(meta); body.appendChild(det); }
      }
      li.appendChild(body);
      timelineEl.appendChild(li);
    });
  }

  function render() {
    if (!state.data) return;
    renderSummary(state.data.lead);
    renderBanner(state.data.lead, state.data.events);
    renderTimeline(state.data.events);
    resultEl.classList.remove("hidden");
    statusMsg.classList.add("hidden");
    lastUpdatedEl.textContent = "Last updated: " + fmtTime(new Date().toISOString());
  }

  function showStatus(strongText, text, isError) {
    resultEl.classList.add("hidden");
    statusMsg.classList.remove("hidden");
    statusMsg.className = "status-msg" + (isError ? " error" : "");
    statusMsg.innerHTML = "";
    if (strongText) statusMsg.appendChild(el("strong", null, strongText));
    if (text) statusMsg.appendChild(document.createTextNode(text));
  }

  function isTerminal(data) {
    if (!data || !data.lead) return false;
    var s = data.lead.status;
    return s === "COMPLETED" || s === "SKIPPED" || s === "FAILED";
  }

  // ---- data -------------------------------------------------------------
  function fetchLifecycle(leadId, quiet) {
    var key = keyEl.value.trim();
    if (!leadId) { showStatus("Enter a Lead ID", "Paste a lead id above and press Search.", false); return; }
    if (!key) { showStatus("API key required", "Paste the bearer API key above.", true); return; }
    if (!quiet) showStatus("Loading lead lifecycle\\u2026", "", false);
    fetch("/api/leads/" + encodeURIComponent(leadId) + "/lifecycle", {
      headers: { "Authorization": "Bearer " + key }
    }).then(function (res) {
      if (res.status === 401) { showStatus("Unauthorized", "The API key was rejected. Check it and try again.", true); return null; }
      if (res.status === 404) { showStatus("No lead found", "Check the Lead ID and try again.", false); return null; }
      if (!res.ok) { showStatus("Unable to load lead lifecycle", "Please try again.", true); return null; }
      return res.json();
    }).then(function (data) {
      if (!data) { state.data = null; return; }
      state.leadId = leadId;
      state.data = data;
      if (!data.events || !data.events.length) {
        if (data.lead) { render(); if (!data.events.length) {
          // lead exists but no events yet
          timelineEl.innerHTML = ""; timelineEl.appendChild(el("li", "muted", "No lifecycle events are available for this lead yet."));
        } }
        else { showStatus("No lifecycle events", "No lifecycle events are available for this lead yet.", false); }
        return;
      }
      render();
    }).catch(function () {
      showStatus("Unable to load lead lifecycle", "Please try again.", true);
    });
  }

  // ---- lead list --------------------------------------------------------
  function stateCls(state) {
    if (state === "BOOKED" || state === "COMPLETED_NO_BOOKING" || state === "STATUS_REPORTED" || state === "CRM_NOTE_DELIVERED") return "b-ok";
    if (state === "CALL_FAILED" || state === "PHONE_INVALID") return "b-err";
    if (state === "SKIPPED" || state === "RECEIVED_NOT_PROCESSED" || state === "NOT_RECEIVED") return "b-skip";
    return "b-neutral";
  }
  function renderList(leads) {
    listWrap.innerHTML = "";
    if (!leads || !leads.length) { listWrap.appendChild(el("p", "muted", "No leads found.")); return; }
    var tbl = el("table"); tbl.style.width = "100%"; tbl.style.borderCollapse = "collapse"; tbl.style.fontSize = "13px";
    var thead = el("thead"), htr = el("tr");
    ["Lead", "Lifecycle state", "Call", "Booking", "Last event", "Updated"].forEach(function (h) {
      var th = el("th", null, h);
      th.style.textAlign = "left"; th.style.padding = "6px 8px"; th.style.color = "var(--muted)"; th.style.borderBottom = "1px solid var(--border)";
      htr.appendChild(th);
    });
    thead.appendChild(htr); tbl.appendChild(thead);
    var tb = el("tbody");
    leads.forEach(function (ld) {
      var tr = el("tr"); tr.style.cursor = "pointer";
      tr.addEventListener("click", function () { idEl.value = ld.leadId; doSearch(); try { window.scrollTo(0, 0); } catch (e) {} });
      function td(node) {
        var c = el("td"); c.style.padding = "6px 8px"; c.style.borderBottom = "1px solid var(--border)";
        if (typeof node === "string") c.textContent = node; else if (node) c.appendChild(node);
        return c;
      }
      var idShort = el("span"); idShort.style.fontFamily = "var(--mono)"; idShort.textContent = ld.leadId.slice(0, 8) + "\\u2026"; idShort.title = ld.leadId;
      tr.appendChild(td(idShort));
      tr.appendChild(td(badge(ld.currentStateLabel || ld.currentState || "\\u2014", stateCls(ld.currentState))));
      tr.appendChild(td(ld.callStatus || "\\u2014"));
      tr.appendChild(td(ld.bookingStatus === "BOOKED" ? badge("Booked", "b-ok") : (ld.bookingStatus === "NO_BOOKING" ? badge("No booking", "b-skip") : "\\u2014")));
      tr.appendChild(td(ld.lastEvent ? titleFor(ld.lastEvent) : "\\u2014"));
      tr.appendChild(td(fmtTime(ld.updatedAt || ld.lastEventAt)));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); listWrap.appendChild(tbl);
  }
  function fetchList() {
    var key = keyEl.value.trim();
    if (!key) { listWrap.innerHTML = ""; listWrap.appendChild(el("p", "status-msg error", "Paste the bearer API key above first.")); return; }
    var lim = parseInt(listLimit.value, 10); if (!(lim > 0)) lim = 50;
    listWrap.innerHTML = ""; listWrap.appendChild(el("p", "muted", "Loading recent leads\\u2026"));
    fetch("/api/leads/lifecycles?limit=" + encodeURIComponent(lim), { headers: { "Authorization": "Bearer " + key } })
      .then(function (res) {
        if (res.status === 401) { listWrap.innerHTML = ""; listWrap.appendChild(el("p", "status-msg error", "The API key was rejected.")); return null; }
        if (!res.ok) { listWrap.innerHTML = ""; listWrap.appendChild(el("p", "status-msg error", "Unable to load leads.")); return null; }
        return res.json();
      })
      .then(function (data) { if (data) renderList(data.leads || []); })
      .catch(function () { listWrap.innerHTML = ""; listWrap.appendChild(el("p", "status-msg error", "Unable to load leads.")); });
  }

  function doSearch() { stopAuto(); fetchLifecycle(idEl.value.trim(), false); syncAuto(); }

  function stopAuto() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  function syncAuto() {
    stopAuto();
    if (autoEl.checked && state.leadId && !isTerminal(state.data)) {
      state.timer = setInterval(function () {
        if (isTerminal(state.data)) { stopAuto(); autoEl.checked = false; return; }
        fetchLifecycle(state.leadId, true);
      }, 10000);
    }
  }

  // ---- events -----------------------------------------------------------
  searchBtn.addEventListener("click", doSearch);
  loadListBtn.addEventListener("click", fetchList);
  idEl.addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
  refreshBtn.addEventListener("click", function () { if (state.leadId) fetchLifecycle(state.leadId, false); });
  autoEl.addEventListener("change", syncAuto);
  Array.prototype.forEach.call(document.querySelectorAll("#filters button"), function (b) {
    b.addEventListener("click", function () {
      state.filter = b.getAttribute("data-f");
      Array.prototype.forEach.call(document.querySelectorAll("#filters button"), function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      if (state.data) renderTimeline(state.data.events);
    });
  });

  // Prefill from ?leadId= for shareable links.
  try {
    var qp = new URLSearchParams(location.search).get("leadId");
    if (qp) { idEl.value = qp; if (keyEl.value.trim()) doSearch(); }
  } catch (e) {}
})();
</script>
</body>
</html>`;
