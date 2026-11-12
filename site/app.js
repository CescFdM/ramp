import { h, lineChart, barChart, chartCard } from "./charts.js";
import { deriveKey, decryptFile, saveKey, loadKey, clearKey } from "./crypto.js";

const app = document.getElementById("app");
const S = { data: null, key: null, tab: "stats", range: 30, loadedAt: 0, detail: null };

/* ------------------------------------------------------------------ helpers */
const ICONS = {
  bike: '<circle cx="6" cy="17" r="3.4"/><circle cx="18" cy="17" r="3.4"/><path d="M6 17 10 8 15 8 18 17 M10 8 13 13 18 17 M13 13 9 13"/><circle cx="15" cy="5" r="1.3" fill="currentColor" stroke="none"/>',
  run: '<circle cx="14.5" cy="4.5" r="1.8" fill="currentColor" stroke="none"/><path d="M8 21l3.5-6-2.5-3 3-4 3 2.5 3 .5M11.5 15l3.5 2.5.5 3.5M9 12l-3.5 1"/>',
  strength: '<path d="M4 12h16"/><rect x="1.6" y="9" width="3" height="6" rx="1"/><rect x="19.4" y="9" width="3" height="6" rx="1"/><rect x="6" y="7" width="2.2" height="10" rx="1"/><rect x="15.8" y="7" width="2.2" height="10" rx="1"/>',
  walk: '<circle cx="13" cy="4.5" r="1.7" fill="currentColor" stroke="none"/><path d="M10 21l1.8-6.5-2.3-2.2 1.6-4.3 3.4 2 2.4 1.5M11.8 14.5l3.4 2 .8 4.5M9.2 9.5 6.5 11"/>',
  other: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  rest: '<path d="M20 14.2A8.4 8.4 0 1 1 9.8 4a7 7 0 0 0 10.2 10.2Z" fill="currentColor" stroke="none"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  acts: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  plan: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
};
function icon(name, size = 20) {
  const span = document.createElement("span");
  span.style.display = "inline-flex";
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  return span;
}
const SPORT_LABEL = { bike: "Cycling", run: "Running", strength: "Strength", walk: "Walk / hike", other: "Other" };
const SPORT_COLOR = { bike: "var(--bike)", run: "var(--run)", strength: "var(--strength)", walk: "var(--other)", other: "var(--other)" };

