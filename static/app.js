"use strict";

/* ===========================================================================
   Helpers
   ======================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { prefs: {}, status: {}, renderToken: 0, refreshTimer: null };

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseLocal = (s) => { const [d, t = "00:00"] = s.split("T"); const [y, m, dd] = d.split("-").map(Number); const [h, mi] = t.split(":").map(Number); return new Date(y, m - 1, dd, h, mi); };
const hm = (s) => s ? s.slice(11, 16) : "";
const fmt = {
  weekday: new Intl.DateTimeFormat("en-GB", { weekday: "long" }),
  long: new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }),
  short: new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }),
  dayMonth: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }),
};
const eur = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const money = (c) => eur.format((c || 0) / 100);
const moneyShort = (c) => money(c).replace(/,00(?=\D*$)/, "");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function duration(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h${m ? ` ${m}` : ""}` : `${m} min`;
}
function relDay(iso) {
  const d = parseLocal(iso.length === 10 ? iso + "T00:00" : iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return fmt.short.format(d);
}
function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - parseLocal(iso)) / 60000));
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return relDay(iso);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(path, { method = "GET", body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") msg = j.detail;
      else if (Array.isArray(j.detail)) msg = j.detail.map((d) => d.msg.replace(/^Value error, /, "")).join("; ");
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function toast(msg, kind = "ok", ms = null, action = null) {
  const el = $("#toast");
  $("[data-msg]", el).textContent = msg;
  el.classList.remove("hidden", "bg-red-600", "text-white", "bg-slate-900", "text-slate-50");
  el.classList.add(...(kind === "error" ? ["bg-red-600", "text-white"] : ["bg-slate-900", "text-slate-50"]));
  const btn = $("[data-action]", el);
  btn.classList.toggle("hidden", !action);
  btn.textContent = action?.label || "";
  btn.onclick = action ? () => { el.classList.add("hidden"); action.run(); } : null;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), ms ?? (action ? 6000 : kind === "error" ? 5000 : 2500));
}

function openModal(title, contentEl) {
  $("#modal-title").textContent = title;
  $("#modal-body").replaceChildren(contentEl);
  $("#modal").classList.remove("hidden");
}
function closeModal() { $("#modal").classList.add("hidden"); $("#modal-body").replaceChildren(); }
$("#modal-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

async function savePrefs(changes) {
  Object.assign(state.prefs, changes);
  try { state.prefs = await api("/api/prefs", { method: "PUT", body: changes }); }
  catch (err) { toast(err.message, "error"); }
}

/* Links: Gmail and other web pages open in your browser, not inside the app. */
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-external]");
  if (!a) return;
  e.preventDefault();
  if (window.pywebview?.api?.open_url) window.pywebview.api.open_url(a.href);
  else window.open(a.href, "_blank", "noopener");
});

/* ===========================================================================
   Icons
   ======================================================================== */

const svg = (paths, cls = "w-5 h-5") =>
  `<svg class="${cls}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">${paths}</svg>`;
const ICON = {
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  "cloud-sun": `<path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M19.1 4.9l-1.4 1.4"/><path d="M15.9 10.4A4 4 0 0 0 8.1 11"/><path d="M17.5 21H9a5 5 0 1 1 1.6-9.7A5.5 5.5 0 0 1 21 14a3.5 3.5 0 0 1-3.5 7Z"/>`,
  cloud: `<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/>`,
  fog: `<path d="M4 14h16M4 18h16M6 10h12"/>`,
  drizzle: `<path d="M17.5 15H9a6 6 0 1 1 5.7-8h1.8a4 4 0 1 1 0 8Z"/><path d="M8 19v1M12 19v1M16 19v1"/>`,
  rain: `<path d="M17.5 14H9a6 6 0 1 1 5.7-8h1.8a4 4 0 1 1 0 8Z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>`,
  snow: `<path d="M17.5 14H9a6 6 0 1 1 5.7-8h1.8a4 4 0 1 1 0 8Z"/><path d="M8 18h.01M12 20h.01M16 18h.01"/>`,
  storm: `<path d="M17.5 14H9a6 6 0 1 1 5.7-8h1.8a4 4 0 1 1 0 8Z"/><path d="m13 14-3 4h4l-3 4"/>`,
  umbrella: `<path d="M12 2a10 10 0 0 0-10 10h20A10 10 0 0 0 12 2Z"/><path d="M12 12v7a2 2 0 0 0 4 0"/>`,
  book: `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>`,
  pin: `<path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>`,
  mail: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  euro: `<path d="M18 7a6 6 0 1 0 0 10"/><path d="M4 10h9M4 14h9"/>`,
  flag: `<path d="M5 21V4h11l-1.5 4L16 12H5"/>`,
  list: `<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2"/>`,
};

/* ===========================================================================
   Today: the morning brief
   ======================================================================== */

function weatherBlock(w, isTomorrow = false) {
  if (!w || w.error) return `<p class="text-sm text-slate-400">${esc(w?.error || "")}</p>`;
  return `
    <div class="flex items-center gap-3">
      <span class="text-accent">${svg(ICON[w.icon] || ICON.cloud, "w-9 h-9")}</span>
      <div>
        <p class="display text-3xl font-semibold text-slate-900 leading-none">${w.temp}°</p>
        <p class="text-xs text-slate-500 mt-1">${isTomorrow ? "Tomorrow · " : ""}${esc(w.label)} · ${w.high}° / ${w.low}° · ${esc(w.place)}</p>
      </div>
    </div>
    ${w.advice ? `<p class="mt-3 inline-flex items-center gap-1.5 rounded-full bg-accent/10 text-slate-800 text-xs font-medium px-2.5 py-1">
      ${svg(ICON.umbrella, "w-3.5 h-3.5")}${esc(w.advice)}</p>` : ""}`;
}

function sessionButtons(id) {
  return `<span class="flex gap-1 shrink-0">
    <button data-session="${id}" data-status="done" class="btn btn-secondary !px-2.5 !py-1 text-xs">Done</button>
    <button data-session="${id}" data-status="missed" class="btn btn-ghost !px-2.5 !py-1 text-xs">Missed</button></span>`;
}

