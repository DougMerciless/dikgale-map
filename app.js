// Sebayeng/Dikgale cluster projects map.
// Reads data/projects.json (built from the CSVs by tools/build_data.py).

const STATUS = {
  complete:    { label: "Complete",        color: "--ok" },
  in_progress: { label: "In progress",     color: "--prog" },
  funded:      { label: "Funded",          color: "--fund" },
  deferred:    { label: "Deferred or cut", color: "--cut" },
  planned:     { label: "Planned",         color: "--fund" },
};

const LEVELS = { municipal: "Municipal", district: "District", provincial: "Provincial", national: "National" };

// Every ward in the boundary file (all 45 of Polokwane), and the clusters
// (groups of wards) from data/clusters.csv.
const ALL_WARDS = (window.WARDS?.features || []).map((f) => f.properties.ward).sort((a, b) => a - b);
const CLUSTERS = window.CLUSTERS || [];
const clusterWards = (name) => new Set(CLUSTERS.find((c) => c.name === name)?.wards || []);

// With many pins, labels only show from this zoom level (or on the selected pin).
const LABEL_ZOOM = 13;
const LIST_STEP = 60;

const PIN_TEXT = {
  site: "Pin marks the project site",
  village: "Pin marks the village, not the exact site",
  route: "Line shows the road",
};

