// Small dependency-free SVG chart kit: line/area charts with crosshair tooltip, stacked bars with
// per-column tooltip, legends, keyboard support, and a table view for every chart.
// All text goes in through textContent (activity names etc. are untrusted data).

const NS = "http://www.w3.org/2000/svg";

export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function s(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v != null) e.setAttribute(k, v);
  }
  if (parent) parent.append(e);
  return e;
}

function niceScale(min, max, ticks = 4) {
  if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1, step: 0.25 };
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
}

function roundedTop(x, y, w, hgt, r) {
  r = Math.max(0, Math.min(r, w / 2, hgt));
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function legend(items, kind) {
  return h("div", { class: "legend" }, items.map((it) =>
    h("span", { class: "legend-item" },
      h("i", { class: "key " + (kind === "bar" ? "key-bar" : "key-line") + (it.dash ? " key-dash" : ""), style: { background: it.dash ? "transparent" : it.color, color: it.color } }),
      it.name)));
}

function tooltipEl(host) {
  const t = h("div", { class: "chart-tip", role: "status", hidden: true });
  host.append(t);
  return t;
}

function placeTip(tip, host, px, py) {
  tip.hidden = false;
  const hw = host.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = px + 14;
  if (left + tw > hw - 4) left = px - tw - 14;
  left = Math.max(4, left);
  tip.style.left = left + "px";
  tip.style.top = Math.max(0, Math.min(py - th / 2, host.clientHeight - th)) + "px";
}

function fillTip(tip, title, rows) {
  tip.replaceChildren(
    h("div", { class: "tip-title" }, title),
    ...rows.map((r) => h("div", { class: "tip-row" },
      r.color ? h("i", { class: "key " + (r.bar ? "key-bar" : "key-line"), style: { background: r.color } }) : h("i", { class: "key key-none" }),
      h("strong", {}, r.value), h("span", {}, r.name))));
}

/* ------------------------------------------------------------------ line chart */
export function lineChart(host, o) {
  const height = o.height || 200;
  const n = o.labels.length;
  const wrap = h("div", { class: "chart-body" });
  host.replaceChildren(wrap);
  const items = o.series.map((x) => ({ name: x.name, color: x.color, dash: x.dash }));
  if (o.band) items.push({ name: o.band.name, color: o.band.color, bar: true });
  if (items.length > 1) wrap.append(legend(items, "line"));
  const plot = h("div", { class: "plot" });
  wrap.append(plot);
  const tip = tooltipEl(plot);
  let idxFocus = n - 1;

  function draw() {
    plot.querySelectorAll("svg").forEach((x) => x.remove());
    const W = Math.max(220, plot.clientWidth || 320), H = height;
    const m = { l: o.yPad || 40, r: 12, t: 10, b: 24 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: 0, "aria-label": o.title || "chart" });
    plot.prepend(svg);

    let vals = [];
    o.series.forEach((x) => x.values.forEach((v) => v != null && vals.push(v)));
    if (o.band) { o.band.low.concat(o.band.high).forEach((v) => v != null && vals.push(v)); }
    let lo = o.yMin != null ? o.yMin : Math.min(...vals), hi = o.yMax != null ? o.yMax : Math.max(...vals);
    if (o.zeroBase) lo = Math.min(0, lo);
    if (!vals.length) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.06 || 1;
    if (o.yMin == null && !o.zeroBase) lo -= pad;
    if (o.yMax == null) hi += pad;
    const sc = o.yStep ? { min: Math.floor(lo / o.yStep) * o.yStep, max: Math.ceil(hi / o.yStep) * o.yStep, step: o.yStep } : niceScale(lo, hi, 4);
    const y = (v) => { const t = (v - sc.min) / (sc.max - sc.min); return m.t + (o.invertY ? t : 1 - t) * ih; };
    const x = (i) => (n === 1 ? m.l + iw / 2 : m.l + (i / (n - 1)) * iw);

    for (let v = sc.min; v <= sc.max + sc.step / 2; v += sc.step) {
      s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }, svg);
      const t = s("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }, svg);
      t.textContent = (o.yFmt || ((q) => String(Math.round(q * 100) / 100)))(v);
    }
    const nt = Math.min(n, W < 340 ? 4 : 6);
    const seen = new Set();
    for (let k = 0; k < nt; k++) {
      const i = nt === 1 ? 0 : Math.round((k / (nt - 1)) * (n - 1));
      if (seen.has(i)) continue;
      seen.add(i);
      const t = s("text", { x: x(i), y: H - 6, class: "axis", "text-anchor": i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle" }, svg);
      t.textContent = o.labels[i];
    }

    if (o.band) {
      const pts = [];
      for (let i = 0; i < n; i++) if (o.band.low[i] != null && o.band.high[i] != null) pts.push(i);
      if (pts.length > 1) {
        const top = pts.map((i) => `${x(i)},${y(o.band.high[i])}`);
        const bot = pts.slice().reverse().map((i) => `${x(i)},${y(o.band.low[i])}`);
        s("polygon", { points: top.concat(bot).join(" "), fill: o.band.color, opacity: 0.16 }, svg);
      }
    }

    o.series.forEach((ser) => {
      let d = "", pen = false, count = 0;
      ser.values.forEach((v, i) => {
        if (v == null) { if (!o.spanGaps) pen = false; return; }
        d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1);
        pen = true; count++;
      });
      if (ser.fill && count > 1) {
        const first = ser.values.findIndex((v) => v != null);
        const last = ser.values.length - 1 - [...ser.values].reverse().findIndex((v) => v != null);
        s("path", { d: d + `L${x(last)},${y(sc.min)}L${x(first)},${y(sc.min)}Z`, fill: ser.color, opacity: 0.14 }, svg);
      }
      s("path", { d, fill: "none", stroke: ser.color, "stroke-width": ser.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": ser.dash ? "5 4" : null }, svg);
      if (o.markers || count === 1 || (o.spanGaps && count < 40)) {
        ser.values.forEach((v, i) => v != null && s("circle", { cx: x(i), cy: y(v), r: 4, fill: ser.color, stroke: "var(--surface)", "stroke-width": 2 }, svg));
      }
    });

    const cross = s("g", { visibility: "hidden", "pointer-events": "none" }, svg);
    const vline = s("line", { y1: m.t, y2: m.t + ih, class: "crosshair" }, cross);
    const dots = o.series.map((ser) => s("circle", { r: 4, fill: ser.color, stroke: "var(--surface)", "stroke-width": 2 }, cross));

    function show(i) {
      i = Math.max(0, Math.min(n - 1, i));
      idxFocus = i;
      cross.setAttribute("visibility", "visible");
      vline.setAttribute("x1", x(i)); vline.setAttribute("x2", x(i));
      const rows = [];
      let any = false;
      o.series.forEach((ser, k) => {
        const v = ser.values[i];
        if (v == null) { dots[k].setAttribute("visibility", "hidden"); return; }
        any = true;
        dots[k].setAttribute("visibility", "visible");
        dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(v));
        rows.push({ color: ser.color, value: (o.valFmt || o.yFmt || String)(v, ser), name: ser.name });
      });
      if (o.band && o.band.low[i] != null && o.band.high[i] != null) {
        rows.push({ color: o.band.color, bar: true, value: `${(o.valFmt || String)(o.band.low[i])}–${(o.valFmt || String)(o.band.high[i])}`, name: o.band.name });
      }
      if (!any && !rows.length) { hide(); return; }
      fillTip(tip, (o.titles || o.labels)[i], rows);
      placeTip(tip, plot, x(i), m.t + ih / 2);
    }
    function hide() { cross.setAttribute("visibility", "hidden"); tip.hidden = true; }

    const hit = s("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
    const idxAt = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      return n === 1 ? 0 : Math.round(((px - m.l) / iw) * (n - 1));
    };
    hit.addEventListener("pointermove", (ev) => show(idxAt(ev)));
    hit.addEventListener("pointerdown", (ev) => show(idxAt(ev)));
    hit.addEventListener("pointerleave", (ev) => ev.pointerType === "mouse" && hide());
    svg.addEventListener("focus", () => show(idxFocus));
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowLeft") { show(idxFocus - 1); ev.preventDefault(); }
      if (ev.key === "ArrowRight") { show(idxFocus + 1); ev.preventDefault(); }
    });
  }

  draw();
  observe(plot, draw);

  const f = o.valFmt || o.yFmt || String;
  return {
    head: ["", ...o.series.map((x) => x.name), ...(o.band ? [o.band.name] : [])],
    rows: o.labels.map((_, i) => [(o.titles || o.labels)[i],
      ...o.series.map((x) => (x.values[i] == null ? "–" : f(x.values[i], x))),
      ...(o.band ? [o.band.low[i] == null ? "–" : `${f(o.band.low[i])}–${f(o.band.high[i])}`] : [])]),
  };
}

