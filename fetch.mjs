// Henter vær, teater og kino og lagrer alt i data.json.
// Kjøres automatisk av GitHub Actions (se .github/workflows/oppdater.yml).
import * as cheerio from "cheerio";
import fs from "node:fs";

const UA = "infoskjerm/1.0 (privat infoskjerm; github.com/avejohnsen-home/infoskjerm)";
const H = { "User-Agent": UA, "Accept-Language": "nb-NO,nb;q=0.9" };
const OSLO_KINO = ["Colosseum", "Gimle", "Klingenberg", "Ringen", "Saga", "Symra", "Vika"];
const MONTHS = ["januar","februar","mars","april","mai","juni","juli","august","september","oktober","november","desember"];
const pad = n => String(n).padStart(2, "0");

let old = {};
try { old = JSON.parse(fs.readFileSync("data.json", "utf8")); } catch {}

// ---------- robots.txt: hopp over sider nettstedet ber roboter holde seg unna ----------
const robots = {};
async function allowed(url) {
  const u = new URL(url);
  if (!(u.origin in robots)) {
    try { const r = await fetch(u.origin + "/robots.txt", { headers: H }); robots[u.origin] = r.ok ? await r.text() : ""; }
    catch { robots[u.origin] = ""; }
  }
  let applies = false; const dis = [];
  for (const line of robots[u.origin].split(/\r?\n/)) {
    const i = line.indexOf(":"); if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(), val = line.slice(i + 1).replace(/#.*/, "").trim();
    if (key === "user-agent") applies = val === "*";
    else if (applies && key === "disallow" && val) dis.push(val.replace(/\*.*$/, ""));
  }
  return !dis.some(p => p && u.pathname.startsWith(p));
}
async function getHtml(url) {
  if (!(await allowed(url))) throw new Error("robots.txt tillater ikke " + url);
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(url + " svarte " + r.status);
  return cheerio.load(await r.text());
}
const abs = (src, base) => { try { return src ? new URL(src, base).href : ""; } catch { return ""; } };
const imgOf = (el, base) => {
  const img = el.find("img").first();
  const src = img.attr("src") || img.attr("data-src") || (img.attr("srcset") || "").split(/\s+/)[0];
  // Next.js-bilder (/_next/image?url=...) pakkes ut til originaladressen
  try { const u = new URL(src, base); if (u.pathname.includes("/_next/image") && u.searchParams.get("url")) return u.searchParams.get("url"); } catch {}
  return abs(src, base);
};
function cardAround($, el, test) { // gå oppover til elementet som inneholder det vi leter etter
  let c = $(el).parent();
  for (let k = 0; k < 8 && c.length && !test(c); k++) c = c.parent();
  return c;
}

// ---------- Vær (Meteorologisk institutt / Yr) ----------
async function weather() {
  const r = await fetch("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=59.923&lon=10.759", { headers: H });
  if (!r.ok) throw new Error("MET svarte " + r.status);
  const ts = (await r.json()).properties.timeseries;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const rows = ts.map(t => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t.time)).map(x => [x.type, x.value]));
    const next = t.data.next_1_hours || t.data.next_6_hours;
    return {
      date: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour) % 24,
      temp: Math.round(t.data.instant.details.air_temperature),
      wind: Math.round(t.data.instant.details.wind_speed),
      sym: next?.summary?.symbol_code || "",
      rain: Math.round((next?.details?.precipitation_amount ?? 0) * 10) / 10,
      span: t.data.next_1_hours ? 1 : 6
    };
  });
  const days = [];
  for (const row of rows) {
    let d = days.find(x => x.date === row.date);
    if (!d) { if (days.length === 7) break; d = { date: row.date, hours: [] }; days.push(d); }
    d.hours.push(row);
  }
  for (const d of days) {
    const t = d.hours.map(x => x.temp);
    d.max = Math.max(...t); d.min = Math.min(...t);
    d.rain = Math.round(d.hours.reduce((s, x) => s + x.rain, 0) * 10) / 10;
    const mid = d.hours.reduce((a, b) => Math.abs(b.h - 13) < Math.abs(a.h - 13) ? b : a);
    d.sym = mid.sym;
  }
  return { now: rows[0], days };
}