function timeline(day, now, isTomorrow = false) {
  if (day.error === "no_access") {
    return `<div class="text-center py-8">
      <p class="text-slate-700 font-medium">Today needs to see your calendar</p>
      <p class="text-sm text-slate-500 mt-1 mb-4">macOS will ask once. Your events stay on your Mac.</p>
      <button data-allow-calendar class="btn btn-primary">Allow calendar access</button></div>`;
  }
  if (day.error) return `<p class="text-sm text-red-600">${esc(day.error)}</p>`;
  const allDay = day.events.filter((e) => e.all_day);
  const timed = day.events.filter((e) => !e.all_day);
  const nowIso = now.slice(0, 16);
  const items = [
    ...timed.map((e) => ({ at: e.start, type: "event", e })),
    ...day.free.map((f) => ({ at: f.start, type: "free", f })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  let nowShown = false;
  const rows = [];
  for (const it of items) {
    if (!isTomorrow && !nowShown && it.at >= nowIso && rows.length) { rows.push(`<div class="now-line my-1" aria-label="Now"></div>`); nowShown = true; }
    if (it.type === "free") {
      rows.push(`<div class="relative flex gap-4 py-2.5 pl-1 text-sm">
        <span class="w-14 shrink-0 text-right tabular text-xs text-slate-400 pt-0.5">${hm(it.f.start)}</span>
        <span class="text-slate-400 pl-4">Free until ${hm(it.f.end)} · ${duration(it.f.minutes)}</span></div>`);
      continue;
    }
    const e = it.e;
    const isSession = e.session_id != null;
    rows.push(`<div class="relative flex gap-4 py-2.5 pl-1 ${e.past ? "opacity-50" : ""}">
      <span class="w-14 shrink-0 text-right tabular text-xs text-slate-500 pt-0.5 leading-tight">${hm(e.start)}<br><span class="text-slate-400">${hm(e.end)}</span></span>
      <span class="tl-dot" style="background:${esc(e.color)}"></span>
      <div class="pl-4 min-w-0 flex-1 flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <p class="font-medium text-slate-900 truncate">${isSession ? `<span class="inline-block align-[-3px] text-accent mr-1">${svg(ICON.book, "w-4 h-4")}</span>` : ""}${esc(e.title.replace(/^📚\s*/, ""))}
            ${e.now ? `<span class="ml-1.5 align-middle rounded-full bg-accent text-on-accent text-[10px] font-semibold px-1.5 py-0.5">NOW</span>` : ""}</p>
          <p class="text-xs text-slate-500 truncate mt-0.5">${e.location ? `${esc(e.location)} · ` : ""}${esc(e.calendar)}</p>
        </div>
        ${isSession && e.past ? sessionButtons(e.session_id)
          : isSession && !isTomorrow ? `<button data-focus="${e.session_id}" class="btn btn-primary !px-3 !py-1 text-xs shrink-0">Start</button>` : ""}
      </div></div>`);
  }
  if (!isTomorrow && !nowShown && rows.length && items.length && items.at(-1).at < nowIso) rows.push(`<div class="now-line my-1"></div>`);
  return `
    ${allDay.length ? `<div class="flex flex-wrap gap-2 mb-3">${allDay.map((e) => `<span class="chip border-slate-200 text-slate-700 !py-1">
      <span class="w-2 h-2 rounded-full" style="background:${esc(e.color)}"></span>${esc(e.title)}</span>`).join("")}</div>` : ""}
    ${timed.length ? `<div class="timeline">${rows.join("")}</div>`
      : `<p class="text-sm text-slate-500 py-6 text-center">Nothing in your calendar today. ${day.free.length ? "The day is yours." : ""}</p>`}
    ${day.tomorrow_first ? `<p class="text-xs text-slate-500 mt-4 pt-3 border-t border-slate-100">Tomorrow starts at <b class="text-slate-700">${hm(day.tomorrow_first.start)}</b> with ${esc(day.tomorrow_first.title.replace(/^📚\s*/, ""))}</p>` : ""}`;
}

function comingUp(items) {
  if (!items.length) return `<p class="text-sm text-slate-400">No exams or deadlines in the next two weeks.</p>`;
  return `<ul class="space-y-3">${items.slice(0, 6).map((i) => `
    <li class="flex items-center gap-3">
      <span class="w-11 shrink-0 text-center rounded-xl py-1 ${i.days <= 3 ? "bg-accent text-on-accent" : "bg-slate-100 text-slate-700"}">
        <span class="display block text-lg font-semibold leading-none">${i.days}</span>
        <span class="block text-[10px] leading-none mt-0.5 opacity-80">${i.days === 1 ? "day" : "days"}</span></span>
      <span class="min-w-0">
        <span class="block text-sm font-medium text-slate-900 truncate">${esc(i.title)}</span>
        <span class="block text-xs text-slate-500">${relDay(i.date)}${i.time ? ` · ${i.time}` : ""}</span></span>
    </li>`).join("")}</ul>`;
}

function remindersBlock(rs) {
  if (rs.error) return `<p class="text-sm text-slate-400">${esc(rs.error)}</p>`;
  if (!rs.length) return `<p class="text-sm text-slate-400">Nothing due. Nice.</p>`;
  return `<ul class="space-y-2">${rs.map((r) => `
    <li class="flex items-start gap-2.5 text-sm">
      <span class="mt-1 w-3.5 h-3.5 rounded-full border-2 shrink-0" style="border-color:${esc(r.color)}"></span>
      <span class="flex-1 min-w-0 text-slate-800">${esc(r.title)}</span>
      <span class="text-xs shrink-0 ${r.overdue ? "text-red-600 font-medium" : "text-slate-400"}">${r.overdue ? "Overdue" : r.when === "today" ? (hm(r.due) !== "00:00" ? hm(r.due) : "Today") : "Tomorrow"}</span>
    </li>`).join("")}</ul>`;
}

function emailBlock(m) {
  if (m.error && !m.items?.length) return `<p class="text-sm text-slate-500">${esc(m.error)} · <a href="#/settings?open=gmail" class="underline">Settings</a></p>`;
  if (!m.enabled) return `<p class="text-sm text-slate-500">Connect Gmail to see emails that need a reply. <a href="#/settings?open=gmail" class="underline">Set up</a></p>`;
  if (!m.items.length) return `<p class="text-sm text-slate-400">Inbox zero, as far as replies go.</p>`;
  return `<ul class="-mx-2">${m.items.map((e) => `
    <li><a ${e.link ? `href="${esc(e.link)}" data-external` : ""} class="flex items-start gap-3 rounded-xl px-2 py-2 ${e.link ? "hover:bg-slate-50" : ""}">
      <span class="mt-1.5 w-2 h-2 rounded-full shrink-0 ${e.unread ? "bg-accent" : "bg-transparent"}"></span>
      <span class="min-w-0 flex-1">
        <span class="flex justify-between gap-2"><span class="text-sm font-medium text-slate-900 truncate">${esc(e.from)}</span>
          <span class="text-xs text-slate-400 shrink-0">${ago(e.received)}</span></span>
        <span class="block text-sm text-slate-600 truncate">${esc(e.subject)}</span></span></a></li>`).join("")}</ul>
    ${m.error ? `<p class="text-xs text-amber-700 mt-2">Couldn't refresh: ${esc(m.error)}</p>` : ""}`;
}

function budgetBlock(b) {
  if (!b || b.error) return "";
  const line = b.left_cents == null
    ? `<p class="display text-2xl font-semibold text-slate-900">${money(b.spent_cents)}</p><p class="text-xs text-slate-500 mt-1">spent this month</p>`
    : `<p class="display text-2xl font-semibold ${b.left_cents < 0 ? "text-red-600" : "text-slate-900"}">${money(Math.abs(b.left_cents))}</p>
       <p class="text-xs text-slate-500 mt-1">${b.left_cents < 0 ? "over budget this month" : `left this month · about ${money(b.per_day_cents)} a day`}</p>`;
  return `<section class="card p-5">
    <div class="flex items-center justify-between mb-2"><h2 class="eyebrow">Money</h2>
      ${window.pywebview?.api?.open_budget ? `<button data-open-budget class="link text-xs">Open Budget</button>` : ""}</div>
    ${line}</section>`;
}

function top3Block(t, isTomorrow) {
  if (t.error) return `<p class="text-sm text-slate-400">${esc(t.error)}</p>`;
  return `<form data-top3 data-date="${t.date}" class="space-y-2">
    ${t.items.map((i) => `<label class="flex items-center gap-2.5">
      <input type="checkbox" data-done="${i.position}" ${i.done ? "checked" : ""} ${i.text ? "" : "disabled"} class="w-4 h-4 rounded-full border-slate-300 shrink-0">
      <input data-text="${i.position}" value="${esc(i.text)}" maxlength="120" placeholder="${["", "The one thing that matters most", "Second", "Third"][i.position]}"
        class="flex-1 min-w-0 bg-transparent border-0 border-b border-transparent focus:border-slate-200 focus:outline-none text-sm py-1 ${i.done ? "line-through text-slate-400" : "text-slate-800"} placeholder:text-slate-300"></label>`).join("")}
    ${t.leftover.length ? `<div class="pt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">${isTomorrow ? "Still open:" : "From yesterday:"}
      ${t.leftover.map((x) => `<button type="button" data-carry="${esc(x)}" class="rounded-full bg-slate-100 hover:bg-slate-200 px-2.5 py-1 text-slate-700">+ ${esc(x)}</button>`).join("")}</div>` : ""}
  </form>`;
}

function wireTop3(root) {
  const f = $("[data-top3]", root);
  if (!f) return;
  const save = async () => {
    const items = [1, 2, 3].map((p) => ({ position: p, text: $(`[data-text="${p}"]`, f).value, done: $(`[data-done="${p}"]`, f).checked }));
    try { await api("/api/top3", { method: "PUT", body: { date: f.dataset.date, items } }); } catch (err) { toast(err.message, "error"); }
  };
  f.addEventListener("submit", (e) => e.preventDefault());
  f.addEventListener("change", async (e) => {
    if (e.target.matches("[data-done]")) {
      $(`[data-text="${e.target.dataset.done}"]`, f).classList.toggle("line-through", e.target.checked);
      $(`[data-text="${e.target.dataset.done}"]`, f).classList.toggle("text-slate-400", e.target.checked);
      if (e.target.checked && [1, 2, 3].every((p) => !$(`[data-text="${p}"]`, f).value || $(`[data-done="${p}"]`, f).checked)) toast("All done. Great day.");
    }
    if (e.target.matches("[data-text]")) $(`[data-done="${e.target.dataset.text}"]`, f).disabled = !e.target.value.trim();
    save();
  });
  f.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-text]")) { e.preventDefault(); $(`[data-text="${Number(e.target.dataset.text) + 1}"]`, f)?.focus() || e.target.blur(); }
  });
  f.addEventListener("click", (e) => {
    const b = e.target.closest("[data-carry]");
    if (!b) return;
    const empty = [1, 2, 3].map((p) => $(`[data-text="${p}"]`, f)).find((i) => !i.value.trim());
    if (!empty) return toast("Your three are full. Clear one first.", "error");
    empty.value = b.dataset.carry;
    $(`[data-done="${empty.dataset.text}"]`, f).disabled = false;
    b.remove();
    save();
  });
}