/* ------------------------------------------------------------------ bar chart */
export function barChart(host, o) {
  const height = o.height || 200;
  const n = o.labels.length;
  const wrap = h("div", { class: "chart-body" });
  host.replaceChildren(wrap);
  if (o.series.length > 1) wrap.append(legend(o.series.map((x) => ({ name: x.name, color: x.color })), "bar"));
  const plot = h("div", { class: "plot" });
  wrap.append(plot);
  const tip = tooltipEl(plot);
  const f = o.valFmt || o.yFmt || String;
  let idxFocus = n - 1;

  function draw() {
    plot.querySelectorAll("svg").forEach((x) => x.remove());
    const W = Math.max(220, plot.clientWidth || 320), H = height;
    const m = { l: o.yPad || 36, r: 8, t: 10, b: 24 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: 0, "aria-label": o.title || "chart" });
    plot.prepend(svg);
    const totals = o.labels.map((_, i) => o.series.reduce((a, ser) => a + (ser.values[i] || 0), 0));
    const sc = niceScale(0, Math.max(...totals, o.yMax || 0, 0.001), 4);
    const y = (v) => m.t + (1 - v / sc.max) * ih;
    for (let v = 0; v <= sc.max + sc.step / 2; v += sc.step) {
      s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }, svg);
      const t = s("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }, svg);
      t.textContent = (o.yFmt || String)(v);
    }
    const slot = iw / n, bw = Math.min(30, slot * 0.68);
    const cols = [];
    const every = Math.ceil(n / (W < 340 ? 6 : 10));
    for (let i = 0; i < n; i++) {
      const g = s("g", { class: "col" }, svg);
      cols.push(g);
      const cx = m.l + slot * i + (slot - bw) / 2;
      let acc = 0;
      const segs = o.series.map((ser, k) => ({ ser, k, v: ser.values[i] || 0 })).filter((q) => q.v > 0);
      segs.forEach((q, j) => {
        const y0 = y(acc), y1 = y(acc + q.v);
        acc += q.v;
        const top = j === segs.length - 1;
        const gap = top ? 0 : 2;
        const hh = Math.max(1, y0 - y1 - gap);
        if (top) s("path", { d: roundedTop(cx, y1, bw, hh, 4), fill: q.ser.color }, g);
        else s("rect", { x: cx, y: y1 + gap, width: bw, height: hh, fill: q.ser.color }, g);
      });
      if (i % every === 0 || i === n - 1) {
        const t = s("text", { x: cx + bw / 2, y: H - 6, class: "axis", "text-anchor": "middle" }, svg);
        t.textContent = o.labels[i];
      }
    }
    function show(i) {
      i = Math.max(0, Math.min(n - 1, i)); idxFocus = i;
      cols.forEach((c, k) => c.classList.toggle("dim", k !== i));
      const rows = o.series.map((ser) => ({ color: ser.color, bar: true, value: f(ser.values[i] || 0, ser), name: ser.name })).filter((r, k) => (o.series[k].values[i] || 0) > 0 || o.series.length === 1);
      if (o.series.length > 1) rows.push({ value: f(totals[i]), name: o.totalName || "Total" });
      if (o.extra && o.extra[i]) rows.push(...o.extra[i]);
      fillTip(tip, (o.titles || o.labels)[i], rows);
      const cx = m.l + slot * i + slot / 2;
      placeTip(tip, plot, cx, m.t + ih / 2);
    }
    function hide() { cols.forEach((c) => c.classList.remove("dim")); tip.hidden = true; }
    for (let i = 0; i < n; i++) {
      const r = s("rect", { x: m.l + slot * i, y: m.t, width: slot, height: ih, fill: "transparent" }, svg);
      r.addEventListener("pointermove", () => show(i));
      r.addEventListener("pointerdown", () => show(i));
      r.addEventListener("pointerleave", (ev) => ev.pointerType === "mouse" && hide());
    }
    svg.addEventListener("focus", () => show(idxFocus));
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowLeft") { show(idxFocus - 1); ev.preventDefault(); }
      if (ev.key === "ArrowRight") { show(idxFocus + 1); ev.preventDefault(); }
    });
  }
  draw();
  observe(plot, draw);

  return {
    head: ["", ...o.series.map((x) => x.name), ...(o.series.length > 1 ? [o.totalName || "Total"] : [])],
    rows: o.labels.map((_, i) => [(o.titles || o.labels)[i], ...o.series.map((x) => f(x.values[i] || 0, x)),
      ...(o.series.length > 1 ? [f(o.series.reduce((a, x) => a + (x.values[i] || 0), 0))] : [])]),
  };
}

