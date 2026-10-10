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
const data = { updated: new Date().toISOString(), errors: [] };
try { old = JSON.parse(fs.readFileSync("data.json", "utf8")); } catch {}

// ---------- robots.txt: følg reglene nettstedet har satt for roboter ----------
// Standard tolkning: lengste treff vinner, Allow vinner ved likt, * er jokertegn og $ betyr slutt.
const robots = {};
const toRx = p => new RegExp("^" + p.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\$$/, "$") + (p.endsWith("$") ? "" : ""));
async function robotsRule(url) {
  const u = new URL(url);
  if (!(u.origin in robots)) {
    try { const r = await fetch(u.origin + "/robots.txt", { headers: H }); robots[u.origin] = r.ok ? await r.text() : ""; }
    catch { robots[u.origin] = ""; }
  }
  let applies = false; const rules = [];
  for (const line of robots[u.origin].split(/\r?\n/)) {
    const i = line.indexOf(":"); if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(), val = line.slice(i + 1).replace(/#.*/, "").trim();
    if (key === "user-agent") applies = val === "*";
    else if (applies && (key === "allow" || key === "disallow") && val) rules.push({ allow: key === "allow", path: val });
  }
  const target = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    if (!toRx(r.path).test(target)) continue;
    const len = r.path.replace(/[*$]/g, "").length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { ...r, len };
  }
  return best;
}
async function getHtml(url) {
  const rule = await robotsRule(url);
  if (rule && !rule.allow) throw new Error(`robots.txt tillater ikke ${url} (regel: Disallow: ${rule.path})`);
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
  const out = [], seen = new Set();
  const mi = m => MONTHS.indexOf(m.toLowerCase()) + 1;
  const norm = h => abs(h, base).split("#")[0].replace(/\/$/, "");
  const hasDate = t => /\d{1,2}\.\s\p{L}+\s\d{4}/u.test(t);
  const links = $('a[href*="/forestillinger/"]');
  links.each((_, a) => {
    const href = norm($(a).attr("href"));
    if (seen.has(href) || !/\/forestillinger\/[^/]+$/.test(href)) return;
    // gå opp til minste blokk som har en dato og bare handler om denne ene forestillingen
    const card = cardAround($, a, c => {
      const own = new Set(c.find('a[href*="/forestillinger/"]').map((_, x) => norm($(x).attr("href"))).get());
      return own.size === 1 && hasDate(c.text().replace(/\s+/g, " "));
    });
    const text = card.text().replace(/\s+/g, " ");
    if (!hasDate(text)) return;
    let from, to;
    const r = text.match(/Fra (\d{1,2})\. (\p{L}+)(?: (\d{4}))? til (\d{1,2})\. (\p{L}+) (\d{4})/u);
    if (r && mi(r[2]) && mi(r[5])) {
      const ty = Number(r[6]), fm = mi(r[2]);
      const fy = r[3] ? Number(r[3]) : (fm > mi(r[5]) ? ty - 1 : ty);
      from = `${fy}-${pad(fm)}-${pad(r[1])}`; to = `${ty}-${pad(mi(r[5]))}-${pad(r[4])}`;
    } else {
      const s = text.match(/(\d{1,2})\. (\p{L}+) (\d{4})/u);
      if (s && mi(s[2])) from = to = `${s[3]}-${pad(mi(s[2]))}-${pad(s[1])}`;
    }
    const title = (card.find("h2,h3").first().text() || $(a).text()).trim();
    if (!title || !from) return;
    seen.add(href);
    out.push({
      title, venue: "Nationaltheatret, " + (card.find('a[href*="vare-scener"]').first().text().trim() || "scene ukjent"),
      url: href, img: imgOf(card, base), from, to,
      about: card.find("p").first().text().trim().slice(0, 220)
    });
  });
  if (!out.length) console.log("  Diagnose Nationaltheatret: lenker funnet:", links.length, "| tekst:", $("main").text().replace(/\s+/g, " ").slice(0, 300) || $("body").text().replace(/\s+/g, " ").slice(0, 300));
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

// ---------- Oslo Nye Teater via Ticketmaster ----------
async function oslonye() {
  const key = process.env.TICKETMASTER_KEY;
  if (!key) throw new Error("mangler TICKETMASTER_KEY i GitHub Secrets");
  const B = "https://app.ticketmaster.com/discovery/v2";
  const r = await fetch(`${B}/venues.json?keyword=${encodeURIComponent("Oslo Nye")}&countryCode=NO&size=20&apikey=${key}`);
  if (!r.ok) throw new Error("Ticketmaster svarte " + r.status);
  const venues = ((await r.json())._embedded?.venues || []).filter(v => /oslo nye/i.test(v.name));
  console.log("  Ticketmaster-steder:", venues.map(v => v.name).join(" | ") || "ingen");
  const shows = new Map();
  for (const v of venues) {
    const er = await fetch(`${B}/events.json?venueId=${v.id}&size=200&sort=date,asc&apikey=${key}`);
    if (!er.ok) continue;
    for (const e of (await er.json())._embedded?.events || []) {
      const d = e.dates?.start; if (!d?.localDate) continue;
      const iso = d.localDate + "T" + (d.localTime || "19:00:00").slice(0, 5);
      const img = (e.images || []).sort((a, b) => (b.ratio === "3_2") - (a.ratio === "3_2") || b.width - a.width)[0]?.url || "";
      const k = e.name + "|" + v.name;
      if (!shows.has(k)) shows.set(k, { title: e.name, venue: /kjeller/i.test(v.name) ? "Oslo Nye Teaterkjelleren" : /central/i.test(v.name) ? "Oslo Nye Centralteatret" : "Oslo Nye Teater", url: e.url, img, times: [] });
      const s = shows.get(k); if (!s.times.includes(iso)) s.times.push(iso);
    }
    await new Promise(res => setTimeout(res, 250)); // skånsom mot API-et
  }
  return [...shows.values()].map(s => ({ ...s, times: s.times.sort() }));
}

// ---------- Sider som laster programmet med JavaScript: åpnes i en usynlig nettleser ----------
const MON = { jan: 1, januar: 1, feb: 2, februar: 2, mar: 3, mars: 3, apr: 4, april: 4, mai: 5, jun: 6, juni: 6, jul: 7, juli: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, nov: 11, november: 11, des: 12, desember: 12 };
function datesIn(text) {
  const now = new Date(), out = new Set();
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?!\d)/g)) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (Number(m[2]) >= 1 && Number(m[2]) <= 12) out.add(`${y}-${pad(m[2])}-${pad(m[1])}`);
  }
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\.?\s+(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|aug|sept|sep|okt|nov|des)\.?(?:\s+(\d{4}))?/gi)) {
    const mo = MON[m[2].toLowerCase()];
    let y = m[3] ? Number(m[3]) : now.getFullYear();
    if (!m[3] && new Date(y, mo - 1, Number(m[1])) < new Date(now.getFullYear(), now.getMonth() - 2, 1)) y++;
    out.add(`${y}-${pad(mo)}-${pad(m[1])}`);
  }
  // perioder som «1.—4. september»: ta med startdagen også
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\.?\s?[—–-]\s?\d{1,2}\.?\s+(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|aug|sept|sep|okt|nov|des)\.?(?:\s+(\d{4}))?/gi)) {
    const mo = MON[m[2].toLowerCase()];
    let y = m[3] ? Number(m[3]) : now.getFullYear();
    if (!m[3] && new Date(y, mo - 1, Number(m[1])) < new Date(now.getFullYear(), now.getMonth() - 2, 1)) y++;
    out.add(`${y}-${pad(mo)}-${pad(m[1])}`);
  }
  return [...out].sort();
}
function cardsFrom($, base, venue, pathHint, opts = {}) {
  const origin = new URL(base).origin, listPath = new URL(base).pathname.replace(/\/$/, "");
  const norm = h => { try { const u = new URL(h, base); u.hash = ""; return u.href.replace(/\/$/, ""); } catch { return ""; } };
  const shows = new Map();
  $("a[href]").each((_, a) => {
    const href = norm($(a).attr("href")); if (!href) return;
    const u = new URL(href);
    const okOrigin = u.origin === origin || (opts.origins || []).includes(u.origin);
    if (!okOrigin || u.pathname.replace(/\/$/, "") === listPath || u.pathname === "/" ) return;
    if (pathHint && !pathHint.test(u.pathname)) return;
    const card = cardAround($, a, c => {
      const own = new Set(c.find("a[href]").map((_, x) => norm($(x).attr("href"))).get().filter(h => h.startsWith(origin) && (!pathHint || pathHint.test(new URL(h).pathname))));
      return c.find("img").length > 0 && (opts.noDates || datesIn(c.text().replace(/\s+/g, " ")).length > 0) && own.size <= 2;
    });
    const dates = datesIn(card.text().replace(/\s+/g, " "));
    if ((!dates.length && !opts.noDates) || !card.find("img").length) return;
    const title = (card.find("h1,h2,h3,h4").first().text() || card.find("img").first().attr("alt") || $(a).text()).replace(/\s+/g, " ").trim();
    if (!title || title.length > 90) return;
    const s = shows.get(href) || { title, venue, url: href, img: imgOf(card, base), dates: [], hint: card.text().replace(/\s+/g, " ").slice(0, 300) };
    s.dates.push(...dates); shows.set(href, s);
  });
  const today = new Date().toISOString().slice(0, 10);
  return [...shows.values()].map(s => {
    const d = [...new Set(s.dates)].sort();
    return { title: s.title, venue: s.venue, url: s.url, img: s.img, from: d[0] || null, to: d[d.length - 1] || null, about: "", hint: s.hint };
  }).filter(s => !s.to || s.to >= today);
}
async function rendered(browser, urls, venue, pathHint, opts) {
  const page = await browser.newPage({ userAgent: UA, locale: "nb-NO" });
  const json = [];
  page.on("response", async r => {
    try { if ((r.headers()["content-type"] || "").includes("json") && json.length < 12) { const b = await r.json(); json.push(`${r.url().slice(0, 140)} [${Array.isArray(b) ? "liste " + b.length : Object.keys(b).slice(0, 6).join(",")}]`); } } catch {}
  });
  try {
    for (const url of urls) {
      const rule = await robotsRule(url);
      if (rule && !rule.allow) { console.log(`  ${venue}: robots.txt sperrer ${url} (Disallow: ${rule.path})`); continue; }
      const res = await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(e => ({ status: () => "feil: " + e.message.slice(0, 80) }));
      await page.waitForTimeout(2500);
      for (let k = 0; k < 4; k++) { await page.mouse.wheel(0, 4000); await page.waitForTimeout(700); } // last inn mer ved scrolling
      const $ = cheerio.load(await page.content());
      const out = cardsFrom($, url, venue, pathHint, opts);
      console.log(`  ${venue}: ${url} -> status ${res?.status?.()} , ${out.length} funnet`);
      if (out.length) return out;
      console.log(`  Diagnose ${venue}: JSON-kall: ${json.join(" | ") || "ingen"}`);
      const links = [...new Set($("a[href]").map((_, a) => $(a).attr("href")).get())].slice(0, 40).join(" ");
      console.log(`  Diagnose ${venue}: lenker: ${links}`);
      console.log(`  Diagnose ${venue}: tekst: ${$("main").text().replace(/\s+/g, " ").slice(0, 400) || $("body").text().replace(/\s+/g, " ").slice(0, 400)}`);
    }
    return [];
  } finally { await page.close(); }
}

