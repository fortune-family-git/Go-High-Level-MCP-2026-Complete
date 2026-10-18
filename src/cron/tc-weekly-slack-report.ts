/**
 * TC-Wochenreport -> Slack-Direktnachricht (Railway-Cron, montags 08:00 Europe/Berlin).
 *
 * Gleiche Regeln wie das FF Sales Cockpit (https://claude.ai/artifact/TBi7snHfWFygLsHcx5TQu1)
 * und die TC-Entwicklungsseite (https://claude.ai/artifact/9YAXsMDAYJSQ3QRwz1avQS):
 *  - Team & Ziele: Notion „Team (Provision)" ist führend. Nur Rolle TC bekommt einen Block,
 *    Ziel = „Zielumsatz pro Woche", anteilig nach „Aktiv von"/„Aktiv bis".
 *  - Aufträge: Notion „Verkaufsmeldungen", alles außer Status verworfen. Jede Zahlung (AZ/RZ/TZ…)
 *    ist eine eigene Meldung mit der vollen Deal-Höhe -> zusammengefasst zu einem Auftrag:
 *    gleiche E-Mail + gleiche Programm-Familie + gleiche Deal-Höhe (Meldung ohne Deal-Höhe hängt
 *    sich an). Datum und TC = erste Meldung. Umsatz = Deal-Höhe netto einmal pro Auftrag.
 *  - Gespräche: GHL-Kalendergruppen „Für mehr Klarheit" (KG) und „Follow Up Gespräche" (FU).
 *    Gehalten = confirmed UND Termin vorbei (diese Location hat kein "showed").
 *    Ausfall = noshow oder cancelled ohne spätere Neubuchung derselben Person in derselben Gruppe.
 *  - Abschlussquote = Aufträge ÷ (gehaltene KG + gehaltene FU)   (Entscheidung Annett, 12.10.2026)
 *
 * Env:
 *   GHL_API_KEY, GHL_LOCATION_ID, NOTION_TOKEN        (wie die KPI-Syncs)
 *   SLACK_BOT_TOKEN   xoxb-…  (Scope chat:write)
 *   SLACK_USER_ID     Slack-Member-ID der Empfängerin (DM)
 *   DRY_RUN=1         Nachricht nur ins Log schreiben, nicht senden
 *   ENFORCE_SCHEDULE=true + RUN_HOUR_LOCAL=8   Zeitzonen-Gate (Cron feuert 06:00 und 07:00 UTC)
 */

const GHL_BASE = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_KEY = clean(process.env.GHL_API_KEY);
const LOCATION_ID = clean(process.env.GHL_LOCATION_ID);
const NOTION_TOKEN = clean(process.env.NOTION_TOKEN);
const NOTION_VERSION = '2022-06-28';
const SLACK_TOKEN = clean(process.env.SLACK_BOT_TOKEN);
const SLACK_USER = clean(process.env.SLACK_USER_ID);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const ENFORCE_SCHEDULE = process.env.ENFORCE_SCHEDULE === 'true';
const RUN_HOUR_LOCAL = Number(process.env.RUN_HOUR_LOCAL || '8');
const TZ = 'Europe/Berlin';

const GROUP_KG = 'wrPyrpLSeMliybw06BMf'; // „Für mehr Klarheit"
const GROUP_FU = '9wIHgkVjSGDUlCniksVy'; // „Follow Up Gespräche"
const SALES_DB = '5eb72c2777de42d88a6272bb0155bcd6'; // Verkaufsmeldungen (Slack/Stripe)
const TEAM_DB = '7d43befa9a984f66bd01ee6a91b3a537'; // Team (Provision)
const COCKPIT_URL = 'https://claude.ai/artifact/TBi7snHfWFygLsHcx5TQu1';
const NAME_SEED: Record<string, string> = {
  '8hRebq2P4CIgbPICSF47': 'Feven Winde',
  KztcjgK3QnKIn9k2YzzE: 'Monika Beye',
  cqhnHUMu1wSXuZTikUHJ: 'Bianca Kohnle-Volk',
  aBZZOxCtcUQVglxSPDpr: 'Andjelina Milanovic',
  L2IHM9q47loiJVFYwvfT: 'Stefanie Tuncer',
};
const DAY = 86400000;
const NOW = Date.now();