const D0 = (iso) => new Date(iso + "T12:00:00");
const fmtShort = (iso) => D0(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const fmtFull = (iso) => D0(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const fmtTime = (isoLocal) => (isoLocal || "").slice(11, 16);
function lastDays(todayIso, n) {
  const base = new Date(todayIso + "T12:00:00Z");
  return Array.from({ length: n }, (_, i) => new Date(base.getTime() - (n - 1 - i) * 864e5).toISOString().slice(0, 10));
}
const weekStart = (iso) => {
  const d = new Date(iso + "T12:00:00Z");
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
};
const num = (v) => (v == null || isNaN(v) ? null : Number(v));
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}
const fmtHM = (sec) => { const m = Math.round((sec || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`; };
const fmtHrs = (v) => (v == null ? "–" : v.toFixed(1) + " h");
const km = (m, d = 1) => (m == null ? null : (m / 1000).toFixed(d));
function paceOf(speed) {
  if (!speed || speed < 0.9) return null;
  const s = 1000 / speed; let mm = Math.floor(s / 60), ss = Math.round(s % 60);
  if (ss === 60) { mm++; ss = 0; }
  return `${mm}:${String(ss).padStart(2, "0")}`;
}
const secToPace = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const kmh = (speed) => (speed ? (speed * 3.6).toFixed(1) : null);
const avg = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; };
const titleCase = (s) => String(s || "").replace(/_\d+$/, "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const rolling = (vals, n) => vals.map((_, i) => avg(vals.slice(Math.max(0, i - n + 1), i + 1)));

/* ------------------------------------------------------------------ boot & auth */
async function fetchEnc() {
  const r = await fetch("data.enc?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  let file;
  try { file = await fetchEnc(); } catch (e) { return fatal("Couldn't load your data (" + e.message + "). Check your connection and reload."); }
  const cached = await loadKey();
  if (cached && cached.salt === file.salt) {
    try { S.key = cached.key; S.data = await decryptFile(file, S.key); S.loadedAt = Date.now(); return start(); } catch { /* password changed, fall through */ }
  }
  showLogin(file);
}

function fatal(msg) { app.replaceChildren(h("div", { class: "boot" }, msg)); }

function showLogin(file, message) {
  const err = h("p", { class: "err", role: "alert" }, message || "");
  const user = h("input", { type: "text", name: "username", autocomplete: "username", autocapitalize: "none", autocorrect: "off", spellcheck: "false", required: true });
  const pass = h("input", { type: "password", name: "password", autocomplete: "current-password", required: true });
  const btn = h("button", { class: "btn", type: "submit" }, "Unlock");
  const form = h("form", {}, h("h1", {}, "Ramp"), h("p", {}, "Private training dashboard. Sign in to decrypt your data on this device."),
    h("label", {}, "Username", user), h("label", {}, "Password", pass), err, btn);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    btn.disabled = true; btn.textContent = "Unlocking…"; err.textContent = "";
    try {
      const key = await deriveKey(user.value, pass.value, file.salt, file.iter);
      const data = await decryptFile(file, key);
      S.key = key; S.data = data; S.loadedAt = Date.now();
      await saveKey(key, file.salt);
      start();
    } catch {
      err.textContent = "Wrong username or password.";
      btn.disabled = false; btn.textContent = "Unlock"; pass.value = ""; pass.focus();
    }
  });
  app.replaceChildren(h("div", { class: "login" }, form));
  user.focus();
}

async function reload(manual) {
  try {
    const file = await fetchEnc();
    S.data = await decryptFile(file, S.key);
    S.loadedAt = Date.now();
    render();
  } catch (e) {
    if (manual) alert("Couldn't refresh: " + e.message);
  }
}

/* ------------------------------------------------------------------ shell */
let mainEl, metaEl, bannerEl, tabsEl;
function start() {
  metaEl = h("div", { class: "meta" });
  mainEl = h("main", {});
  bannerEl = h("div", {});
  const refresh = h("button", { class: "icon-btn", type: "button", "aria-label": "Refresh data", onclick: () => reload(true) }, icon("refresh", 18));
  const lock = h("button", { class: "icon-btn", type: "button", "aria-label": "Sign out", onclick: async () => { await clearKey(); location.reload(); } }, icon("lock", 18));
  tabsEl = h("nav", { class: "tabs", role: "tablist" }, ["stats|Athlete stats", "acts|Activities", "plan|Plan"].map((t) => {
    const [id, label] = t.split("|");
    return h("button", { role: "tab", "data-tab": id, onclick: () => { S.tab = id; closeDetail(); render(); window.scrollTo(0, 0); } }, icon(id, 22), label);
  }));
  app.replaceChildren(h("div", { class: "shell" },
    h("header", { class: "topbar" }, h("div", {}, h("h1", {}, "Ramp"), metaEl), h("div", { style: { display: "flex", gap: "8px" } }, refresh, lock)),
    bannerEl, mainEl), tabsEl);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - S.loadedAt > 10 * 60e3) reload(false); });
  window.addEventListener("popstate", () => { if (!history.state || !history.state.act) closeDetail(true); });
  render();
}

function render() {
  const D = S.data;
  tabsEl.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  const t = new Date(D.generated_at);
  metaEl.textContent = "Synced " + t.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  bannerEl.replaceChildren();
  const failures = D.sync && D.sync.failures && Object.keys(D.sync.failures).length;
  if (failures) bannerEl.append(h("div", { class: "banner" }, `Garmin didn't return some data (${Object.keys(D.sync.failures).join(", ")}). Related charts may be incomplete.`));
  mainEl.replaceChildren(S.tab === "stats" ? statsView() : S.tab === "acts" ? actsView() : planView());
}

/* ------------------------------------------------------------------ ATHLETE STATS */
function tile(label, value, unit, hint, tone) {
  return h("div", { class: "tile" }, h("div", { class: "lbl" }, label),
    h("div", { class: "val" }, value, unit ? h("small", {}, unit) : null), hint ? h("div", { class: "hint " + (tone || "") }, hint) : null);
}

function statsView() {
  const D = S.data, n = S.range;
  const days = lastDays(D.today, n);
  const dm = Object.fromEntries(D.daily.map((d) => [d.date, d]));
  const lm = Object.fromEntries(D.load.map((d) => [d.date, d]));
  const labels = days.map(fmtShort), titles = days.map(fmtFull);
  const wrap = h("div", {});

  wrap.append(h("div", { class: "filters", role: "group", "aria-label": "Date range" },
    h("div", { class: "seg" }, [7, 30, 90].map((r) => h("button", { type: "button", "aria-pressed": String(S.range === r), onclick: () => { S.range = r; render(); } }, r + "d")))));

  /* tiles */
  const recent = D.daily.slice().reverse();
  const latest = (f) => { for (const d of recent.slice(0, 4)) { const v = f(d); if (v != null) return { v, d }; } return null; };
  const last30 = D.daily.slice(-30);
  const tiles = h("div", { class: "tiles" });
  const rhr = latest((d) => d.rhr);
  if (rhr) {
    const base = avg(last30.map((d) => d.rhr)), delta = base ? Math.round(rhr.v - base) : null;
    tiles.append(tile("Resting HR", rhr.v, "bpm", delta == null ? null : `${delta > 0 ? "+" : ""}${delta} vs 30d avg`, delta >= 4 ? "warn" : delta <= -2 ? "good" : ""));
  }
  const hrv = latest((d) => d.hrv && d.hrv.last);
  if (hrv) {
    const hv = hrv.d.hrv, ok = hv.status === "BALANCED";
    tiles.append(tile("HRV last night", hv.last, "ms", `${titleCase(hv.status || "")}${hv.low ? ` · range ${hv.low}–${hv.high}` : ""}`, hv.status ? (ok ? "good" : "warn") : ""));
  }
  const sl = latest((d) => d.sleep && d.sleep.total);
  if (sl) {
    const a7 = avg(D.daily.slice(-7).map((d) => d.sleep && d.sleep.total));
    tiles.append(tile("Sleep", fmtHM(sl.d.sleep.total), "", `${sl.d.sleep.score ? "Score " + sl.d.sleep.score + " · " : ""}7d avg ${fmtHM(a7)}`));
  }
  const ld = D.load[D.load.length - 1];
  if (ld && ld.ratio != null) {
    const r = ld.ratio;
    const [txt, tone] = r < 0.8 ? ["Low, room to build", ""] : r <= 1.3 ? ["Sweet spot", "good"] : r <= 1.5 ? ["High, watch fatigue", "warn"] : ["Very high", "bad"];
    tiles.append(tile("Acute : chronic load", r.toFixed(2), "", txt, tone));
  }
  // Prefer Garmin's account-level daily estimate (what the Garmin app shows); fall back to per-activity values.
  const vo = (g) => {
    const day = recent.find((d) => d.vo2 && d.vo2[g]);
    if (day) return day.vo2[g];
    const a = D.activities.filter((x) => x.sport_group === g && x.vo2max).pop();
    return a ? a.vo2max : null;
  };
  const vr = vo("run") ?? (D.training_status && D.training_status.vo2_run), vb = vo("bike") ?? (D.training_status && D.training_status.vo2_bike);
  if (vr || vb) tiles.append(tile("VO₂max", vr ? Number(vr).toFixed(1) : Number(vb).toFixed(1), "", vr && vb ? `Run · bike ${Number(vb).toFixed(1)}` : vr ? "Running" : "Cycling"));
  const bb = latest((d) => d.bb_high);
  if (bb) tiles.append(tile("Body battery", bb.v, "/100", bb.d.bb_low != null ? `Low ${bb.d.bb_low}` : null));
  if (D.training_status && D.training_status.phrase) tiles.append(tile("Garmin status", titleCase(D.training_status.phrase), "", null));
  wrap.append(tiles);

  /* weekly volume */
  const nWeeks = Math.max(4, Math.ceil(n / 7));
  const thisWeek = weekStart(D.today);
  const weeks = Array.from({ length: nWeeks }, (_, i) => new Date(new Date(thisWeek + "T12:00:00Z").getTime() - (nWeeks - 1 - i) * 7 * 864e5).toISOString().slice(0, 10));
  const wk = Object.fromEntries(weeks.map((w) => [w, { run: 0, bike: 0, strength: 0, other: 0, sessions: 0, km: 0, load: 0 }]));
  D.activities.forEach((a) => {
    const w = wk[weekStart(a.date)];
    if (!w) return;
    const g = a.sport_group === "walk" ? "other" : a.sport_group;
    w[g] += (a.duration_s || 0) / 3600; w.sessions++; w.km += (a.distance_m || 0) / 1000; w.load += a.load || 0;
  });
  if (D.activities.length) {
    wrap.append(chartCard({ title: "Training volume per week", sub: "Hours by sport, weeks start Monday" }, (host) =>
      barChart(host, {
        title: "Training volume per week", labels: weeks.map(fmtShort), titles: weeks.map((w) => "Week of " + fmtShort(w)), valFmt: fmtHrs, yFmt: (v) => v + "h", totalName: "Total",
        series: [["run", "Running"], ["bike", "Cycling"], ["strength", "Strength"], ["other", "Walk / other"]].map(([k, name]) => ({ name, color: SPORT_COLOR[k], values: weeks.map((w) => wk[w][k]) })),
        extra: weeks.map((w) => [{ value: String(wk[w].sessions), name: "sessions" }, { value: wk[w].km.toFixed(0) + " km", name: "distance" }]),
      })));
  }

  /* load */
  if (D.load.length && D.load.some((d) => d.acute)) {
    wrap.append(chartCard({ title: "Training load", sub: "7-day load vs your 28-day weekly average. Staying close keeps the ramp sustainable.", note: "Uses Garmin's activity training load; sessions without one are estimated from duration." }, (host) =>
      lineChart(host, {
        title: "Training load", labels, titles, yMin: 0, yFmt: (v) => String(Math.round(v)),
        series: [{ name: "Acute (7 days)", color: "var(--ink)", values: days.map((d) => lm[d] ? lm[d].acute : null) },
                 { name: "Chronic (weekly avg, 28 days)", color: "var(--ink-3)", dash: true, values: days.map((d) => lm[d] ? lm[d].chronic : null) }],
      })));
  }

  /* recovery */
  const rv = days.map((d) => num(dm[d] && dm[d].rhr));
  if (rv.some((v) => v != null)) {
    wrap.append(chartCard({ title: "Resting heart rate", sub: "Lower and stable is better; a jump of 4+ bpm often means fatigue or illness." }, (host) =>
      lineChart(host, { title: "Resting heart rate", labels, titles, yFmt: (v) => String(Math.round(v)), valFmt: (v) => Math.round(v) + " bpm",
        series: [{ name: "Daily", color: "var(--rhr)", width: 1.6, values: rv }, { name: "7-day average", color: "var(--ink)", dash: true, values: rolling(rv, 7).map((v) => v && Math.round(v * 10) / 10) }] })));
  }
  const hv = days.map((d) => num(dm[d] && dm[d].hrv && dm[d].hrv.last));
  if (hv.some((v) => v != null)) {
    wrap.append(chartCard({ title: "Heart rate variability", sub: "Overnight HRV against your balanced range." }, (host) =>
      lineChart(host, { title: "HRV", labels, titles, yFmt: (v) => String(Math.round(v)), valFmt: (v) => Math.round(v) + " ms",
        series: [{ name: "Last night", color: "var(--hrv)", values: hv }, { name: "Weekly average", color: "var(--ink)", dash: true, values: days.map((d) => num(dm[d] && dm[d].hrv && dm[d].hrv.weekly)) }],
        band: { name: "Balanced range", color: "var(--hrv)", low: days.map((d) => num(dm[d] && dm[d].hrv && dm[d].hrv.low)), high: days.map((d) => num(dm[d] && dm[d].hrv && dm[d].hrv.high)) } })));
  }
  const sleepDays = days.map((d) => dm[d] && dm[d].sleep);
  if (sleepDays.some(Boolean)) {
    const hrs = (k) => sleepDays.map((s) => (s && s[k] ? s[k] / 3600 : 0));
    wrap.append(chartCard({ title: "Sleep", sub: "Hours per night by phase" }, (host) =>
      barChart(host, { title: "Sleep", labels, titles, valFmt: (v) => fmtHM(v * 3600), yFmt: (v) => v + "h", totalName: "In bed",
        series: [{ name: "Deep", color: "var(--deep)", values: hrs("deep") }, { name: "Light", color: "var(--light)", values: hrs("light") }, { name: "REM", color: "var(--rem)", values: hrs("rem") }, { name: "Awake", color: "var(--awake)", values: hrs("awake") }],
        extra: sleepDays.map((s) => (s && s.score ? [{ value: String(s.score), name: "sleep score" }] : [])) })));
  }
  const bh = days.map((d) => num(dm[d] && dm[d].bb_high));
  if (bh.some((v) => v != null)) {
    wrap.append(chartCard({ title: "Body battery", sub: "Daily high and low" }, (host) =>
      lineChart(host, { title: "Body battery", labels, titles, yMin: 0, yMax: 100, yFmt: (v) => String(Math.round(v)), valFmt: (v) => String(Math.round(v)),
        series: [{ name: "Highest", color: "var(--bb)", values: bh }, { name: "Lowest", color: "var(--ink-3)", dash: true, values: days.map((d) => num(dm[d] && dm[d].bb_low)) }] })));
  }

  /* fitness + body (at least 90 days: these update rarely) */
  const long = lastDays(D.today, Math.max(n, 90)), lLabels = long.map(fmtShort), lTitles = long.map(fmtFull);
  const vSeries = (g, color, name) => {
    const m = {};
    D.activities.filter((a) => a.sport_group === g && a.vo2max).forEach((a) => (m[a.date] = a.vo2max));
    D.daily.forEach((d) => { if (d.vo2 && d.vo2[g]) m[d.date] = d.vo2[g]; }); // account-level value wins
    return { name, color, values: long.map((d) => (m[d] != null ? m[d] : null)) };
  };
  const vs = [vSeries("run", "var(--run)", "Running"), vSeries("bike", "var(--bike)", "Cycling")].filter((x) => x.values.some((v) => v != null));
  if (vs.length) {
    wrap.append(chartCard({ title: "VO₂max", sub: "Garmin's estimate, last " + long.length + " days" }, (host) =>
      lineChart(host, { title: "VO2max", labels: lLabels, titles: lTitles, spanGaps: true, series: vs, yFmt: (v) => v.toFixed(0), valFmt: (v) => Number(v).toFixed(1) })));
  }
  const wm = Object.fromEntries(D.weights.map((w) => [w.date, w]));
  const wv = long.map((d) => (wm[d] ? wm[d].kg : null));
  if (wv.some((v) => v != null)) {
    wrap.append(chartCard({ title: "Body weight", sub: "From Garmin weigh-ins, last " + long.length + " days" }, (host) =>
      lineChart(host, { title: "Body weight", labels: lLabels, titles: lTitles, spanGaps: true, yFmt: (v) => v.toFixed(0), valFmt: (v) => v.toFixed(1) + " kg",
        series: [{ name: "Weight", color: "var(--ink)", values: wv }] })));
    const fv = long.map((d) => (wm[d] && wm[d].fat != null ? wm[d].fat : null)), mv = long.map((d) => (wm[d] && wm[d].muscle_kg != null ? wm[d].muscle_kg : null));
    if (mv.some((v) => v != null)) {
      wrap.append(chartCard({ title: "Muscle mass", sub: "Garmin scale estimate" }, (host) =>
        lineChart(host, { title: "Muscle mass", labels: lLabels, titles: lTitles, spanGaps: true, yFmt: (v) => v.toFixed(0), valFmt: (v) => v.toFixed(1) + " kg", series: [{ name: "Muscle mass", color: "var(--strength)", values: mv }] })));
    }
    if (fv.some((v) => v != null)) {
      wrap.append(chartCard({ title: "Body fat", sub: "Garmin scale estimate" }, (host) =>
        lineChart(host, { title: "Body fat", labels: lLabels, titles: lTitles, spanGaps: true, yFmt: (v) => v.toFixed(1) + "%", valFmt: (v) => v.toFixed(1) + "%", series: [{ name: "Body fat", color: "var(--run)", values: fv }] })));
    }
  }

  /* strength frequency */
  if (D.activities.some((a) => a.sport_group === "strength")) {
    wrap.append(chartCard({ title: "Strength sessions per week", sub: "Consistency matters more than any single session" }, (host) =>
      barChart(host, { title: "Strength sessions per week", labels: weeks.map(fmtShort), titles: weeks.map((w) => "Week of " + fmtShort(w)), valFmt: (v) => String(Math.round(v)), yFmt: (v) => String(Math.round(v)),
        series: [{ name: "Sessions", color: "var(--strength)", values: weeks.map((w) => D.activities.filter((a) => a.sport_group === "strength" && weekStart(a.date) === w).length) }],
        extra: weeks.map((w) => [{ value: fmtHM(D.activities.filter((a) => a.sport_group === "strength" && weekStart(a.date) === w).reduce((p, a) => p + (a.duration_s || 0), 0)), name: "time under way" }]) })));
  }

  if (wrap.children.length <= 2) wrap.append(h("p", { class: "empty" }, "No Garmin data yet. The first sync fills this in."));
  return wrap;
}

/* ------------------------------------------------------------------ PAST ACTIVITIES */
function actCard(a) {
  const g = a.sport_group;
  const chips = [fmtDur(a.duration_s)];
  if (a.distance_m && g !== "strength") chips.push(km(a.distance_m, 2) + " km");
  if (g === "run" && paceOf(a.avg_speed)) chips.push(paceOf(a.avg_speed) + "/km");
  if (g === "bike" && a.avg_speed) chips.push(kmh(a.avg_speed) + " km/h");
  if (a.avg_hr) chips.push(Math.round(a.avg_hr) + " bpm");
  if (g === "strength" && a.sets) chips.push(a.sets + " sets");
  return h("button", { class: "act", type: "button", onclick: () => openDetail(a.id) },
    h("div", { class: "badge " + g }, icon(g, 22)),
    h("div", { class: "main" }, h("div", { class: "name" }, a.name), h("div", { class: "when" }, `${fmtTime(a.start_local)} · ${SPORT_LABEL[g]}${a.location ? " · " + a.location : ""}`),
      h("div", { class: "chips" }, chips.map((c) => h("span", {}, c)))),
    h("span", { class: "chev" }, icon("chev", 18)));
}

function actsView() {
  const D = S.data;
  const days = lastDays(D.today, 7).reverse();
  const by = {};
  D.activities.forEach((a) => (by[a.date] = (by[a.date] || []).concat(a)));
  const week = days.flatMap((d) => by[d] || []);
  const wrap = h("div", {});
  wrap.append(h("div", { class: "sum-row" },
    [[String(week.length), "sessions"], [fmtHM(week.reduce((p, a) => p + (a.duration_s || 0), 0)), "time"],
     [week.reduce((p, a) => p + (a.sport_group !== "strength" ? a.distance_m || 0 : 0), 0) / 1000 | 0, "km"], [String(Math.round(week.reduce((p, a) => p + (a.load || 0), 0))), "load"]]
      .map(([v, l]) => h("div", {}, h("b", {}, v), h("span", {}, l)))));
  days.forEach((d, i) => {
    const list = (by[d] || []).slice().sort((a, b) => b.start_local.localeCompare(a.start_local));
    const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : D0(d).toLocaleDateString(undefined, { weekday: "long" });
    wrap.append(h("div", { class: "day-h" }, h("span", {}, label), h("em", {}, fmtShort(d) + (list.length ? " · " + fmtHM(list.reduce((p, a) => p + (a.duration_s || 0), 0)) : ""))));
    if (!list.length) wrap.append(h("p", { class: "empty" }, "No activity"));
    list.forEach((a) => wrap.append(actCard(a)));
  });
  return wrap;
}

/* ---- detail */
function openDetail(id) {
  history.pushState({ act: id }, "");
  showDetail(id);
}
function closeDetail(fromPop) {
  const el = document.getElementById("detail");
  if (!el) return;
  el.remove(); document.body.style.overflow = "";
  if (!fromPop && history.state && history.state.act) history.back();
}

function showDetail(id) {
  const D = S.data;
  const a = D.activities.find((x) => String(x.id) === String(id));
  if (!a) return;
  const det = D.details[String(a.id)] || {};
  const g = a.sport_group;
  const wrap = h("div", {});

  const stat = (label, value) => (value == null || value === "" ? null : h("div", {}, h("b", {}, value), h("span", {}, label)));
  const items = [];
  items.push(stat("Time", fmtDur(a.duration_s)));
  if (g !== "strength") items.push(stat("Distance", a.distance_m ? km(a.distance_m, 2) + " km" : null));
  if (g === "run") items.push(stat("Avg pace", paceOf(a.avg_speed) ? paceOf(a.avg_speed) + " /km" : null));
  if (g === "bike" || g === "walk" || g === "other") items.push(stat("Avg speed", a.avg_speed ? kmh(a.avg_speed) + " km/h" : null));
  if (g === "bike") { items.push(stat("Avg power", a.avg_power ? Math.round(a.avg_power) + " W" : null)); items.push(stat("Norm. power", a.norm_power ? Math.round(a.norm_power) + " W" : null)); }
  items.push(stat("Avg HR", a.avg_hr ? Math.round(a.avg_hr) + " bpm" : null), stat("Max HR", a.max_hr ? Math.round(a.max_hr) + " bpm" : null));
  items.push(stat("Elevation gain", a.elev_gain_m != null && g !== "strength" ? Math.round(a.elev_gain_m) + " m" : null));
  if (g === "run") items.push(stat("Cadence", a.cadence ? Math.round(a.cadence) + " spm" : null));
  if (g === "bike") items.push(stat("Cadence", a.cadence ? Math.round(a.cadence) + " rpm" : null));
  if (g === "strength") items.push(stat("Sets", a.sets), stat("Reps", a.reps));
  items.push(stat("Calories", a.calories ? Math.round(a.calories) + " kcal" : null));
  items.push(stat("Aerobic TE", a.te_aerobic != null ? Number(a.te_aerobic).toFixed(1) : null), stat("Anaerobic TE", a.te_anaerobic != null ? Number(a.te_anaerobic).toFixed(1) : null));
  items.push(stat("Training load", a.load ? Math.round(a.load) : null));
  wrap.append(h("div", { class: "grid-stats" }, items.filter(Boolean)));

  const sr = det.series;
  if (sr && sr.t && sr.t.length > 2) {
    const labels = sr.t.map((t) => Math.round(t / 60) + " min");
    const titles = sr.t.map((t, i) => fmtDur(t) + (sr.dist && sr.dist[i] != null ? " · " + km(sr.dist[i], 2) + " km" : ""));
    const common = { labels, titles, markers: false };
    if (sr.hr) wrap.append(chartCard({ title: "Heart rate" }, (host) => lineChart(host, { ...common, title: "Heart rate", yFmt: (v) => String(Math.round(v)), valFmt: (v) => Math.round(v) + " bpm", series: [{ name: "Heart rate", color: "var(--rhr)", values: sr.hr.map(num) }] })));
    if (sr.speed) {
      if (g === "run") {
        const pv = sr.speed.map((s) => (s && s > 0.9 ? 1000 / s : null));
        wrap.append(chartCard({ title: "Pace", sub: "Faster is higher" }, (host) => lineChart(host, { ...common, title: "Pace", invertY: true, yStep: 30, yFmt: (v) => secToPace(v), valFmt: (v) => secToPace(v) + " /km", series: [{ name: "Pace", color: "var(--run)", values: pv }] })));
      } else {
        wrap.append(chartCard({ title: "Speed" }, (host) => lineChart(host, { ...common, title: "Speed", yMin: 0, yFmt: (v) => v.toFixed(0), valFmt: (v) => v.toFixed(1) + " km/h", series: [{ name: "Speed", color: SPORT_COLOR[g], values: sr.speed.map((s) => (s == null ? null : s * 3.6)) }] })));
      }
    }
    if (sr.power) wrap.append(chartCard({ title: "Power" }, (host) => lineChart(host, { ...common, title: "Power", yMin: 0, yFmt: (v) => String(Math.round(v)), valFmt: (v) => Math.round(v) + " W", series: [{ name: "Power", color: "var(--bike)", values: sr.power.map(num) }] })));
    if (sr.elev) wrap.append(chartCard({ title: "Elevation" }, (host) => lineChart(host, { ...common, title: "Elevation", yFmt: (v) => String(Math.round(v)), valFmt: (v) => Math.round(v) + " m", series: [{ name: "Elevation", color: "var(--ink-2)", fill: true, values: sr.elev.map(num) }] })));
  }

  if (det.hr_zones && det.hr_zones.length) {
    const tot = det.hr_zones.reduce((p, z) => p + (z.secs || 0), 0) || 1;
    wrap.append(h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", {}, h("h3", {}, "Time in heart rate zones"))),
      h("div", { class: "zones" }, det.hr_zones.map((z) => h("div", { class: "zone" },
        h("span", {}, `Zone ${z.zone}`), h("div", { class: "bar" }, h("div", { class: "fill", style: { width: (100 * (z.secs || 0)) / tot + "%", background: `var(--z${Math.min(5, Math.max(1, z.zone))})` } })),
        h("span", { class: "t" }, `${fmtDur(z.secs || 0)} · ${Math.round((100 * (z.secs || 0)) / tot)}%`))))));
  }

  if (det.route && det.route.length > 3) wrap.append(h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", {}, h("h3", {}, "Route"), h("p", { class: "sub" }, "Outline only, north up"))), routeSvg(det.route)));

  if (det.laps && det.laps.length > 1) {
    const isRun = g === "run", hasPow = det.laps.some((l) => l.power);
    wrap.append(h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", {}, h("h3", {}, "Laps"))),
      h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ["#", "Dist", "Time", isRun ? "Pace" : "Speed", "HR", hasPow ? "Power" : "Elev"].map((c) => h("th", {}, c)))),
        h("tbody", {}, det.laps.map((l) => h("tr", {}, [String(l.n), l.dist_m ? km(l.dist_m, 2) : "–", fmtDur(l.dur_s), isRun ? paceOf(l.speed) || "–" : l.speed ? kmh(l.speed) : "–", l.hr ? Math.round(l.hr) : "–", hasPow ? (l.power ? Math.round(l.power) : "–") : l.elev_gain != null ? Math.round(l.elev_gain) + " m" : "–"].map((c) => h("td", {}, c))))))));
  }

  if (det.sets && det.sets.length) {
    const groups = [];
    det.sets.forEach((s) => { let gr = groups.find((x) => x.name === s.name); if (!gr) groups.push((gr = { name: s.name, sets: [] })); gr.sets.push(s); });
    wrap.append(h("section", { class: "card" }, h("header", { class: "card-head" }, h("div", {}, h("h3", {}, "Exercises"), h("p", { class: "sub" }, "Reps × weight, per set"))),
      h("table", { class: "tbl" }, h("tbody", {}, groups.map((gr) => h("tr", {}, h("td", {}, h("b", {}, gr.name)), h("td", { style: { textAlign: "left" } }, gr.sets.map((s) => `${s.reps || "?"}${s.kg ? "×" + s.kg + " kg" : ""}`).join("  ·  "))))))));
  }

  if (!sr && !det.hr_zones && !det.laps && !det.sets) wrap.append(h("p", { class: "empty" }, "No detailed data stored for this activity."));

  const el = h("div", { class: "detail", id: "detail", role: "dialog", "aria-modal": "true", "aria-label": a.name },
    h("div", { class: "inner" },
      h("div", { class: "d-top" }, h("button", { class: "icon-btn", type: "button", "aria-label": "Back", onclick: () => closeDetail() }, icon("back", 20)),
        h("div", {}, h("h2", {}, a.name), h("p", { class: "sub" }, `${fmtFull(a.date)} · ${fmtTime(a.start_local)} · ${SPORT_LABEL[g]}`))), wrap));
  document.getElementById("detail")?.remove();
  document.body.append(el); document.body.style.overflow = "hidden";
  el.scrollTop = 0;
}