function birthdaysBlock(list) {
  if (list.error) return `<p class="text-sm text-slate-400">${esc(list.error)}</p>`;
  if (!list.length) return `<p class="text-sm text-slate-400">No birthdays this week.</p>`;
  return `<ul class="space-y-2">${list.map((b) => `<li class="flex items-center justify-between gap-2 text-sm">
    <span class="text-slate-800 truncate">${esc(b.name)}</span>
    <span class="text-xs ${b.days === 0 ? "text-accent font-semibold" : "text-slate-400"} shrink-0">${b.days === 0 ? "Today" : b.days === 1 ? "Tomorrow" : fmt.weekday.format(parseLocal(b.date + "T00:00"))}</span></li>`).join("")}</ul>`;
}

function leaveByLine(lb, isTomorrow) {
  if (!lb) return "";
  const soon = !isTomorrow && lb.minutes_until <= 15;
  const when = isTomorrow ? "" : lb.minutes_until <= 0 ? " · leave now" : lb.minutes_until < 120 ? ` · in ${duration(lb.minutes_until)}` : "";
  return `<p class="mt-3 inline-flex items-center gap-1.5 rounded-full ${soon ? "bg-accent text-on-accent" : "bg-slate-100 text-slate-700"} text-xs font-medium px-2.5 py-1">
    ${svg(ICON.pin, "w-3.5 h-3.5")}Leave by ${hm(lb.leave)}${isTomorrow ? " tomorrow" : ""} for ${esc(lb.title)}${when}</p>`;
}

function sideCard(id, b, isTomorrow) {
  const card = (title, body, extra = "") => `<section class="card p-5"><div class="flex items-center justify-between mb-3"><h2 class="eyebrow">${title}</h2>${extra}</div>${body}</section>`;
  switch (id) {
    case "top3": return b.top3 ? card(isTomorrow ? "Top 3 for tomorrow" : "Top 3 for today", top3Block(b.top3, isTomorrow)) : "";
    case "coming_up": return b.coming_up ? card("Coming up", Array.isArray(b.coming_up) ? comingUp(b.coming_up) : `<p class="text-sm text-slate-400">${esc(b.coming_up.error || "")}</p>`, `<a href="#/revision" class="link text-xs">Revision</a>`) : "";
    case "todo": return b.reminders ? card("To do", remindersBlock(b.reminders)) : "";
    case "birthdays": return b.birthdays?.length || b.birthdays?.error ? card("Birthdays", birthdaysBlock(b.birthdays)) : "";
    case "email": return b.email ? card("Needs a reply", emailBlock(b.email)) : "";
    case "money": return budgetBlock(b.budget);
    default: return "";
  }
}

async function viewToday(root, params) {
  const want = params?.get("view");
  const [b, rev] = await Promise.all([api(`/api/brief${want ? `?view=${want}` : ""}`), api("/api/revision").catch(() => null)]);
  const now = parseLocal(b.now);
  const isTomorrow = b.view === "tomorrow";
  const target = parseLocal(b.date + "T00:00");
  const toCheck = rev?.to_check || [];
  const todaySessions = (rev?.sessions || []).filter((s) => s.start.slice(0, 10) === b.date && !s.event_id && s.status === "planned");
  state.sessions = rev?.sessions || [];
  root.innerHTML = `
    <section class="hero card p-6 sm:p-8">
      <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-6">
        <div>
          <p class="eyebrow">${isTomorrow ? `Tomorrow · ${esc(fmt.long.format(target))}` : esc(fmt.long.format(now))}</p>
          <h1 class="display text-4xl sm:text-5xl font-semibold text-slate-900 mt-2">${esc(b.greeting)}</h1>
          <p class="text-sm text-slate-500 mt-2">${isTomorrow ? "Here's tomorrow. " : ""}${summaryLine(b, todaySessions)}</p>
          ${leaveByLine(b.day?.leave_by, isTomorrow)}
          ${b.evening_available && now.getHours() >= 19 ? `<p class="mt-3"><a href="#/today?view=${isTomorrow ? "today" : "tomorrow"}" class="link underline-offset-2 underline">${isTomorrow ? "Show today instead" : "Show tomorrow"}</a></p>` : ""}
        </div>
        <div class="sm:text-right sm:min-w-[14rem]">${weatherBlock(b.weather, isTomorrow)}</div>
      </div>
    </section>

    ${toCheck.length ? `<section class="card p-5 mt-4">
      <h2 class="eyebrow mb-3">How did revision go?</h2>
      <ul class="space-y-2">${toCheck.slice(-4).map((s) => `<li class="flex items-center gap-3 text-sm">
        <span class="flex-1 min-w-0 text-slate-800 truncate">${esc(s.subject)}${s.kind === "review" ? " review" : ""}
          <span class="text-slate-400">· ${relDay(s.start)} ${hm(s.start)}–${hm(s.end)}</span></span>${sessionButtons(s.id)}</li>`).join("")}</ul>
    </section>` : ""}

    <div class="grid lg:grid-cols-[1.45fr_1fr] gap-4 mt-4">
      <section class="card p-5 sm:p-6">
        <div class="flex items-baseline justify-between mb-4">
          <h2 class="font-semibold text-slate-900">${isTomorrow ? "Tomorrow" : "Your day"}</h2>
          ${b.day.events ? `<span class="text-xs text-slate-400">${plural(b.day.events.filter((e) => !e.all_day).length, "event", "events")}</span>` : ""}
        </div>
        ${timeline(b.day, b.now, isTomorrow)}
        ${todaySessions.length ? `<p class="text-xs text-slate-500 mt-3">${plural(todaySessions.length, "revision session", "revision sessions")} planned today (not in your calendar yet). <a href="#/revision" class="underline">See plan</a></p>` : ""}
      </section>
      <div class="space-y-4">${b.sections.filter((s) => s.on).map((s) => sideCard(s.id, b, isTomorrow)).join("")}</div>
    </div>`;

  $("[data-allow-calendar]", root)?.addEventListener("click", async () => {
    const r = await api("/api/calendar/access", { method: "POST" });
    if (r.events !== "granted") toast("Calendar access is off. Turn it on in System Settings → Privacy & Security → Calendars.", "error", 8000);
    render();
  });
  $("[data-open-budget]", root)?.addEventListener("click", () => window.pywebview.api.open_budget());
  wireSessionButtons(root);
  wireTop3(root);
  wireFocusButtons(root);
}

function summaryLine(b, todaySessions) {
  const parts = [];
  const timed = (b.day.events || []).filter((e) => !e.all_day && !e.past);
  if (b.view === "tomorrow") {
    const all = (b.day.events || []).filter((e) => !e.all_day);
    parts.push(all.length ? `${plural(all.length, "thing", "things")} in your calendar, starting ${hm(all[0].start)}` : "Nothing in your calendar");
  } else if (timed.length) parts.push(`${plural(timed.length, "thing", "things")} left in your calendar`);
  else if (b.day.events) parts.push("Nothing else in your calendar");
  const soon = Array.isArray(b.coming_up) ? b.coming_up.find((i) => i.days <= 7) : null;
  const bday = Array.isArray(b.birthdays) ? b.birthdays.find((x) => x.days === 0) : null;
  if (bday) parts.push(`${bday.name}'s birthday`);
  if (soon) parts.push(`${soon.title} ${soon.days === 0 ? "today" : soon.days === 1 ? "tomorrow" : `in ${soon.days} days`}`);
  if (b.email?.items?.length) parts.push(plural(b.email.items.length, "email to answer", "emails to answer"));
  return esc(parts.join(" · "));
}

function wireSessionButtons(root) {
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-session]");
    if (!b) return;
    await api(`/api/revision/sessions/${b.dataset.session}`, { method: "PATCH", body: { status: b.dataset.status } });
    toast(b.dataset.status === "done" ? "Nice work. Marked as done." : "Marked as missed. Replan in Revision to make up for it.", "ok", null,
      b.dataset.status === "missed" ? { label: "Replan", run: () => { location.hash = "#/revision?replan=1"; } } : null);
    render();
  });
}

/* ===========================================================================
   Focus timer for a revision session
   ======================================================================== */

const focus = { session: null, total: 0, left: 0, paused: false, last: 0, timer: null };

