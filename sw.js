/* Service worker: lets the app install on Android and open without a connection.
   The page itself is network-first (so updates always arrive) with the cached copy
   as the offline fallback. Sheet data is never cached, so numbers are never stale. */
const CACHE = "ads-tracker-v4";
const META = "ads-meta";   // small notes the worker keeps between checks (sheet links, who it has already seen)
const SHELL = ["./", "index.html", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== META).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req, { cache: "no-cache" })   // always revalidate: GitHub Pages sets max-age=600, which would show a stale copy
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
    );
    return;
  }

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
      }))
    );
  }
});

/* ── Background check: new leads and booked calls ────────────────────
   Chrome on Android may wake this now and then (Periodic Background Sync) — it decides how often,
   usually every few hours at best. The page also hands over the sheet links so we know where to look. */
async function putJSON(key, value) {
  const c = await caches.open(META);
  await c.put("/__" + key, new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }));
}
async function getJSON(key) {
  const c = await caches.open(META);
  const r = await c.match("/__" + key);
  return r ? r.json() : null;
}
function csvRows(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function peopleIn(text) {   // { email: name } for every row that has an email address
  const rows = csvRows(text), head = (rows[0] || []).map((h) => String(h).toLowerCase().trim());
  const ei = head.findIndex((h) => h.includes("email"));
  let ni = head.findIndex((h) => h === "name"); if (ni < 0) ni = head.findIndex((h) => h.includes("name") && !/campaign|adset|ad name/.test(h));
  const out = {};
  if (ei < 0) return out;
  rows.slice(1).forEach((r) => { const e = String(r[ei] || "").trim().toLowerCase(); if (e.includes("@")) out[e] = String(r[ni] || "").trim() || "Someone"; });
  return out;
}
async function checkSheets() {
  const urls = await getJSON("config"); if (!urls) return;
  const seen = await getJSON("seen"), now = {}, kinds = { leads: "lead", intro: "intro", calls: "demo" };
  for (const k of Object.keys(kinds)) {
    if (!urls[k]) continue;
    try {
      const r = await fetch(urls[k] + (urls[k].includes("?") ? "&" : "?") + "_=" + Date.now(), { cache: "no-store" });
      if (r.ok) now[k] = peopleIn(await r.text());
    } catch {}
  }
  const keep = Object.assign({}, seen || {});
  const todo = [];
  Object.keys(now).forEach((k) => {
    const had = seen && seen[k] ? new Set(seen[k]) : null, add = had ? Object.keys(now[k]).filter((e) => !had.has(e)) : [];
    keep[k] = Object.keys(now[k]);
    if (add.length && add.length <= 25) todo.push([k, add.map((e) => now[k][e])]);
  });
  await putJSON("seen", keep);
  const titles = { leads: ["New lead", "new leads"], intro: ["Intro call booked", "new intro calls booked"], calls: ["Demo call booked", "new demo calls booked"] };
  for (const [k, names] of todo) {
    const [one, many] = titles[k];
    await self.registration.showNotification(names.length === 1 ? one : `${names.length} ${many}`, {
      body: names.length === 1 ? names[0] : names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3} more` : ""),
      icon: "icon-192.png", badge: "icon-192.png", tag: "alert-" + k, renotify: true, data: { page: "mleads" },
    });
  }
}
self.addEventListener("periodicsync", (e) => { if (e.tag === "check-leads") e.waitUntil(checkSheets()); });
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "config") e.waitUntil(putJSON("config", d.urls));
  if (d.type === "check") e.waitUntil(checkSheets());
});
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "SanterMedia", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    const open = cs.filter((c) => c.visibilityState === "visible");
    if (open.length && d.tag !== "alert-test") { open.forEach((c) => c.postMessage({ type: "refresh" })); return; }   // app is on screen: it shows its own banner
    return self.registration.showNotification(d.title || "SanterMedia", {
      body: d.body || "", icon: "icon-192.png", badge: "icon-192.png", tag: d.tag || "alert", renotify: true, data: { page: d.page || "glance" },
    });
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const page = (e.notification.data && e.notification.data.page) || "glance";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    if (cs.length) { cs[0].postMessage({ type: "goto", page }); return cs[0].focus(); }
    return self.clients.openWindow(new URL("./?page=" + page, self.registration.scope).href);
  }));
});