function clean(v?: string): string {
  return (v || '').replace(/^﻿/, '').trim();
}

// ---------- Zeit (Europe/Berlin) ----------
function berlinParts(ts: number) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(ts))) p[x.type] = x.value;
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday); // 0 = Montag
  return { y: +p.year, m: +p.month - 1, d: +p.day, hh: +p.hour, mm: +p.minute, dow };
}
function berlinOffset(ts: number): number {
  const b = berlinParts(ts);
  return Date.UTC(b.y, b.m, b.d, b.hh, b.mm) - Math.floor(ts / 60000) * 60000;
}
/** Mitternacht Berlin des Kalendertags (y, m, d) als Epoch-ms (m/d dürfen überlaufen). */
function berlinMidnight(y: number, m: number, d: number): number {
  const naive = Date.UTC(y, m, d);
  const t = naive - berlinOffset(naive);
  return naive - berlinOffset(t);
}
const fmtD = (ts: number) => { const b = berlinParts(ts); return `${String(b.d).padStart(2, '0')}.${String(b.m + 1).padStart(2, '0')}.`; };
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
function isoWeek(ts: number): number {
  const b = berlinParts(ts);
  const d = new Date(Date.UTC(b.y, b.m, b.d));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d.getTime() - firstThu.getTime()) / DAY - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}

// ---------- Format ----------
const eur = (n: number) => Math.round(n).toLocaleString('de-DE') + ' €';
const eurK = (n: number) => (Math.abs(n) >= 1000 ? (n / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 0 }) + 'K €' : Math.round(n) + ' €');
const pct = (v: number) => Math.round(v * 100) + ' %';

// ---------- Personen & Team ----------
interface Member { name: string; kz: string; rolle: string; uid: string; ziel: number; von: number; bis: number; }
let TEAM: Member[] = [];
const norm = (s: unknown) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
function codesFor(name: string): Set<string> {
  const p = norm(name).split(/\s+/).filter(Boolean); const out = new Set<string>();
  if (p.length >= 2) { const a = p[0], b = p[p.length - 1]; out.add(a[0] + b[0]); out.add(a.slice(0, 2) + b.slice(0, 2)); }
  return out;
}
function memberByName(name: string): Member | null {
  const n = norm(name); if (!n) return null; const first = n.split(/\s+/)[0]; const codes = codesFor(name);
  return TEAM.find(m => norm(m.name) === n)
    || TEAM.find(m => m.kz && codes.has(norm(m.kz)))
    || TEAM.find(m => norm(m.kz) === n)
    || TEAM.find(m => !/\s/.test(norm(m.name)) && norm(m.name) === first)
    || null;
}
const userNames: Record<string, string> = {};
function nameOf(uid: string, events: CalEvent[]): string {
  if (userNames[uid]) return userNames[uid];
  let nm = NAME_SEED[uid];
  if (!nm) {
    const tally: Record<string, number> = {};
    for (const e of events) {
      if (e.assignedUserId !== uid) continue;
      const parts = (e.title || '').split(/\s+mit\s+|\s+&\s+/i);
      if (parts.length > 1) { const x = parts[parts.length - 1].trim().replace(/\s+/g, ' '); if (x && x.length < 28) tally[x] = (tally[x] || 0) + 1; }
    }
    const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    nm = best ? best[0] : 'User ' + (uid || '?').slice(0, 4);
  }
  return (userNames[uid] = nm);
}
const memberCache: Record<string, Member | null> = {};
function memberForUser(uid: string, events: CalEvent[]): Member | null {
  if (uid in memberCache) return memberCache[uid];
  return (memberCache[uid] = TEAM.find(t => t.uid && t.uid === uid) || memberByName(nameOf(uid, events)));
}
function memberForSales(raw: string): Member | null {
  if (!raw || !raw.trim()) return null;
  const m = raw.match(/^\s*([^\s(]+)\s*\(([^)]*)\)/);
  if (m) { const hit = TEAM.find(t => t.kz && norm(t.kz) === norm(m[1])); if (hit) return hit; }
  return memberByName(raw);
}
const activeOverlap = (m: Member, lo: number, hi: number) => Math.max(0, Math.min(hi, m.bis) - Math.max(lo, m.von));
const goalFor = (m: Member, lo: number, hi: number) => (m.ziel > 0 ? (m.ziel * activeOverlap(m, lo, hi)) / (7 * DAY) : 0);

