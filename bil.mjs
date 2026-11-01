// Henter status fra Nissan Leaf (MyNissan / Kamereon) og lagrer den KRYPTERT i bil.enc.json.
// Kjøres av GitHub Actions (.github/workflows/bil.yml). Ingen ekstra pakker trengs (Node 22).
//
// Secrets i GitHub:
//   NISSAN_USER, NISSAN_PASSWORD  – samme innlogging som i MyNissan-appen
//   CAR_KEY                        – krypteringsnøkkel (32 byte, base64url). Samme nøkkel står i lenken til skjermen (#k=...)
//   BIL_TOKEN                      – GitHub-nøkkel som lar skjermen starte klima / oppdatering (legges kryptert i fila)
//   NISSAN_VIN (valgfri)           – hvis kontoen har flere biler
// Input fra workflow: ACTION = status | refresh | hvac-start | hvac-stop | charge-start, TEMP = ønsket temperatur
//
// Ingenting om bilen (posisjon, VIN, passord) skrives i klartekst – verken i fila eller i loggen.
import fs from "node:fs";
import crypto from "node:crypto";

const S = {
  clientId: "ZM3WK7ax1OtQKYQ8Qqzcv5VgiA8a",
  scope: "openid name profile email offline_access",
  kScope: "openid profile vehicles",
  auth: "https://login.mynissan-account.com/",
  redirect: "com://wso2.service.nci",
  platform: "Android",
  car: "https://alliance-platform-caradapter-prod.apps.eu2.kamereon.io/car-adapter/",
  userAdapter: "https://alliance-platform-usersadapter-prod.apps.eu2.kamereon.io/user-adapter/",
  bff: "https://nci-bff-web-prod.apps.eu2.kamereon.io/bff-web/",
};
const OUT = "bil.enc.json", TOKFILE = "bil-token.enc";
const ACTION = (process.env.ACTION || "status").trim();
const TEMP = Math.min(26, Math.max(16, Number(process.env.TEMP || 21) || 21));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- kryptering (AES-256-GCM, samme format som nettleseren leser) ----------
const KEY = Buffer.from((process.env.CAR_KEY || "").trim(), "base64url");
if (KEY.length !== 32) { console.log("FEIL: CAR_KEY mangler eller er ikke 32 byte"); process.exit(1); }
function enc(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final(), c.getAuthTag()]);
  return { v: 1, iv: iv.toString("base64"), ct: ct.toString("base64") };
}
function dec(box) {
  const iv = Buffer.from(box.iv, "base64"), all = Buffer.from(box.ct, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv); d.setAuthTag(all.subarray(all.length - 16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString("utf8"));
}
const readEnc = f => { try { return dec(JSON.parse(fs.readFileSync(f, "utf8"))); } catch { return null; } };

// ---------- innlogging (MyNissan OneID -> Kamereon), samme flyt som appen ----------
const jar = new Map();
function keepCookies(res) { for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } }
const cookieHdr = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const isAuth = u => { try { return new URL(u).host === new URL(S.auth).host; } catch { return false; } };
const HTML = { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148" };
async function req(url, opt = {}) {
  const res = await fetch(url, { ...opt, redirect: "manual", headers: { ...HTML, ...(opt.headers || {}), Cookie: cookieHdr() }, signal: AbortSignal.timeout(30000) });
  keepCookies(res); return res;
}
const decodeEnt = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function loginForm(html) {
  for (const m of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const action = (/action=["']([^"']*)["']/i.exec(m[0]) || [])[1];
    const inputs = {};
    for (const t of m[1].matchAll(/<input\b[^>]*>/gi)) {
      const n = /name=["']([^"']*)["']/i.exec(t[0]); if (!n) continue;
      const v = /value=["']([^"']*)["']/i.exec(t[0]); inputs[n[1]] = v ? decodeEnt(v[1]) : "";
    }
    if ("sessionDataKey" in inputs && "password" in inputs) return { action: action ? decodeEnt(action) : null, inputs };
  }
  return null;
}
async function login() {
  const user = process.env.NISSAN_USER, pass = process.env.NISSAN_PASSWORD;
  if (!user || !pass) throw new Error("NISSAN_USER / NISSAN_PASSWORD mangler i GitHub Secrets");
  jar.clear();
  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  let url = S.auth + "oauth2/authorize?" + new URLSearchParams({ response_type: "code", redirect_uri: S.redirect, client_id: S.clientId, state, scope: S.scope,
    code_challenge: challenge, code_challenge_method: "S256", locale: "en_GB", brand: "Nissan", client: "mynissanapp" });
  let res = await req(url);
  for (let i = 0; i < 10 && res.status >= 300 && res.status < 400; i++) {
    const t = new URL(res.headers.get("location"), url).toString(); if (!isAuth(t)) throw new Error("uventet omdirigering ved innlogging");
    url = t; res = await req(url);
  }
  const form = loginForm(await res.text());
  if (!form || !form.action) throw new Error("fant ikke innloggingsskjemaet hos Nissan (status " + res.status + ")");
  const formUrl = new URL(form.action, url).toString(); if (!isAuth(formUrl)) throw new Error("uventet adresse for innloggingsskjemaet");
  const region = form.inputs.regionCode || "";
  const body = new URLSearchParams({ ...form.inputs, userName: user, username: region ? `${region}/${user}` : user, password: pass });
  const o = new URL(formUrl);
  res = await req(formUrl, { method: "POST", body: body.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: `${o.protocol}//${o.host}`, Referer: url } });
  let cb = null, cur = formUrl;
  for (let i = 0; i < 10; i++) {
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location"); if (!loc) break;
      if (loc.startsWith(S.redirect)) { cb = loc; break; }
      const t = new URL(loc, cur).toString(); if (!isAuth(t)) throw new Error("uventet omdirigering etter innlogging");
      cur = t; res = await req(cur); continue;
    }
    if (res.status < 300 && loginForm(await res.text())) throw new Error("Nissan godtok ikke brukernavn/passord");
    break;
  }
  if (!cb) throw new Error("innloggingen ble ikke fullført – åpne MyNissan-appen og godta eventuelle nye vilkår, prøv igjen");
  const q = new URL(cb.replace(/^com:\/\//, "https://x/")).searchParams;
  if (q.get("error")) throw new Error("Nissan: " + q.get("error"));
  if (q.get("state") !== state || !q.get("code")) throw new Error("ugyldig svar fra Nissan-innloggingen");
  res = await fetch(S.auth + "oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ redirect_uri: S.redirect, grant_type: "authorization_code", client_id: S.clientId, code: q.get("code"), code_verifier: verifier, scope: S.scope }).toString() });
  const t1 = await res.json().catch(() => ({}));
  if (!t1.id_token) throw new Error("fikk ikke token fra Nissan (" + res.status + ")");
  return kamereon(`${S.bff}v1/oauth2/access_token?platform=${S.platform}`, t1.id_token);
}
async function kamereon(url, auth, body = null) {
  const res = await fetch(url, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/vnd.api+json", Accept: "application/json" }, body, signal: AbortSignal.timeout(30000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error("fikk ikke Kamereon-token (" + res.status + ")");
  return { access: j.access_token, refresh: j.refresh_token || null, type: j.token_type || "Bearer", exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
}
async function getToken() {
  const old = readEnc(TOKFILE);
  if (old?.access && old.exp > Date.now() + 120000) { log("  Bruker lagret token"); return old; }
  if (old?.refresh) {
    try { const t = await kamereon(`${S.bff}v1/oauth2/refresh-token?platform=${S.platform}`, old.refresh, JSON.stringify({ scope: S.kScope })); t.refresh ||= old.refresh; log("  Token fornyet"); return t; }
    catch (e) { log("  Fornying feilet, logger inn på nytt: " + e.message); }
  }
  const t = await login(); log("  Logget inn hos Nissan"); return t;
}

// ---------- Kamereon-API ----------
let TOKEN;
async function api(method, url, data) {
  for (let k = 0; k < 2; k++) {
    const res = await fetch(url, { method, headers: { Authorization: `${TOKEN.type} ${TOKEN.access}`, "Content-Type": "application/vnd.api+json", Accept: "*/*",
      "User-Agent": "NissanConnect/2 CFNetwork/978.0.7 Darwin/18.7.0" }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(120000) });
    if (res.status === 401 && k === 0) { TOKEN = await login(); continue; }
    const j = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, j };
  }
}
const attrs = r => r?.j?.data?.attributes || r?.j?.attributes || r?.j || {};
async function get(path, ver = "v1") { try { const r = await api("GET", `${S.car}${ver}/cars/${VIN}/${path}`); log(`  ${path}: ${r.status}`); return r.ok ? attrs(r) : null; } catch (e) { log(`  ${path}: ${e.message}`); return null; } }
async function act(name, type, attributes) {
  const r = await api("POST", `${S.car}v1/cars/${VIN}/actions/${name}`, { data: attributes ? { type, attributes } : { type } });
  log(`  handling ${name}: ${r.status}`); return r.ok;
}

let VIN = (process.env.NISSAN_VIN || "").trim(), CARNAME = "Leaf";
async function main() {
  TOKEN = await getToken();
  if (!VIN) {
    const u = await api("GET", `${S.userAdapter}v1/users/current`);
    const uid = u?.j?.userId; if (!uid) throw new Error("fant ikke bruker-ID (" + u?.status + ")");
    const c = await api("GET", `${S.bff}v5/users/${uid}/cars`);
    const car = c?.j?.data?.[0]; if (!car?.vin) throw new Error("fant ingen bil på kontoen");
    VIN = car.vin; CARNAME = car.nickname || car.modelName || "Leaf";
    log(`  Fant ${c.j.data.length} bil(er) på kontoen`);
  }
  let lastAction = null;
  if (ACTION !== "status") {
    let ok = false;
    if (ACTION === "refresh") ok = (await act("refresh-battery-status", "RefreshBatteryStatus")) | (await act("refresh-hvac-status", "RefreshHvacStatus")) | (await act("refresh-location", "RefreshLocation"));
    else if (ACTION === "hvac-start") ok = await act("hvac-start", "HvacStart", { action: "start", targetTemperature: TEMP });
    else if (ACTION === "hvac-stop") ok = await act("hvac-start", "HvacStart", { action: "stop" });
    else if (ACTION === "charge-start") ok = await act("charging-start", "ChargingStart", { action: "start" });
    lastAction = { name: ACTION, ok: !!ok, at: new Date().toISOString(), temp: ACTION === "hvac-start" ? TEMP : undefined };
    // gi bilen tid til å svare, og be om ny status
    await sleep(ACTION === "refresh" ? 75000 : 40000);
    if (ACTION.startsWith("hvac")) { await act("refresh-hvac-status", "RefreshHvacStatus"); await sleep(25000); }
  }
  const b = await get("battery-status") || {}, h = await get("hvac-status") || {}, l = await get("location") || {}, ck = await get("cockpit", "v2") || {}, lk = await get("lock-status") || {};
  const num = v => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));
  const car = {
    name: CARNAME, soc: num(b.batteryLevel), range: num(b.rangeHvacOff ?? b.batteryAutonomy), rangeHvacOn: num(b.rangeHvacOn),
    plugged: num(b.plugStatus) ? num(b.plugStatus) > 0 : null, charging: num(b.chargeStatus) ? num(b.chargeStatus) > 0 : (num(b.chargeStatus) === 0 ? false : null),
    chargePower: num(b.chargePower), toFull: num(b.chargingRemainingTime ?? b.timeRequiredToFullNormal), batteryTemp: num(b.batteryTemperature),
    battUpdated: b.lastUpdateTime || b.timestamp || null,
    hvacOn: h.hvacStatus ? String(h.hvacStatus).toLowerCase() === "on" : null, cabinTemp: num(h.internalTemperature), hvacUpdated: h.lastUpdateTime || null,
    lat: num(l.gpsLatitude), lon: num(l.gpsLongitude), locUpdated: l.lastUpdateTime || null,
    mileage: num(ck.totalMileage), locked: lk.lockStatus ? String(lk.lockStatus).toLowerCase() === "locked" : null,
  };
  log(`  Status: batteri ${car.soc ?? "?"} %, lader ${car.charging}, klima ${car.hvacOn}, posisjon ${car.lat !== null ? "ja" : "nei"}`);
  // skriv bare ny fil når noe faktisk er endret (ellers blir det en ny commit hver halvtime)
  const prev = readEnc(OUT);
  const same = prev && !lastAction && JSON.stringify({ ...prev.car }) === JSON.stringify(car) && prev.token === (process.env.BIL_TOKEN || "");
  if (!same) fs.writeFileSync(OUT, JSON.stringify(enc({ car, lastAction: lastAction || prev?.lastAction || null, fetched: new Date().toISOString(), token: process.env.BIL_TOKEN || "" })));
  else log("  Ingen endring siden sist");
  // tokenet lagres (kryptert) bare når det er nytt, så det ikke blir unødige commits
  const oldTok = readEnc(TOKFILE);
  if (!oldTok || oldTok.access !== TOKEN.access) fs.writeFileSync(TOKFILE, JSON.stringify(enc(TOKEN)));
}
main().catch(e => {
  console.log("FEIL: " + e.message);
  // skriv feilen kryptert, så skjermen kan vise at noe er galt
  try { const prev = readEnc(OUT) || {}; if (ACTION !== "status") fs.writeFileSync(OUT, JSON.stringify(enc({ ...prev, lastAction: { name: ACTION, ok: false, at: new Date().toISOString(), error: e.message }, token: process.env.BIL_TOKEN || prev.token || "" }))); } catch {}
  process.exit(ACTION === "status" ? 1 : 0);
});