// ---------- Chateau Neuf ----------
// Tar med scenearrangementer, hopper over film, quiz, spillkvelder o.l.
const NEUF_SKIP = /filmvisning|gratisvisning|quiz|kviss|bingo|magic: the gathering|smash|brettspill|boiler room|jazz!klubb|valgvake|debrif|workshop|spark 20/i;
async function neuf() {
  const base = "https://neuf.no/arrangementer";
  const $ = await getHtml(base);
  const today = new Date().toISOString().slice(0, 10), out = [], seen = new Set();
  $('a[href*="/arrangementer/"]').each((_, a) => {
    const url = abs($(a).attr("href"), base).split("#")[0];
    if (seen.has(url) || !/\/arrangementer\/[^/]+$/.test(url)) return;
    const card = cardAround($, a, c => c.find("h1,h2,h3").length > 0 && c.find("img").length > 0);
    const h = card.find("h1,h2,h3").first();
    const title = h.text().replace(/\s+/g, " ").trim();
    const text = card.text().replace(/\s+/g, " ");
    if (!title || NEUF_SKIP.test(title + " " + text.slice(0, 200))) return;
    // datoer uten årstall: ligger de før i dag, gjelder de neste år
    const dates = datesIn(text).map(d => d < today ? (Number(d.slice(0, 4)) + 1) + d.slice(4) : d).sort();
    if (!dates.length) return;
    seen.add(url);
    const more = dates.length > 1 || /\+\d+/.test(text);
    out.push({ title, venue: "Chateau Neuf", url, img: imgOf(card, base), from: dates[0], to: dates[0],
      about: more ? "Flere forestillinger. Se alle datoer på nettsiden." : "", hint: text.slice(0, 300) + " " + (card.find("img").attr("alt") || "") });
  });
  return out;
}