function wireFocusButtons(root) {
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-focus]");
    if (!b) return;
    const s = (state.sessions || []).find((x) => x.id === Number(b.dataset.focus));
    if (s) startFocus(s);
  });
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 1.2);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 1.3);
    });
  } catch { /* no sound available */ }
}

function startFocus(s) {
  const minutes = Math.round((parseLocal(s.end) - parseLocal(s.start)) / 60000);
  Object.assign(focus, { session: s, total: minutes * 60, left: minutes * 60, paused: false, last: Date.now() });
  let el = $("#focus");
  if (!el) { el = document.createElement("div"); el.id = "focus"; document.body.append(el); }
  el.className = "fixed inset-0 z-50 bg-slate-50 flex items-center justify-center p-6";
  el.innerHTML = `
    <div class="text-center max-w-md w-full">
      <p class="eyebrow">${s.kind === "review" ? "Review" : "Revision"} · ${duration(minutes)}</p>
      <h1 class="display text-3xl sm:text-4xl font-semibold text-slate-900 mt-2">${esc(s.subject)}</h1>
      <div class="relative w-64 h-64 mx-auto my-8">
        <svg viewBox="0 0 100 100" class="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r="45" fill="none" stroke="rgb(var(--slate-200))" stroke-width="3"/>
          <circle data-ring cx="50" cy="50" r="45" fill="none" stroke="rgb(var(--accent))" stroke-width="3" stroke-linecap="round"
                  stroke-dasharray="282.74" stroke-dashoffset="0" style="transition: stroke-dashoffset .5s linear"/></svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          <span data-clock class="display text-6xl font-semibold text-slate-900 tabular"></span>
          <span data-state class="text-xs text-slate-400 mt-1">focus</span></div>
      </div>
      <div data-controls class="flex justify-center gap-2">
        <button data-pause class="btn btn-secondary w-28">Pause</button>
        <button data-finish class="btn btn-primary w-28">Finish</button>
      </div>
      <button data-stop class="link mt-5">Stop without saving</button>
      <p class="text-xs text-slate-400 mt-6">Phone away, one tab open. You've got this.</p>
    </div>`;
  $("[data-pause]", el).onclick = () => {
    focus.paused = !focus.paused;
    focus.last = Date.now();
    $("[data-pause]", el).textContent = focus.paused ? "Resume" : "Pause";
    $("[data-state]", el).textContent = focus.paused ? "paused" : "focus";
  };
  $("[data-finish]", el).onclick = () => endFocus(true);
  $("[data-stop]", el).onclick = () => endFocus(false);
  clearInterval(focus.timer);
  focus.timer = setInterval(tickFocus, 250);
  tickFocus();
}

function tickFocus() {
  const el = $("#focus");
  if (!el || !focus.session) return;
  const now = Date.now();
  if (!focus.paused) focus.left -= (now - focus.last) / 1000;
  focus.last = now;
  const left = Math.max(0, Math.ceil(focus.left));
  $("[data-clock]", el).textContent = `${Math.floor(left / 60)}:${pad(left % 60)}`;
  $("[data-ring]", el).style.strokeDashoffset = String(282.74 * (1 - left / focus.total));
  document.title = focus.paused ? "Paused · Today" : `${Math.floor(left / 60)}:${pad(left % 60)} · ${focus.session.subject}`;
  if (left <= 0) endFocus(true, true);
}

async function endFocus(done, finished = false) {
  clearInterval(focus.timer);
  const s = focus.session;
  focus.session = null;
  document.title = "Today";
  const el = $("#focus");
  if (done && s) {
    try { await api(`/api/revision/sessions/${s.id}`, { method: "PATCH", body: { status: "done" } }); } catch (err) { toast(err.message, "error"); }
    if (finished) {
      chime();
      window.pywebview?.api?.notify?.("Session complete", `${s.subject}: nice work. Take a break.`);
    }
    el.innerHTML = `<div class="text-center">
      <span class="inline-flex w-16 h-16 rounded-full bg-accent text-on-accent items-center justify-center">${svg(ICON.check, "w-8 h-8")}</span>
      <h1 class="display text-3xl font-semibold text-slate-900 mt-5">${finished ? "Session complete" : "Marked as done"}</h1>
      <p class="text-sm text-slate-500 mt-2">${esc(s.subject)} · take a short break before the next thing.</p>
      <button data-close class="btn btn-primary mt-6">Back to Today</button></div>`;
    $("[data-close]", el).onclick = () => { el.remove(); render(); };
  } else {
    el?.remove();
  }
}

/* ===========================================================================
   Revision: exams and the timetable
   ======================================================================== */

const EXAM_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#8b5cf6", "#e34948", "#eda100", "#e87ba4", "#184f95"];
const examColor = (id) => EXAM_COLORS[(id - 1) % EXAM_COLORS.length];
const DIFFICULTY = { 1: "Easy", 2: "Medium", 3: "Hard" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function examForm(exam = null) {
  const f = document.createElement("form");
  f.className = "space-y-4";
  f.innerHTML = `
    <div><label class="label">Subject</label><input name="subject" class="input" maxlength="60" placeholder="e.g. Statistics" value="${esc(exam?.subject || "")}" required></div>
    <div class="grid grid-cols-2 gap-3">
      <div><label class="label">Exam date</label><input name="date" type="date" class="input" value="${exam?.date || ""}" required></div>
      <div><label class="label">Time <span class="font-normal text-slate-400">(optional)</span></label><input name="time" type="time" class="input" value="${exam?.time || ""}"></div>
    </div>
    <div><label class="label">How hard is it for you?</label>
      <div class="grid grid-cols-3 gap-2" data-diff>${[1, 2, 3].map((d) => `
        <button type="button" data-d="${d}" class="btn border ${(exam?.difficulty || 2) === d ? "border-accent bg-accent/10 text-slate-900" : "border-slate-200 text-slate-600"}">${DIFFICULTY[d]}
          <span class="text-[11px] text-slate-400 font-normal">${{ 1: 6, 2: 10, 3: 15 }[d]} h</span></button>`).join("")}</div>
      <input type="hidden" name="difficulty" value="${exam?.difficulty || 2}"></div>
    <details ${exam?.hours ? "open" : ""}><summary class="cursor-pointer list-none text-sm text-slate-500 hover:text-slate-900 inline-flex items-center gap-1">
      <span data-chevron class="inline-block transition-transform">›</span> Set the hours yourself</summary>
      <div class="mt-2 w-32"><input name="hours" inputmode="decimal" class="input text-right" placeholder="e.g. 12" value="${exam?.hours || ""}"></div></details>
    <button class="btn btn-primary w-full py-2.5">${exam ? "Save" : "Add exam"}</button>`;
  $("[data-diff]", f).addEventListener("click", (e) => {
    const b = e.target.closest("[data-d]");
    if (!b) return;
    f.difficulty.value = b.dataset.d;
    $$("[data-d]", f).forEach((x) => { const on = x === b; x.classList.toggle("border-accent", on); x.classList.toggle("bg-accent/10", on); x.classList.toggle("text-slate-900", on); x.classList.toggle("border-slate-200", !on); x.classList.toggle("text-slate-600", !on); });
  });
  f.values = () => ({ subject: f.subject.value.trim(), date: f.date.value, time: f.time.value || null,
                      difficulty: Number(f.difficulty.value), hours: f.hours.value ? Number(f.hours.value.replace(",", ".")) : (exam ? 0 : null) });
  return f;
}

function openExamForm(exam, after) {
  const f = examForm(exam);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = f.values();
    if (!v.subject || !v.date) return toast("Add the subject and the date", "error");
    try {
      await api(exam ? `/api/revision/exams/${exam.id}` : "/api/revision/exams", { method: exam ? "PATCH" : "POST", body: v });
      closeModal();
      toast(exam ? "Exam updated. Replan to use the change." : `Added ${v.subject}`);
      after();
    } catch (err) { toast(err.message, "error"); }
  });
  openModal(exam ? "Edit exam" : "Add an exam", f);
  setTimeout(() => f.subject.focus(), 50);
}

