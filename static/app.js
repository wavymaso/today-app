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
  // A compact row on phones; a large temperature on wider screens.
  return `
    <div class="flex sm:block items-center gap-4">
      <div class="flex items-center sm:justify-end gap-3">
        <span class="text-slate-400">${svg(ICON[w.icon] || ICON.cloud, "w-7 h-7 sm:w-8 sm:h-8")}</span>
        <span class="display text-4xl sm:text-5xl font-semibold text-slate-900 leading-none tabular">${w.temp}°</span>
      </div>
      <div class="sm:mt-2">
        <p class="text-sm text-slate-500">${isTomorrow ? "Tomorrow · " : ""}${esc(w.label)} · ${w.high}° / ${w.low}°</p>
        <p class="text-xs text-slate-400 mt-0.5">${esc(w.place)}</p></div>
    </div>`;
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
    const sess = isSession ? (state.sessions || []).find((x) => x.id === e.session_id) : null;
    const dot = sess ? examColor(sess.exam_id) : e.color;
    rows.push(`<div class="relative flex gap-4 py-2.5 pl-1 ${e.past ? "opacity-50" : ""}">
      <span class="w-14 shrink-0 text-right tabular text-xs text-slate-500 pt-0.5 leading-tight">${hm(e.start)}<br><span class="text-slate-400">${hm(e.end)}</span></span>
      <span class="tl-dot" style="background:${esc(dot)}"></span>
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
  return `<ul class="space-y-3.5">${items.slice(0, 6).map((i) => {
    const color = i.exam_id ? examColor(i.exam_id) : i.color || "rgb(var(--slate-400))";
    return `<li class="grid grid-cols-[2.75rem_1fr] items-center gap-3">
      <span class="text-center">
        <span class="display block text-2xl font-semibold leading-none tabular ${i.days <= 3 ? "text-accent" : "text-slate-900"}">${i.days}</span>
        <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400 mt-1">${i.days === 1 ? "day" : "days"}</span></span>
      <span class="min-w-0">
        <span class="flex items-center gap-2"><span class="w-2 h-2 rounded-full shrink-0" style="background:${color}"></span>
          <span class="text-sm font-medium text-slate-900 truncate">${esc(i.title)}</span></span>
        <span class="block text-xs text-slate-500 pl-4 mt-0.5">${relDay(i.date)}${i.time ? ` · ${i.time}` : ""}</span></span>
    </li>`;
  }).join("")}</ul>`;
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
  const big = b.left_cents == null ? money(b.spent_cents) : money(Math.abs(b.left_cents));
  const line = b.left_cents == null ? "spent this month" : b.left_cents < 0 ? "over budget this month" : `left this month · about ${money(b.per_day_cents)} a day`;
  return `<section class="py-6 border-t border-slate-200 first:border-t-0 first:pt-1">
    <div class="flex items-center justify-between mb-3"><h2 class="eyebrow">Money</h2>
      ${window.pywebview?.api?.open_budget ? `<button data-open-budget class="link text-xs">Open Budget</button>` : ""}</div>
    <p class="display text-3xl font-semibold tabular ${b.left_cents < 0 ? "text-red-600" : "text-slate-900"}">${big}</p>
    <p class="text-sm text-slate-500 mt-1">${line}</p></section>`;
}

function top3Block(t, isTomorrow) {
  if (t.error) return `<p class="text-sm text-slate-400">${esc(t.error)}</p>`;
  return `<form data-top3 data-date="${t.date}" class="space-y-2">
    ${t.items.map((i) => `<label class="flex items-center gap-2.5">
      <input type="checkbox" data-done="${i.position}" ${i.done ? "checked" : ""} ${i.text ? "" : "disabled"} class="w-4 h-4 rounded-full border-slate-300 shrink-0">
      <input data-text="${i.position}" value="${esc(i.text)}" maxlength="120" placeholder="${["", "The one thing that matters most", "Second", "Third"][i.position]}"
        class="flex-1 min-w-0 bg-transparent border-0 border-b border-transparent focus:border-slate-200 focus:outline-none text-sm py-1 ${i.done ? "line-through text-slate-400" : "text-slate-800"} placeholder:text-slate-400"></label>`).join("")}
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

function note(icon, html, strong = false) {
  return `<p class="flex items-center gap-2 text-sm ${strong ? "text-slate-900 font-medium" : "text-slate-600"}">
    <span class="${strong ? "text-accent" : "text-slate-400"}">${svg(icon, "w-4 h-4")}</span>${html}</p>`;
}

function leaveByLine(lb, isTomorrow) {
  if (!lb) return "";
  const soon = !isTomorrow && lb.minutes_until <= 15;
  const when = isTomorrow ? "" : lb.minutes_until <= 0 ? " · leave now" : lb.minutes_until < 120 ? ` · in ${duration(lb.minutes_until)}` : "";
  return note(ICON.pin, `Leave by <b class="font-semibold text-slate-900 tabular">${hm(lb.leave)}</b>${isTomorrow ? " tomorrow" : ""} for ${esc(lb.title)}${when}`, soon);
}

function sideCard(id, b, isTomorrow) {
  const card = (title, body, extra = "") => `<section class="py-6 border-t border-slate-200 first:border-t-0 first:pt-1">
    <div class="flex items-center justify-between mb-4"><h2 class="eyebrow">${title}</h2>${extra}</div>${body}</section>`;
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
  if (rev) assignCourseColors(rev.exams);
  const umbrella = b.weather?.advice;
  root.innerHTML = `
    <header class="grid sm:grid-cols-[1fr_auto] gap-8 items-end pt-2">
      <div class="min-w-0">
        <p class="eyebrow">${isTomorrow ? `Tomorrow · ${esc(fmt.long.format(target))}` : esc(fmt.long.format(now))}</p>
        <h1 class="display text-5xl sm:text-6xl font-semibold text-slate-900 mt-3 leading-[1.02]">${esc(b.greeting)}.</h1>
        <p class="text-slate-600 mt-4 leading-relaxed max-w-2xl">${isTomorrow ? "Here's tomorrow. " : ""}${summaryLine(b, todaySessions)}</p>
        ${b.day?.leave_by || umbrella ? `<div class="mt-4 space-y-1.5">${leaveByLine(b.day?.leave_by, isTomorrow)}${umbrella ? note(ICON.umbrella, esc(umbrella)) : ""}</div>` : ""}
        ${b.evening_available && now.getHours() >= 19 ? `<a href="#/today?view=${isTomorrow ? "today" : "tomorrow"}" class="link inline-block mt-4 underline underline-offset-4 decoration-slate-300">${isTomorrow ? "Show today instead" : "Show tomorrow"}</a>` : ""}
      </div>
      <div class="sm:text-right">${weatherBlock(b.weather, isTomorrow)}</div>
    </header>

    ${toCheck.length ? `<section class="mt-8 py-4 border-y border-slate-200">
      <h2 class="eyebrow mb-3">How did revision go?</h2>
      <ul class="space-y-2">${toCheck.slice(-4).map((s) => `<li class="flex items-center gap-3 text-sm">
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${examColor(s.exam_id)}"></span>
        <span class="flex-1 min-w-0 text-slate-800 truncate">${esc(s.subject)}${s.kind === "review" ? " review" : ""}
          <span class="text-slate-400">· ${relDay(s.start)} ${hm(s.start)}–${hm(s.end)}</span></span>${sessionButtons(s.id)}</li>`).join("")}</ul>
    </section>` : ""}

    <div class="grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-x-14 gap-y-4 mt-10">
      <section>
        <div class="flex items-baseline justify-between pb-3 mb-2 border-b border-slate-200">
          <h2 class="eyebrow">${isTomorrow ? "Tomorrow" : "Your day"}</h2>
          ${b.day.events ? `<span class="text-xs text-slate-400">${plural(b.day.events.filter((e) => !e.all_day).length, "event", "events")}</span>` : ""}
        </div>
        ${timeline(b.day, b.now, isTomorrow)}
        ${todaySessions.length ? `<p class="text-xs text-slate-500 mt-3">${plural(todaySessions.length, "revision session", "revision sessions")} planned today (not in your calendar yet). <a href="#/revision" class="underline">See plan</a></p>` : ""}
      </section>
      <aside class="lg:border-l lg:border-slate-200 lg:pl-10 border-t border-slate-200 pt-4 lg:border-t-0 lg:pt-0">
        ${b.sections.filter((s) => s.on).map((s) => sideCard(s.id, b, isTomorrow)).join("")}
      </aside>
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

/* --- Course colours ----------------------------------------------------------
   One colour per course, so a course's midterm, final and sessions match. The
   eight hues are a palette checked for colour-blind readers, with their own
   steps for dark themes; they always sit next to the course name. */
const COURSE_HUES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
const DIFFICULTY = { 1: "Easy", 2: "Medium", 3: "Hard" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const courseOf = (x) => x.course || x.subject;
const palette = { byCourse: new Map() };

/** Courses get colours in the order they were added, and keep them. */
function assignCourseColors(exams) {
  const hues = COURSE_HUES[document.documentElement.dataset.mode === "dark" ? "dark" : "light"];
  palette.byCourse = new Map();
  for (const x of [...exams].sort((a, b) => a.id - b.id)) {
    const c = courseOf(x);
    if (!palette.byCourse.has(c)) palette.byCourse.set(c, hues[palette.byCourse.size % hues.length]);
  }
  palette.byExam = new Map(exams.map((x) => [x.id, palette.byCourse.get(courseOf(x))]));
}
const examColor = (id) => palette.byExam?.get(id) || "rgb(var(--slate-400))";

const monthLong = new Intl.DateTimeFormat("en-GB", { month: "long" });
const monthShortFmt = new Intl.DateTimeFormat("en-GB", { month: "short" });
const dayDiff = (a, b) => Math.round((parseLocal(b + "T00:00") - parseLocal(a + "T00:00")) / 86400000);
const sessionMinutes = (s) => Math.round((parseLocal(s.end) - parseLocal(s.start)) / 60000);
const countdown = (days) => days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;

function examForm(exam = null) {
  const f = document.createElement("form");
  f.className = "space-y-4";
  f.innerHTML = `
    <div class="grid sm:grid-cols-2 gap-3">
      <div><label class="label">What</label><input name="subject" class="input" maxlength="60" placeholder="e.g. Statistics midterm" value="${esc(exam?.subject || "")}" required></div>
      <div><label class="label">Course <span class="font-normal text-slate-400">(groups its exams)</span></label><input name="course" class="input" maxlength="80" placeholder="e.g. Statistics" value="${esc(exam?.course || "")}"></div>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <div><label class="label">Date</label><input name="date" type="date" class="input" value="${exam?.date || ""}" required></div>
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
    ${exam?.notes ? `<p class="text-xs text-slate-500 leading-relaxed border-l-2 border-slate-200 pl-3">${esc(exam.notes)}</p>` : ""}
    <div class="flex gap-2">
      <button class="btn btn-primary flex-1 py-2.5">${exam ? "Save" : "Add exam"}</button>
      ${exam ? `<button type="button" data-delete class="btn btn-ghost text-red-600 hover:bg-red-50">Delete</button>` : ""}
    </div>`;
  $("[data-diff]", f).addEventListener("click", (e) => {
    const b = e.target.closest("[data-d]");
    if (!b) return;
    f.difficulty.value = b.dataset.d;
    $$("[data-d]", f).forEach((x) => { const on = x === b; x.classList.toggle("border-accent", on); x.classList.toggle("bg-accent/10", on); x.classList.toggle("text-slate-900", on); x.classList.toggle("border-slate-200", !on); x.classList.toggle("text-slate-600", !on); });
  });
  f.values = () => ({ subject: f.subject.value.trim(), course: f.course.value.trim() || null, date: f.date.value, time: f.time.value || null,
                      difficulty: Number(f.difficulty.value), hours: f.hours.value ? Number(f.hours.value.replace(",", ".")) : (exam ? 0 : null) });
  return f;
}

function openExamForm(exam, after) {
  const f = examForm(exam);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = f.values();
    if (!v.subject || !v.date) return toast("Add what it is and the date", "error");
    try {
      await api(exam ? `/api/revision/exams/${exam.id}` : "/api/revision/exams", { method: exam ? "PATCH" : "POST", body: v });
      closeModal();
      toast(exam ? "Saved. Replan to use the change." : `Added ${v.subject}`);
      after();
    } catch (err) { toast(err.message, "error"); }
  });
  $("[data-delete]", f)?.addEventListener("click", async (e) => {
    if (e.target.dataset.armed !== "1") { e.target.dataset.armed = "1"; e.target.textContent = "Tap again to delete"; return; }
    await api(`/api/revision/exams/${exam.id}`, { method: "DELETE" });
    closeModal();
    toast(`Deleted ${exam.subject}`);
    after();
  });
  openModal(exam ? exam.subject : "Add an exam", f);
  if (!exam) setTimeout(() => f.subject.focus(), 50);
}

/* --- The semester runway: one line from today to the last exam -------------- */

function runway(exams, todayIso) {
  const ahead = exams.filter((x) => x.date >= todayIso).sort((a, b) => a.date.localeCompare(b.date));
  if (!ahead.length) return "";
  const last = ahead.at(-1).date;
  const span = Math.max(14, dayDiff(todayIso, last));
  const x = (iso) => 3 + (dayDiff(todayIso, iso) / span) * 94;             // keep 3% breathing room each side
  // Exams close together share one label ("6 exams · 10–18 Dec").
  const groups = [];
  for (const e of ahead) {
    const g = groups.at(-1);
    if (g && x(e.date) - x(g.items[0].date) < 7) g.items.push(e);
    else groups.push({ items: [e] });
  }
  const ticks = [];
  const d = parseLocal(todayIso + "T00:00");
  for (let m = new Date(d.getFullYear(), d.getMonth() + 1, 1); isoDay(m) <= last; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) ticks.push(isoDay(m));
  let row = 0;
  const labels = groups.map((g) => {
    const a = g.items[0], b = g.items.at(-1);
    const left = (x(a.date) + x(b.date)) / 2;
    const text = g.items.length === 1 ? a.subject
      : `${g.items.length} exams · ${parseLocal(a.date + "T00:00").getDate()}–${parseLocal(b.date + "T00:00").getDate()} ${monthShortFmt.format(parseLocal(b.date + "T00:00"))}`;
    const anchor = left > 82 ? "right" : left < 14 ? "left" : "center";
    row = 1 - row;
    const pos = anchor === "right" ? `right:${100 - left}%;transform:translateX(50%)` : anchor === "left" ? `left:${left}%;transform:translateX(-12px)` : `left:${left}%;transform:translateX(-50%)`;
    return `<span class="hidden sm:inline absolute ${row ? "top-[18px]" : "top-[34px]"} whitespace-nowrap text-[12px] ${g.items.length > 1 ? "font-semibold text-slate-900" : "text-slate-600"}" style="${pos}">${esc(text)}</span>
      <span class="hidden sm:block absolute w-px bg-slate-300" style="left:${left}%;top:${row ? 36 : 52}px;height:${row ? 22 : 6}px"></span>`;
  }).join("");
  return `<section class="mt-10" aria-label="Exams from today to ${esc(fmt.dayMonth.format(parseLocal(last + "T00:00")))}">
    <div class="relative h-[104px] -mt-12 sm:mt-0 select-none">
      <span class="absolute left-0 right-0 top-[64px] h-px bg-slate-300"></span>
      ${ticks.map((t) => `<span class="absolute top-[60px] h-[9px] w-px bg-slate-300" style="left:${x(t)}%"></span>
        <span class="absolute top-[78px] text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400" style="left:${x(t)}%;transform:translateX(-50%)">${monthShortFmt.format(parseLocal(t + "T00:00"))}</span>`).join("")}
      ${labels}
      <span class="absolute top-[59px] w-[11px] h-[11px] rounded-full bg-accent" style="left:${x(todayIso)}%;transform:translateX(-50%)"></span>
      <span class="absolute top-[78px] text-[10px] font-semibold uppercase tracking-[0.16em] text-accent" style="left:${x(todayIso)}%;transform:translateX(-30%)">Today</span>
      ${ahead.map((e) => `<span title="${esc(e.subject)} · ${esc(fmt.short.format(parseLocal(e.date + "T00:00")))}" class="absolute top-[60px] w-[9px] h-[9px] rounded-full ring-2 ring-slate-50"
        style="left:${x(e.date)}%;transform:translateX(-50%);background:${examColor(e.id)}"></span>`).join("")}
    </div>
  </section>`;
}

/* --- Exams, as an editorial list grouped by month -------------------------- */

function examRow(x) {
  const date = parseLocal(x.date + "T00:00");
  const color = examColor(x.id);
  const weight = (x.notes || "").match(/^(\d+%)/)?.[1];
  const pctDone = Math.min(100, (x.done_minutes / x.target_minutes) * 100);
  const pctPlanned = Math.min(100 - pctDone, (x.planned_minutes / x.target_minutes) * 100);
  const meta = [x.course && x.course !== x.subject ? x.course : null, x.time, DIFFICULTY[x.difficulty]].filter(Boolean);
  const over = x.planned_minutes + x.done_minutes > x.target_minutes + 60;
  return `<li><button data-exam="${x.id}" class="group w-full grid grid-cols-[3.25rem_1fr_auto] gap-x-4 items-center text-left py-4 border-b border-slate-200/70 hover:bg-slate-100/60 -mx-3 px-3 rounded-xl transition">
    <span class="text-center">
      <span class="display block text-[2rem] font-semibold leading-none text-slate-900">${date.getDate()}</span>
      <span class="block text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400 mt-1.5">${WEEKDAYS[(date.getDay() + 6) % 7]}</span></span>
    <span class="min-w-0">
      <span class="flex items-center gap-2"><span class="w-2 h-2 rounded-full shrink-0" style="background:${color}"></span>
        <span class="font-medium text-slate-900 truncate">${esc(x.subject)}</span>
        ${weight ? `<span class="text-[11px] tabular text-slate-500 border border-slate-200 rounded-full px-1.5 leading-[18px] shrink-0">${weight}</span>` : ""}</span>
      <span class="block text-xs text-slate-500 truncate mt-1 pl-4">${esc(meta.join(" · "))}</span>
      <span class="mt-2.5 ml-4 h-[3px] rounded-full bg-slate-200/80 overflow-hidden flex max-w-[16rem]">
        <span style="width:${pctDone}%;background:${color}"></span><span style="width:${pctPlanned}%;background:${color};opacity:.35"></span></span>
      ${x.short_minutes > 0 ? `<span class="block text-xs text-amber-700 mt-1.5 pl-4">${duration(x.short_minutes)} doesn't fit yet: allow more hours a day</span>`
        : over ? `<span class="block text-xs text-slate-500 mt-1.5 pl-4">More planned than it needs now. Replan to update.</span>` : ""}
    </span>
    <span class="text-right">
      <span class="block text-sm text-slate-900 tabular whitespace-nowrap">${x.days === 0 ? "Today" : x.days === 1 ? "Tomorrow" : `${x.days} days`}</span>
      <span class="block text-xs text-slate-400 tabular whitespace-nowrap mt-0.5">${duration(x.target_minutes)}${x.done_minutes ? ` · ${duration(x.done_minutes)} done` : ""}</span></span>
  </button></li>`;
}

function examList(exams) {
  const ahead = exams.filter((x) => x.days >= 0);
  const past = exams.filter((x) => x.days < 0);
  const months = new Map();
  for (const x of ahead) {
    const k = x.date.slice(0, 7);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(x);
  }
  return `${[...months].map(([k, list]) => `
    <div class="mt-8 first:mt-2">
      <h3 class="flex items-baseline gap-3 mb-1"><span class="display text-2xl font-semibold text-slate-900">${monthLong.format(parseLocal(k + "-01T00:00"))}</span>
        <span class="text-xs text-slate-400">${plural(list.length, "exam", "exams")}</span></h3>
      <ol>${list.map(examRow).join("")}</ol>
    </div>`).join("")}
    ${past.length ? `<details class="mt-6"><summary class="cursor-pointer list-none link inline-flex items-center gap-1"><span data-chevron class="inline-block transition-transform">›</span> ${plural(past.length, "exam", "exams")} done</summary>
      <ol class="opacity-60 mt-2">${past.map(examRow).join("")}</ol></details>` : ""}`;
}

/* --- The timetable, week by week ---------------------------------------------- */

function weekTimetable(st, weeksShown) {
  const todayIso = isoDay(new Date());
  const items = st.sessions.filter((s) => s.start.slice(0, 10) >= todayIso || s.status === "planned");
  if (!items.length) return "";
  const monday = (iso) => { const d = parseLocal(iso + "T00:00"); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDay(d); };
  const lastIso = [...items.map((s) => s.start.slice(0, 10)), ...st.exams.filter((x) => x.days >= 0).map((x) => x.date)].sort().at(-1);
  const weeks = [];
  for (let w = monday(todayIso); w <= lastIso; ) {
    weeks.push(w);
    const d = parseLocal(w + "T00:00"); d.setDate(d.getDate() + 7); w = isoDay(d);
  }
  const examsOn = (iso) => st.exams.filter((x) => x.date === iso);
  const sessOn = (iso) => items.filter((s) => s.start.slice(0, 10) === iso);
  const chip = (s) => {
    const c = examColor(s.exam_id);
    const state = s.status === "done" ? "opacity-50 line-through" : s.status === "missed" ? "opacity-40" : "";
    return `<button data-sess="${s.id}" class="block w-full text-left rounded-md pl-2.5 pr-1.5 py-1.5 transition hover:brightness-95 ${state}"
        style="background:color-mix(in srgb, ${c} 13%, transparent);box-shadow:inset 2.5px 0 0 ${c}">
      <span class="block text-[11px] tabular text-slate-500 leading-tight">${hm(s.start)} <span class="text-slate-400">· ${duration(sessionMinutes(s))}</span></span>
      <span class="block text-[12px] font-medium text-slate-900 leading-snug line-clamp-2">${esc(s.subject)}</span>
      ${s.kind === "review" ? `<span class="block text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">Review</span>` : ""}</button>`;
  };
  const examChip = (x) => `<button data-exam="${x.id}" class="block w-full text-left rounded-md px-2 py-1.5 border-[1.5px] bg-surface" style="border-color:${examColor(x.id)}">
      <span class="block text-[10px] font-bold uppercase tracking-[0.14em]" style="color:${examColor(x.id)}">Exam${x.time ? ` · ${x.time}` : ""}</span>
      <span class="block text-[12px] font-semibold text-slate-900 leading-snug line-clamp-2">${esc(x.subject)}</span></button>`;

  return weeks.slice(0, weeksShown).map((w) => {
    const days = [...Array(7)].map((_, i) => { const d = parseLocal(w + "T00:00"); d.setDate(d.getDate() + i); return isoDay(d); });
    const mins = days.flatMap(sessOn).filter((s) => s.status !== "missed").reduce((a, s) => a + sessionMinutes(s), 0);
    const first = parseLocal(days[0] + "T00:00"), last = parseLocal(days[6] + "T00:00");
    const range = first.getMonth() === last.getMonth() ? `${first.getDate()} – ${last.getDate()} ${monthLong.format(last)}`
      : `${first.getDate()} ${monthShortFmt.format(first)} – ${last.getDate()} ${monthShortFmt.format(last)}`;
    const nExams = days.flatMap(examsOn).length;
    return `<div class="mt-10 first:mt-4">
      <div class="flex items-baseline justify-between gap-3 pb-3">
        <h3 class="display text-xl font-semibold text-slate-900">${w === monday(todayIso) ? "This week" : range}${w === monday(todayIso) ? ` <span class="text-sm font-normal text-slate-400 ml-1">${range}</span>` : ""}</h3>
        <span class="text-xs text-slate-500 tabular">${mins ? duration(mins) : "No study"}${nExams ? ` · ${plural(nExams, "exam", "exams")}` : ""}</span></div>
      <div class="hidden sm:grid grid-cols-7 border-t border-l border-slate-200/80 rounded-xl overflow-hidden">
        ${days.map((iso, i) => {
          const isToday = iso === todayIso, past = iso < todayIso, d = parseLocal(iso + "T00:00");
          return `<div class="border-r border-b border-slate-200/80 p-1.5 min-h-[8.5rem] ${past ? "bg-slate-100/50" : ""}">
            <div class="flex items-baseline justify-between px-1 pb-1.5">
              <span class="text-[10px] font-semibold uppercase tracking-[0.14em] ${isToday ? "text-accent" : "text-slate-400"}">${WEEKDAYS[i]}</span>
              <span class="text-[13px] tabular ${isToday ? "inline-flex w-6 h-6 -my-1 items-center justify-center rounded-full bg-accent text-on-accent font-semibold" : past ? "text-slate-400" : "text-slate-700"}">${d.getDate()}</span></div>
            <div class="space-y-1">${examsOn(iso).map(examChip).join("")}${sessOn(iso).map(chip).join("")}</div></div>`;
        }).join("")}
      </div>
      <div class="sm:hidden border-t border-slate-200/80">${days.filter((iso) => examsOn(iso).length || sessOn(iso).length).map((iso) => {
          const d = parseLocal(iso + "T00:00");
          return `<div class="grid grid-cols-[3rem_1fr] gap-3 py-3 border-b border-slate-200/80">
            <div class="text-center pt-0.5"><span class="display block text-xl font-semibold leading-none ${iso === todayIso ? "text-accent" : "text-slate-900"}">${d.getDate()}</span>
              <span class="block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400 mt-1">${WEEKDAYS[(d.getDay() + 6) % 7]}</span></div>
            <div class="space-y-1.5">${examsOn(iso).map(examChip).join("")}${sessOn(iso).map(chip).join("")}</div></div>`;
        }).join("") || `<p class="py-4 text-sm text-slate-400">A free week.</p>`}</div>
    </div>`;
  }).join("") + (weeks.length > weeksShown ? `<div class="text-center mt-8"><button data-more-weeks class="btn btn-secondary">Show ${plural(weeks.length - weeksShown, "more week", "more weeks")}</button></div>` : "");
}

/** Tap a session: start it, tick it off, or take it out. */
function openSessionMenu(s, after) {
  const todayIso = isoDay(new Date());
  const past = parseLocal(s.end) <= new Date();
  const body = document.createElement("div");
  body.innerHTML = `
    <p class="text-sm text-slate-500 -mt-2">${esc(relDay(s.start))} · ${hm(s.start)}–${hm(s.end)} · ${duration(sessionMinutes(s))}${s.kind === "review" ? " · review" : ""}</p>
    <div class="grid gap-2 mt-5">
      ${s.start.slice(0, 10) === todayIso && !past && s.status === "planned" ? `<button data-act="focus" class="btn btn-primary py-2.5">Start focus timer</button>` : ""}
      ${s.status !== "done" ? `<button data-act="done" class="btn btn-secondary py-2.5">Mark as done</button>` : `<button data-act="planned" class="btn btn-secondary py-2.5">Not done after all</button>`}
      ${s.status === "planned" && past ? `<button data-act="missed" class="btn btn-secondary py-2.5">I missed it</button>` : ""}
      <button data-act="remove" class="btn btn-ghost text-red-600 hover:bg-red-50">Remove this session</button>
    </div>`;
  body.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    closeModal();
    if (act === "focus") return startFocus(s);
    if (act === "remove") { await api(`/api/revision/sessions/${s.id}`, { method: "DELETE" }); toast("Session removed"); }
    else { await api(`/api/revision/sessions/${s.id}`, { method: "PATCH", body: { status: act } }); toast(act === "done" ? "Nice work." : act === "missed" ? "Marked as missed. Replan to make up for it." : "Saved"); }
    after();
  });
  openModal(s.subject, body);
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

let revisionTab = null;   // remembered while the app is open

async function viewRevision(root, params) {
  let st = await api("/api/revision");
  let weeksShown = 3;
  let tab = revisionTab || null;

  async function replan(quiet = false) {
    try {
      st = await api("/api/revision/plan", { method: "POST" });
      draw();
      if (!quiet) toast(st.settings.synced ? "Plan updated in your calendar" : `Planned ${plural(st.sessions.filter((s) => !s.past).length, "session", "sessions")}`);
    } catch (err) { toast(err.message, "error"); }
  }
  async function reload() { st = await api("/api/revision"); draw(); }

  function draw() {
    state.sessions = st.sessions;
    assignCourseColors(st.exams);
    const todayIso = isoDay(new Date());
    const ahead = st.exams.filter((x) => x.days >= 0).sort((a, b) => a.date.localeCompare(b.date));
    const planned = st.sessions.filter((s) => !s.past && s.status === "planned");
    const hasPlan = planned.length > 0;
    const inCalendar = st.settings.synced;
    const plannedMin = planned.reduce((a, s) => a + sessionMinutes(s), 0);
    tab = tab || (hasPlan ? "plan" : "exams");

    if (!st.exams.length) {
      root.innerHTML = `
        <section class="max-w-xl mx-auto text-center pt-10">
          <p class="eyebrow">Revision</p>
          <h1 class="display text-5xl font-semibold text-slate-900 mt-3 leading-[1.05]">Plan the semester<br><span class="text-slate-400">before it plans you.</span></h1>
          <p class="text-slate-500 mt-5 mb-8 leading-relaxed">Add your exams. Today fits study sessions into the free time in your calendar, gives harder subjects more of it, and saves a review for the day before each exam.</p>
          <div class="flex flex-col sm:flex-row gap-2 justify-center">
            <button data-import class="btn btn-primary">Import your class's key dates</button>
            <button data-add-exam class="btn btn-secondary">Add an exam yourself</button></div>
        </section>`;
      $("[data-add-exam]", root).addEventListener("click", () => openExamForm(null, reload));
      $("[data-import]", root).addEventListener("click", () => openImport(reload));
      return;
    }

    const next = ahead[0], after = ahead[1];
    const span = ahead.length ? dayDiff(todayIso, ahead.at(-1).date) : 0;
    root.innerHTML = `
      <header class="flex flex-wrap items-end justify-between gap-6 pt-2">
        <div class="max-w-2xl">
          <p class="eyebrow">Revision</p>
          <h1 class="display text-5xl sm:text-6xl font-semibold text-slate-900 mt-3 leading-[1.02]">
            ${ahead.length ? `${plural(ahead.length, "exam", "exams")},<br class="sm:hidden"> <span class="text-slate-400">${plural(span, "day", "days")}.</span>` : "All done."}</h1>
          ${next ? `<p class="text-slate-600 mt-4 leading-relaxed">Next is <b class="text-slate-900">${esc(next.subject)}</b> ${countdown(next.days)}${next.time ? ` at ${next.time}` : ""}${after ? `, then ${esc(after.subject)} ${countdown(after.days)}` : ""}.</p>` : ""}
        </div>
        <div class="flex gap-2">
          <button data-import class="btn btn-ghost">Import key dates</button>
          <button data-add-exam class="btn btn-secondary">Add exam</button></div>
      </header>

      ${runway(st.exams, todayIso)}

      <nav class="mt-6 flex items-center gap-6 border-b border-slate-200" role="tablist">
        ${[["plan", "Timetable", hasPlan ? duration(plannedMin) : ""], ["exams", "Exams", String(ahead.length)]].map(([id, label, n]) => `
          <button role="tab" data-tab="${id}" aria-selected="${tab === id}" class="relative -mb-px pb-3 text-sm ${tab === id ? "text-slate-900 font-medium" : "text-slate-500 hover:text-slate-800"}">
            ${label}${n ? ` <span class="ml-1 text-xs tabular ${tab === id ? "text-slate-500" : "text-slate-400"}">${n}</span>` : ""}
            ${tab === id ? `<span class="absolute left-0 right-0 bottom-0 h-[2px] bg-slate-900 rounded-full"></span>` : ""}</button>`).join("")}
      </nav>

      ${tab === "exams" ? `<section class="max-w-3xl mt-4">${examList(st.exams)}</section>` : `
        <section>
          <div class="flex flex-wrap items-center justify-between gap-3 mt-5">
            <p class="text-sm text-slate-600">${hasPlan ? `${duration(plannedMin)} of study ahead${inCalendar ? ` · in your <b class="text-slate-900">${esc(st.calendar?.title || "")}</b> calendar` : " · not in your calendar yet"}` : "No plan yet."}</p>
            <div class="flex flex-wrap gap-2">
              <button data-plan class="btn ${hasPlan ? "btn-ghost" : "btn-primary"} !py-1.5">${hasPlan ? "Replan" : "Make my plan"}</button>
              ${hasPlan && !inCalendar ? `<button data-sync class="btn btn-primary !py-1.5">Add to calendar</button>` : ""}
              ${inCalendar ? `<button data-unsync class="btn btn-ghost !py-1.5 text-slate-500">Remove from calendar</button>` : ""}
            </div>
          </div>
          ${hasPlan && !inCalendar ? `<p class="text-xs text-slate-500 mt-2">Have a look first. Nothing goes into your calendar until you tap Add to calendar.</p>` : ""}
          ${inCalendar && st.calendar && !st.calendar.separate ? `<p class="text-xs text-slate-500 mt-2">Your calendar account doesn't allow new calendars from the Mac, so sessions are in “${esc(st.calendar.title)}”.</p>` : ""}
          ${hasPlan ? weekTimetable(st, weeksShown) : `<p class="text-sm text-slate-500 py-14 text-center">Make a plan and your weeks appear here.</p>`}
          <details data-prefs class="mt-10 border-t border-slate-200" ${params.get("open") === "prefs" ? "open" : ""}>
            <summary class="flex items-center justify-between py-4 cursor-pointer list-none">
              <span><span class="block text-sm font-medium text-slate-900">Study preferences</span>
                <span class="block text-xs text-slate-500 mt-0.5">Up to ${st.settings.hours_per_day} h a day · ${st.settings.earliest}–${st.settings.latest}${st.settings.days_off.length ? ` · off ${st.settings.days_off.map((d) => WEEKDAYS[d]).join(", ")}` : ""}</span></span>
              <span data-chevron class="inline-block text-slate-400 text-xl transition-transform">›</span></summary>
            <div class="pb-4 max-w-2xl">${settingsForm(st)}<p class="text-xs text-slate-400 mt-3">Used the next time you replan.</p></div>
          </details>
        </section>`}`;

    $("[data-add-exam]", root).addEventListener("click", () => openExamForm(null, reload));
    $("[data-import]", root).addEventListener("click", () => openImport(reload));
    $("[data-plan]", root)?.addEventListener("click", () => replan());
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
    if (!study) return;
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
      $("[data-prefs]", root).open = true;
    });
  }

  root.addEventListener("click", (e) => {
    const ex = e.target.closest("[data-exam]");
    const se = e.target.closest("[data-sess]");
    if (ex) openExamForm(st.exams.find((x) => x.id === Number(ex.dataset.exam)), reload);
    if (se) openSessionMenu(st.sessions.find((s) => s.id === Number(se.dataset.sess)), reload);
    if (e.target.closest("[data-more-weeks]")) { weeksShown += 6; draw(); }
    const t = e.target.closest("[data-tab]");
    if (t) { tab = revisionTab = t.dataset.tab; draw(); }
  });
  wireSessionButtons(root);
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
// Course colours have their own shades in dark themes.
window.addEventListener("themechange", () => { if (parseHash().route === "revision" && !focus.session) render(); });
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