const state = { projects: [], selected: null, status: new Set(), sector: "all", level: "all", ward: "all", money: "all", contractor: "all", cluster: "all", sort: "name", shade: false, q: "", listMax: LIST_STEP };
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- helpers ----------
function fmt(n) {
  if (n == null || isNaN(n)) return "–";
  if (n < 0) return "−" + fmt(-n);
  const a = Math.abs(n);
  if (a >= 1e9) return "R" + (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "bn";
  if (a >= 1e6) return "R" + (n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, "") + "m";
  if (a >= 1e3) return "R" + Math.round(n / 1e3) + "k";
  return "R" + Math.round(n);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const hasLoc = (p) => typeof p.lat === "number" && typeof p.lon === "number";

// Compare original vs adjusted across the budget lines that have been adjusted.
function moneyChange(p) {
  const rows = (p.budget || []).filter((r) => r.adjusted != null);
  if (!rows.length) return { kind: "none", delta: 0 };
  const orig = rows.reduce((s, r) => s + (+r.original || 0), 0);
  const adj = rows.reduce((s, r) => s + (+r.adjusted || 0), 0);
  if (orig === 0 && adj > 0) return { kind: "new", delta: adj };
  if (adj > orig) return { kind: "more", delta: adj - orig };
  if (adj < orig) return { kind: "cut", delta: adj - orig, zero: adj === 0 };
  return { kind: "same", delta: 0 };
}

function deltaText(m) {
  if (m.kind === "more") return "+" + fmt(m.delta);
  if (m.kind === "new") return "New " + fmt(m.delta);
  if (m.kind === "cut") return m.zero ? "Cut to R0" : "−" + fmt(-m.delta);
  return "";
}

// "24, 29 to 33" -> [24, 29, 30, 31, 32, 33]
function parseWards(text) {
  const out = new Set();
  for (const part of String(text || "").split(/[,;]/)) {
    const m = part.match(/(\d+)\s*(?:to|-|–)\s*(\d+)/);
    if (m) for (let w = +m[1]; w <= +m[2]; w++) out.add(w);
    else for (const n of part.match(/\d+/g) || []) out.add(+n);
  }
  return out;
}
const projectWards = (p) => { const w = parseWards(p.ward); if (p.mapWard) w.add(p.mapWard); return w; };

// Every company named on a project: contractors and consultants.
const firms = (p) => [...(p.contractor || []), ...(p.consultant || [])];

function matchesQuery(p) {
  if (!state.q) return true;
  const hay = [p.name, p.short, p.village, p.implementer, p.sector, p.id, p.ward && "ward " + p.ward, ...(p.clusters || []), ...firms(p)].join(" ").toLowerCase();
  return state.q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
}

function isVisible(p) {
  if (!matchesQuery(p)) return false;
  if (state.ward !== "all" && !projectWards(p).has(+state.ward)) return false;
  if (state.cluster !== "all" && !(p.clusters || []).includes(state.cluster)) return false;
  if (state.status.size && !state.status.has(p.status)) return false;
  if (state.sector !== "all" && p.sector !== state.sector) return false;
  if (state.level !== "all" && p.level !== state.level) return false;
  if (state.money !== "all" && moneyChange(p).kind !== state.money) return false;
  if (state.contractor !== "all" && !firms(p).includes(state.contractor)) return false;
  return true;
}

// ---------- map ----------
// Two backends behind one small interface: Google Maps when config.js has an
// API key, otherwise Leaflet with free satellite/street tiles. Pins are the
// same HTML element in both, so they share the page's CSS colours.
let mapApi = null;   // { addMarker(pos, el, title, onClick) -> setZ(z), addRoute(lines, title, onClick) -> setStyle(s), fit(points), panTo(pos), onView(cb) }
const markers = {};  // id -> { setZ, el, setRoute }

function markerEl(p) {
  const el = document.createElement("div");
  el.className = "pin" + (p.pin === "village" ? " approx" : "") + (p.pin === "route" ? " onroute" : "");
  el.innerHTML = `<i class="ring"></i><i class="dot"></i><span class="lbl">${esc(p.short || p.name)}</span>`;
  el.title = p.name;
  return el;
}

function drawMarkers() {
  if (!mapApi) return;
  const seen = {};
  for (const p of state.projects.filter(hasLoc)) {
    let entry = markers[p.id];
    if (!entry) {
      // Nudge projects that share a location so both stay clickable.
      const key = p.lat.toFixed(4) + "," + p.lon.toFixed(4);
      const n = (seen[key] = (seen[key] || 0) + 1);
      const el = markerEl(p);
      const setZ = mapApi.addMarker({ lat: p.lat + (n - 1) * 0.0025, lng: p.lon }, el, p.name, () => select(p.id, true));
      const setRoute = p.route && mapApi.addRoute ? mapApi.addRoute(p.route, p.name, () => select(p.id, true)) : null;
      entry = markers[p.id] = { setZ, el, setRoute };
    }
    const m = moneyChange(p);
    const st = STATUS[p.status] || STATUS.planned;
    const el = entry.el;
    el.style.setProperty("--c", `var(${st.color})`);
    if (entry.setRoute) entry.setRoute({ color: css(st.color), dim: !isVisible(p), sel: state.selected === p.id });
    el.dataset.money = m.kind;
    el.classList.toggle("dim", !isVisible(p));
    el.classList.toggle("sel", state.selected === p.id);
    entry.setZ(state.selected === p.id ? 1000 : isVisible(p) ? 10 : 1);
  }
  requestAnimationFrame(declutter);
}

// Keep labels from overlapping each other, the pins, the map edge and the map
// controls: try each label on the right of its pin, then left, above and
// below, else hide it (it shows again on hover). Selected and visible pins get
// first pick. On a narrow map only the selected pin keeps its label.
function declutter() {
  const box = $("map").getBoundingClientRect();
  const narrow = box.width < 560;
  // Many pins: no labels until zoomed in, so the overview stays readable.
  const zoomedOut = Object.keys(markers).length > 60 && mapApi?.getZoom && mapApi.getZoom() < LABEL_ZOOM;
  $("map").dataset.zoomedOut = zoomedOut ? "1" : "";
  $("map").classList.toggle("far", !!(mapApi?.getZoom && mapApi.getZoom() < 12));
  const order = state.projects.filter((p) => markers[p.id])
    .sort((a, b) => (b.id === state.selected) - (a.id === state.selected) || isVisible(b) - isVisible(a));
  const taken = order.map((p) => markers[p.id].el.querySelector(".dot").getBoundingClientRect());
  for (const c of $("map").querySelectorAll(".leaflet-control, .gmnoprint, .gm-fullscreen-control")) taken.push(c.getBoundingClientRect());
  const hits = (r) => r.left < box.left + 4 || r.right > box.right - 4 || r.top < box.top + 4 || r.bottom > box.bottom - 4 ||
    taken.some((t) => r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top);
  const spots = ["", "left", "up", "down"];
  for (const p of order) {
    const el = markers[p.id].el;
    el.classList.remove("left", "up", "down", "nolbl");
    if ((narrow || zoomedOut) && p.id !== state.selected) { el.classList.add("nolbl"); continue; }
    const spot = spots.find((c) => {
      el.classList.remove("left", "up", "down");
      if (c) el.classList.add(c);
      return !hits(el.querySelector(".lbl").getBoundingClientRect());
    });
    if (spot === undefined) { el.classList.remove("left", "up", "down"); el.classList.add("nolbl"); continue; }
    taken.push(el.querySelector(".lbl").getBoundingClientRect());
  }
}

// Label point for a ward: area-weighted centroid of its largest ring.
function wardCentre(geom) {
  const polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
  let best = null, bestA = 0;
  for (const poly of polys) {
    const r = poly[0]; let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < r.length - 1; i++) {
      const c = r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
      A += c; cx += (r[i][0] + r[i + 1][0]) * c; cy += (r[i][1] + r[i + 1][1]) * c;
    }
    if (Math.abs(A) > bestA) { bestA = Math.abs(A); best = { lat: cy / (3 * A), lng: cx / (3 * A) }; }
  }
  return best;
}

function wardLabel(n) {
  const el = document.createElement("div");
  el.className = "wardlbl";
  el.textContent = "Ward " + n;
  return el;
}

function fitTo(list) {
  const pts = list.filter(hasLoc).map((p) => ({ lat: p.lat, lng: p.lon }));
  if (mapApi && pts.length) mapApi.fit(pts);
}
const fitAll = () => fitTo(state.cluster !== "all" ? state.projects.filter(isVisible) : state.projects);

// ---------- money by area ----------
// A project's 2025/26 budget: the adjusted figure where there is one, else the
// original. A project listed in several wards is split equally between them,
// so ward and cluster totals add up to the municipal total.
function budget2526(p) {
  return (p.budget || []).filter((r) => r.fy === "2025/26").reduce((t, r) => t + (r.adjusted != null ? +r.adjusted || 0 : +r.original || 0), 0);
}
const planned2627 = (p) => (p.budget || []).filter((r) => r.fy === "2026/27").reduce((t, r) => t + (+r.original || 0), 0);
function shareWards(p) {
  const w = [...parseWards(p.ward)].filter((n) => ALL_WARDS.includes(n));
  return w.length ? w : p.mapWard ? [p.mapWard] : [];
}
// Every filter except ward and cluster, so the table compares areas.
function visibleAnyArea(p) {
  const keep = [state.ward, state.cluster];
  state.ward = state.cluster = "all";
  const v = isVisible(p);
  [state.ward, state.cluster] = keep;
  return v;
}
function moneyByWard() {
  const by = new Map(ALL_WARDS.map((w) => [w, { amount: 0, added: 0, cut: 0, planned: 0, n: 0 }]));
  const none = { amount: 0, added: 0, cut: 0, planned: 0, n: 0 };
  for (const p of state.projects.filter(visibleAnyArea)) {
    const ws = shareWards(p), k = ws.length || 1, g = gain(p);
    for (const t of ws.length ? ws.map((w) => by.get(w)) : [none]) {
      t.amount += budget2526(p) / k; t.planned += planned2627(p) / k; t.n += 1;
      if (g > 0) t.added += g / k; else t.cut += g / k;
    }
  }
  return { by, none };
}

function renderAreas() {
  const { by, none } = (wardCache = moneyByWard());
  const shown = state.projects.filter(visibleAnyArea);
  const nIn = (ws) => shown.filter((p) => shareWards(p).some((w) => ws.includes(w))).length;
  const sum = (ws) => ws.reduce((t, w) => { const x = by.get(w); for (const k in t) t[k] += x[k]; return t; }, { amount: 0, added: 0, cut: 0, planned: 0, n: 0 });
  const rows = CLUSTERS.map((c) => ({ name: c.name, ...sum(c.wards), n: nIn(c.wards) })).sort((a, b) => b.amount - a.amount);
  const total = rows.reduce((t, r) => ({ ...t, amount: t.amount + r.amount, added: t.added + r.added, cut: t.cut + r.cut, planned: t.planned + r.planned }), { ...none, n: shown.length });
  const max = Math.max(1, ...rows.map((r) => r.amount));
  const row = (r, cls = "") => `<tr class="${cls}"${r.name && cls !== "tot" && cls !== "nw" ? ` data-cluster="${esc(r.name)}" tabindex="0"` : ""}>
      <th scope="row">${esc(r.name)}</th>
      <td class="n">${r.n ?? ""}</td>
      <td class="n">${fmt(r.amount)}${cls === "tot" || cls === "nw" ? "" : `<div class="bar"><i style="width:${(r.amount / max * 100).toFixed(1)}%;background:var(--fund)"></i></div>`}</td>
      <td class="n up">${r.added ? "+" + fmt(r.added) : "–"}</td>
      <td class="n">${r.cut ? "−" + fmt(-r.cut) : "–"}</td>
      <td class="n">${fmt(r.planned)}</td></tr>`;
  $("areas").innerHTML = `
    <h3 class="sect">Where the money goes</h3>
    <p class="hint">2025/26 budget per cluster for the projects matching your filters (sector, level, status). Click a cluster to show it on the map.</p>
    <div class="tablewrap"><table class="budget areatable">
      <thead><tr><th>Cluster</th><th class="n">Projects</th><th class="n">2025/26 budget</th><th class="n">Added mid-year</th><th class="n">Cut mid-year</th><th class="n">2026/27 planned</th></tr></thead>
      <tbody>${rows.map((r) => row(r, r.name === state.cluster ? "sel" : "")).join("")}
        ${row({ name: "No ward given (municipality-wide)", ...none }, "nw")}
        ${row({ name: "Total", ...total }, "tot")}</tbody></table></div>
    <p class="hint">2025/26 budget is the adjusted amount where the adjustments budget gives one, otherwise the original. A project in several wards is split equally between them, so a project counts in every cluster it touches but its money is not counted twice. Projects with no ward are shown separately.</p>`;
  for (const tr of $("areas").querySelectorAll("tr[data-cluster]")) {
    const go = () => { state.cluster = state.cluster === tr.dataset.cluster ? "all" : tr.dataset.cluster; state.ward = "all"; render(); fitAll(); $("map").scrollIntoView({ behavior: "smooth", block: "center" }); };
    tr.onclick = go;
    tr.onkeydown = (e) => { if (e.key === "Enter") go(); };
  }
  if (mapApi?.shadeWards) mapApi.shadeWards(state.shade ? by : null);
  renderShadeLegend(by);
}

// Sequential ramp: one hue (--fund) from light to dark, mixed with the page colour.
function hex(c) { const m = c.replace("#", ""); return [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16)); }
function mix(a, b, t) { const A = hex(a), B = hex(b); return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join(""); }
let shadeBins = [];
function shadeColour(v) {
  if (!v) return null;
  const i = shadeBins.findIndex((b) => v <= b);
  return mix(css("--paper"), css("--fund"), [0.18, 0.36, 0.54, 0.72, 0.92][i < 0 ? 4 : i]);
}
function renderShadeLegend(by) {
  const vals = [...by.values()].map((x) => x.amount).filter((v) => v > 0).sort((a, b) => a - b);
  shadeBins = [0.2, 0.4, 0.6, 0.8, 1].map((q) => vals[Math.min(vals.length - 1, Math.floor(q * vals.length) - (q === 1 ? 1 : 0))] || 0);
  const box = $("shadeLegend");
  box.classList.toggle("hidden", !state.shade);
  let lo = 0;
  box.innerHTML = "Ward 2025/26 budget: " + shadeBins.map((b, i) => {
    const t = `<span><i class="sw sq" style="background:${mix(css("--paper"), css("--fund"), [0.18, 0.36, 0.54, 0.72, 0.92][i])}"></i>${fmt(lo)}–${fmt(b)}</span>`;
    lo = b; return t;
  }).join("") + '<span><i class="sw sq none"></i>none</span>';
  $("shade").setAttribute("aria-pressed", state.shade);
  $("shade").textContent = state.shade ? "Hide ward shading" : "Shade wards by budget";
}