/** Import a class's key dates (shipped with the app, or a .json file someone shares). */
async function openImport(after) {
  const lists = await api("/api/revision/key-dates").catch(() => []);
  const body = document.createElement("div");

  function pick(list) {
    const courses = [...new Set(list.items.map((i) => i.course || "Other"))];
    body.innerHTML = `
      <p class="text-sm text-slate-500 -mt-1">${esc(list.description || "")}</p>
      ${list.check ? `<p class="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2 mt-3">${esc(list.check)}</p>` : ""}
      <p class="label mt-4">Your courses</p>
      <div class="divide-y divide-slate-100">${courses.map((c) => {
        const items = list.items.filter((i) => (i.course || "Other") === c);
        return `<label class="flex items-start gap-3 py-2.5 cursor-pointer">
          <input type="checkbox" data-course="${esc(c)}" checked class="mt-0.5 rounded border-slate-300">
          <span class="flex-1 min-w-0"><span class="block text-sm font-medium text-slate-900">${esc(c)}</span>
            <span class="block text-xs text-slate-500">${items.map((i) => `${esc(i.subject)} · ${fmt.dayMonth.format(parseLocal(i.date + "T00:00"))}`).join(" — ")}</span></span></label>`;
      }).join("")}</div>
      <button data-do-import class="btn btn-primary w-full mt-4">Add these dates</button>
      <p class="text-xs text-slate-400 mt-2 text-center">Dates you already have are left as they are. Nothing goes into your calendar.</p>`;
    $("[data-do-import]", body).onclick = async () => {
      const chosen = $$("[data-course]", body).filter((x) => x.checked).map((x) => x.dataset.course);
      const items = list.items.filter((i) => chosen.includes(i.course || "Other"));
      if (!items.length) return toast("Pick at least one course", "error");
      try {
        const r = await api("/api/revision/import", { method: "POST", body: { items } });
        closeModal();
        toast(`Added ${plural(r.added, "date", "dates")}${r.skipped ? `, ${r.skipped} you already had` : ""}. Set how hard each one is for you, then make your plan.`, "ok", 8000);
        after();
      } catch (err) { toast(err.message, "error"); }
    };
  }

  body.innerHTML = `
    <p class="text-sm text-slate-500 -mt-1 mb-3">Add a whole semester of exams at once, shared by your class.</p>
    <div class="space-y-2">${lists.map((l, i) => `
      <button data-list="${i}" class="w-full text-left card !shadow-none p-4 hover:bg-slate-50">
        <span class="block font-medium text-slate-900">${esc(l.title)}</span>
        <span class="block text-xs text-slate-500 mt-0.5">${plural(l.items.length, "date", "dates")}${l.updated ? ` · updated ${esc(l.updated)}` : ""}</span></button>`).join("")
      || `<p class="text-sm text-slate-400">No lists come with this version of Today.</p>`}</div>
    <label class="link inline-block mt-4 cursor-pointer">Or use a key-dates file (.json) someone shared…
      <input type="file" accept=".json,application/json" data-file class="hidden"></label>`;
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-list]");
    if (b) { const l = lists[Number(b.dataset.list)]; $("#modal-title").textContent = l.title; pick(l); }
  });
  $("[data-file]", body).addEventListener("change", async (e) => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(data.items) || !data.items.length) throw new Error("That file has no dates in it");
      $("#modal-title").textContent = data.title || "Key dates";
      pick({ title: data.title || "Key dates", description: data.description, check: data.check, items: data.items });
    } catch (err) { toast(`Couldn't read that file: ${err.message}`, "error"); }
  });
  openModal("Import key dates", body);
}