// ---------- Operaen: nettsiden henter programmet fra sitt eget kalender-API ----------
function deepStrings(o, out = [], key = "") {
  if (typeof o === "string") out.push([key, o]);
  else if (Array.isArray(o)) o.forEach(x => deepStrings(x, out, key));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) deepStrings(v, out, k);
  return out;
}
async function operaen() {
  const url = "https://www.operaen.no/api/calendar/productions?language=no";
  const rule = await robotsRule(url);
  if (rule && !rule.allow) throw new Error(`robots.txt sperrer ${url} (Disallow: ${rule.path})`);
  const r = await fetch(url, { headers: { ...H, Accept: "application/json" } });
  if (!r.ok) throw new Error("Operaen svarte " + r.status);
  const list = await r.json();
  const items = Array.isArray(list) ? list : (list.items || list.productions || list.data || []);
  console.log("  Operaen API: " + items.length + " produksjoner. Eksempel: " + JSON.stringify(items[0]).slice(0, 700));
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const it of items) {
    const title = it.name || it.title;
    const next = (it.nextEvent || "").slice(0, 16);
    if (!title || !next || next.slice(0, 10) < today || /arkiv/i.test(it.url || "")) continue;
    out.push({ title: String(title).trim(), venue: "Operaen", url: abs(it.url, "https://www.operaen.no/") || "https://www.operaen.no/forestillinger/",
      img: abs(it.imageUrl, "https://www.operaen.no/"), next, genres: it.genres || [], from: null, to: null, about: it.secondaryTitle || "" });
  }
  return out;
}