// ---------- sorting ----------
// Latest document date that mentions the project (history is sorted by date).
const lastSeen = (p) => (p.history || []).reduce((d, h) => (h.date > d ? h.date : d), "");
const SORTS = {
  name:    { label: "Name (A to Z)",           cmp: (a, b) => a.name.localeCompare(b.name) },
  budget:  { label: "Biggest budget",          cmp: (a, b) => (headline(b)?.amount || 0) - (headline(a)?.amount || 0) },
  added:   { label: "Most money added",        cmp: (a, b) => gain(b) - gain(a) },
  cut:     { label: "Biggest cut",             cmp: (a, b) => gain(a) - gain(b) },
  recent:  { label: "Most recently reported",  cmp: (a, b) => lastSeen(b).localeCompare(lastSeen(a)) },
};
// Change at the mid-year adjustment in rands (negative for a cut, 0 when none).
const gain = (p) => { const m = moneyChange(p); return m.kind === "none" || m.kind === "same" ? 0 : m.delta; };
const sorted = (list) => list.slice().sort((a, b) => (SORTS[state.sort] || SORTS.name).cmp(a, b) || a.name.localeCompare(b.name));

// ---------- side panel ----------
// The money figure uses the same rule as the "Where the money goes" table:
// each project's 2025/26 budget, adjusted where it was revised mid-year,
// otherwise the original.
function renderTally() {
  let more = 0, cut = 0, total = 0;
  for (const p of state.projects) {
    const m = moneyChange(p);
    if (m.kind === "more" || m.kind === "new") more++;
    if (m.kind === "cut") cut++;
    total += budget2526(p);
  }
  const noFigs = state.projects.filter((p) => !(p.budget || []).length).length;
  const caption = ["2025/26 budgets across all levels of government (adjusted where revised mid-year)",
    noFigs ? `${noFigs} project${noFigs > 1 ? "s" : ""} with no figures yet` : ""].filter(Boolean).join("; ");
  const levels = new Set(state.projects.map((p) => p.level)).size;
  $("tally").innerHTML = state.projects.length
    ? `<div class="stat"><b>${state.projects.length}</b><span>projects tracked across ${levels} levels of government</span></div>
       <div class="stat"><b>${fmt(total)}</b><span>${esc(caption)}</span></div>
       <div class="stat more"><b>▲ ${more}</b><span>got more money mid-year</span></div>
       <div class="stat cut"><b>▼ ${cut}</b><span>were cut, some to nothing</span></div>`
    : "";
}

function renderFilters() {
  const box = $("statusChips");
  box.innerHTML = "";
  for (const [key, s] of Object.entries(STATUS)) {
    if (!state.projects.some((p) => p.status === key)) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = s.label;
    b.setAttribute("aria-pressed", state.status.has(key));
    b.onclick = () => { state.status.has(key) ? state.status.delete(key) : state.status.add(key); render(); };
    box.appendChild(b);
  }
  const sectors = [...new Set(state.projects.map((p) => p.sector).filter(Boolean))].sort();
  $("sector").innerHTML = '<option value="all">All sectors</option>' +
    sectors.map((s) => `<option ${s === state.sector ? "selected" : ""}>${esc(s)}</option>`).join("");
  const count = (k) => state.projects.filter((p) => p.level === k).length;
  $("level").innerHTML = '<option value="all">All government levels</option>' +
    Object.entries(LEVELS).filter(([k]) => count(k))
      .map(([k, l]) => `<option value="${k}" ${k === state.level ? "selected" : ""}>${l} (${count(k)})</option>`).join("");
  const wcount = (w) => state.projects.filter((p) => projectWards(p).has(w)).length;
  const names = [...new Set(state.projects.flatMap(firms))].sort((a, b) => a.localeCompare(b));
  const fcount = (n) => state.projects.filter((p) => firms(p).includes(n)).length;
  $("contractor").classList.toggle("hidden", !names.length);
  $("contractor").innerHTML = '<option value="all">All contractors</option>' +
    names.map((n) => `<option value="${esc(n)}" ${n === state.contractor ? "selected" : ""}>${esc(n)} (${fcount(n)})</option>`).join("");
  const inCluster = state.cluster === "all" ? null : clusterWards(state.cluster);
  $("ward").innerHTML = '<option value="all">All wards</option>' +
    ALL_WARDS.filter((w) => !inCluster || inCluster.has(w))
      .map((w) => `<option value="${w}" ${String(w) === state.ward ? "selected" : ""}>Ward ${w} (${wcount(w)})</option>`).join("");
  const ccount = (n) => state.projects.filter((p) => (p.clusters || []).includes(n)).length;
  $("cluster").classList.toggle("hidden", !CLUSTERS.length);
  $("cluster").innerHTML = '<option value="all">All clusters</option>' +
    CLUSTERS.map((c) => `<option value="${esc(c.name)}" ${c.name === state.cluster ? "selected" : ""}>${esc(c.name)} (${ccount(c.name)})</option>`).join("");
}