// ---------- Notion ----------
async function notionQueryAll(dbId: string): Promise<any[]> {
  const out: any[] = []; let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify(cursor ? { page_size: 100, start_cursor: cursor } : { page_size: 100 }),
    });
    if (!res.ok) throw new Error(`Notion query ${dbId} failed (${res.status}): ${await res.text()} — ist die Datenbank mit der Integration geteilt?`);
    const body: any = await res.json();
    out.push(...(body.results || []));
    if (!body.has_more) return out;
    cursor = body.next_cursor;
  }
  throw new Error(`Notion query ${dbId}: zu viele Seiten (abgebrochen).`);
}
function prop(page: any, name: string): any {
  const p = page?.properties?.[name];
  if (!p) throw new Error(`Notion-Property „${name}" fehlt (Seite ${page?.id}).`);
  switch (p.type) {
    case 'title': return (p.title || []).map((t: any) => t.plain_text).join('');
    case 'rich_text': return (p.rich_text || []).map((t: any) => t.plain_text).join('');
    case 'email': return p.email || '';
    case 'select': return p.select?.name || '';
    case 'number': return p.number;
    case 'date': return p.date?.start || null;
    default: throw new Error(`Notion-Property „${name}" hat unerwarteten Typ ${p.type}.`);
  }
}
const dateMs = (s: string | null, endOfDay = false) => {
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, d] = s.split('-').map(Number); return berlinMidnight(y, m - 1, d + (endOfDay ? 1 : 0)); }
  return Date.parse(s);
};
async function fetchTeam(): Promise<Member[]> {
  return (await notionQueryAll(TEAM_DB)).map(p => {
    const von = prop(p, 'Aktiv von'), bis = prop(p, 'Aktiv bis');
    return {
      name: prop(p, 'Name'), kz: prop(p, 'Kürzel'), rolle: prop(p, 'Rolle'), uid: prop(p, 'GHL-User-ID'),
      ziel: Number(prop(p, 'Zielumsatz pro Woche')) || 0,
      von: von ? dateMs(von) : -Infinity, bis: bis ? dateMs(bis, true) : Infinity, // „Aktiv bis" inklusive
    };
  }).filter(m => m.name);
}
interface Deal { t: number; who: string; raw: string; netto: number; nettoMissing: boolean; reports: number; }
function progFamily(p: string): string {
  const t = String(p || '').split(',').map(x => norm(x.replace(/\(.*?\)/g, ''))).filter(Boolean);
  return t.includes('eb') ? 'eb' : t[0] || '?';
}
async function fetchDeals(): Promise<Deal[]> {
  const reports = (await notionQueryAll(SALES_DB))
    .filter(p => prop(p, 'Status') !== 'verworfen')
    .map((p, i) => {
      const netto = prop(p, 'Deal-Höhe netto (€)');
      const am = prop(p, 'Gemeldet am');
      return {
        t: am ? Date.parse(am) : Date.parse(p.created_time),
        who: (norm(prop(p, 'E-Mail')) || norm(String(prop(p, 'Name')).split(' – ')[0]) || '#' + i) + '|' + progFamily(prop(p, 'Programm')),
        raw: prop(p, 'Sales / TC') || '', netto: Number(netto) || 0, nettoMissing: netto == null, reports: 1,
      } as Deal;
    })
    .filter(r => !isNaN(r.t)).sort((a, b) => a.t - b.t);
  const deals: Deal[] = []; const byWho: Record<string, Deal[]> = {};
  for (const r of reports) {
    const list = (byWho[r.who] = byWho[r.who] || []);
    const d = list.find(x => r.nettoMissing || x.nettoMissing || x.netto === r.netto);
    if (d) {
      d.reports++;
      if (d.nettoMissing && !r.nettoMissing) { d.netto = r.netto; d.nettoMissing = false; }
      if (!d.raw && r.raw) d.raw = r.raw;
    } else { const n = { ...r }; list.push(n); deals.push(n); }
  }
  console.log(`Notion: ${reports.length} gültige Meldungen -> ${deals.length} Aufträge (${deals.filter(d => d.nettoMissing).length} ohne Deal-Höhe, nicht gezählt).`);
  return deals.filter(d => !d.nettoMissing);
}