// ---------- Kjør alt, behold forrige data hvis en kilde feiler ----------
async function run(key, fn) {
  try {
    const v = await fn();
    if (Array.isArray(v) && v.length === 0) throw new Error("fant ingen oppføringer");
    data[key] = v; console.log("OK", key, Array.isArray(v) ? v.length : "");
  } catch (e) {
    data[key] = old[key] ?? null; data.errors.push(`${key}: ${e.message}`); console.log("FEIL", key, e.message);
  }
}
for (const [key, fn] of [["weather", weather], ["christiania", christiania], ["nationaltheatret", nationaltheatret], ["films", nfkino], ["oslonye", oslonye], ["operaen", operaen], ["neuf", neuf]]) await run(key, fn);

const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  await run("chatnoir", () => rendered(browser, ["https://www.chatnoir.no/program"], "Chat Noir", null, { noDates: true }));
  await run("detnorske", () => rendered(browser, ["https://www.detnorsketeatret.no/framsyningar"], "Det Norske Teatret", null, { noDates: true, origins: ["https://program.detnorsketeatret.no"] }));
} finally { await browser.close(); }
// Hvilken by hver kilde hører til (nye byer legges til her)
const CITY = { christiania: "Oslo", nationaltheatret: "Oslo", oslonye: "Oslo", operaen: "Oslo", neuf: "Oslo", chatnoir: "Oslo", detnorske: "Oslo", films: "Oslo" };
for (const [k, city] of Object.entries(CITY)) if (Array.isArray(data[k])) data[k].forEach(x => { x.city = x.city || city; });
fs.writeFileSync("data.json", JSON.stringify(data, null, 1));