function renderList() {
  const ul = $("list");
  ul.innerHTML = "";
  const visible = sorted(state.projects.filter(isVisible));
  $("sort").innerHTML = Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === state.sort ? "selected" : ""}>Sort: ${v.label}</option>`).join("");
  if (!visible.length) {
    ul.innerHTML = '<li class="empty">No projects match these filters. Clear a filter to see more.</li>';
    return;
  }
  for (const p of visible.slice(0, state.listMax)) {
    const m = moneyChange(p);
    const st = STATUS[p.status] || STATUS.planned;
    const meta = [LEVELS[p.level], p.village, p.ward ? "Ward " + p.ward : "", !hasLoc(p) ? "not on map yet" : p.pin === "village" ? "approximate pin" : ""].filter(Boolean).join(", ");
    const li = document.createElement("li");
    const h = headline(p);
    li.innerHTML = `<button type="button" class="item${state.selected === p.id ? " sel" : ""}" style="--c:var(${st.color})">
      <span class="body">
        <span class="kick">${esc(p.sector)} · <i>${st.label}</i></span>
        <span class="t">${esc(p.name)}</span>
        <span class="m">${esc(meta)}</span>${badges(p)}
      </span>
      <span class="fig">
        ${h ? `<b>${fmt(h.amount)}</b><small>${esc(h.fy)} ${h.kind}</small>` : '<small>no figures</small>'}
        ${deltaText(m) ? `<span class="delta ${m.kind}">${deltaText(m)}</span>` : ""}
      </span></button>`;
    li.firstElementChild.onclick = () => select(p.id, false);
    ul.appendChild(li);
  }
  if (visible.length > state.listMax) {
    const li = document.createElement("li");
    li.className = "more";
    li.innerHTML = `<button type="button" class="chip">Show ${Math.min(LIST_STEP, visible.length - state.listMax)} more of ${visible.length - state.listMax}</button>`;
    li.firstElementChild.onclick = () => { state.listMax += LIST_STEP; renderList(); };
    ul.appendChild(li);
  }
}

// One headline figure per project: the latest adjusted budget if there is
// one, otherwise the first year's original amount.
function headline(p) {
  const rows = p.budget || [];
  const adj = rows.filter((r) => r.adjusted != null);
  if (adj.length) {
    const fy = adj[adj.length - 1].fy;
    return { amount: adj.filter((r) => r.fy === fy).reduce((t, r) => t + (+r.adjusted || 0), 0), fy, kind: "adjusted" };
  }
  const yearly = rows.filter((r) => r.fy !== "total");
  if (yearly.length) {
    const fy = yearly[0].fy;
    return { amount: yearly.filter((r) => r.fy === fy).reduce((t, r) => t + (+r.original || 0), 0), fy, kind: "planned" };
  }
  // Some documents give only a total project cost, with no yearly split.
  if (rows.length) return { amount: rows.reduce((t, r) => t + (+r.original || 0), 0), fy: "Total", kind: "project cost" };
  return null;
}

function badges(p) {
  const b = [];
  if (p.progress) b.push(`<span class="tag">${esc(p.progress)} done</span>`);
  if (p.dataIssue) b.push('<span class="tag warn">Figures disputed</span>');
  return b.length ? `<br>${b.join("")}` : "";
}

function pct(text) {
  const m = String(text || "").match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Math.min(100, +m[1]) : null;
}

// What each document said over time. The summary shows one line per
// financial year: each document's figure in date order, with ▲/▼ against the
// previous figure on the same VAT basis. The full list sits underneath.
function historyTable(p) {
  const rows = p.history || [];
  if (!rows.length) return "";
  // One step per document, year and VAT basis: add up a document's funding lines.
  const byFy = {}, seen = {};
  for (const h of rows) {
    if (h.amount == null || !h.fy) continue;
    const key = [h.date, h.document, h.fy, h.vat === "incl"].join("|");
    if (seen[key]) { seen[key].amount += h.amount; seen[key].note += " + " + (h.note || ""); continue; }
    (byFy[h.fy] = byFy[h.fy] || []).push((seen[key] = { ...h, note: h.note || "" }));
  }
  const fys = Object.keys(byFy).sort((a, b) => (a === "total") - (b === "total") || a.localeCompare(b));
  const chart = historyChart(byFy, fys);
  const lines = fys.map((fy) => {
    const last = {};
    const steps = byFy[fy].map((h) => {
      const basis = h.vat === "incl" ? "incl" : "excl";
      const prev = last[basis];
      last[basis] = h.amount;
      const cls = prev == null || prev === h.amount ? "" : h.amount > prev ? " up" : " down";
      const mark = prev == null || prev === h.amount ? "" : h.amount > prev ? "▲" : "▼";
      return `<span class="step${cls}${basis === "incl" ? " incl" : ""}" title="${esc(h.date + " · " + h.document + (h.note ? " · " + h.note : ""))}">${mark}${fmt(h.amount)}${basis === "incl" ? "<sup>incl</sup>" : ""}</span>`;
    });
    return `<div class="traj${chart && byFy[fy].length > 1 ? " charted" : ""}"><span class="fy">${fy === "total" ? "Total cost" : esc(fy)}</span><span>${chart && byFy[fy].length > 1 ? chart.svg[fy] : ""}<span class="steps">${steps.join('<i class="arr">→</i>')}</span></span></div>`;
  }).join("") + (chart ? chart.axis : "");
  const progress = rows.filter((h) => h.progress).map((h) => `<li><b>${esc(h.date)}</b> ${esc(h.progress)} <span class="hint">(${esc(h.document)})</span></li>`).join("");
  const body = rows.map((h) => `<tr>
      <td class="d">${esc(h.date)}</td>
      <td>${esc(h.document)}${h.note ? `<br><span class="hint">${esc(h.note)}</span>` : ""}</td>
      <td>${esc(h.fy === "total" ? "Total" : h.fy)}</td>
      <td class="n">${h.amount != null ? fmt(h.amount) : ""}${h.vat === "incl" ? "<sup>incl</sup>" : ""}${h.progress ? `<br><span class="hint">${esc(h.progress)}</span>` : ""}</td></tr>`).join("");
  return `<section class="hist">
    <h4>How the budget moved</h4>
    ${lines || '<p class="hint">No amounts on record, only progress notes.</p>'}
    ${progress ? `<ul class="milestones">${progress}</ul>` : ""}
    <p class="hint">Each figure is one document, oldest first.${chart ? " The charts share one scale and one timeline; each step is a new document." : ""} Hover for the document name. ▲ ▼ compare with the previous figure for the same year. <sup>incl</sup> means VAT included.</p>
    <details><summary>All ${rows.length} entries, with page references</summary>
      <table class="budget"><thead><tr><th>Date</th><th>Document</th><th>Year</th><th class="n">Amount</th></tr></thead><tbody>${body}</tbody></table>
    </details></section>`;
}

// One small step chart per financial year, all on the same money scale and
// timeline, so a year that was cut reads as lower than one that grew. A step
// up is red, a step down grey. Only drawn when some year has two or more
// documents to compare.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (d) => { const [y, m] = String(d).split("-").map(Number); return y * 12 + (m || 1) - 1; };
const monthText = (n) => MONTHS[n % 12] + " " + Math.floor(n / 12);

function historyChart(byFy, fys) {
  if (!fys.some((fy) => byFy[fy].length > 1)) return null;
  const all = fys.flatMap((fy) => byFy[fy]);
  const t0 = Math.min(...all.map((h) => month(h.date))), t1 = Math.max(...all.map((h) => month(h.date)));
  const max = Math.max(1, ...all.map((h) => h.amount));
  const W = 300, H = 54, pad = 7;
  const x = (h) => t1 === t0 ? W / 2 : pad + (month(h.date) - t0) / (t1 - t0) * (W - 2 * pad);
  const y = (v) => H - pad - v / max * (H - 2 * pad);
  const svg = {};
  for (const fy of fys) {
    const parts = [];
    for (const basis of ["excl", "incl"]) {
      const pts = byFy[fy].filter((h) => (h.vat === "incl" ? "incl" : "excl") === basis);
      if (!pts.length) continue;
      const d = pts.map((h, i) => (i ? `H${x(h).toFixed(1)}V${y(h.amount).toFixed(1)}` : `M${x(h).toFixed(1)} ${y(h.amount).toFixed(1)}`)).join("");
      parts.push(`<path d="${d}" class="ln${basis === "incl" ? " incl" : ""}"/>`);
      pts.forEach((h, i) => {
        const prev = i ? pts[i - 1].amount : null;
        const cls = prev == null || prev === h.amount ? "" : h.amount > prev ? " up" : " down";
        const tip = `${h.document} (${monthText(month(h.date))}): ${fmt(h.amount)}${basis === "incl" ? " incl. VAT" : ""}` +
          (prev == null || prev === h.amount ? "" : ` · ${h.amount > prev ? "+" : "−"}${fmt(Math.abs(h.amount - prev))} on the previous document`);
        parts.push(`<circle cx="${x(h).toFixed(1)}" cy="${y(h.amount).toFixed(1)}" r="4" class="pt${cls}${basis === "incl" ? " incl" : ""}"/>` +
          `<circle cx="${x(h).toFixed(1)}" cy="${y(h.amount).toFixed(1)}" r="11" class="hit" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}"/>`);
      });
    }
    svg[fy] = `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(fy)} budget by document">
      <line x1="0" x2="${W}" y1="${H - pad}" y2="${H - pad}" class="base"/>${parts.join("")}</svg>`;
  }
  const axis = `<div class="traj axis"><span class="fy">Scale</span><span class="ax"><span>${monthText(t0)}</span><span>height R0 to ${fmt(max)}</span><span>${monthText(t1)}</span></span></div>`;
  return { svg, axis };
}