/* ------------------------------------------------------------------ card with table toggle */
export function chartCard({ title, sub, note }, build) {
  const body = h("div", { class: "chart-host" });
  const tableHost = h("div", { class: "chart-table", hidden: true });
  const btn = h("button", { class: "mini-btn", type: "button", "aria-pressed": "false", title: "Show the data as a table" }, "Table");
  const card = h("section", { class: "card chart-card" },
    h("header", { class: "card-head" }, h("div", {}, h("h3", {}, title), sub ? h("p", { class: "sub" }, sub) : null), btn),
    body, tableHost, note ? h("p", { class: "note" }, note) : null);
  const t = build(body);
  if (t) {
    tableHost.append(h("div", { class: "table-scroll" }, h("table", {},
      h("thead", {}, h("tr", {}, t.head.map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", {}, t.rows.slice().reverse().map((r) => h("tr", {}, r.map((c, i) => (i === 0 ? h("th", { scope: "row" }, c) : h("td", {}, c)))))))));
  }
  btn.addEventListener("click", () => {
    const on = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(on));
    btn.textContent = on ? "Chart" : "Table";
    body.hidden = on; tableHost.hidden = !on;
    if (!on) window.dispatchEvent(new Event("resize"));
  });
  return card;
}

function observe(el, fn) {
  if (!("ResizeObserver" in window)) return;
  let last = el.clientWidth, raf = 0;
  new ResizeObserver(() => {
    if (!el.isConnected) return;
    const w = el.clientWidth;
    if (w === last || w === 0) return;
    last = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fn);
  }).observe(el);
}
