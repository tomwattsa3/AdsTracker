// Runs on GitHub every few minutes: looks at the Google Sheet and pushes a phone notification
// when a new lead, intro call or demo call has appeared since the last look.
import fs from "node:fs";

const PUBLIC_KEY = "BMC2ZRhHiU6bdbA8i-4bC0JzQhisnJ9A_C8JkuDZ1ouCNzG79oHs9pozhnNpLtompvep81wu0fvC61IAbePoH2w";
const SEEN_FILE = ".seen/seen.json";
const DRY = process.env.DRY_RUN === "1";

const html = fs.readFileSync("index.html", "utf8");
const urlOf = (name) => (html.match(new RegExp(`const ${name} = "([^"]+)"`)) || [])[1];
const SHEETS = { leads: urlOf("DEFAULT_LEADS_URL"), intro: urlOf("DEFAULT_INTRO_URL"), calls: urlOf("DEFAULT_CALLS_URL") };

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
function peopleIn(text) {   // { email: name } for every row with an email address
  const rows = csvRows(text), head = (rows[0] || []).map((h) => String(h).toLowerCase().trim());
  const ei = head.findIndex((h) => h.includes("email"));
  let ni = head.findIndex((h) => h === "name");
  if (ni < 0) ni = head.findIndex((h) => h.includes("name") && !/campaign|adset|ad name/.test(h));
  const out = {};
  if (ei < 0) return out;
  rows.slice(1).forEach((r) => { const e = String(r[ei] || "").trim().toLowerCase(); if (e.includes("@")) out[e] = String(r[ni] || "").trim() || "Someone"; });
  return out;
}

async function send(payload) {
  if (DRY) { console.log("[dry run] would send:", JSON.stringify(payload)); return; }
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails("https://tomwattsa3.github.io/AdsTracker/", PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  try {
    await webpush.sendNotification(JSON.parse(process.env.PUSH_SUBSCRIPTION), JSON.stringify(payload));
    console.log("sent:", payload.title, "-", payload.body);
  } catch (err) {
    console.log("push failed:", err.statusCode || "", err.body || err.message);
    if (err.statusCode === 404 || err.statusCode === 410) console.log("The phone's subscription has expired. Turn Alerts off and on again in the app and replace the PUSH_SUBSCRIPTION secret.");
    process.exitCode = 1;
  }
}

if (!DRY && (!process.env.VAPID_PRIVATE_KEY || !process.env.PUSH_SUBSCRIPTION)) {
  console.log("VAPID_PRIVATE_KEY or PUSH_SUBSCRIPTION is not set yet, so there is nowhere to send alerts. Nothing to do.");
  process.exit(0);
}
if (process.env.TEST === "true") {
  await send({ title: "Test alert", body: "Instant alerts are working.", tag: "alert-test", page: "glance" });
  process.exit(process.exitCode || 0);
}

const now = {};
for (const [k, url] of Object.entries(SHEETS)) {
  if (!url) continue;
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(), { redirect: "follow" });
  if (!r.ok) { console.log(`Could not read the ${k} sheet (${r.status}); skipping this round.`); process.exit(0); }
  now[k] = peopleIn(await r.text());
}

fs.mkdirSync(".seen", { recursive: true });
const seen = fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) : null;
const next = Object.fromEntries(Object.entries(now).map(([k, v]) => [k, Object.keys(v)]));
if (!seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(next));
  console.log("First look: remembered", Object.entries(next).map(([k, v]) => `${k} ${v.length}`).join(", "), "- no alerts this time.");
  process.exit(0);
}

const titles = { leads: ["New lead", "new leads"], intro: ["Intro call booked", "new intro calls booked"], calls: ["Demo call booked", "new demo calls booked"] };
const page = { leads: "mleads", intro: "mleads", calls: "mleads" };
for (const k of Object.keys(now)) {
  const had = new Set(seen[k] || []);
  const added = Object.keys(now[k]).filter((e) => !had.has(e)).map((e) => now[k][e]);
  if (!added.length) continue;
  if (added.length > 25) { console.log(`${added.length} new in ${k}: too many at once, treating it as a data change and not alerting.`); continue; }
  const [one, many] = titles[k];
  await send({
    title: added.length === 1 ? one : `${added.length} ${many}`,
    body: added.length === 1 ? added[0] : added.slice(0, 3).join(", ") + (added.length > 3 ? ` +${added.length - 3} more` : ""),
    tag: "alert-" + k, page: page[k],
  });
}
if (!DRY) fs.writeFileSync(SEEN_FILE, JSON.stringify(next));
else console.log("[dry run] leaving the remembered list as it was.");
if (!Object.keys(next).length) console.log("No sheets found to check.");