// A company name in the detail panel filters the list to that company's projects.
const firmLink = (n) => `<button type="button" class="linkbtn firm" data-firm="${esc(n)}">${esc(n)}</button>`;

function renderDetail() {
  const box = $("detail");
  const p = state.projects.find((x) => x.id === state.selected);
  if (!p) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");

  const st = STATUS[p.status] || STATUS.planned;
  const m = moneyChange(p);
  const rows = p.budget || [];
  const max = Math.max(1, ...rows.map((r) => Math.max(+r.original || 0, +r.adjusted || 0)));
  const budgetRows = rows.map((r) => {
    const planned = r.adjusted == null;
    const o = +r.original || 0, a = planned ? 0 : +r.adjusted || 0;
    const color = planned ? "--fund" : a > o ? "--more" : a < o ? "--cut" : "--ok";
    return `<tr>
      <td>${r.fy === "total" ? "Total cost" : esc(r.fy)}<br><span class="hint">${esc(r.label)}</span></td>
      <td class="n">${fmt(o)}</td>
      <td class="n">${r.fy === "total" ? "–" : planned ? "Planned" : fmt(a)}</td>
      <td style="width:28%">
        <div class="bar"><i style="width:${(o / max * 100).toFixed(1)}%;background:var(--line)"></i></div>
        ${planned ? "" : `<div class="bar"><i style="width:${(a / max * 100).toFixed(1)}%;background:var(${color})"></i></div>`}
      </td></tr>`;
  }).join("");

  const h = headline(p);
  box.style.setProperty("--c", `var(${st.color})`);
  box.innerHTML = `
    <button type="button" class="close" aria-label="Close project">×</button>
    <span class="kick">${esc(p.sector)} · ${LEVELS[p.level] || ""}${p.ward ? " · Ward " + esc(p.ward) : ""}</span>
    <h2>${esc(p.name)}</h2>
    <span class="status"><i class="sw" style="background:var(${st.color})"></i>${st.label}${p.statusNote ? ": " + esc(p.statusNote) : ""}</span>
    ${h ? `<div class="bigfig"><div><b>${fmt(h.amount)}</b><span>${h.fy === "Total" ? "total project cost" : esc(h.fy) + " " + h.kind + " budget"}</span></div>
      ${deltaText(m) ? `<div class="delta ${m.kind}"><b>${deltaText(m)}</b><span>change at mid-year adjustment</span></div>` : ""}</div>` : ""}
    ${p.dataIssue ? `<p class="issue"><b>Figures disputed:</b> ${esc(p.dataIssue)}</p>` : ""}
    ${pct(p.progress) != null ? `<div class="prog"><div class="bar"><i style="width:${pct(p.progress)}%;background:var(${pct(p.progress) >= 100 ? "--ok" : "--prog"})"></i></div><span>${esc(p.progress)} complete${p.due ? ", due " + esc(p.due) : ""}</span></div>` : ""}
    <dl class="kv">
      ${p.implementer ? `<dt>Implementer</dt><dd>${esc(p.implementer)}</dd>` : ""}
      <dt>Contractor</dt><dd>${(p.contractor || []).length ? p.contractor.map(firmLink).join(", ") : '<span class="hint">Not named in the documents we found</span>'}</dd>
      ${(p.consultant || []).length ? `<dt>Consultant</dt><dd>${p.consultant.map(firmLink).join(", ")}</dd>` : ""}
      ${p.contractNote ? `<dt>Contract</dt><dd class="hint">${esc(p.contractNote)}</dd>` : ""}
      ${p.level ? `<dt>Government</dt><dd>${LEVELS[p.level]}</dd>` : ""}
      ${p.sector ? `<dt>Sector</dt><dd>${esc(p.sector)}</dd>` : ""}
      ${p.village ? `<dt>Area</dt><dd>${esc(p.village)}${p.ward ? ", ward " + esc(p.ward) : ""}</dd>` : ""}
      ${p.mapWard && !parseWards(p.ward).has(p.mapWard) ? `<dt>Pin is in</dt><dd>Ward ${p.mapWard}</dd>` : ""}
      ${hasLoc(p) ? `<dt>On the map</dt><dd>${PIN_TEXT[p.pin] || PIN_TEXT.site}${p.routeNote ? `<br><span class="hint">${esc(p.routeNote)}</span>` : ""}</dd>` : `<dt>On the map</dt><dd>Not on the map: no site published</dd>`}
    </dl>
    ${rows.length
      ? `<table class="budget"><thead><tr><th>Year</th><th class="n">Original</th><th class="n">Adjusted</th><th></th></tr></thead><tbody>${budgetRows}</tbody></table>
         <p class="hint">Rands, from the budget documents listed below. Municipal figures exclude VAT.</p>`
      : '<p class="note hint">No budget figures on record yet.</p>'}
    ${historyTable(p)}
    ${p.note ? `<p class="note">${esc(p.note)}</p>` : ""}
    ${(p.sources || []).length ? `<div class="src">${p.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label || s.url)}</a>`).join("")}</div>` : ""}
    <div class="actions">
      <button type="button" class="btn copy">Copy link to this project</button>
      ${hasLoc(p) ? `<a class="btn alt" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}">Open in Google Maps ↗</a>` : ""}
    </div>`;
  box.querySelector(".close").onclick = () => { state.selected = null; render(); };
  box.querySelector(".copy").onclick = (e) => copyLink(e.currentTarget, projectUrl(p.id));
  for (const b of box.querySelectorAll(".firm")) b.onclick = () => { state.contractor = b.dataset.firm; render(); };
}

// ---------- shareable links ----------
// The filters and the open project live in the address, e.g.
// ?p=road-titibe-makgoba or ?ward=32&status=deferred. Other parameters
// (such as theme) are kept.
function readUrl() {
  const u = new URLSearchParams(location.search);
  state.selected = u.get("p") || null;
  state.q = u.get("q") || "";
  state.status = new Set((u.get("status") || "").split(",").filter((k) => STATUS[k]));
  for (const k of ["sector", "ward", "level", "money", "contractor", "cluster"]) state[k] = u.get(k) || "all";
  state.sort = SORTS[u.get("sort")] ? u.get("sort") : "name";
  state.shade = u.get("shade") === "1";
  $("q").value = state.q;
  $("money").value = state.money;
}

function writeUrl() {
  const u = new URLSearchParams(location.search);
  const set = (k, v) => (v ? u.set(k, v) : u.delete(k));
  set("p", state.selected);
  set("q", state.q);
  set("status", [...state.status].join(","));
  for (const k of ["sector", "ward", "level", "money", "contractor", "cluster"]) set(k, state[k] === "all" ? "" : state[k]);
  set("sort", state.sort === "name" ? "" : state.sort);
  set("shade", state.shade ? "1" : "");
  const qs = u.toString().replace(/%2C/g, ",");
  history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
}

function projectUrl(id) {
  const u = new URLSearchParams();
  const theme = new URLSearchParams(location.search).get("theme");
  if (theme) u.set("theme", theme);
  u.set("p", id);
  return location.origin + location.pathname + "?" + u;
}

async function copyLink(btn, url) {
  try { await navigator.clipboard.writeText(url); btn.textContent = "Link copied"; }
  catch { window.prompt("Copy this link:", url); }
  setTimeout(() => { btn.textContent = "Copy link to this project"; }, 2000);
}

// ---------- CSV download ----------
function csvCell(v) {
  const t = v == null ? "" : String(v);
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function downloadCsv() {
  const head = ["id", "name", "sector", "status", "status_note", "level", "implementer", "contractor", "consultant", "contract_note", "ward", "village", "lat", "lon", "pin",
    "headline_fy", "headline_amount", "headline_kind", "budget_change", "budget_change_rands", "budget_lines", "link", "sources"];
  const rows = sorted(state.projects.filter(isVisible)).map((p) => {
    const h = headline(p), m = moneyChange(p);
    const lines = (p.budget || []).map((r) => `${r.fy} ${r.label || ""}: original ${r.original}${r.adjusted != null ? ", adjusted " + r.adjusted : ""}`.replace(/\s+:/, ":")).join("; ");
    return [p.id, p.name, p.sector, STATUS[p.status]?.label, p.statusNote, LEVELS[p.level], p.implementer, (p.contractor || []).join("; "), (p.consultant || []).join("; "), p.contractNote, p.ward, p.village,
      p.lat, p.lon, p.pin, h?.fy, h?.amount, h?.kind, m.kind === "none" ? "" : m.kind, m.delta || "", lines, projectUrl(p.id),
      (p.sources || []).map((x) => x.url).join(" ")];
  });
  const text = "\uFEFF" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = "sebayeng-dikgale-projects.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderCount() {
  const n = state.projects.filter(isVisible).length;
  $("count").textContent = n === state.projects.length ? `All ${n} projects` : `Showing ${n} of ${state.projects.length} projects`;
  $("csv").textContent = `Download ${n === state.projects.length ? "all" : "these " + n} as CSV`;
  $("csv").disabled = !n;
  $("clear").classList.toggle("hidden", n === state.projects.length && !state.q);
}

function clearFilters() {
  Object.assign(state, { status: new Set(), sector: "all", level: "all", ward: "all", money: "all", contractor: "all", cluster: "all", q: "", listMax: LIST_STEP });
  $("q").value = ""; $("money").value = "all";
  render();
}

// ---------- tooltip for chart points ----------
const tip = document.createElement("div");
tip.className = "tip hidden";
tip.setAttribute("role", "tooltip");
document.body.append(tip);
function showTip(e) {
  const t = e.target.closest?.("[data-tip]");
  if (!t) return;
  tip.textContent = t.dataset.tip;
  tip.classList.remove("hidden");
  const r = t.getBoundingClientRect(), w = tip.offsetWidth;
  tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  tip.style.top = (r.top + scrollY - tip.offsetHeight - 6) + "px";
}
// Ward hover: number, cluster and its share of the 2025/26 budget.
let wardCache = null;
function wardTip(w, ev) {
  if (!ev) return;
  const x = (wardCache || (wardCache = moneyByWard())).by.get(w);
  const c = CLUSTERS.find((k) => k.wards.includes(w));
  tip.textContent = `Ward ${w}${c ? " · " + c.name : ""} · ${x.n} project${x.n === 1 ? "" : "s"} · 2025/26 budget ${fmt(x.amount)}`;
  tip.classList.remove("hidden");
  tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, ev.clientX + 12) + "px";
  tip.style.top = (ev.clientY + scrollY + 14) + "px";
}

const hideTip = (e) => { if (e.target.closest?.("[data-tip]")) tip.classList.add("hidden"); };
$("detail").addEventListener("mouseover", showTip);
$("detail").addEventListener("focusin", showTip);
$("detail").addEventListener("mouseout", hideTip);
$("detail").addEventListener("focusout", hideTip);

function render() {
  renderTally();
  renderFilters();
  renderCount();
  renderList();
  renderDetail();
  renderAreas();
  drawMarkers();
  writeUrl();
  if (mapApi && mapApi.highlightWard) {
    mapApi.highlightWard(state.ward !== "all" ? new Set([+state.ward]) : state.cluster !== "all" ? clusterWards(state.cluster) : null);
  }
}

function select(id, fromMap) {
  state.selected = state.selected === id && fromMap ? null : id;
  render();
  const p = state.projects.find((x) => x.id === id);
  if (!fromMap && mapApi && p && hasLoc(p)) {
    if (p.route && mapApi.fit) mapApi.fit(p.route.flat().map(([lat, lng]) => ({ lat, lng })));
    else mapApi.panTo({ lat: p.lat, lng: p.lon });
  }
  if (state.selected && window.matchMedia("(max-width: 899px)").matches) {
    $("detail").scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

$("sector").onchange = (e) => { state.sector = e.target.value; render(); };
$("ward").onchange = (e) => { state.ward = e.target.value; render(); };
$("q").oninput = (e) => { state.q = e.target.value.trim(); render(); };
$("q").onkeydown = (e) => {
  if (e.key === "Enter") {
    const hit = sorted(state.projects.filter(isVisible))[0];
    if (hit) select(hit.id, false);
  }
  if (e.key === "Escape") { e.target.value = ""; state.q = ""; render(); }
};
$("level").onchange = (e) => { state.level = e.target.value; render(); };
$("money").onchange = (e) => { state.money = e.target.value; render(); };
$("contractor").onchange = (e) => { state.contractor = e.target.value; render(); };
$("shade").onclick = () => { state.shade = !state.shade; renderAreas(); writeUrl(); };
$("sort").onchange = (e) => { state.sort = e.target.value; state.listMax = LIST_STEP; renderList(); writeUrl(); };
$("cluster").onchange = (e) => {
  state.cluster = e.target.value;
  // A ward outside the new cluster would hide everything.
  if (state.ward !== "all" && state.cluster !== "all" && !clusterWards(state.cluster).has(+state.ward)) state.ward = "all";
  render();
  if (mapApi && state.cluster !== "all") fitTo(state.projects.filter(isVisible));
};
$("csv").onclick = downloadCsv;
$("clear").onclick = clearFilters;

// ---------- load ----------
function notice(text) {
  const n = $("notice");
  n.textContent = text;
  n.classList.remove("hidden");
}

// Google calls this when the API key is rejected (wrong key, API not enabled,
// or this site's address is not in the key's allowed referrers).
window.gm_authFailure = () =>
  notice("Google Maps rejected the API key. Check the key in config.js, that the Maps JavaScript API is enabled, and that this address is an allowed referrer.");

// Google's dynamic loader: defines google.maps.importLibrary without loading
// anything until the first call. https://developers.google.com/maps/documentation/javascript/load-maps-js-api
function loadGoogle(key) {
  ((g) => {
    var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window;
    b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set(), e = new URLSearchParams(),
    u = () => h || (h = new Promise(async (f, n) => {
      await (a = m.createElement("script"));
      e.set("libraries", [...r] + "");
      for (k in g) e.set(k.replace(/[A-Z]/g, (t) => "_" + t[0].toLowerCase()), g[k]);
      e.set("callback", c + ".maps." + q);
      a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
      d[q] = f; a.onerror = () => h = n(Error(p + " could not load.")); a.nonce = m.querySelector("script[nonce]")?.nonce || "";
      m.head.append(a);
    }));
    d[l] ? console.warn(p + " only loads once. Ignoring:", g) : d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n));
  })({ key, v: "weekly" });
}

function loadScript(src) {
  return new Promise((ok, fail) => {
    const el = document.createElement("script");
    el.src = src; el.onload = ok; el.onerror = () => fail(new Error("could not load " + src));
    document.head.append(el);
  });
}

async function initGoogle(cfg) {
  loadGoogle(cfg.apiKey);
  const { Map } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
  const map = new Map($("map"), {
    center: { lat: -23.77, lng: 29.74 }, zoom: 12,
    mapId: cfg.mapId || "DEMO_MAP_ID",  // AdvancedMarkers need a map ID
    mapTypeId: cfg.mapType || "roadmap",
    mapTypeControl: true,
    mapTypeControlOptions: { mapTypeIds: ["roadmap", "hybrid", "terrain"] },
    streetViewControl: false,
    fullscreenControl: true,
    clickableIcons: false,
    gestureHandling: "cooperative",
  });
  return {
    addMarker(position, el, title, onClick) {
      const mk = new AdvancedMarkerElement({ map, position, content: el, title });
      mk.addListener("click", onClick);
      return (z) => { mk.zIndex = z; };
    },
    // A road: a white casing under a line in the status colour.
    addRoute(lines, title, onClick) {
      const parts = lines.map((line) => {
        const path = line.map(([lat, lng]) => ({ lat, lng }));
        const casing = new google.maps.Polyline({ map, path, strokeColor: "#FFFFFF", strokeWeight: 8, zIndex: 1, clickable: false });
        const top = new google.maps.Polyline({ map, path, strokeWeight: 4.5, zIndex: 2 });
        top.addListener("click", onClick);
        return { casing, top };
      });
      return ({ color, dim, sel }) => {
        for (const { casing, top } of parts) {
          casing.setOptions({ strokeColor: sel ? "#C8281E" : "#FFFFFF", strokeOpacity: dim ? 0.15 : 0.9, strokeWeight: sel ? 10 : 8, zIndex: sel ? 5 : 1 });
          top.setOptions({ strokeColor: color, strokeOpacity: dim ? 0.2 : 0.95, strokeWeight: sel ? 6.5 : 4.5, zIndex: sel ? 6 : 2 });
        }
      };
    },
    fit(pts) {
      const b = new google.maps.LatLngBounds();
      pts.forEach((pt) => b.extend(pt));
      map.fitBounds(b, 48);
      google.maps.event.addListenerOnce(map, "idle", () => { if (map.getZoom() > 14) map.setZoom(14); });
    },
    panTo(pos) { map.panTo(pos); },
    getZoom() { return map.getZoom(); },
    onView(cb) { map.addListener("idle", cb); },
    addWards(gj, onClick) {
      map.data.addGeoJson(gj);
      let hi = null, shade = null;
      const style = (f) => {
        const on = !!hi && hi.has(f.getProperty("ward"));
        const sc = shade && shadeColour(shade.get(f.getProperty("ward"))?.amount);
        if (shade) return { fillColor: sc || css("--paper"), fillOpacity: sc ? 0.6 : 0.05, strokeColor: css("--ink"), strokeOpacity: on ? 0.9 : 0.5, strokeWeight: on ? 2.5 : 1, zIndex: 0 };
        return { fillColor: css("--fund"), fillOpacity: on ? 0.12 : 0.03, strokeColor: css("--ink"), strokeOpacity: on ? 0.9 : 0.45, strokeWeight: on ? 2.5 : 1.2, zIndex: 0 };
      };
      map.data.setStyle(style);
      map.data.addListener("click", (e) => onClick(e.feature.getProperty("ward")));
      map.data.addListener("mouseover", (e) => wardTip(e.feature.getProperty("ward"), e.domEvent));
      map.data.addListener("mouseout", () => tip.classList.add("hidden"));
      this.shadeWards = (by) => { shade = by; map.data.setStyle(style); };
      for (const f of gj.features) new AdvancedMarkerElement({ map, position: wardCentre(f.geometry), content: wardLabel(f.properties.ward), zIndex: 0 });
      this.highlightWard = (w) => { hi = w; map.data.setStyle(style); };
    },
  };
}

async function initLeaflet(cfg) {
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet";
  sheet.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
  document.head.append(sheet);
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js");
  const map = L.map("map").setView([-23.77, 29.74], 12);
  const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, className: "tiles-street", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const imagery = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const places = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
  const satellite = L.layerGroup([
    L.tileLayer(imagery, { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" }),
    L.tileLayer(places, { maxZoom: 19 }),
  ]);
  (cfg.mapType === "roadmap" ? street : satellite).addTo(map);
  L.control.layers({ Satellite: satellite, Street: street }, null, { collapsed: false }).addTo(map);
  return {
    addMarker(pos, el, title, onClick) {
      const mk = L.marker([pos.lat, pos.lng], {
        title, icon: L.divIcon({ html: el, className: "pinwrap", iconSize: [16, 16], iconAnchor: [8, 8] }),
      }).addTo(map);
      mk.on("click", onClick);
      return (z) => mk.setZIndexOffset(z);
    },
    addRoute(lines, title, onClick) {
      const casing = L.polyline(lines, { color: "#FFFFFF", weight: 8, interactive: false }).addTo(map);
      const top = L.polyline(lines, { weight: 4.5 }).addTo(map).on("click", onClick).bindTooltip(title, { sticky: true });
      return ({ color, dim, sel }) => {
        casing.setStyle({ color: sel ? "#C8281E" : "#FFFFFF", opacity: dim ? 0.15 : 0.9, weight: sel ? 10 : 8 });
        top.setStyle({ color, opacity: dim ? 0.2 : 0.95, weight: sel ? 6.5 : 4.5 });
        if (sel) { casing.bringToFront(); top.bringToFront(); }
      };
    },
    fit(pts) { map.fitBounds(pts.map((pt) => [pt.lat, pt.lng]), { padding: [40, 40], maxZoom: 14 }); },
    panTo(pos) { map.panTo([pos.lat, pos.lng]); },
    getZoom() { return map.getZoom(); },
    onView(cb) { map.on("zoomend moveend", cb); },
    addWards(gj, onClick) {
      let hi = null, shade = null;
      const style = (f) => {
        const on = !!hi && hi.has(f.properties.ward);
        const sc = shade && shadeColour(shade.get(f.properties.ward)?.amount);
        if (shade) return { color: css("--ink"), weight: on ? 2.5 : 1, opacity: on ? 0.9 : 0.5, fillColor: sc || css("--paper"), fillOpacity: sc ? 0.6 : 0.05 };
        return { color: css("--ink"), weight: on ? 2.5 : 1.2, opacity: on ? 0.9 : 0.45, fillColor: css("--fund"), fillOpacity: on ? 0.12 : 0.03 };
      };
      const layer = L.geoJSON(gj, { style, onEachFeature: (f, l) => {
        l.on("click", () => onClick(f.properties.ward));
        l.on("mouseover", (e) => wardTip(f.properties.ward, e.originalEvent));
        l.on("mouseout", () => tip.classList.add("hidden"));
      } }).addTo(map);
      this.shadeWards = (by) => { shade = by; layer.setStyle(style); };
      for (const f of gj.features) {
        const c = wardCentre(f.geometry);
        L.marker([c.lat, c.lng], { interactive: false, keyboard: false, zIndexOffset: -1000,
          icon: L.divIcon({ html: wardLabel(f.properties.ward), className: "wardwrap", iconSize: [0, 0] }) }).addTo(map);
      }
      this.highlightWard = (w) => { hi = w; layer.setStyle(style); };
    },
  };
}

async function initMap() {
  await initBackend();
  mapApi.onView(() => requestAnimationFrame(declutter));
  if (window.WARDS) {
    // Clicking a ward toggles the ward filter.
    mapApi.addWards(window.WARDS, (w) => { state.ward = state.ward === String(w) ? "all" : String(w); render(); });
  }
}

async function initBackend() {
  const cfg = window.MAP_CONFIG || {};
  if (cfg.apiKey) {
    mapApi = await initGoogle(cfg);
  } else {
    mapApi = await initLeaflet({ mapType: "hybrid", ...cfg });
    $("mapnote").textContent = "Free map (Esri imagery and OpenStreetMap). Add a Google Maps API key in config.js to switch to Google Maps.";
    $("mapnote").classList.remove("hidden");
  }
}

Promise.all([
  window.PROJECTS ? Promise.resolve(window.PROJECTS)
    : fetch("data/projects.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
  initMap().catch((e) => notice("The map did not load: " + e.message)),
])
  .then(([data]) => {
    state.projects = data;
    readUrl();
    if (!data.some((p) => p.id === state.selected)) state.selected = null;
    render();
    fitAll();
    const p = data.find((x) => x.id === state.selected);
    if (p) setTimeout(() => select(p.id, false), 300);
  })
  .catch(() => notice("Couldn't load the project data. Run python3 tools/build_data.py to create data/projects.js."));
