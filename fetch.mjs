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
  // prøv opptil 3 ganger ved midlertidige nettverksfeil
  let r, err;
  for (let k = 0; k < 3; k++) {
    try { r = await fetch(url, { headers: H }); if (r.ok || r.status < 500) break; err = new Error(url + " svarte " + r.status); }
    catch (e) { err = e; r = null; }
    await new Promise(res => setTimeout(res, 3000 * (k + 1)));
  }
  if (!r) throw err;
  if (!r.ok) throw new Error(url + " svarte " + r.status);
  return cheerio.load(await r.text());
}
const abs = (src, base) => { try { return src ? new URL(src, base).href : ""; } catch { return ""; } };
const imgOf = (el, base) => {
  const img = el.find("img").first();
  const src = img.attr("src") || img.attr("data-src") || (img.attr("srcset") || "").split(/\s+/)[0];
  // Next.js-bilder (/_next/image?url=...) pakkes ut til originaladressen
  try { const u = new URL(src, base); if (u.pathname.includes("/_next/image") && u.searchParams.get("url")) return new URL(u.searchParams.get("url"), base).href; } catch {}
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

// Finn beste bilde i et kort (tåler «lazy loading» der bildet ligger i data-src/srcset)
function posterOf($, card, base) {
  const c = [];
  card.find("img, source").each((_, e) => {
    const el = $(e);
    for (const at of ["data-src", "data-lazy-src", "data-original", "src", "data-srcset", "srcset"]) {
      const v = el.attr(at); if (!v) continue;
      for (const part of v.split(",")) { const u = part.trim().split(/\s+/)[0]; if (u) c.push(u); }
    }
  });
  card.find("[style*='url(']").addBack("[style*='url(']").each((_, e) => {
    const m = ($(e).attr("style") || "").match(/url\(\s*['"]?([^'")]+)/); if (m) c.push(m[1]);
  });
  const ok = c.map(u => { try { const x = new URL(u, base); if (x.pathname.includes("/_next/image") && x.searchParams.get("url")) return new URL(x.searchParams.get("url"), base).href; return x.href; } catch { return ""; } })
    .filter(u => u && !u.startsWith("data:") && !/\.svg(\?|$)/i.test(u) && !/placeholder|blank|spacer|logo/i.test(u));
  const best = ok.find(u => /poster|plakat|styles\//i.test(u)) || ok[0] || "";
  return { best, ok: [...new Set([best, ...ok])].filter(Boolean), all: c.slice(0, 8) };
}
const GENRES = ["Drama","Komedie","Action","Thriller","Horror","Skrekk","Grøsser","Romantikk","Familiefilm","Animasjon","Eventyr","Fantasy","Science fiction","Sci-fi","Krim","Dokumentar","Musikkfilm","Musikal","Superhelt","Biografi","Historisk","Krig","Western","Mysterium","Barnefilm","Ungdom","Sport","Konsert","Opera","Ballett","Kortfilm","Romantisk komedie"];

// ---------- NF Kino, Oslo ----------
async function nfkino() {
  const base = "https://www.nfkino.no/kinoprogram-oslo";
  const $ = await getHtml(base);
  const out = [];
  const today = new Date().toISOString().slice(0, 10);
  const until = new Date(Date.now() + 8 * 864e5).toISOString().slice(0, 10);
  $('h2 a[href*="/film/"]').each((_, a) => {
    const title = $(a).text().trim();
    const card = cardAround($, a, c => c.find('a[href*="/screening/"]').length > 0);
    const shows = [];
    card.find("li[data-date]").each((_, li) => {
      const el = $(li), d = el.attr("data-date"), raw = (el.attr("data-time") || "").padStart(4, "0");
      const room = el.find(".room").text().trim();          // f.eks. «Klingenberg 1»
      const cinema = room.split(/\s+/)[0];
      if (!OSLO_KINO.includes(cinema) || !d || d < today || d > until) return;
      shows.push({
        d, t: raw.slice(0, 2) + ":" + raw.slice(2), c: cinema, r: room.slice(cinema.length).trim(),
        v: el.find(".version").text().replace(/\s+/g, " ").trim().replace(/,$/, ""),
        u: abs(el.find('a[href*="/screening/"]').attr("href"), base)
      });
    });
    if (!title || !shows.length) return;
    shows.sort((x, y) => (x.d + x.t).localeCompare(y.d + y.t));
    const text = cheerio.load($.html(card).replace(/<[^>]+>/g, " ")).text().replace(/\s+/g, " "); // tekst med mellomrom mellom elementene
    const head = text.split(/\d+ timer?|\d+ min/)[0];           // teksten før lengden: tittel + sjangre
    const genres = GENRES.filter(g => new RegExp("(^|[^\\p{L}])" + g + "($|[^\\p{L}])", "iu").test(head));
    // plakaten kan ligge utenfor blokken med visninger: gå oppover så lenge vi bare har denne ene filmen
    let p = posterOf($, card, base), box = card;
    for (let k = 0; k < 4 && !p.best; k++) {
      box = box.parent(); if (!box.length || box.find('h2 a[href*="/film/"]').length > 1) break;
      p = posterOf($, box, base);
    }
    if (!p.best) { const prev = card.prevAll().first(); if (prev.length) p = posterOf($, prev, base); }
    out.push({
      title, url: abs($(a).attr("href"), base), img: p.best, genres,
      len: (text.match(/\d+ timer? \d+ min|\d+ timer?|\d+ min/) || [""])[0],
      age: card.find('a[href*="taxonomy/term"]').first().text().trim(),
      cinemas: OSLO_KINO.filter(k => shows.some(x => x.c === k)),
      shows
    });
  });
  // Trailer: les filmens egen side én gang og finn YouTube-trailer (eller videofil). Huskes mellom kjøringer.
  const list = out.slice(0, 16);
  const known = new Map((old.films || []).filter(f => f.trailerChecked && f.origChecked).map(f => [f.url, f]));
  let found = 0;
  for (const f of list) {
    if (known.has(f.url)) { const k = known.get(f.url); Object.assign(f, { trailer: k.trailer || "", trailerChecked: true, origChecked: true, orig: k.orig, year: k.year, rt: k.rt, imdb: k.imdb, ratingsAt: k.ratingsAt }); if (f.trailer) found++; continue; }
    try {
      const $d = await getHtml(f.url);
      const html = $d.html();
      const yt = html.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|v\/)|youtu\.be\/)([\w-]{11})/);
      const mp4 = html.match(/https?:[^"'\s]+\.mp4/);
      f.trailer = yt ? "yt:" + yt[1] : mp4 ? mp4[0] : "";
      f.trailerChecked = true; f.origChecked = true; if (f.trailer) found++;
      // originaltittel og år (brukes til å slå opp Rotten Tomatoes-score)
      const txt = cheerio.load(html.replace(/<[^>]+>/g, "\n")).text().split("\n").map(x => x.trim()).filter(Boolean);
      const oi = txt.findIndex(l => /^original\s*tittel:?$/i.test(l) || /^originaltittel:?/i.test(l));
      if (oi >= 0) f.orig = (txt[oi].replace(/^original\s*tittel:?\s*/i, "") || txt[oi + 1] || "").trim();
      const yi = txt.findIndex(l => /^(produksjonsår|år|premiere(år)?):?$/i.test(l));
      if (yi >= 0) f.year = (txt[yi + 1] || "").match(/\d{4}/)?.[0] || "";
    } catch {}
    await new Promise(res => setTimeout(res, 300));
  }
  console.log(`  Kino: trailer funnet for ${found} av ${list.length} filmer`);
  // Rotten Tomatoes- og IMDb-score via OMDb (gratis nøkkel). Sjekkes på nytt én gang i døgnet for filmer uten score.
  const OMDB = process.env.OMDB_KEY;
  if (OMDB) {
    let got = 0;
    for (const f of list) {
      if (f.rt && f.imdb) { got++; continue; }
      if (f.ratingsAt && Date.now() - new Date(f.ratingsAt) < 864e5) { if (f.rt) got++; continue; }
      const tries = [[f.orig, f.year], [f.orig, ""], [f.title, f.year], [f.title, ""]].filter(([t]) => t);
      for (const [t, y] of tries) {
        try {
          const r = await fetch(`https://www.omdbapi.com/?apikey=${OMDB}&type=movie&t=${encodeURIComponent(t)}${y ? "&y=" + y : ""}`);
          const j = await r.json();
          if (j.Response === "True") {
            f.rt = (j.Ratings || []).find(x => /rotten/i.test(x.Source))?.Value || "";
            f.imdb = j.imdbRating && j.imdbRating !== "N/A" ? j.imdbRating : "";
            f.imdbId = j.imdbID || ""; break;
          }
        } catch {}
      }
      f.ratingsAt = new Date().toISOString(); if (f.rt) got++;
    }
    console.log(`  Kino: Rotten Tomatoes-score for ${got} av ${list.length} filmer`);
  } else console.log("  Kino: ingen OMDB_KEY – hopper over Rotten Tomatoes");
  return list;
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
      const mins = (e.priceRanges || []).map(x => Number(x.min)).filter(n => n > 0);
      if (mins.length) { const m = Math.round(Math.min(...mins)); if (!s.priceFrom || m < s.priceFrom) s.priceFrom = m; }
    }
    await new Promise(res => setTimeout(res, 250)); // skånsom mot API-et
  }
  return [...shows.values()].map(({ priceFrom, ...s }) => ({ ...s, times: s.times.sort(), ...(priceFrom ? { prices: [{ l: "Fra", kr: priceFrom }] } : {}) }));
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
const JUNK_TITLE = /^kontakt oss$|^teater for barn$|du kontrollerer|dine egne data|informasjonskapsl|cookie|samtykke|personvern|nyhetsbrev|meld deg på|logo$|^meny$|^søk$|gavekort/i;
const JUNK_URL = /personvern|cookie|informasjonskapsl|samtykke|nyhetsbrev|gavekort|ledige-stillinger|kontakt|om-oss|praktisk|billettinfo|vennelaget|podkast|privacy/i;
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
    let title = (card.find("h1,h2,h3,h4").first().text() || card.find("img").first().attr("alt") || $(a).text()).replace(/\u00ad/g, "").replace(/\s+/g, " ").trim();
    // fjern kategorietiketter som henger fast i tittelen, f.eks. «MUSIKALENCabaret», «FOR BARNPippi», «…Gratis»
    title = title.replace(/^(musikalen|for barn|lunsj\s*&\s*lyrikk|innsikt|omvising|konsert|gjestespel|gjestespill)\s*/i, "").replace(/gratis$/i, "").trim();
    if (!title || title.length > 90) return;
    // hopp over cookie-vinduer, nyhetsbrev, personvern o.l. (ikke forestillinger)
    if (JUNK_TITLE.test(title) || JUNK_URL.test(u.pathname)) return;
    const s = shows.get(href) || { title, venue, url: href, img: imgOf(card, base), dates: [], hint: card.text().replace(/\s+/g, " ").slice(0, 300) };
    s.dates.push(...dates); shows.set(href, s);
  });
  const today = new Date().toISOString().slice(0, 10), seenTitle = new Set();
  return [...shows.values()].map(s => {
    const d = [...new Set(s.dates)].sort();
    return { title: s.title, venue: s.venue, url: s.url, img: s.img, from: d[0] || null, to: d[d.length - 1] || null, about: "", hint: s.hint };
  }).filter(s => !s.to || s.to >= today)
    .filter(s => { const k = s.title.toLowerCase(); if (seenTitle.has(k)) return false; seenTitle.add(k); return true; });   // samme tittel bare én gang
}
async function rendered(browser, urls, venue, pathHint, opts) {
  const page = await browser.newPage({ userAgent: UA, locale: "nb-NO" });
  const json = [];
  page.on("response", async r => {
    try { if (opts && opts.jsonSample && opts.jsonSample.test(r.url())) { const b = await r.json(); const d = b.data || b; console.log(`  Eksempel fra ${r.url().slice(0, 120)}: ` + JSON.stringify(Array.isArray(d) ? d[0] : d).slice(0, 900)); } } catch {}
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
      if (out.length && !(opts && opts.diag)) return out;
      if (out.length) console.log(`  Diagnose ${venue}: funnet: ${out.map(o => o.title + " -> " + o.url).join(" | ")}`);
      console.log(`  Diagnose ${venue}: JSON-kall: ${json.join(" | ") || "ingen"}`);
      const links = [...new Set($("a[href]").map((_, a) => $(a).attr("href")).get())].filter(h => !/privacy|cookie|policy|facebook|instagram|google|microsoft|snap|apple|mozilla|opera\.com|macromedia|hubpages|adform|twentythree|cloudflare/i.test(h)).slice(0, 60).join(" ");
      console.log(`  Diagnose ${venue}: lenker: ${links}`);
      console.log(`  Diagnose ${venue}: tekst: ${$("main").text().replace(/\s+/g, " ").slice(0, 400) || $("body").text().replace(/\s+/g, " ").slice(0, 400)}`);
      if (opts && opts.diag) { console.log(`  Diagnose ${venue}: bilder: ${$("img").length}, overskrifter: ${$("h1,h2,h3").map((_, h) => $(h).text().trim()).get().slice(0, 25).join(" | ")}`); return out; }
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

// ---------- Chat Noir: nettsiden henter programmet fra sitt eget API ----------
async function chatnoirApi() { return eventsEdge("https://www.chatnoir.no", "Chat Noir"); }
// Samme publiseringsplattform brukes av Chat Noir, Rockefeller/John Dee/Sentrum Scene, Blå og Vulkan Arena
async function eventsEdge(site, venueName) {
  const url = site + "/api/eventsEdge";
  const rule = await robotsRule(url);
  if (rule && !rule.allow) throw new Error(`robots.txt sperrer ${url} (Disallow: ${rule.path})`);
  const r = await fetch(url, { headers: { ...H, Accept: "application/json" } });
  if (!r.ok) throw new Error(venueName + " svarte " + r.status);
  const j = await r.json();
  const items = Array.isArray(j) ? j : (j.events || j.data || j.items || []);
  const now = new Date().toISOString().slice(0, 16);
  const shows = new Map();
  for (const it of items) {
    const strs = deepStrings(it);
    const pick = re => (strs.find(([k]) => re.test(k)) || [])[1];
    const title = String(it.name || it.title || pick(/^(name|title|heading)$/i) || "").trim();
    if (!title) continue;
    // tidspunkt: første ISO-dato med klokkeslett, helst fra et felt som heter noe med start/dato
    // tider oppgis i UTC (slutter på Z) – gjør om til norsk tid
    const osloFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const isoOf = v => {
      const str = String(v); if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str)) return null;
      if (!/(Z|[+-]\d{2}:?\d{2})$/.test(str)) return str.slice(0, 10) + "T" + str.slice(11, 16);
      const p = Object.fromEntries(osloFmt.formatToParts(new Date(str)).map(x => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
    };
    const when = isoOf(pick(/start|date|dato|time/i) || "") || strs.map(([, v]) => isoOf(v)).find(Boolean);
    if (!when || when < now) continue;
    // plakaten ligger hos ImageKit (imagekit.url), uten filendelse; logoer for spillestedet hoppes over
    const ik = (it.imagekit && (it.imagekit.url || it.imagekit.thumbnailUrl)) || (strs.find(([, v]) => /ik\.imagekit\.io\/.+\/event_/i.test(v)) || [])[1];
    const img = ik ? ik.replace(/\/tr:[^/]+\//, "/") + (ik.includes("?") ? "&" : "?") + "tr=w-600" : "";
    const slugify = t => t.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const id = it.id || it._id || pick(/^(id|eventId)$/i), slug = it.slug || pick(/^slug$/i) || (id ? slugify(title) : "");
    const link = strs.map(([, v]) => v).find(v => /ticketmaster\.no\/(event|artist)/i.test(v))
      || (slug && id ? `${site}/events/${slug}/${id}` : site);
    const tags = (it.tags || []).join(" ");
    const about = String(it.details || "").replace(/^[^\n]*\n+/, "").replace(/\s+/g, " ").trim().slice(0, 220);
    const pl = it.place && (typeof it.place === "object" ? (it.place.name || it.place.title || it.place.label) : it.place);
    const venue = pl && String(pl).trim() && !new RegExp(venueName, "i").test(String(pl)) ? String(pl).trim() : venueName;
    const key = title + "|" + venue;
    if (!shows.has(key)) shows.set(key, { title, venue, url: link, img: abs(img, site + "/"), times: [], hint: tags, about });
    const s = shows.get(key); if (!s.times.includes(when)) s.times.push(when);
  }
  return [...shows.values()].map(s => ({ ...s, times: s.times.sort() }));
}

// ---------- Malerier til skjermspareren (Art Institute of Chicago, kun fri bruk / public domain) ----------
// Hentes på nytt bare én gang i uken. Bytt kunstnere her om du vil.
const ARTISTS = ["Claude Monet", "Vincent van Gogh", "Edvard Munch", "Pierre-Auguste Renoir", "Gustave Caillebotte", "Georges Seurat", "Paul Cézanne", "Mary Cassatt", "Katsushika Hokusai", "Johannes Vermeer"];
async function paintings() {
  if (old.art && old.art.length && old.artUpdated && Date.now() - new Date(old.artUpdated) < 7 * 864e5) { data.artUpdated = old.artUpdated; return old.art; }
  const AH = { "AIC-User-Agent": UA, "User-Agent": UA, Accept: "application/json" };
  const out = [], seen = new Set();
  for (const name of ARTISTS) {
    const q = new URLSearchParams({ q: name, limit: "40", fields: "id,title,artist_title,artist_display,date_display,image_id,is_public_domain,artwork_type_title,thumbnail" });
    q.append("query[term][is_public_domain]", "true");
    const r = await fetch("https://api.artic.edu/api/v1/artworks/search?" + q, { headers: AH });
    if (!r.ok) { console.log("  Malerier: " + name + " svarte " + r.status); continue; }
    const items = (await r.json()).data || [];
    let n = 0;
    for (const it of items) {
      if (!it.is_public_domain || !it.image_id || seen.has(it.id)) continue;
      if (!/painting/i.test(it.artwork_type_title || "") && !/hokusai/i.test(name)) continue;
      if (!(it.artist_title || it.artist_display || "").toLowerCase().includes(name.split(" ").pop().toLowerCase())) continue;
      seen.add(it.id); n++;
      out.push({ title: it.title, artist: it.artist_title || name, year: it.date_display || "", img: `https://www.artic.edu/iiif/2/${it.image_id}/full/843,/0/default.jpg`, url: `https://www.artic.edu/artworks/${it.id}` });
      if (n >= 8) break;
    }
    await new Promise(res => setTimeout(res, 400));
  }
  console.log("  Malerier: " + out.length + " fra " + [...new Set(out.map(o => o.artist))].join(", "));
  data.artUpdated = new Date().toISOString();
  return out;
}

// ================= BERGEN, KRISTIANSAND, TRONDHEIM =================
const ddmmyyyy = t => { const m = t.match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

// ---------- Den Nationale Scene (Bergen) ----------
function parseDns($, base) {
  const out = [], seen = new Set();
  $("h2").each((_, h2) => {
    const title = $(h2).text().replace(/\s+/g, " ").trim(); if (!title) return;
    const card = cardAround($, h2, c => c.find("img").length > 0 && c.find('a[href*="/forestillinger/"]').length > 0);
    if (card.find("h2").length !== 1) return;
    const link = $(h2).find("a").attr("href") || $(h2).closest("a").attr("href") || card.find('a[href*="/forestillinger/"]').first().attr("href");
    const url = abs(link, base); if (!/\/forestillinger\/[^/]+/.test(url) || seen.has(url)) return;
    const text = cheerio.load($.html(card).replace(/<[^>]+>/g, "\n")).text();
    const lines = text.split("\n").map(x => x.trim()).filter(Boolean);
    const iso = (text.match(/(\d{4}-\d{2}-\d{2})-/) || [])[1];
    const ti = lines.indexOf(title);
    const before = lines.slice(0, ti > 0 ? ti : 2).filter(l => !/kjøp billetter|les mer/i.test(l));
    seen.add(url);
    out.push({ title, venue: "Den Nationale Scene" + (before[0] ? ", " + before[0] : ""), url, img: posterOf($, card, base).best,
      from: iso && !iso.startsWith("9999") ? iso : null, to: null, about: before.slice(1).join(". "), hint: before.join(" ") });
  });
  return out;
}
// Prøv vanlig henting først; får vi ingenting (f.eks. en mellomside), åpnes siden i den usynlige nettleseren
async function dns(browser) {
  const base = "https://dns.no/forestillinger/";
  let $ = await getHtml(base), out = parseDns($, base);
  if (out.length) return out;
  console.log(`  DNS (vanlig henting): tittel="${$("title").text().trim()}", h2=${$("h2").length}, lenker=${$('a[href*="/forestillinger/"]').length} – prøver nettleser`);
  const page = await browser.newPage({ userAgent: UA, locale: "nb-NO" });
  try {
    await page.goto(base, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    $ = cheerio.load(await page.content()); out = parseDns($, base);
    if (!out.length) console.log(`  DNS (nettleser): tittel="${$("title").text().trim()}", h2=${$("h2").length}, lenker=${$('a[href*="/forestillinger/"]').length}, tekst: ${$("body").text().replace(/\s+/g, " ").slice(0, 300)}`);
    return out;
  } finally { await page.close(); }
}

// ---------- Kilden (Kristiansand) ----------
const KILDEN_SKIP = /babysang|kilden ut i agder/i;
async function kilden() {
  const base = "https://kilden.com/program/";
  const $ = await getHtml(base);
  const shows = new Map(), now = new Date();
  $('a[href*="/program/"]').each((_, a) => {
    const url = abs($(a).attr("href"), base);
    if (!/\/program\/\d+-/.test(url)) return;
    const card = cardAround($, a, c => c.find("h4").length > 0);
    const title = card.find("h4").first().text().replace(/\s+/g, " ").trim();
    const text = cheerio.load($.html(card).replace(/<[^>]+>/g, " ")).text().replace(/\s+/g, " ");
    if (!title || KILDEN_SKIP.test(text)) return;
    const m = text.match(/(\d{1,2})\.\s*(jan|feb|mar|apr|mai|jun|jul|aug|sep|okt|nov|des)\w*\s*kl\.?\s*(\d{1,2}):(\d{2})/i);
    if (!m) return;
    const mo = MON[m[2].toLowerCase()];
    let y = now.getFullYear(); if (new Date(y, mo - 1, Number(m[1])) < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)) y++;
    const iso = `${y}-${pad(mo)}-${pad(m[1])}T${pad(m[3])}:${m[4]}`;
    const tags = text.slice(text.indexOf(title) + title.length).split(/location_on|confirmation_number/)[0].trim();
    if (!shows.has(url)) shows.set(url, { title, venue: "Kilden", url, img: posterOf($, card, base).best, times: [], hint: tags, about: card.find("h5").first().text().trim() });
    const s = shows.get(url); if (!s.times.includes(iso)) s.times.push(iso);
  });
  return [...shows.values()].map(s => ({ ...s, times: s.times.sort() }));
}

// ---------- Bruddet Fjæreheia (Grimstad, sommersesong) ----------
async function fjaereheia() {
  const base = "https://www.xn--bruddetfjreheia-5lb.no/program";
  const $ = await getHtml(base);
  const year = ($("h1").first().text().match(/(\d{4})/) || [])[1] || String(new Date().getFullYear());
  const today = new Date().toISOString().slice(0, 10), out = [];
  $('a[href*="/program/"]').each((_, a) => {
    const el = $(a), text = el.text().replace(/\s+/g, " ");
    if (/ferdigspilt/i.test(text)) return;                 // forestillinger som er ferdig spilt hoppes over
    const title = el.find("h2,h3,h4").first().text().trim() || el.find("img").attr("alt") || "";
    const dates = datesIn(text.replace(/(\d{1,2}\.\s*\p{L}+)(?!\s*\d{4})/gu, `$1 ${year}`)).filter(d => d >= today);
    if (!title || !dates.length) return;
    out.push({ title, venue: "Bruddet Fjæreheia (Grimstad)", url: abs(el.attr("href"), base), img: posterOf($, el, base).best,
      from: dates[0], to: dates[dates.length - 1], about: "", hint: text.slice(0, 300) });
  });
  console.log("  Bruddet Fjæreheia: " + out.length + " kommende (sommerprogrammet kommer gjerne på vinteren)");
  return out;
}

// ---------- Trøndelag Teater (Trondheim) ----------
async function trondelag() {
  const base = "https://www.trondelag-teater.no/forestillinger";
  const $ = await getHtml(base);
  const out = [], seen = new Set();
  $("h3").each((_, h) => {
    const card = cardAround($, h, c => /Spilles fra/i.test(c.text()) && c.find('a[href*="/forestillinger/"]').length > 0);
    const text = card.text().replace(/\s+/g, " ");
    if (!/Spilles fra/i.test(text) || card.find("h3").length !== 1) return;   // bare kort med én forestilling (ikke kalenderen øverst)
    const title = $(h).text().trim(), url = abs(card.find('a[href*="/forestillinger/"]').first().attr("href"), base).split("#")[0];
    if (!title || seen.has(url)) return; seen.add(url);
    let p = posterOf($, card, base), box = card;
    for (let k = 0; k < 4 && !p.best; k++) { box = box.parent(); if (!box.length || box.find("h3").length > 1) break; p = posterOf($, box, base); }
    out.push({ title, venue: "Trøndelag Teater", url, img: p.best,
      from: ddmmyyyy(text.split(/Spilles fra/i)[1] || ""), to: null, about: $(h).next().text().trim().slice(0, 160), hint: text.slice(0, 300) });
  });
  return out;
}

// ---------- Nye Hjorten Teater (Trondheim): siden henter forestillingene fra et eventim-API ----------
async function nyehjorten(browser) {
  const base = "https://nyehjortenteater.no/program?type=productions";
  const rule = await robotsRule(base); if (rule && !rule.allow) throw new Error("robots.txt sperrer " + base);
  const page = await browser.newPage({ userAgent: UA, locale: "nb-NO" });
  const bodies = [];
  page.on("response", async r => { try { if (/fetch-eventim/.test(r.url())) bodies.push(await r.json()); } catch {} });
  try {
    const byProd = new Map(), bySlug = new Map();
    for (const pageUrl of [base, "https://nyehjortenteater.no/program", "https://nyehjortenteater.no/program?type=events"]) {   // «Forestillinger» og «Alle» (med gjestespill/arrangementer)
    await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    for (let k = 0; k < 12; k++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(400); }
    const $ = cheerio.load(await page.content());
    // plakat og lenke per produksjon: kortet som har både /program/-lenke og billettlenke med production=NN
    $('a[href^="/program/"], a[href*="nyehjortenteater.no/program/"]').each((_, a) => {
      const href = abs($(a).attr("href"), base); if (!/\/program\/[^/?#]+$/.test(href)) return;
      const card = cardAround($, a, c => c.find("img").length > 0);
      if (new Set(card.find('a[href*="/program/"]').map((_, x) => abs($(x).attr("href"), base)).get()).size > 1) return;
      const info = { url: href, img: posterOf($, card, base).best };
      bySlug.set(href.split("/program/")[1], info);
      const prod = (card.find('a[href*="production="]').attr("href") || "").match(/production=(\d+)/);
      if (prod && (!byProd.has(prod[1]) || !byProd.get(prod[1]).img)) byProd.set(prod[1], info);
    });
    }
    const one = v => Array.isArray(v) ? v[0] : v;
    const val = v => { v = one(v); return v && typeof v === "object" ? (v._ ?? "") : (v ?? ""); };
    const items = bodies.flatMap(b => { const d = b.data || b; const w = d.eventiminhouseweb || d; return [].concat(w.veranstaltung || []); });
    const now = new Date().toISOString().slice(0, 16);
    const slugify = t => t.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const shows = new Map();
    for (const it of items) {
      const title = String(val(it.Arrangementstittel)).trim(); if (!title) continue;
      const d = ddmmyyyy(String(val(it.Arrangementsdato))); const t = String(val(it.Arrangementstid)).padStart(4, "0");
      if (!d) continue;
      const iso = `${d}T${t.slice(0, 2)}:${t.slice(2, 4)}`; if (iso < now) continue;
      const prod = String(val(it.Produksjonsnummer));
      const sl = slugify(title);
      const info = byProd.get(prod) || [...bySlug.entries()].find(([k]) => k.startsWith(sl.slice(0, 12)) || sl.startsWith(k.slice(0, 12)))?.[1] || {};
      const key = prod || title;
      if (!shows.has(key)) shows.set(key, { title, venue: "Nye Hjorten Teater" + (val(it.Salnavn) ? ", " + val(it.Salnavn) : ""), url: info.url || "https://nyehjortenteater.no/program", img: info.img || "", times: [], hint: title });
      const s = shows.get(key); if (!s.times.includes(iso)) s.times.push(iso);
    }
    // Mangler fortsatt plakat: prøv forestillingens egen side (adressen lages av tittelen) og bruk delingsbildet der
    const prevImg = new Map((old.nyehjorten || []).filter(x => x.img).map(x => [x.title, x]));
    for (const sh of shows.values()) {
      if (sh.img) continue;
      if (prevImg.has(sh.title)) { sh.img = prevImg.get(sh.title).img; sh.url = prevImg.get(sh.title).url; continue; }
      const guess = "https://nyehjortenteater.no/program/" + slugify(sh.title);
      try {
        const $d = await getHtml(guess);
        const og = abs($d('meta[property="og:image"]').attr("content") || "", guess);
        if (og && !/logo|default|fallback/i.test(og)) { sh.img = og; sh.url = guess; }
      } catch {}
      if (!sh.img) {   // siste forsøk: åpne siden i nettleseren og ta første store bilde
        try {
          await page.goto(guess, { waitUntil: "networkidle", timeout: 30000 });
          const $p = cheerio.load(await page.content());
          const p = posterOf($p, $p("main").length ? $p("main") : $p("body"), guess);
          if (p.best && !/logo/i.test(p.best)) { sh.img = p.best; sh.url = guess; }
        } catch {}
      }
      console.log(`  Nye Hjorten: plakat for «${sh.title}»: ${sh.img ? "funnet" : "ikke funnet"} (${guess})`);
    }
    console.log(`  Nye Hjorten: ${items.length} visninger i API-et, ${shows.size} forestillinger, ${[...shows.values()].filter(x => x.img).length} med plakat`);
    return [...shows.values()].map(s => ({ ...s, times: s.times.sort() }));
  } finally { await page.close(); }
}

// Trøndelag Teater laster plakatene først når de scrolles inn i bildet: åpne siden i nettleseren og scroll sakte nedover
async function trondelagPosters(browser) {
  const list = data.trondelag; if (!Array.isArray(list) || list.every(x => x.img)) return;
  // gjenbruk bare plakater som faktisk er hentet via nettleseren (eldre forsøk ga feil bilder)
  const known = new Map((old.trondelag || []).filter(x => x.img && x.imgSrc === "nettleser3").map(x => [x.url, x]));
  list.forEach(x => { if (known.has(x.url)) { x.img = known.get(x.url).img; x.imgAlt = known.get(x.url).imgAlt || []; x.imgSrc = "nettleser3"; } else if (x.imgSrc !== "nettleser3") x.img = ""; });
  if (list.every(x => x.img)) { console.log("  Trøndelag-plakater: alle " + list.length + " hentet tidligere"); return; }
  const base = "https://www.trondelag-teater.no/forestillinger";
  const page = await browser.newPage({ userAgent: UA, locale: "nb-NO", viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(base, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    // scroll hvert plakatområde inn i bildet, ett om gangen, slik at «lazyload» laster bildet
    const wrappers = await page.$$(".image-wrapper, .lazyload-placeholder");
    for (const el of wrappers) {
      try { await el.scrollIntoViewIfNeeded(); await page.evaluate(() => window.dispatchEvent(new Event("scroll"))); await page.waitForTimeout(400); } catch {}
    }
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); window.dispatchEvent(new Event("scroll")); await new Promise(r => setTimeout(r, 200)); } });
    await page.waitForTimeout(2000);
    const $ = cheerio.load(await page.content());
    const byUrl = new Map();
    $("h3").each((_, h) => {
      const card = cardAround($, h, c => /Spilles fra/i.test(c.text()) && c.find('a[href*="/forestillinger/"]').length > 0);
      if (card.find("h3").length !== 1) return;
      const url = abs(card.find('a[href*="/forestillinger/"]').first().attr("href"), base).split("#")[0];
      const p = posterOf($, card, base); if (p.best) byUrl.set(url, p.ok);
    });
    let n = 0; list.forEach(x => { if (!x.img && byUrl.has(x.url)) { const ok = byUrl.get(x.url); x.img = ok[0]; x.imgAlt = ok.slice(1, 4); x.imgSrc = "nettleser3"; n++; } });
    const missing = list.filter(x => !x.img).length;
    console.log(`  Trøndelag-plakater: ${n} hentet via nettleser, ${missing} mangler` + (missing ? ". Diagnose: " + $.html($(".lazyload-placeholder").first().parent()).replace(/\s+/g, " ").slice(0, 400) : ""));
  } finally { await page.close(); }
}

// ---------- Quiz: faste quizkvelder fra Norges Quizforbunds pubquizliste ----------
// Stedene du vil følge med på. «fallback» brukes hvis stedet ikke står i Quizforbundets liste.
const MY_QUIZ = [
  { name: "Rabalder Bar", match: /rabalder/i },
  { name: "Grünerløkka Brygghus", match: /grünerløkka brygghus/i },
  { name: "Ringnes Brygghus", match: /ringnes brygghus/i },
  { name: "Cultivate Food", match: /cultivate/i },
  { name: "Nieu Torshov", match: /nieu/i, fallback: { day: "Onsdag", time: "19:00", type: "Allmenn", note: "Populær – kom gjerne en time før, ingen bordbestilling" } }
];
const WEEKDAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
function quizRule(day) {
  const d = day.toLowerCase();
  const wd = WEEKDAYS.findIndex(w => d.includes(w));
  let rule = "weekly";
  if (/1\.|første/.test(d) && /måned|mnd/.test(d)) rule = "first";
  else if (/siste/.test(d)) rule = "last";
  else if (/oddetall/.test(d)) rule = "odd";
  else if (/partall/.test(d)) rule = "even";
  else if (/annenhver|annen hver/.test(d)) rule = "biweekly";
  else if (/måned|mnd|utvalgte|varierer/.test(d)) rule = "monthly";
  return { wd, rule };
}
async function quiz() {
  const base = "https://www.norgesquizforbund.no/arrangementer/finn-din-pubquiz/";
  const $ = await getHtml(base);
  const out = [];
  $("tr").each((_, tr) => {
    const td = $(tr).find("td"); if (td.length < 6) return;
    const city = $(td[1]).text().trim(), place = $(td[2]).text().replace(/\s+/g, " ").trim();
    if (city !== "Oslo") return;
    const mine = MY_QUIZ.find(m => m.match.test(place)); if (!mine) return;
    const day = $(td[3]).text().replace(/\s+/g, " ").trim();
    const times = $(td[4]).html().split(/<br\s*\/?>/i).map(x => cheerio.load(x).text().trim());
    const types = $(td[5]).html().split(/<br\s*\/?>/i).map(x => cheerio.load(x).text().trim());
    times.forEach((time, i) => out.push({ place: mine.name, day, ...quizRule(day), time, type: types[i] || types[0] || "", link: abs($(td[2]).find("a").attr("href") || "", base), src: "Norges Quizforbund" }));
  });
  for (const m of MY_QUIZ) {
    if (!out.some(q => q.place === m.name)) {
      if (m.fallback) out.push({ place: m.name, ...m.fallback, ...quizRule(m.fallback.day), link: "", src: "egen research" });
      else console.log("  Quiz: fant ikke " + m.name + " i Quizforbundets liste");
    }
  }
  return out;
}

// ---------- Oslo Konserthus: programmet ligger i et eget API ----------
async function konserthus() {
  const url = "https://oslokonserthus.no/api/program?kategori=all&sal=&serie=";
  const rule = await robotsRule(url); if (rule && !rule.allow) throw new Error("robots.txt sperrer " + url);
  const r = await fetch(url, { headers: { ...H, Accept: "application/json" } });
  if (!r.ok) throw new Error("Oslo Konserthus svarte " + r.status);
  const j = await r.json(); const items = Array.isArray(j) ? j : (Object.values(j).find(Array.isArray) || []);
  const now = new Date().toISOString().slice(0, 16), out = [];
  const osloFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const toOslo = v => { const str = String(v); if (!/^\d{4}-\d{2}-\d{2}/.test(str)) return null; if (str.length <= 10) return str + "T00:00";
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(str)) return str.slice(0, 10) + "T" + str.slice(11, 16);
    const p = Object.fromEntries(osloFmt.formatToParts(new Date(str)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`; };
  for (const it of items) {
    const times = [...new Set(deepStrings(it).map(([, v]) => toOslo(v)).filter(Boolean))].filter(t => t >= now).sort();
    if (!it.title || !times.length) continue;
    out.push({ title: String(it.title).trim(), venue: "Oslo Konserthus" + (it.sal && it.sal.label ? ", " + it.sal.label : ""), url: it.billetturl || abs(it.url, "https://oslokonserthus.no/"),
      img: it.bilde && it.bilde.url ? it.bilde.url : "", times, hint: (it.kategori || []).join(" "), about: it.undertittel || "" });
  }
  if (!out.length && items[0]) console.log("  Diagnose Oslo Konserthus: felter: " + Object.keys(items[0]).join(","));
  return out;
}

// ---------- Cosmopolite: programmet ligger i nettsiden ----------
async function cosmopolite(browser) {
  const base = "https://cosmopolite.no/program";
  const page = await browser.newPage({ userAgent: UA, locale: "nb-NO" });
  try {
    const rule = await robotsRule(base); if (rule && !rule.allow) throw new Error("robots.txt sperrer " + base);
    await page.goto(base, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    for (let k = 0; k < 10; k++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(400); }
    const $ = cheerio.load(await page.content());
    const shows = new Map(), now = new Date();
    const MONTHS_NB = { januar: 1, februar: 2, mars: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, desember: 12 };
    $('a[href*="/program/"]').each((_, a) => {
      const url = abs($(a).attr("href"), base).split("#")[0];
      const m = url.match(/\/program\/([^/]+)\/(\d{4})\/([a-zæøå]+)\/([^/?]+)/i); if (!m || shows.has(url)) return;
      const card = cardAround($, a, c => c.find("img").length > 0 && /\d{1,2}\.\s*\p{L}+/u.test(c.text()));
      const bad = /^(bilde|main navigation|kjøp billett|få billetter|les mer)$/i;
      const cands = [card.find("h1,h2,h3,h4,h5").first().text(), ...card.find("a").map((_, x) => $(x).text()).get()].map(t => t.replace(/\s+/g, " ").trim()).filter(t => t && !bad.test(t) && t.length < 90);
      const title = cands[0] || m[4].replace(/-/g, " ").replace(/^\w/, c => c.toUpperCase());
      const day = (cheerio.load($.html(card).replace(/<[^>]+>/g, " ")).text().match(/(\d{1,2})\.\s*(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)/i) || []);
      const mo = MONTHS_NB[m[3].toLowerCase()]; const d = day[1] && MONTHS_NB[day[2].toLowerCase()] === mo ? day[1] : null;
      const from = d ? `${m[2]}-${pad(mo)}-${pad(d)}` : null;
      if (from && new Date(from + "T23:59") < now) return;
      shows.set(url, { title, venue: "Cosmopolite" + (/belleville/i.test(m[1]) ? ", Belleville" : ""), url, img: posterOf($, card, base).best, from, to: from, about: "", hint: card.text().replace(/\s+/g, " ").slice(0, 200) });
    });
    return [...shows.values()];
  } finally { await page.close(); }
}

// ---------- Vink (Aftenposten): restauranttitler, privat bruk etter avtale med Vink ----------
const VINK_OTHER_CITY = /^(Bergen|Trondheim|Stavanger|Kristiansand|Tromsø|Bodø|Ålesund|Drammen|Fredrikstad|Tønsberg|Stockholm|Göteborg|København|London|Paris|Roma|Berlin)$/i;
async function vink() {
  const base = "https://vink.aftenposten.no/mat-og-drikke";
  const $ = await getHtml(base);
  const seen = new Set(), out = [];
  $('a[href*="/artikkel/"]').each((_, a) => {
    const el = $(a), url = abs(el.attr("href"), base).split("?")[0];
    if (!url || seen.has(url)) return; seen.add(url);
    const leaves = [];
    el.find("*").each((_, n) => { const c = $(n); if (!c.children().length) { const t = c.text().replace(/\s+/g, " ").trim(); if (t) leaves.push(t); } });
    const L = [...new Set(leaves)];
    const alt = (el.find("img").attr("alt") || "").trim();
    let title = [...L].sort((x, y) => y.length - x.length)[0] || alt || el.text().replace(/\s+/g, " ").trim();
    if (title.length < 8 && alt) title = alt;
    if (!title) return;
    const score = L.find(t => /^[1-6]$/.test(t)) || "";
    const city = L.find(t => VINK_OTHER_CITY.test(t)) || "";
    if (city) return; // bare Oslo
    const ti = L.indexOf(title);
    const kicker = L.find((t, i) => i < (ti < 0 ? L.length : ti) && t !== score && t !== title) || "";
    const after = L.filter((t, i) => i > ti && t !== score && t !== title);
    const cat = after[after.length - 1] || "";
    let img = imgOf(el, base);
    if (!img) { const ss = el.find("source").attr("srcset") || ""; img = abs(ss.split(",")[0].trim().split(/\s+/)[0], base); }
    out.push({ title, kicker: kicker === title ? "" : kicker, score, cat: cat === kicker ? "" : cat, url, img });
  });
  console.log("  Vink: " + out.length + " saker" + (out[0] ? ` (første: ${out[0].kicker} – ${out[0].title})` : ""));
  return out.slice(0, 24);
}

// ---------- Billettpriser: Scenekort og OBOS først, så ordinær pris ----------
// Leser arrangørens egen side for hver forestilling/konsert i Oslo. Ticketmaster-sider hoppes over.
// Hver side sjekkes på nytt én gang i uken; maks PRICE_MAX_NEW nye sider per kjøring for å være skånsom.
const PRICE_MAX_NEW = 40, PRICE_TTL = 7 * 864e5;
const PRICE_ORDER = ["Scenekort", "OBOS", "Ordinær", "Fra"];
function labelOf(w) {
  w = w.toLowerCase();
  if (w.startsWith("scenekort")) return "Scenekort";
  if (w.startsWith("obos")) return "OBOS";
  if (/^(ordin|full|voksen)/.test(w)) return "Ordinær";
  if (w === "fra" || w.startsWith("priser fra") || w.startsWith("billetter fra")) return "Fra";
  return null;
}
function pricesFrom($) {
  const found = {};
  const put = (l, v) => { if (l && !(l in found)) found[l] = v; };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).text());
      for (const x of [].concat(j, j["@graph"] || [])) for (const o of [].concat(x?.offers || [])) {
        const n = Math.round(Number(o.lowPrice ?? o.price));
        if (n >= 50 && n <= 5000 && (!found.Fra || n < found.Fra.kr)) found.Fra = { kr: n };
      }
    } catch {}
  });
  $("script,style,noscript,svg").remove();
  $("body *").each((_, e) => { $(e).append(" "); }); // mellomrom mellom elementer, så «390 kr» ikke klistres til neste ord
  const text = $("body").text().replace(/\s+/g, " ");
  const W = "(scenekort(?:pris|medlemmer)?|obos(?:-?(?:pris|medlem(?:mer)?|rabatt))?|ordin[æa]r(?:\\s*pris)?|full\\s*pris|fullpris|voksen|billetter fra|priser fra|fra)";
  const reKr = new RegExp(W + "\\s*[:\\-–]?\\s*(kr\\.?\\s*|nok\\s*)?(\\d{1,2}[ .]\\d{3}|\\d{2,4})\\s*(,-|,00|kr\\b|nok\\b)?", "gi");
  for (const m of text.matchAll(reKr)) {
    if (!m[2] && !m[4]) continue; // må ha kr / ,- for å regnes som pris
    const n = Number(m[3].replace(/[ .]/g, ""));
    if (n >= 50 && n <= 5000) put(labelOf(m[1]), { kr: n });
  }
  for (const m of text.matchAll(/(scenekort|obos)[^.!?]{0,60}?(\d{1,2})\s*(%|prosent)/gi)) put(labelOf(m[1]), { pct: Number(m[2]) });
  let list = PRICE_ORDER.filter(l => found[l]).map(l => ({ l, ...found[l] }));
  if (found.Ordinær && found.Fra) list = list.filter(x => x.l !== "Fra");
  return list;
}
async function prices() {
  const prev = old.prices || {}, out = {}, now = Date.now(), items = [];
  for (const [k, v] of Object.entries(data)) {
    if (!Array.isArray(v) || ["films", "art", "quiz", "vink"].includes(k)) continue;
    for (const x of v) {
      if (!x || !x.url || x.city !== "Oslo" || x.prices) continue;
      if (/ticketmaster\./i.test(x.url)) continue;
      const first = (x.times && x.times[0]) || x.from || "9999";
      items.push({ url: x.url, first });
    }
  }
  items.sort((a, b) => String(a.first).localeCompare(String(b.first)));
  let fetched = 0;
  for (const { url } of items) {
    if (url in out) continue;
    const c = prev[url];
    if (c && now - c.at < PRICE_TTL) { out[url] = c; continue; }
    if (fetched >= PRICE_MAX_NEW) { if (c) out[url] = c; continue; }
    fetched++;
    try { out[url] = { p: pricesFrom(await getHtml(url)), at: now }; }
    catch (e) { out[url] = { p: (c && c.p) || [], at: now, err: true }; }
    await new Promise(res => setTimeout(res, 800));
  }
  const withP = Object.values(out).filter(x => x.p && x.p.length).length;
  console.log(`  Priser: ${fetched} sider sjekket nå, priser funnet for ${withP} av ${Object.keys(out).length}`);
  return out;
}

// ---------- Kjør alt, behold forrige data hvis en kilde feiler ----------
async function run(key, fn, allowEmpty = false) {
  try {
    const v = await fn();
    if (Array.isArray(v) && v.length === 0 && !allowEmpty) throw new Error("fant ingen oppføringer");
    data[key] = v; console.log("OK", key, Array.isArray(v) ? v.length : "");
  } catch (e) {
    data[key] = old[key] ?? null; data.errors.push(`${key}: ${e.message}`); console.log("FEIL", key, e.message);
  }
}
for (const [key, fn] of [["weather", weather], ["christiania", christiania], ["nationaltheatret", nationaltheatret], ["films", nfkino], ["oslonye", oslonye], ["operaen", operaen], ["neuf", neuf], ["chatnoir", chatnoirApi], ["art", paintings], ["kilden", kilden], ["trondelag", trondelag], ["quiz", quiz], ["vink", vink]]) await run(key, fn);
await run("fjaereheia", fjaereheia, true);

const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  await run("detnorske", () => rendered(browser, ["https://www.detnorsketeatret.no/framsyningar"], "Det Norske Teatret", null, { noDates: true, origins: ["https://program.detnorsketeatret.no"] }));
  await run("dns", () => dns(browser));
  // ---- Konsertsteder ----
  await run("k_rockefeller", () => eventsEdge("https://www.rockefeller.no", "Rockefeller"));
  await run("k_blaa", () => eventsEdge("https://www.blaaoslo.no", "Blå"));
  await run("k_vulkan", () => eventsEdge("https://vulkanarena.no", "Vulkan Arena"));
  await run("k_konserthus", () => konserthus());
  await run("k_cosmopolite", () => cosmopolite(browser));
  await run("nyehjorten", () => nyehjorten(browser));
  try { await trondelagPosters(browser); } catch (e) { console.log("  Trøndelag-plakater feilet: " + e.message); }
} finally { await browser.close(); }
// Hvilken by hver kilde hører til (nye byer legges til her)
const CITY = { k_rockefeller: "Oslo", k_blaa: "Oslo", k_vulkan: "Oslo", k_cosmopolite: "Oslo", k_konserthus: "Oslo", dns: "Bergen", kilden: "Kristiansand", fjaereheia: "Kristiansand", trondelag: "Trondheim", nyehjorten: "Trondheim", christiania: "Oslo", nationaltheatret: "Oslo", oslonye: "Oslo", operaen: "Oslo", neuf: "Oslo", chatnoir: "Oslo", detnorske: "Oslo", films: "Oslo" };
for (const [k, city] of Object.entries(CITY)) if (Array.isArray(data[k])) data[k].forEach(x => { x.city = x.city || city; });
try { data.prices = await prices(); } catch (e) { data.prices = old.prices || {}; data.errors.push("prices: " + e.message); console.log("FEIL prices", e.message); }
fs.writeFileSync("data.json", JSON.stringify(data, null, 1));