function examCard(x, synced) {
  const pctDone = Math.min(100, (x.done_minutes / x.target_minutes) * 100);
  const pctPlanned = Math.min(100 - pctDone, (x.planned_minutes / x.target_minutes) * 100);
  const past = x.days < 0;
  return `<article class="card p-5 ${past ? "opacity-60" : ""}">
    <div class="flex items-start gap-3">
      <span class="w-1.5 self-stretch rounded-full" style="background:${examColor(x.id)}"></span>
      <div class="flex-1 min-w-0">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0"><h3 class="font-semibold text-slate-900 truncate">${esc(x.subject)}</h3>
            <p class="text-xs text-slate-500 mt-0.5">${fmt.short.format(parseLocal(x.date + "T00:00"))}${x.time ? ` · ${x.time}` : ""} · ${DIFFICULTY[x.difficulty]}</p></div>
          <div class="text-right shrink-0">${past ? `<span class="text-xs text-slate-400">Done</span>`
            : `<span class="display text-2xl font-semibold text-slate-900">${x.days}</span><span class="text-xs text-slate-500"> ${x.days === 1 ? "day" : "days"}</span>`}</div>
        </div>
        <div class="mt-3 h-2 rounded-full bg-slate-100 overflow-hidden flex" title="Done and planned hours">
          <div style="width:${pctDone}%;background:${examColor(x.id)}"></div>
          <div style="width:${pctPlanned}%;background:${examColor(x.id)};opacity:.3"></div></div>
        <div class="flex flex-wrap justify-between gap-x-3 gap-y-1 mt-2 text-xs text-slate-500">
          <span>${x.done_minutes ? `${duration(x.done_minutes)} done · ` : "Not started · "}${duration(x.planned_minutes)} planned of ${duration(x.target_minutes)}</span>
          <span class="flex gap-3"><button data-edit-exam="${x.id}" class="hover:text-slate-900">Edit</button>
            <button data-del-exam="${x.id}" class="hover:text-red-600">Delete</button></span>
        </div>
        ${!past && x.planned_minutes + x.done_minutes > x.target_minutes + 60 ? `<p class="text-xs text-slate-500 mt-2">More is planned than this exam needs now. Replan to update.</p>` : ""}
        ${x.short_minutes > 0 && !past ? `<p class="text-xs text-amber-700 mt-2">${duration(x.short_minutes)} doesn't fit before the exam. Allow more hours a day, or fewer days off.</p>` : ""}
      </div>
    </div></article>`;
}

function planList(sessions) {
  const upcoming = sessions.filter((s) => !s.past || s.status === "planned");
  if (!upcoming.length) return "";
  const byDay = new Map();
  for (const s of upcoming) {
    const k = s.start.slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }
  return [...byDay].slice(0, 21).map(([day, list]) => `
    <div class="flex gap-4 py-3 border-t border-slate-100 first:border-0">
      <div class="w-20 shrink-0"><p class="text-sm font-medium text-slate-900">${relDay(day)}</p>
        <p class="text-xs text-slate-400">${duration(list.reduce((a, s) => a + (parseLocal(s.end) - parseLocal(s.start)) / 60000, 0))}</p></div>
      <ul class="flex-1 min-w-0 space-y-1.5">${list.map((s) => `
        <li class="flex items-center gap-2.5 text-sm ${s.status !== "planned" ? "opacity-50" : ""}">
          <span class="w-2 h-2 rounded-full shrink-0" style="background:${examColor(s.exam_id)}"></span>
          <span class="tabular text-slate-500 w-[5.5rem] shrink-0">${hm(s.start)}–${hm(s.end)}</span>
          <span class="flex-1 min-w-0 truncate text-slate-800">${esc(s.subject)}${s.kind === "review" ? ` <span class="text-xs text-slate-400">review</span>` : ""}</span>
          ${s.status === "done" ? `<span class="text-xs text-emerald-600">Done</span>` : s.status === "missed" ? `<span class="text-xs text-slate-400">Missed</span>`
            : s.past ? sessionButtons(s.id)
            : s.start.slice(0, 10) === isoDay(new Date()) ? `<button data-focus="${s.id}" class="btn btn-primary !px-3 !py-1 text-xs shrink-0">Start</button>`
            : s.event_id ? `<span class="text-slate-400" title="In your calendar">${svg(ICON.check, "w-4 h-4")}</span>` : ""}
        </li>`).join("")}</ul>
    </div>`).join("");
}

function settingsForm(st) {
  const s = st.settings;
  return `
    <form data-study class="grid sm:grid-cols-2 gap-4">
      <div><label class="label">Most hours a day</label><input name="hours_per_day" inputmode="decimal" class="input" value="${s.hours_per_day}"></div>
      <div><label class="label">Session length</label><select name="session_minutes" class="input">
        ${[45, 60, 75, 90, 120].map((m) => `<option value="${m}" ${s.session_minutes === m ? "selected" : ""}>${duration(m)}</option>`).join("")}</select></div>
      <div><label class="label">Study between</label><div class="flex items-center gap-2">
        <input name="earliest" type="time" class="input" value="${s.earliest}"><span class="text-slate-400">–</span>
        <input name="latest" type="time" class="input" value="${s.latest}"></div></div>
      <div><label class="label">Break between things</label><select name="break_minutes" class="input">
        ${[0, 10, 15, 20, 30].map((m) => `<option value="${m}" ${s.break_minutes === m ? "selected" : ""}>${m ? `${m} min` : "None"}</option>`).join("")}</select></div>
      <div><label class="label">Alert before each session</label><select name="alert_minutes" class="input">
        ${[0, 5, 10, 15, 30].map((m) => `<option value="${m}" ${s.alert_minutes === m ? "selected" : ""}>${m ? `${m} min before` : "No alert"}</option>`).join("")}</select></div>
      <div class="sm:col-span-2"><label class="label">Days off</label><div class="flex flex-wrap gap-1.5" data-days>
        ${WEEKDAYS.map((d, i) => `<button type="button" data-day="${i}" class="chip !px-3 !py-1 ${s.days_off.includes(i) ? "bg-accent text-on-accent border-transparent" : "border-slate-200 text-slate-600"}">${d}</button>`).join("")}</div></div>
    </form>`;
}

async function viewRevision(root, params) {
  let st = await api("/api/revision");

  async function replan(quiet = false) {
    try {
      st = await api("/api/revision/plan", { method: "POST" });
      draw();
      if (!quiet) toast(st.settings.synced ? "Plan updated in your calendar" : `Planned ${plural(st.sessions.filter((s) => !s.past).length, "session", "sessions")}`);
    } catch (err) { toast(err.message, "error"); }
  }

  function draw() {
    state.sessions = st.sessions;
    const upcomingExams = st.exams.filter((x) => x.days >= 0);
    const hasPlan = st.sessions.some((s) => !s.past && s.status === "planned");
    const inCalendar = st.settings.synced;
    const totalPlanned = st.sessions.filter((s) => !s.past && s.status === "planned").reduce((a, s) => a + (parseLocal(s.end) - parseLocal(s.start)) / 60000, 0);
    if (!st.exams.length) {
      root.innerHTML = `
        <section class="hero card p-8 sm:p-10 text-center max-w-xl mx-auto">
          <span class="inline-flex w-12 h-12 rounded-2xl bg-accent text-on-accent items-center justify-center">${svg(ICON.book, "w-6 h-6")}</span>
          <h1 class="display text-3xl font-semibold text-slate-900 mt-4">Plan your revision</h1>
          <p class="text-sm text-slate-500 mt-2 mb-6">Add your exams. Today fits study sessions into the free time in your calendar,
            gives harder subjects more time, and adds a review the day before each exam.</p>
          <div class="flex flex-col sm:flex-row gap-2 justify-center">
            <button data-import class="btn btn-primary">Import your class's key dates</button>
            <button data-add-exam class="btn btn-secondary">Add an exam yourself</button></div>
        </section>`;
      $("[data-add-exam]", root).addEventListener("click", () => openExamForm(null, reload));
      $("[data-import]", root).addEventListener("click", () => openImport(reload));
      return;
    }
    root.innerHTML = `
      <div class="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div><p class="eyebrow">Revision</p>
          <h1 class="display text-3xl font-semibold text-slate-900 mt-1">${upcomingExams.length ? plural(upcomingExams.length, "exam", "exams") + " ahead" : "All exams done"}</h1></div>
        <div class="flex gap-2"><button data-import class="btn btn-ghost">Import key dates</button>
          <button data-add-exam class="btn btn-secondary">+ Add exam</button></div>
      </div>
      <div class="grid sm:grid-cols-2 gap-4">${st.exams.map((x) => examCard(x, inCalendar)).join("")}</div>

      <section class="card p-5 sm:p-6 mt-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div><h2 class="font-semibold text-slate-900">Your timetable</h2>
            <p class="text-sm text-slate-500 mt-0.5">${hasPlan ? `${duration(Math.round(totalPlanned))} of study planned${inCalendar ? ` · in your <b>${esc(st.calendar?.title || "calendar")}</b> calendar` : " · not in your calendar yet"}`
              : "Make a plan to see it here."}</p></div>
          <div class="flex flex-wrap gap-2">
            <button data-plan class="btn ${hasPlan ? "btn-secondary" : "btn-primary"}">${hasPlan ? "Replan" : "Make my plan"}</button>
            ${hasPlan && !inCalendar ? `<button data-sync class="btn btn-primary">Add to calendar</button>` : ""}
            ${inCalendar ? `<button data-unsync class="btn btn-ghost">Remove from calendar</button>` : ""}
          </div>
        </div>
        ${hasPlan && !inCalendar ? `<p class="text-xs text-slate-500 mt-3">Have a look first. Nothing goes into your calendar until you tap Add to calendar.</p>` : ""}
        ${inCalendar && st.calendar && !st.calendar.separate ? `<p class="text-xs text-slate-500 mt-3">Your calendar account doesn't allow new calendars from the Mac, so sessions are in “${esc(st.calendar.title)}”, marked 📚.</p>` : ""}
        <div class="mt-4">${planList(st.sessions)}</div>
      </section>

      <details class="card mt-4 group" ${params.get("open") === "prefs" ? "open" : ""}>
        <summary class="flex items-center justify-between px-5 py-4 cursor-pointer list-none">
          <span><span class="block font-medium text-slate-900">Study preferences</span>
            <span class="block text-sm text-slate-500">Up to ${st.settings.hours_per_day} h a day · ${st.settings.earliest}–${st.settings.latest}${st.settings.days_off.length ? ` · off ${st.settings.days_off.map((d) => WEEKDAYS[d]).join(", ")}` : ""}</span></span>
          <span data-chevron class="inline-block text-slate-400 text-xl transition-transform">›</span></summary>
        <div class="px-5 pb-5">${settingsForm(st)}
          <p class="text-xs text-slate-400 mt-3">Changes are used the next time you replan.</p></div>
      </details>`;

    $("[data-add-exam]", root).addEventListener("click", () => openExamForm(null, reload));
    $("[data-import]", root).addEventListener("click", () => openImport(reload));
    $("[data-plan]", root).addEventListener("click", () => replan());
    $("[data-sync]", root)?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { st = await api("/api/revision/calendar", { method: "POST" }); draw(); toast(`Added ${plural(st.added, "session", "sessions")} to your calendar`); }
      catch (err) { toast(err.message, "error"); e.target.disabled = false; }
    });
    $("[data-unsync]", root)?.addEventListener("click", async () => {
      st = await api("/api/revision/calendar", { method: "DELETE" });
      draw();
      toast(`Removed ${plural(st.removed, "session", "sessions")} from your calendar. The plan is still here.`);
    });
    const study = $("[data-study]", root);
    const saveStudy = async (body) => {
      try { st = await api("/api/revision/settings", { method: "PUT", body }); toast("Saved"); }
      catch (err) { toast(err.message, "error"); }
    };
    study.addEventListener("change", (e) => {
      const n = e.target.name;
      if (!n) return;
      const v = ["hours_per_day"].includes(n) ? Number(e.target.value.replace(",", ".")) : ["session_minutes", "break_minutes", "alert_minutes"].includes(n) ? Number(e.target.value) : e.target.value;
      saveStudy({ [n]: v });
    });
    $("[data-days]", root).addEventListener("click", async (e) => {
      const b = e.target.closest("[data-day]");
      if (!b) return;
      const d = Number(b.dataset.day);
      const off = st.settings.days_off.includes(d) ? st.settings.days_off.filter((x) => x !== d) : [...st.settings.days_off, d];
      await saveStudy({ days_off: off });
      draw();
      $("details", root).open = true;
    });
  }

  async function reload() { st = await api("/api/revision"); draw(); }

  root.addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-edit-exam]");
    const del = e.target.closest("[data-del-exam]");
    if (edit) openExamForm(st.exams.find((x) => x.id === Number(edit.dataset.editExam)), reload);
    if (del) {
      const x = st.exams.find((x) => x.id === Number(del.dataset.delExam));
      if (!confirm(`Delete ${x.subject}? Its upcoming sessions are removed too.`)) return;
      st = await api(`/api/revision/exams/${x.id}`, { method: "DELETE" });
      draw();
      toast(`Deleted ${x.subject}`);
    }
  });
  wireSessionButtons(root);
  wireFocusButtons(root);
  draw();
  if (params.get("replan")) replan();
}

/* ===========================================================================
   Settings
   ======================================================================== */

const THEME_ORDER = ["auto", "light", "dark", "sand", "ocean", "lavender", "rose", "noir"];
const themeLabel = (n) => n === "auto" ? "Automatic" : Theme.THEMES[n].label;

function themeSwatch(name) {
  const card = (t) => `<span class="flex-1 h-full p-1.5" style="background:#${t.neutral[0]}"><span class="block h-full rounded-md p-1.5" style="background:#${t.surface}">
    <span class="block h-1.5 w-8 rounded-full mb-1" style="background:#${t.neutral[3]}"></span><span class="block h-1.5 w-5 rounded-full" style="background:#${t.accent}"></span></span></span>`;
  const on = Theme.choice === name;
  return `<button type="button" data-theme-pick="${name}" class="text-left rounded-xl border-2 p-1 transition ${on ? "border-accent" : "border-transparent hover:border-slate-200"}">
    <span class="flex h-14 rounded-lg overflow-hidden border border-slate-200">${name === "auto" ? card(Theme.THEMES.light) + card(Theme.THEMES.dark) : card(Theme.THEMES[name])}</span>
    <span class="block text-sm text-center mt-1.5 ${on ? "font-medium text-slate-900" : "text-slate-600"}"
      style="${Theme.THEMES[name]?.display === "serif" ? "font-family:ui-serif,'New York',Georgia,serif" : ""}">${themeLabel(name)}</span></button>`;
}

async function sectionAppearance(el) {
  const draw = () => {
    el.innerHTML = `<div class="grid grid-cols-4 gap-2">${THEME_ORDER.map(themeSwatch).join("")}</div>`;
  };
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-theme-pick]");
    if (!b) return;
    Theme.set(b.dataset.themePick);
    draw();
    await savePrefs({ theme: Theme.choice });
  });
  draw();
}

async function sectionYou(el) {
  const p = state.prefs;
  el.innerHTML = `
    <div class="grid sm:grid-cols-2 gap-4">
      <div><label class="label">Your name <span class="font-normal text-slate-400">(for the greeting)</span></label>
        <input data-name class="input" maxlength="40" value="${esc(p.name || "")}" placeholder="Optional"></div>
      <div><label class="label">Weather for</label>
        <div class="relative"><input data-place class="input" value="${esc(p.place?.name || "Madrid")}" autocomplete="off">
          <div data-place-results class="hidden absolute z-10 mt-1 w-full card p-1"></div></div></div>
    </div>`;
  $("[data-name]", el).addEventListener("change", async (e) => { await savePrefs({ name: e.target.value }); toast("Saved"); });
  const results = $("[data-place-results]", el);
  let places = [];
  $("[data-place]", el).addEventListener("input", debounce(async (e) => {
    const q = e.target.value.trim();
    if (q.length < 2) { results.classList.add("hidden"); return; }
    try { places = await api(`/api/places?q=${encodeURIComponent(q)}`); } catch { places = []; }
    results.innerHTML = places.map((p, i) => `<button type="button" data-i="${i}" class="block w-full text-left rounded-lg px-3 py-2 text-sm hover:bg-slate-50">
      ${esc(p.name)} <span class="text-slate-400">${esc([p.admin, p.country].filter(Boolean).join(", "))}</span></button>`).join("") || `<p class="px-3 py-2 text-sm text-slate-400">No places found</p>`;
    results.classList.remove("hidden");
  }, 300));
  results.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    const p = places[Number(b.dataset.i)];
    $("[data-place]", el).value = p.name;
    results.classList.add("hidden");
    await savePrefs({ place: { name: p.name, lat: p.lat, lon: p.lon } });
    toast(`Weather for ${p.name}`);
  });
}

async function sectionCalendars(el) {
  const cals = await api("/api/calendars");
  el.innerHTML = `<p class="text-sm text-slate-500 mb-3">Choose which calendars appear in your day. Revision planning always avoids all of them.</p>
    <div class="divide-y divide-slate-100">${cals.map((c) => `<label class="flex items-center gap-3 py-2.5 cursor-pointer">
      <span class="w-3 h-3 rounded-full" style="background:${esc(c.color)}"></span>
      <span class="flex-1 text-sm text-slate-800">${esc(c.title)} <span class="text-slate-400">· ${esc(c.source)}</span></span>
      <input type="checkbox" data-cal="${esc(c.id)}" ${c.shown ? "checked" : ""} class="rounded border-slate-300"></label>`).join("")}</div>`;
  el.addEventListener("change", async () => {
    const hidden = $$("[data-cal]", el).filter((x) => !x.checked).map((x) => x.dataset.cal);
    await savePrefs({ hidden_calendars: hidden });
    toast("Saved");
  });
}

async function sectionGmail(el) {
  let cfg = await api("/api/gmail");
  const draw = () => {
    el.innerHTML = `
      <p class="text-sm text-slate-500 mb-3">Shows emails from your Primary inbox that look like they need a reply. Gmail is opened read-only;
        the app password stays in your Mac's Keychain.</p>
      <form data-gmail class="space-y-3" autocomplete="off">
        <div class="grid sm:grid-cols-2 gap-3">
          <div><label class="label">Gmail address</label><input name="address" type="email" class="input" value="${esc(cfg.address)}" placeholder="you@gmail.com"></div>
          <div><label class="label">App password</label><input name="password" type="password" class="input" autocomplete="new-password"
            placeholder="${cfg.has_password ? "Saved, type to replace" : "16-letter app password"}"></div>
        </div>
        <label class="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" name="enabled" ${cfg.enabled ? "checked" : ""} class="rounded border-slate-300"> Show emails in the brief</label>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-primary">Save</button>
          <button type="button" data-budget-pw class="btn btn-secondary">Use Budget's password</button>
          <button type="button" data-test class="btn btn-ghost">Test</button>
        </div>
        <p data-result class="hidden text-sm rounded-lg px-3 py-2"></p>
      </form>`;
    const f = $("[data-gmail]", el);
    const show = (ok, msg) => { const r = $("[data-result]", el); r.className = `text-sm rounded-lg px-3 py-2 ${ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`; r.textContent = msg; };
    const save = async (extra = {}) => {
      cfg = await api("/api/gmail", { method: "PUT", body: { address: f.address.value.trim(), enabled: f.enabled.checked, password: f.password.value || null, ...extra } });
    };
    f.addEventListener("submit", async (e) => { e.preventDefault(); try { await save(); draw(); toast("Saved"); } catch (err) { show(false, err.message); } });
    $("[data-budget-pw]", el).addEventListener("click", async () => {
      try { await save({ use_budget_password: true, password: null }); draw(); toast("Using Budget's app password"); }
      catch (err) { show(false, err.message); }
    });
    $("[data-test]", el).addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Testing…";
      try { const r = await api("/api/gmail/test", { method: "POST" }); show(r.ok, r.message); }
      catch (err) { show(false, err.message); }
      finally { e.target.disabled = false; e.target.textContent = "Test"; }
    });
  };
  draw();
}

const SECTION_INFO = {
  top3: ["Top 3 for today", "Three things you want to get done, ticked off as you go"],
  coming_up: ["Coming up", "Exams and deadlines in the next two weeks"],
  todo: ["To do", "Reminders due today and tomorrow"],
  birthdays: ["Birthdays", "From your Birthdays calendar, the coming week"],
  email: ["Needs a reply", "Gmail emails waiting for an answer"],
  money: ["Money", "What's left this month, from Budget"],
  leave_by: ["Leave-by time", "When to set off for your first event with a place"],
  evening: ["Evening mode", "After 19:00, show tomorrow instead of today"],
};
const FEATURE_IDS = ["leave_by", "evening"];

async function sectionSections(el) {
  const draw = () => {
    const secs = state.prefs.sections;
    const cards = secs.filter((s) => !FEATURE_IDS.includes(s.id));
    const toggle = (s) => `<button type="button" role="switch" aria-checked="${s.on}" data-toggle="${s.id}"
      class="relative w-10 h-6 rounded-full shrink-0 transition ${s.on ? "bg-accent" : "bg-slate-200"}">
      <span class="absolute top-0.5 ${s.on ? "left-[1.125rem]" : "left-0.5"} w-5 h-5 rounded-full bg-white shadow transition-all"></span></button>`;
    el.innerHTML = `
      <p class="text-sm text-slate-500 mb-2">Cards next to your day, in this order. Switch off what you don't need.</p>
      <div class="divide-y divide-slate-100">${cards.map((s, i) => `
        <div class="flex items-center gap-3 py-2.5 ${s.on ? "" : "opacity-60"}">
          <div class="flex-1 min-w-0"><p class="text-sm font-medium text-slate-900">${SECTION_INFO[s.id][0]}</p>
            <p class="text-xs text-slate-500">${SECTION_INFO[s.id][1]}</p></div>
          <button data-move="${s.id}" data-dir="-1" class="btn btn-ghost !px-2" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button data-move="${s.id}" data-dir="1" class="btn btn-ghost !px-2" ${i === cards.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          ${toggle(s)}</div>`).join("")}</div>
      <p class="text-sm text-slate-500 mt-5 mb-2">Extras</p>
      <div class="divide-y divide-slate-100">${secs.filter((s) => FEATURE_IDS.includes(s.id)).map((s) => `
        <div class="flex items-center gap-3 py-2.5">
          <div class="flex-1 min-w-0"><p class="text-sm font-medium text-slate-900">${SECTION_INFO[s.id][0]}</p>
            <p class="text-xs text-slate-500">${SECTION_INFO[s.id][1]}</p>
            ${s.id === "leave_by" && s.on ? `<label class="mt-2 flex items-center gap-2 text-xs text-slate-600">Travel time
              <input data-travel inputmode="numeric" class="input !w-16 !py-1 text-right" value="${state.prefs.travel_minutes}"> min</label>` : ""}</div>
          ${toggle(s)}</div>`).join("")}</div>`;
  };
  const save = async (sections) => { await savePrefs({ sections }); draw(); };
  el.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-toggle]");
    const m = e.target.closest("[data-move]");
    if (t) await save(state.prefs.sections.map((s) => s.id === t.dataset.toggle ? { ...s, on: !s.on } : s));
    if (m) {
      const list = [...state.prefs.sections];
      const cards = list.filter((s) => !FEATURE_IDS.includes(s.id));
      const i = cards.findIndex((s) => s.id === m.dataset.move), j = i + Number(m.dataset.dir);
      [cards[i], cards[j]] = [cards[j], cards[i]];
      await save([...cards, ...list.filter((s) => FEATURE_IDS.includes(s.id))]);
    }
  });
  el.addEventListener("change", async (e) => {
    if (!e.target.matches("[data-travel]")) return;
    const v = Math.max(0, Math.min(180, parseInt(e.target.value, 10) || 0));
    await savePrefs({ travel_minutes: v });
    toast(`Leave-by uses ${v} min of travel`);
    draw();
  });
  draw();
}

async function sectionMorning(el) {
  let m = await api("/api/morning");
  const draw = () => {
    el.innerHTML = `
      <p class="text-sm text-slate-500 mb-3">Your Mac opens Today by itself at this time, so the brief is waiting when you sit down.
        If Today is already open, it just comes to the front.</p>
      <form data-morning class="space-y-3">
        <label class="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" name="enabled" ${m.enabled ? "checked" : ""} class="rounded border-slate-300">
          Open Today every <select name="weekdays_only" class="input !w-auto !py-1 !px-2 inline-block">
            <option value="1" ${m.weekdays_only ? "selected" : ""}>weekday</option><option value="0" ${m.weekdays_only ? "" : "selected"}>day</option></select>
          at <input name="time" type="time" class="input !w-auto !py-1 !px-2 inline-block" value="${m.time}"></label>
        <label class="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" name="at_login" ${m.at_login ? "checked" : ""} class="rounded border-slate-300">
          Also open it when I log in</label>
      </form>`;
  };
  el.addEventListener("change", async () => {
    const f = $("[data-morning]", el);
    try {
      m = await api("/api/morning", { method: "PUT", body: { enabled: f.enabled.checked, time: f.time.value || "08:00",
        weekdays_only: f.weekdays_only.value === "1", at_login: f.at_login.checked } });
      toast(m.enabled ? `Today will open at ${m.time}` : "Turned off");
      $('[data-section="morning"] [data-summary]')?.replaceChildren(document.createTextNode(m.enabled ? `${m.weekdays_only ? "Weekdays" : "Every day"} at ${m.time}` : "Off"));
    } catch (err) { toast(err.message, "error"); }
  });
  draw();
}

async function viewSettings(root, params) {
  const sections = [
    { id: "appearance", title: "Appearance", summary: () => themeLabel(Theme.choice), init: sectionAppearance },
    { id: "sections", title: "Sections", summary: () => `${state.prefs.sections?.filter((s) => s.on).length || 0} of ${state.prefs.sections?.length || 0} on`, init: sectionSections },
    { id: "you", title: "You and the weather", summary: () => [state.prefs.name, state.prefs.place?.name].filter(Boolean).join(" · "), init: sectionYou },
    { id: "calendars", title: "Calendars", summary: () => state.prefs.hidden_calendars?.length ? `${state.prefs.hidden_calendars.length} hidden` : "All shown", init: sectionCalendars },
    { id: "morning", title: "Every morning", summary: () => "", init: sectionMorning },
    { id: "gmail", title: "Gmail", summary: () => "", init: sectionGmail },
  ];
  root.innerHTML = `<div class="max-w-2xl mx-auto"><h1 class="display text-3xl font-semibold text-slate-900 mb-5">Settings</h1>
    <div class="card divide-y divide-slate-100 overflow-hidden">${sections.map((s) => `
      <details data-section="${s.id}">
        <summary class="flex items-center gap-3 px-5 py-4 cursor-pointer list-none hover:bg-slate-50">
          <span class="flex-1 min-w-0"><span class="block font-medium text-slate-900">${s.title}</span>
            <span data-summary class="block text-sm text-slate-500 truncate">${esc(s.summary())}</span></span>
          <span data-chevron class="inline-block text-slate-400 text-xl leading-none transition-transform">›</span></summary>
        <div data-body class="px-5 pb-5 pt-1"></div></details>`).join("")}</div>
    <p class="text-xs text-slate-400 mt-4 px-1">Your data stays on this Mac in <code>${esc((state.status.data_dir || "").replace(/^\/Users\/[^/]+/, "~"))}</code>.</p></div>`;
  for (const s of sections) {
    const d = $(`[data-section="${s.id}"]`, root);
    d.addEventListener("toggle", async () => {
      if (!d.open || d.dataset.ready) return;
      d.dataset.ready = "1";
      try { await s.init($("[data-body]", d)); } catch (err) { $("[data-body]", d).innerHTML = `<p class="text-sm text-red-600">${esc(err.message)}</p>`; }
    });
  }
  api("/api/morning").then((m) => { $('[data-section="morning"] [data-summary]', root).textContent = m.enabled ? `${m.weekdays_only ? "Weekdays" : "Every day"} at ${m.time}` : "Off"; }).catch(() => {});
  api("/api/gmail").then((g) => { $('[data-section="gmail"] [data-summary]', root).textContent = g.enabled && g.address ? `On · ${g.address}` : "Off"; }).catch(() => {});
  const open = params.get("open");
  if (open) $(`[data-section="${open}"]`, root)?.setAttribute("open", "");
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ===========================================================================
   Router
   ======================================================================== */

const NAV = [
  { route: "today", label: "Today", icon: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2"/>` },
  { route: "revision", label: "Revision", icon: ICON.book },
  { route: "settings", label: "Settings", icon: `<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>` },
];
const VIEWS = { today: viewToday, revision: viewRevision, settings: viewSettings };