// ---------- Christiania Teater ----------
async function christiania() {
  const base = "https://christianiateaterscene.no/program";
  const $ = await getHtml(base);
  const shows = new Map();
  $('a[href*="webticket/shop?event="], a[href*="ticketmaster.no/event"]').each((_, a) => {
    const card = cardAround($, a, c => c.find("img").length > 0 && /\d{2}\.\d{2}\.\d{4}/.test(c.text()));
    const text = card.text();
    const d = text.match(/(\d{2})\.(\d{2})\.(\d{4})/), t = text.match(/(\d{1,2}):(\d{2})/);
    const img = card.find("img").first();
    const title = (img.attr("alt") || "").trim();
    if (!d || !t || !title) return;
    const link = card.find("a[href]").filter((_, x) => { const h = $(x).attr("href"); return !/billett\.|ticketmaster|webticket/.test(h); }).first().attr("href");
    if (!shows.has(title)) shows.set(title, { title, venue: "Christiania Teater", url: abs(link, base) || base, img: imgOf(card, base), times: [] });
    const iso = `${d[3]}-${d[2]}-${d[1]}T${pad(t[1])}:${t[2]}`;
    const s = shows.get(title); if (!s.times.includes(iso)) s.times.push(iso);
  });
  return [...shows.values()].map(s => ({ ...s, times: s.times.sort() }));
}

// ---------- Nationaltheatret ----------
async function nationaltheatret() {
  const base = "https://www.nationaltheatret.no/program/forestillinger";
  const $ = await getHtml(base);
  const out = [];
  const mi = m => MONTHS.indexOf(m.toLowerCase()) + 1;
  $('h2 a[href*="/forestillinger/"]').each((_, a) => {
    const title = $(a).text().trim();
    const card = cardAround($, a, c => c.is("li") || c.find("img").length > 0);
    const text = card.text().replace(/\s+/g, " ");
    let from, to;
    const r = text.match(/Fra (\d{1,2})\. (\p{L}+)(?: (\d{4}))? til (\d{1,2})\. (\p{L}+) (\d{4})/u);
    if (r) {
      const ty = Number(r[6]), fm = mi(r[2]);
      const fy = r[3] ? Number(r[3]) : (fm > mi(r[5]) ? ty - 1 : ty);
      from = `${fy}-${pad(fm)}-${pad(r[1])}`; to = `${ty}-${pad(mi(r[5]))}-${pad(r[4])}`;
    } else {
      const s = text.match(/(\d{1,2})\. (\p{L}+) (\d{4})/u);
      if (s && mi(s[2])) from = to = `${s[3]}-${pad(mi(s[2]))}-${pad(s[1])}`;
    }
    if (!title || !from) return;
    out.push({
      title, venue: "Nationaltheatret, " + (card.find('a[href*="vare-scener"]').first().text().trim() || "scene ukjent"),
      url: abs($(a).attr("href"), base), img: imgOf(card, base), from, to,
      about: card.find("p").first().text().trim().slice(0, 220)
    });
  });
  return out;
}

// ---------- NF Kino, Oslo ----------
async function nfkino() {
  const base = "https://www.nfkino.no/kinoprogram-oslo";
  const $ = await getHtml(base);
  const out = [];
  $('h2 a[href*="/film/"]').each((_, a) => {
    const title = $(a).text().trim();
    const card = cardAround($, a, c => c.find('a[href*="/screening/"]').length > 0);
    const cinemas = new Set();
    card.find('a[href*="/screening/"]').each((_, s) => {
      const name = $(s).text().trim().split(/\s+/)[0];
      if (OSLO_KINO.includes(name)) cinemas.add(name);
    });
    if (!title || !cinemas.size) return;
    const text = card.text().replace(/\s+/g, " ");
    out.push({
      title, url: abs($(a).attr("href"), base), img: imgOf(card, base),
      len: (text.match(/\d+ timer? \d+ min|\d+ timer?|\d+ min/) || [""])[0],
      age: card.find('a[href*="taxonomy/term"]').first().text().trim(),
      cinemas: OSLO_KINO.filter(k => cinemas.has(k))
    });
  });
  return out.slice(0, 12);
}

// ---------- Kjør alt, behold forrige data hvis en kilde feiler ----------
const data = { updated: new Date().toISOString(), errors: [] };
for (const [key, fn] of [["weather", weather], ["christiania", christiania], ["nationaltheatret", nationaltheatret], ["films", nfkino]]) {
  try {
    const v = await fn();
    if (Array.isArray(v) && v.length === 0) throw new Error("fant ingen oppføringer");
    data[key] = v; console.log("OK", key, Array.isArray(v) ? v.length : "");
  } catch (e) {
    data[key] = old[key] ?? null; data.errors.push(`${key}: ${e.message}`); console.log("FEIL", key, e.message);
  }
}
fs.writeFileSync("data.json", JSON.stringify(data, null, 1));