// ---------- GHL-Kalender ----------
interface CalEvent { assignedUserId: string; contactId: string; appointmentStatus: string; startTime: string; dateAdded: string; title?: string; deleted?: boolean; _t: number; _rebooked?: boolean; }
async function fetchGroup(groupId: string, from: number, to: number): Promise<CalEvent[]> {
  const q = new URLSearchParams({ locationId: LOCATION_ID, groupId, startTime: String(from), endTime: String(to) });
  const res = await fetch(`${GHL_BASE}/calendars/events?${q}`, {
    headers: { Authorization: `Bearer ${GHL_KEY}`, Version: '2021-04-15', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) throw new Error(`GHL calendar events failed (${res.status}) for group ${groupId}: ${await res.text()}`);
  const body: any = await res.json();
  const evs: CalEvent[] = (Array.isArray(body?.events) ? body.events : [])
    .filter((e: any) => !e.deleted && e.appointmentStatus !== 'invalid')
    .map((e: any) => ({ ...e, _t: Date.parse(e.startTime) }));
  // Abgesagt + danach neu gebucht (gleiche Person, gleiche Gruppe) = Umbuchung, kein Ausfall
  const byC: Record<string, CalEvent[]> = {};
  for (const e of evs) (byC[e.contactId] = byC[e.contactId] || []).push(e);
  for (const a of evs) {
    if (a.appointmentStatus !== 'cancelled') continue;
    const ta = Date.parse(a.dateAdded) || a._t;
    a._rebooked = (byC[a.contactId] || []).some(b => b !== a && b.appointmentStatus === 'confirmed' && (Date.parse(b.dateAdded) || b._t) >= ta);
  }
  return evs;
}
const isHeld = (e: CalEvent) => e.appointmentStatus === 'confirmed' && e._t <= NOW;
const isLost = (e: CalEvent) => e._t <= NOW && (e.appointmentStatus === 'noshow' || (e.appointmentStatus === 'cancelled' && !e._rebooked));

// ---------- Kennzahlen ----------
interface Cell { rev: number; orders: number; kg: number; fu: number; kgLost: number; goal: number; goalToDate: number; }
function cell(m: Member, lo: number, end: number, kg: CalEvent[], fu: CalEvent[], all: CalEvent[], deals: Deal[]): Cell {
  const hi = Math.min(end, NOW);
  const mine = (e: CalEvent) => e._t >= lo && e._t < hi && memberForUser(e.assignedUserId, all) === m;
  const kgE = kg.filter(mine), fuE = fu.filter(mine);
  const ds = deals.filter(d => d.t >= lo && d.t < hi && memberForSales(d.raw) === m);
  return {
    rev: ds.reduce((a, d) => a + d.netto, 0), orders: ds.length,
    kg: kgE.filter(isHeld).length, fu: fuE.filter(isHeld).length, kgLost: kgE.filter(isLost).length,
    goal: goalFor(m, lo, end), goalToDate: goalFor(m, lo, hi),
  };
}
const METRICS: { k: string; lbl: string; get: (c: Cell) => number | null; fmt: (v: number) => string; pctPts?: boolean; lowerBetter?: boolean; count?: boolean }[] = [
  { k: 'rev', lbl: 'Umsatz', get: c => c.rev, fmt: eurK, count: true },
  { k: 'att', lbl: 'Ziel-%', get: c => (c.goalToDate > 0 ? c.rev / c.goalToDate : null), fmt: pct, pctPts: true },
  { k: 'orders', lbl: 'Aufträge', get: c => c.orders, fmt: v => String(Math.round(v)), count: true },
  { k: 'avg', lbl: 'Ø Auftrag', get: c => (c.orders ? c.rev / c.orders : null), fmt: eurK },
  { k: 'kg', lbl: 'KG gehalten', get: c => c.kg, fmt: v => String(Math.round(v)), count: true },
  { k: 'fu', lbl: 'FU gehalten', get: c => c.fu, fmt: v => String(Math.round(v)), count: true },
  { k: 'quote', lbl: 'Abschluss', get: c => (c.kg + c.fu > 0 ? c.orders / (c.kg + c.fu) : null), fmt: pct, pctPts: true },
  { k: 'ausfall', lbl: 'Ausfall KG', get: c => (c.kg + c.kgLost > 0 ? c.kgLost / (c.kg + c.kgLost) : null), fmt: pct, pctPts: true, lowerBetter: true },
];
function trend(mt: (typeof METRICS)[number], cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null) return null;
  let d: number;
  if (mt.pctPts) { d = cur - prev; if (Math.abs(d) < 0.02) return 0; }
  else { if (prev === 0) return cur > 0 ? 1 : 0; d = (cur - prev) / Math.abs(prev); if (Math.abs(d) < 0.05) return 0; }
  const s = d > 0 ? 1 : -1; return mt.lowerBetter ? -s : s;
}

// ---------- Nachricht ----------
function buildMessage(kg: CalEvent[], fu: CalEvent[], all: CalEvent[], deals: Deal[]): string {
  const b = berlinParts(NOW);
  const thisMon = berlinMidnight(b.y, b.m, b.d - b.dow);
  const wLo = berlinMidnight(b.y, b.m, b.d - b.dow - 7), wHi = thisMon; // abgeschlossene Vorwoche Mo–So
  const months = [-2, -1, 0].map(off => ({
    lo: berlinMidnight(b.y, b.m + off, 1), end: berlinMidnight(b.y, b.m + off + 1, 1),
    name: MONTHS[(b.m + off + 12) % 12], running: off === 0,
  }));
  const cur = months[2];
  const elapsed = Math.max(NOW - cur.lo, 1), factor = (cur.end - cur.lo) / elapsed;
  const tcs = TEAM.filter(m => m.rolle === 'TC' && activeOverlap(m, months[0].lo, NOW + DAY) > 0).sort((a, c) => a.name.localeCompare(c.name, 'de'));
  const lines: string[] = [];
  lines.push(`*📊 TC-Wochenreport · KW ${isoWeek(wLo)} (${fmtD(wLo)}–${fmtD(wHi - DAY)}${berlinParts(wHi - DAY).y})*`);
  if (!tcs.length) { lines.push('_In Notion „Team (Provision)" ist niemand mit Rolle TC aktiv._'); return lines.join('\n'); }
  for (const m of tcs) {
    const wk = cell(m, wLo, wHi, kg, fu, all, deals);
    const cs = months.map(x => cell(m, x.lo, x.end, kg, fu, all, deals));
    const cmp = cs.map((c, i) => METRICS.map(mt => {
      const v = mt.get(c);
      if (v == null || !months[i].running || !mt.count) return v;
      return elapsed < 5 * DAY ? null : v * factor; // laufender Monat: hochgerechnet, erst ab Tag 5
    }));
    let up = 0, dn = 0;
    METRICS.forEach((mt, j) => { const t = trend(mt, cmp[1][j], cmp[0][j]); if (t != null && t > 0) up++; else if (t != null && t < 0) dn++; });
    const verdict = up > dn ? '↑ verbessert' : dn > up ? '↓ verschlechtert' : '→ stabil';
    const wkGoal = goalFor(m, wLo, wHi);
    const curC = cs[2], monthGoal = curC.goal, proj = curC.rev * factor;
    lines.push('');
    lines.push(`*${m.name}* · ${m.ziel > 0 ? 'Wochenziel ' + eurK(m.ziel) : '_kein Wochenziel in Notion_'}`);
    lines.push(`• Letzte Woche: *${eurK(wk.rev)}*${wkGoal > 0 ? ` (${pct(wk.rev / wkGoal)} vom Wochenziel)` : ''} · ${wk.orders} ${wk.orders === 1 ? 'Auftrag' : 'Aufträge'} · ${wk.kg} KG + ${wk.fu} FU gehalten`);
    lines.push(`• ${cur.name} bisher: *${eurK(curC.rev)}*${monthGoal > 0 ? ` von ${eurK(monthGoal)} Monatsziel` : ''} · ${monthGoal > 0 && curC.rev >= monthGoal ? 'Ziel schon erreicht 🎯' : elapsed >= 5 * DAY ? `Hochrechnung ~${eurK(proj)}` : 'Hochrechnung ab dem 5. Tag'}`);
    lines.push(`• Trend ${months[1].name} vs. ${months[0].name}: ${verdict} (${up} besser, ${dn} schlechter)`);
    const W0 = 12, W = 11;
    const head = ''.padEnd(W0) + months.map(x => (x.name.slice(0, 3) + (x.running ? '*' : '')).padStart(W)).join('');
    const rows = METRICS.map((mt, j) => mt.lbl.padEnd(W0) + cs.map((c, i) => {
      const v = mt.get(c); if (v == null) return '–'.padStart(W);
      const t = i > 0 ? trend(mt, cmp[i][j], cmp[i - 1][j]) : null;
      const ar = t == null ? ' ' : t > 0 ? '↑' : t < 0 ? '↓' : '→';
      return (mt.fmt(v) + ar).padStart(W);
    }).join(''));
    lines.push('```\n' + [head, ...rows].join('\n') + '\n```');
  }
  lines.push(`_* ${cur.name} bis ${fmtD(NOW)} · ↑/↓ besser/schlechter als Vormonat (laufender Monat hochgerechnet) · Abschluss = Aufträge ÷ (KG + FU gehalten) · <${COCKPIT_URL}|Sales Cockpit>_`);
  return lines.join('\n');
}

// ---------- Slack ----------
async function slackDM(text: string): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: SLACK_USER, text, unfurl_links: false, mrkdwn: true }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`Slack chat.postMessage failed (${res.status}): ${body.error || 'unbekannt'}`);
}