function routeSvg(pts) {
  const lat0 = pts.reduce((p, c) => p + c[0], 0) / pts.length, kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p[1] * kx), ys = pts.map((p) => -p[0]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const W = 320, Hh = 220, pad = 14, sc = Math.min((W - 2 * pad) / (maxx - minx || 1), (Hh - 2 * pad) / (maxy - miny || 1));
  const ox = (W - (maxx - minx) * sc) / 2, oy = (Hh - (maxy - miny) * sc) / 2;
  const P = pts.map((_, i) => [ox + (xs[i] - minx) * sc, oy + (ys[i] - miny) * sc]);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`); svg.setAttribute("class", "route"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Route outline");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", "M" + P.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L"));
  svg.append(path);
  [[P[0], "var(--good)"], [P[P.length - 1], "var(--bad)"]].forEach(([p, c]) => {
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", p[0]); dot.setAttribute("cy", p[1]); dot.setAttribute("r", 5); dot.setAttribute("fill", c); dot.setAttribute("stroke", "var(--surface)"); dot.setAttribute("stroke-width", 2);
    svg.append(dot);
  });
  return svg;
}

/* ------------------------------------------------------------------ PLANNED TRAINING */
const escXml = (s) => String(s || "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
function buildZwo(day) {
  const blocks = (day.structure || []).map((b) => {
    switch (b.kind) {
      case "Warmup": return `<Warmup Duration="${b.duration}" PowerLow="${b.powerLow}" PowerHigh="${b.powerHigh}"/>`;
      case "Cooldown": return `<Cooldown Duration="${b.duration}" PowerLow="${b.powerLow}" PowerHigh="${b.powerHigh}"/>`;
      case "SteadyState": return `<SteadyState Duration="${b.duration}" Power="${b.power}"/>`;
      case "Intervals": return `<IntervalsT Repeat="${b.repeat}" OnDuration="${b.onDuration}" OnPower="${b.onPower}" OffDuration="${b.offDuration}" OffPower="${b.offPower}"/>`;
      case "FreeRide": return `<FreeRide Duration="${b.duration}"/>`;
      default: return "";
    }
  }).filter(Boolean).join("\n    ");
  return `<workout_file>\n  <author>Ramp</author>\n  <name>${escXml(day.session)}</name>\n  <description>${escXml(day.detail)}</description>\n  <sportType>${day.type === "run" ? "run" : "bike"}</sportType>\n  <tags/>\n  <workout>\n    ${blocks}\n  </workout>\n</workout_file>`;
}
function downloadZwo(day) {
  const blob = new Blob([buildZwo(day)], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: `${day.date}-${String(day.session || "workout").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}.zwo` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function paceRange(seg) { return seg && seg.pace_low && seg.pace_high ? `${seg.pace_low}–${seg.pace_high}/km` : ""; }
function runPlanEl(rp) {
  if (!rp || !rp.main) return null;
  const rows = [];
  if (rp.warmup) rows.push(["Warm-up", [paceRange(rp.warmup), rp.warmup.duration_min + " min"].filter(Boolean).join(" · ")]);
  const m = rp.main;
  let body;
  if (m.kind === "Intervals") {
    const act = m.active_pace_low ? ` @ ${m.active_pace_low}–${m.active_pace_high}/km` : "", rest = m.rest_pace_low ? ` @ ${m.rest_pace_low}–${m.rest_pace_high}/km` : "";
    body = `${m.repeat} × ${m.active_duration_min} min${act}, ${m.rest_duration_min} min easy${rest} between`;
  } else body = [paceRange(m), m.duration_min + " min"].filter(Boolean).join(" · ");
  rows.push([m.kind || "Main", (m.description ? m.description + ": " : "") + body]);
  if (rp.cooldown) rows.push(["Cool-down", [paceRange(rp.cooldown), rp.cooldown.duration_min + " min"].filter(Boolean).join(" · ")]);
  return h("div", { class: "rp" }, rows.map(([k, v]) => h("div", {}, h("b", {}, k), h("span", {}, v))));
}

function planView() {
  const D = S.data, p = D.plan;
  const wrap = h("div", {});
  if (!p || !Array.isArray(p.days)) { wrap.append(h("div", { class: "banner" }, "No plan yet. It's generated every morning (06:15 weekdays, 08:00 weekends).")); return wrap; }
  const gen = new Date(p.generated_at);
  wrap.append(h("p", { class: "sub", style: { margin: "0 2px 10px" } }, `Plan generated ${gen.toLocaleString(undefined, { weekday: "long", hour: "2-digit", minute: "2-digit" })}`));
  if (p.stale) wrap.append(h("div", { class: "banner warn" }, h("strong", {}, "This morning's update failed. "), "Showing the previous plan. It will retry at the next scheduled run."));
  const notes = [["Recovery today", p.readiness_note], ["Adjustment", p.today_adjustment], ["Last week", p.last_week_summary], ["This week's ramp", p.fitness_note]].filter((x) => x[1]);
  if (notes.length) wrap.append(h("div", { class: "coach" }, notes.map(([t, v]) => h("div", { class: "card" }, h("h3", {}, t), h("p", {}, v)))));
  const days = p.days.filter((d) => d.date >= D.today);
  if (!days.length) wrap.append(h("p", { class: "empty" }, "This plan has ended. A new one is generated at the next scheduled run."));
  days.forEach((d) => {
    const key = d.type === "weights" ? "strength" : d.type;
    const done = D.activities.some((a) => a.date === d.date && a.sport_group === key);
    const hasStruct = (d.type === "bike" || d.type === "run") && d.structure && d.structure.length;
    wrap.append(h("div", { class: "pday" + (d.date === D.today ? " today" : "") },
      h("div", { class: "badge " + d.type }, icon(key, 22)),
      h("div", { class: "main" },
        h("div", { class: "top" }, h("span", { class: "title" }, d.session, done ? h("span", { class: "tag" }, "Done") : null), h("span", { class: "dn" }, (d.date === D.today ? "Today" : D0(d.date).toLocaleDateString(undefined, { weekday: "long" })) + " · " + fmtShort(d.date))),
        h("p", { class: "detail-t" }, d.detail),
        d.type === "run" ? runPlanEl(d.runPlan) : null,
        d.type === "weights" && d.exercises && d.exercises.length ? h("ul", { class: "ex" }, d.exercises.map((e) => h("li", {}, h("b", {}, e.name), ` ${e.sets}×${e.reps}${e.note ? " · " + e.note : ""}`))) : null,
        hasStruct ? h("button", { class: "zwo", type: "button", onclick: () => downloadZwo(d) }, icon("download", 14), ".zwo workout") : null)));
  });
  return wrap;
}

boot();