function buildNav() {
  $("#top-nav").innerHTML = NAV.map((n) => `<a href="#/${n.route}" data-route="${n.route}" class="nav-link rounded-lg px-3 py-1.5 hover:text-slate-900">${n.label}</a>`).join("");
  $("#bottom-nav").innerHTML = NAV.map((n) => `<a href="#/${n.route}" data-route="${n.route}" class="bottom-link flex flex-col items-center gap-0.5 py-2">${svg(n.icon, "w-6 h-6")}${n.label}</a>`).join("");
}

function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, "").split("?");
  return { route: VIEWS[path] ? path : "today", params: new URLSearchParams(qs || "") };
}

async function render() {
  const token = ++state.renderToken;
  const { route, params } = parseHash();
  $$("[data-route]").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
  closeModal();
  const root = $("#view");
  // Build the page off-screen, then swap it in, so a refresh never flashes empty.
  const fresh = document.createElement("div");
  try {
    await VIEWS[route](fresh, params);
    if (token !== state.renderToken) return;
    root.replaceChildren(fresh);
  } catch (err) {
    if (token !== state.renderToken) return;
    root.innerHTML = `<div class="card p-6 text-red-600">Something went wrong: ${esc(err.message)}</div>`;
  }
}

window.addEventListener("hashchange", render);
// Keep the brief fresh: every 5 minutes, and whenever the window comes back.
setInterval(() => { if (parseHash().route === "today" && $("#modal").classList.contains("hidden") && !focus.session && !document.activeElement?.matches("input")) render(); }, 5 * 60 * 1000);
window.addEventListener("focus", () => { if (parseHash().route === "today" && Date.now() - (state.lastFocus || 0) > 60000) { state.lastFocus = Date.now(); render(); } });

(async function start() {
  buildNav();
  try {
    [state.prefs, state.status] = await Promise.all([api("/api/prefs"), api("/api/status")]);
    if (state.prefs.theme && state.prefs.theme !== Theme.choice) Theme.set(state.prefs.theme);
    $("#demo-badge").classList.toggle("hidden", !state.status.demo);
  } catch { /* first launch hiccup; the view shows any real error */ }
  render();
})();