async function main(): Promise<void> {
  const b = berlinParts(NOW);
  console.log(`[${new Date(NOW).toISOString()}] TC-Wochenreport start (DRY_RUN=${DRY_RUN}, Berlin ${b.hh}:${String(b.mm).padStart(2, '0')})`);
  if (ENFORCE_SCHEDULE && b.hh !== RUN_HOUR_LOCAL) {
    console.log(`Zeitzonen-Gate: ${b.hh}:${String(b.mm).padStart(2, '0')} ${TZ} (Ziel ${RUN_HOUR_LOCAL}:00) -> uebersprungen.`);
    return;
  }
  for (const [k, v] of Object.entries({ GHL_API_KEY: GHL_KEY, GHL_LOCATION_ID: LOCATION_ID, NOTION_TOKEN })) if (!v) throw new Error(`Env ${k} fehlt.`);
  if (!DRY_RUN && (!SLACK_TOKEN || !SLACK_USER)) throw new Error('SLACK_BOT_TOKEN und SLACK_USER_ID muessen gesetzt sein (oder DRY_RUN=1).');

  TEAM = await fetchTeam();
  console.log(`Team: ${TEAM.map(m => `${m.name} (${m.rolle}${m.ziel ? ', ' + eur(m.ziel) + '/Wo' : ''})`).join(', ')}`);
  const deals = await fetchDeals();
  const from = berlinMidnight(b.y, b.m - 2, 1) - 35 * DAY, to = NOW + 60 * DAY; // Puffer für Umbuchungs-Erkennung
  const [kg, fu] = await Promise.all([fetchGroup(GROUP_KG, from, to), fetchGroup(GROUP_FU, from, to)]);
  console.log(`GHL: ${kg.length} KG-Termine, ${fu.length} FU-Termine im Fenster.`);

  const text = buildMessage(kg, fu, [...kg, ...fu], deals);
  console.log('----- Nachricht -----\n' + text + '\n---------------------');
  if (DRY_RUN) { console.log('DRY_RUN active -> nichts gesendet.'); return; }
  await slackDM(text);
  console.log('Slack-DM gesendet.');
}

main().catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('TC-WOCHENREPORT FAILED:', msg);
  if (!DRY_RUN && SLACK_TOKEN && SLACK_USER) {
    try { await slackDM(`⚠️ Der TC-Wochenreport konnte heute nicht erstellt werden: ${msg}`); } catch { /* Log reicht */ }
  }
  process.exit(1);
});
