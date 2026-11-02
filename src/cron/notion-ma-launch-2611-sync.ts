/**
 * Daily GHL -> Notion KPI sync for the "2026-11 MA-Launch" record (Money Alchemy).
 *
 * Set up 02.11.2026 as a copy of notion-eb-launch-2610-sync.ts. Same metric definitions as the
 * EB launches (board stages, "ever booked / ever held"), adapted to the MA pipeline layout:
 * the second purchase stage is "Kauf Ratenzahlung" (EB: "Kauf Anzahlung"), there is no
 * Zusage/FRA and no "FU abgesagt / no show" stage, and there are MA-only stages (Infopage,
 * Salespage, Kaminabend Teilnehmer, FU NACH launch) that feed no KPI.
 *
 * Writes to the Notion page in the "Promotions" database. Source is the stage every
 * opportunity of the GHL pipeline "26-11 Money Alchemy Webinar" currently sits in.
 *
 *   Anmeldungen, Verkäufe                        -> stage lists
 *   CC gebucht / CC geführt                      -> stage lists ("ever booked / ever held")
 *   SC gebucht / SC geführt                      -> stage lists   (Notion "SC" == GHL "KG")
 *   Follow-Up gebucht                            -> board stage "FU gebucht" (never-decrease)
 *   Follow-Up geführt                            -> 0, see FU below
 *   Lead-Kurve, Werbestart                       -> new Anmeldungen per Berlin day, first day
 *
 * Lead-Kurve / Werbestart feed the "MA-Launch Prognose" dashboard, which compares this launch
 * with the July launch by days since the ads started. Same definition as Anmeldungen (contact
 * counted once, on the day of its first opportunity outside the landing-page stage), so the
 * curve always sums to Anmeldungen. Format: "2026-11-09:57;2026-11-10:30;…".
 *
 * See notion-eb-launch-2610-sync.ts for WHY stages and not calendars, how "ever booked" is
 * modelled as a union of stages, and why the "KG gebucht direkt" route has to be remembered.
 * Everything there applies here unchanged.
 *
 * FU: the July MA sync read follow-ups from the general "Follow Up Feven/Monika" calendars,
 * which the EB launch proved to carry other programmes' follow-ups (03.09.2026). There is no
 * launch-specific MA follow-up calendar yet, so Follow-Up gebucht comes from the board stage
 * and Follow-Up geführt stays 0 until one exists (same interim rule as the MM-Frankfurt sync).
 * "FU NACH launch" is a board reminder, not a booked follow-up (decided 31.07.2026).
 *
 * Run:      node dist/cron/notion-ma-launch-2611-sync.js
 * Schedule: Railway cron "30 18 * * *" (= 19:30 Berlin winter time),
 *           service ff-ma-launch-2611-notion-sync
 *
 * Required env:
 *   GHL_API_KEY, GHL_LOCATION_ID, NOTION_TOKEN
 * Optional env:
 *   GHL_BASE_URL      (default https://services.leadconnectorhq.com)
 *   GHL_API_VERSION   (default 2023-02-21)
 *   DRY_RUN=1         (compute + log, but do NOT write to Notion)
 */

const GHL_BASE = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_VERSION = process.env.GHL_API_VERSION || '2023-02-21';
const GHL_KEY = process.env.GHL_API_KEY || '';
const LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const NOTION_VERSION = '2022-06-28';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const PIPELINE_ID = 'uRJvm3JF3W6HKN2UA3wQ'; // "26-11 Money Alchemy Webinar"
const PAGE_ID = '3e8828f7-cb43-80d2-98af-f91bb4e99c3f'; // "2026-11 MA-Launch", DB Promotions

/**
 * Every stage of the pipeline, by ID. Names are the state on 02.11.2026 and are for
 * reading only — never match on them, they get renamed in production.
 */
const S = {
  landingpage:  '2d541b21-5780-4b62-a83b-acca43c7c28f', // Landingpage aufgerufen
  lead:         'c6d1b8ee-57a3-4c8e-b3fb-5f45457b64e4', // Lead
  kunden:       'b89ebe66-9931-40c0-bd66-57bf86de18f8', // Kunden
  infopage:     'fbdf25ab-4b7c-48f2-bfa5-cb98f7a03c63', // Infopage
  umfrage:      'ebbad43e-1da4-4a28-a714-0a864472d439', // Umfrage ausgefüllt
  salespage:    '419ce217-16a7-48c3-89e3-7d5206e8d1b8', // Salespage
  ccGebucht:    '35643dcf-914c-4cbb-a7ee-9e2bd1f24f6b', // CC gebucht
  kgAusCC:      '3dc7cda3-0e70-4444-9bc4-2ff10c4d580d', // KG gebucht aus CC
  kgDirekt:     '5fd37fec-d90e-4444-bee1-39a7ceb7f921', // KG gebucht direkt
  ccGefuehrt:   '4c7d7882-52de-48ca-8288-37163d4b26b0', // CC geführt / kein KG angeboten
  fuGebucht:    '981d607c-e81b-419e-a4f7-f953ddff1000', // FU gebucht
  kgGefuehrt:   '62c14ec8-7f49-4a03-b4db-0a6b4c0c44fd', // KG geführt / kein Angebot
  kaminabend:   'e0fe8b08-edcb-42d1-94e0-83e14e143a99', // Kaminabend Teilnehmer
  kaufVoll:     '290c1126-cd76-4016-8e35-66941099a916', // Kauf Vollzahlung
  kaufRate:     '2faf8c9c-7085-4303-878c-201080daddc6', // Kauf Ratenzahlung
  fehlkauf:     'beda3c1a-17e5-4adf-a708-1017013dfb5c', // Fehlkauf
  ccNoShow:     'b392ad0c-fb7b-4a48-aac4-98d4e7c9525f', // CC abgesagt / no show
  kgNoShow:     '41cd2a06-293a-4d50-9f77-b96f2cb131c7', // KG abgesagt / no show
  fuNachLaunch: 'fb637c11-1095-4d1d-8f7f-cf0ad83c130f', // FU NACH launch
  absage:       'a9a64791-8c9c-4055-84f4-3372cc76dbcf', // Absage
  noFit:        'f8d97e71-7bf9-4975-a259-2bf8cce7e37d', // NO Fit
};

/**
 * In no list, as in the EB sync: `absage`, `noFit`, `kunden` (settable from anywhere), and the
 * MA-only `infopage`, `salespage`, `kaminabend`, `fuNachLaunch`, which prove no call.
 *
 * OPEN (02.11.2026): the purchase stages sit in the CC/SC lists as in EB. In MA a purchase
 * can also come straight from the sales page without any call; such a buyer would then be
 * counted as CC/SC held. Bounded by the number of sales (July: 19). Decide with the business
 * side before switching this job from DRY_RUN to live.
 */
const METRICS: Record<string, string[]> = {
  // Anmeldungen is computed by SUBTRACTING the landing-page stage (see the EB sync for why an
  // enumerated list is wrong).
  verkaeufe: [S.kaufVoll, S.kaufRate],

  ccGebucht: [
    S.ccGebucht, S.ccNoShow, S.kgAusCC, S.ccGefuehrt, S.kgGefuehrt, S.kgNoShow,
    S.fuGebucht, S.kaufVoll, S.kaufRate, S.fehlkauf,
  ],
  ccGefuehrt: [
    S.kgAusCC, S.ccGefuehrt, S.kgGefuehrt, S.kgNoShow,
    S.fuGebucht, S.kaufVoll, S.kaufRate, S.fehlkauf,
  ],

  // SC (== GHL "KG"): both routes into the KG, plus everything only reachable after one.
  scGebucht: [
    S.kgAusCC, S.kgDirekt, S.kgGefuehrt, S.kgNoShow,
    S.fuGebucht, S.kaufVoll, S.kaufRate, S.fehlkauf,
  ],
  scGefuehrt: [
    S.kgGefuehrt, S.fuGebucht, S.kaufVoll, S.kaufRate, S.fehlkauf,
  ],

  // Board stage only; see FU in the header. Geführt has no stage and is written as 0.
  fuGebucht: [S.fuGebucht],
};

const NOTION_FIELDS = {
  anmeldungen: 'Anmeldungen',
  verkaeufe: 'Verkäufe',
  ccGebucht: 'CC gebucht',
  ccGefuehrt: 'CC geführt',
  scGebucht: 'SC gebucht',
  scGefuehrt: 'SC geführt',
  fuGebucht: 'Follow-Up gebucht',
  fuGefuehrt: 'Follow-Up geführt',
} as const;

const NOTION_CURVE_FIELD = 'Lead-Kurve';    // rich_text
const NOTION_START_FIELD = 'Werbestart';    // date

/** Metrics written with plain overwrite; everything else uses the never-decrease rule. */
const OVERWRITE_METRICS = new Set<string>(['anmeldungen', 'verkaeufe']);

/** Remembering the "KG gebucht direkt" route — see notion-eb-launch-2610-sync.ts. */
const DIRECT_MARKER_PREFIX = '[[kgdirekt:';
const DIRECT_MARKER_SUFFIX = ']]';
const NOTION_COMMENT_LIMIT = 4096; // bytes of UTF-8, hard API limit

/** All comment texts on the page, newest last. */
async function notionGetComments(pageId: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const q = new URLSearchParams({ block_id: pageId, page_size: '100' });
    if (cursor) q.set('start_cursor', cursor);
    const res = await fetch(`https://api.notion.com/v1/comments?${q.toString()}`, {
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION },
    });
    if (!res.ok) throw new Error(`Notion comment read failed (${res.status}): ${await res.text()}`);
    const body: any = await res.json();
    for (const c of body?.results ?? []) {
      out.push(((c?.rich_text ?? []) as any[]).map((t) => t?.plain_text ?? '').join(''));
    }
    cursor = body?.has_more ? body?.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** The remembered direct-KG contacts, from the newest comment carrying a marker. */
function parseDirectMarker(comments: string[]): Set<string> {
  for (let i = comments.length - 1; i >= 0; i--) {
    const text = comments[i];
    const start = text.indexOf(DIRECT_MARKER_PREFIX);
    if (start < 0) continue;
    const end = text.indexOf(DIRECT_MARKER_SUFFIX, start);
    if (end < 0) continue;
    const ids = text.slice(start + DIRECT_MARKER_PREFIX.length, end).split(',').map((s) => s.trim());
    return new Set(ids.filter(Boolean));
  }
  return new Set<string>();
}

function buildDirectMarker(ids: Set<string>): string {
  return DIRECT_MARKER_PREFIX + [...ids].sort().join(',') + DIRECT_MARKER_SUFFIX;
}

function ghlHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${GHL_KEY}`,
    Version: GHL_VERSION,
    Accept: 'application/json',
    // services.leadconnectorhq.com answers 403 / Cloudflare 1010 to default client UAs.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  };
}

/** Exact opportunity total of the pipeline, used to prove the paging below was complete. */
async function ghlPipelineTotal(): Promise<number> {
  const q = new URLSearchParams({ location_id: LOCATION_ID, pipeline_id: PIPELINE_ID, limit: '1' });
  const res = await fetch(`${GHL_BASE}/opportunities/search?${q.toString()}`, { headers: ghlHeaders() });
  if (!res.ok) throw new Error(`GHL total failed (${res.status}): ${await res.text()}`);
  const body: any = await res.json();
  const total = body?.meta?.total;
  if (typeof total !== 'number') throw new Error('GHL response missing numeric meta.total');
  return total;
}

interface Opp { contactId?: string; pipelineStageId?: string; createdAt?: string; }

/**
 * Every opportunity of the pipeline, paged. Fails loud rather than returning a partial set:
 * a short read would lower every KPI at once and look like a quiet week.
 */
async function ghlAllOpportunities(expectedTotal: number): Promise<Opp[]> {
  const out: Opp[] = [];
  let url =
    `${GHL_BASE}/opportunities/search?` +
    new URLSearchParams({ location_id: LOCATION_ID, pipeline_id: PIPELINE_ID, limit: '100' }).toString();

  for (let page = 1; page <= 200; page++) {
    const res = await fetch(url, { headers: ghlHeaders() });
    if (!res.ok) throw new Error(`GHL opportunity page ${page} failed (${res.status}): ${await res.text()}`);
    const body: any = await res.json();
    const opps: any[] = Array.isArray(body?.opportunities) ? body.opportunities : [];
    for (const o of opps) out.push({ contactId: o?.contactId, pipelineStageId: o?.pipelineStageId, createdAt: o?.createdAt });
    const next = body?.meta?.nextPageUrl;
    if (opps.length === 0 || !next || !body?.meta?.nextPage) break;
    url = next as string;
  }

  if (out.length < expectedTotal) {
    throw new Error(`Pipeline paging incomplete: read ${out.length} of ${expectedTotal} opportunities (aborting).`);
  }
  return out;
}

/** Distinct contacts sitting in any of the given stages. */
function distinctContacts(opps: Opp[], stageIds: string[], exclude?: Set<string>): number {
  const wanted = new Set(stageIds);
  const contacts = new Set<string>();
  for (const o of opps) {
    if (!o.contactId || !o.pipelineStageId) continue;
    if (exclude?.has(o.contactId)) continue;
    if (wanted.has(o.pipelineStageId)) contacts.add(o.contactId);
  }
  return contacts.size;
}

/** Distinct contacts holding at least one opportunity OUTSIDE the given stages. */
function distinctContactsOutside(opps: Opp[], stageIds: string[]): number {
  const skip = new Set(stageIds);
  const contacts = new Set<string>();
  for (const o of opps) {
    if (!o.contactId || !o.pipelineStageId) continue;
    if (!skip.has(o.pipelineStageId)) contacts.add(o.contactId);
  }
  return contacts.size;
}

/** Contacts currently sitting in one of the given stages. */
function contactsInStages(opps: Opp[], stageIds: string[]): Set<string> {
  const wanted = new Set(stageIds);
  const out = new Set<string>();
  for (const o of opps) {
    if (o.contactId && o.pipelineStageId && wanted.has(o.pipelineStageId)) out.add(o.contactId);
  }
  return out;
}

/** Calendar day in Europe/Berlin (YYYY-MM-DD), independent of the container's TZ. */
function berlinDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso));
}

/**
 * New Anmeldungen per Berlin day: each contact once, on the day of its first opportunity
 * outside the given stages — the same population as Anmeldungen, so the curve sums to it.
 * Fails loud on an opportunity without a parseable createdAt instead of dropping it.
 */
function leadCurve(opps: Opp[], skipStages: string[]): Map<string, number> {
  const skip = new Set(skipStages);
  const first = new Map<string, string>();
  for (const o of opps) {
    if (!o.contactId || !o.pipelineStageId || skip.has(o.pipelineStageId)) continue;
    if (!o.createdAt || !Number.isFinite(Date.parse(o.createdAt))) {
      throw new Error(`Opportunity of contact ${o.contactId} has no usable createdAt (aborting).`);
    }
    const day = berlinDay(o.createdAt);
    const prev = first.get(o.contactId);
    if (!prev || day < prev) first.set(o.contactId, day);
  }
  const perDay = new Map<string, number>();
  for (const day of first.values()) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  return new Map([...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Read the page once: current numbers (for the max-rule) and a type check of every field this
 * job writes. A missing or retyped property aborts — never create it, never default it.
 */
async function notionReadPage(pageId: string, numberNames: string[]): Promise<Record<string, number>> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION },
  });
  if (!res.ok) throw new Error(`Notion read failed (${res.status}): ${await res.text()}`);
  const body: any = await res.json();
  const out: Record<string, number> = {};
  for (const name of numberNames) {
    const prop = body?.properties?.[name];
    if (!prop) throw new Error(`Notion property not found: "${name}" (aborting, will not guess).`);
    if (prop.type !== 'number') throw new Error(`Notion property "${name}" is type ${prop.type}, expected number.`);
    out[name] = typeof prop.number === 'number' ? prop.number : 0;
  }
  for (const [name, type] of [[NOTION_CURVE_FIELD, 'rich_text'], [NOTION_START_FIELD, 'date'], ['Letzter Sync', 'date']]) {
    const prop = body?.properties?.[name];
    if (!prop) throw new Error(`Notion property not found: "${name}" (aborting, will not guess).`);
    if (prop.type !== type) throw new Error(`Notion property "${name}" is type ${prop.type}, expected ${type}.`);
  }
  return out;
}

/**
 * Write the numbers, the lead curve, Werbestart and "Letzter Sync" in ONE request, so the
 * timestamp only moves when everything was written (the dashboard warns on a stale sync).
 */
async function notionPatch(pageId: string, values: Record<string, number>, curve: string, start: string | null): Promise<void> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) properties[key] = { number: value };
  // rich_text objects hold at most 2000 characters each.
  const chunks: string[] = [];
  for (let i = 0; i < curve.length; i += 1900) chunks.push(curve.slice(i, i + 1900));
  properties[NOTION_CURVE_FIELD] = { rich_text: chunks.map((c) => ({ text: { content: c } })) };
  properties[NOTION_START_FIELD] = { date: start ? { start } : null };
  properties['Letzter Sync'] = { date: { start: new Date().toISOString() } };
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`Notion update failed (${res.status}): ${await res.text()}`);
}

/** Post an audit comment on the Notion page. Non-fatal if the integration cannot comment. */
async function notionAddComment(pageId: string, text: string): Promise<void> {
  const res = await fetch('https://api.notion.com/v1/comments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { page_id: pageId }, rich_text: [{ text: { content: text } }] }),
  });
  if (!res.ok) throw new Error(`Notion comment failed (${res.status}): ${await res.text()}`);
}

/** Current time formatted in Europe/Berlin, independent of the container's TZ. */
function berlinTimestamp(): string {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());
}

async function main(): Promise<void> {
  console.log(`[${new Date().toISOString()}] GHL->Notion MA-Launch 26-11 sync start (DRY_RUN=${DRY_RUN})`);

  const requiredEnv: Record<string, string> = { GHL_API_KEY: GHL_KEY, GHL_LOCATION_ID: LOCATION_ID, NOTION_TOKEN };
  for (const [name, value] of Object.entries(requiredEnv)) {
    if (!value) throw new Error(`Missing required env var: ${name}`);
  }

  // 1. One snapshot of the whole pipeline; every KPI is derived from it.
  const total = await ghlPipelineTotal();
  const opps = await ghlAllOpportunities(total);
  const allContacts = new Set(opps.map((o) => o.contactId).filter(Boolean) as string[]);
  console.log(`Pipeline: ${total} Opportunities, ${allContacts.size} distinkte Kontakte`);

  // 2. Stage occupancy, logged in full — this is what makes a number checkable weeks later.
  const occupancy = Object.entries(S)
    .map(([key, id]) => `${key}=${distinctContacts(opps, [id])}`)
    .join(' ');
  console.log(`Stages (distinkte Kontakte): ${occupancy}`);

  const knownStages = new Set(Object.values(S));
  const unknown = new Map<string, number>();
  for (const o of opps) {
    if (o.pipelineStageId && !knownStages.has(o.pipelineStageId)) {
      unknown.set(o.pipelineStageId, (unknown.get(o.pipelineStageId) ?? 0) + 1);
    }
  }
  if (unknown.size > 0) {
    console.warn(
      `WARNUNG: ${unknown.size} unbekannte Stage(s) in der Pipeline — diese Kontakte fehlen in ` +
      `CC/SC/Verkäufe, bis die IDs eingetragen sind: ` +
      [...unknown.entries()].map(([id, n]) => `${id} (${n} Opps)`).join(', ')
    );
  }

  // 3. The direct-KG route: remember it, because the board forgets it.
  let rememberedDirect = new Set<string>();
  let memoryReadable = true;
  try {
    rememberedDirect = parseDirectMarker(await notionGetComments(PAGE_ID));
  } catch (err) {
    memoryReadable = false;
    console.warn(
      'WARNUNG: Direkt-Marker nicht lesbar -> die gemerkte KG-direkt-Route faellt auf die ' +
      'aktuelle Stage-Belegung zurueck. Ursache: ' + (err instanceof Error ? err.message : String(err))
    );
  }
  const rememberedBefore = rememberedDirect.size;
  const currentDirect = contactsInStages(opps, [S.kgDirekt]);
  for (const cid of currentDirect) rememberedDirect.add(cid);

  const CC_ONLY_STAGES = [S.ccGebucht, S.ccNoShow, S.kgAusCC, S.ccGefuehrt];
  const provenCC = contactsInStages(opps, CC_ONLY_STAGES);
  const excludeFromCC = new Set([...rememberedDirect].filter((cid) => !provenCC.has(cid)));
  console.log(
    `KG-direkt-Route: aktuell in der Stage=${currentDirect.size} · gemerkt (kumuliert)=${rememberedDirect.size} ` +
    `(vorher ${rememberedBefore}) · aus den CC-Kennzahlen ausgeschlossen=${excludeFromCC.size}` +
    (memoryReadable ? '' : ' [GEDAECHTNIS NICHT LESBAR - nur aktuelle Stage]')
  );

  // 4. Metrics from stages. Only the CC metrics get the exclusion.
  const CC_METRICS = new Set(['ccGebucht', 'ccGefuehrt']);
  const computed: Record<string, number> = {};
  for (const [metric, stageIds] of Object.entries(METRICS)) {
    computed[metric] = CC_METRICS.has(metric)
      ? distinctContacts(opps, stageIds, excludeFromCC)
      : distinctContacts(opps, stageIds);
  }
  computed.anmeldungen = distinctContactsOutside(opps, [S.landingpage]);
  computed.fuGefuehrt = 0;
  console.log('Follow-Up: gebucht aus Board-Stage "FU gebucht", geführt = 0 (kein launch-eigener FU-Kalender).');

  // 5. Lead curve + Werbestart (same population as Anmeldungen).
  const curve = leadCurve(opps, [S.landingpage]);
  const curveText = [...curve.entries()].map(([d, n]) => `${d}:${n}`).join(';');
  const curveSum = [...curve.values()].reduce((a, b) => a + b, 0);
  const werbestart = curve.size ? [...curve.keys()][0] : null;
  if (curveSum !== computed.anmeldungen) {
    throw new Error(`Lead-Kurve summiert ${curveSum}, Anmeldungen ${computed.anmeldungen} (aborting).`);
  }
  console.log(`Lead-Kurve: ${curve.size} Tage, Summe ${curveSum}, Werbestart ${werbestart ?? '-'}`);

  // 6. Current Notion values (needed for the never-decrease rule) + field type check.
  const fieldNames = Object.values(NOTION_FIELDS) as string[];
  const cur = await notionReadPage(PAGE_ID, fieldNames);

  // 7. Target values + the full arithmetic in the log.
  const values: Record<string, number> = {};
  console.log('Mapping:');
  for (const [metric, field] of Object.entries(NOTION_FIELDS)) {
    const c = computed[metric] ?? 0;
    const overwrite = OVERWRITE_METRICS.has(metric);
    const value = overwrite ? c : Math.max(c, cur[field]);
    values[field] = value;
    console.log(
      overwrite
        ? `  ${field.padEnd(18)} = ${c} (overwrite)`
        : `  ${field.padEnd(18)} = max(Stages ${c}, Notion ${cur[field]}) = ${value}`
    );
  }
  console.log('  (No-Show + Conversion sind Notion-Formeln und werden dort berechnet.)');

  const commentText =
    `🔄 Railway-Sync MA 26-11 ${berlinTimestamp()} — ` +
    `Anmeldungen ${values['Anmeldungen']} · Verkäufe ${values['Verkäufe']} · ` +
    `CC ${values['CC gebucht']}/${values['CC geführt']} · SC ${values['SC gebucht']}/${values['SC geführt']} · ` +
    `FU ${values['Follow-Up gebucht']}/${values['Follow-Up geführt']} (gebucht/geführt)`;
  const marker = buildDirectMarker(rememberedDirect);
  const commentWithMarker = `${commentText}
${marker}`;
  if (Buffer.byteLength(commentWithMarker, 'utf8') > NOTION_COMMENT_LIMIT - 128) {
    console.warn(
      `WARNUNG: Direkt-Marker mit ${rememberedDirect.size} IDs sprengt bald das Notion-Kommentarlimit ` +
      `(${Buffer.byteLength(commentWithMarker, 'utf8')} von ${NOTION_COMMENT_LIMIT} Bytes).`
    );
  }

  if (DRY_RUN) {
    console.log('DRY_RUN active -> nothing written to Notion.');
    console.log(`DRY_RUN would write ${NOTION_CURVE_FIELD}="${curveText}" ${NOTION_START_FIELD}=${werbestart ?? 'leer'}`);
    console.log('DRY_RUN would post comment:', commentWithMarker);
    return;
  }
  await notionPatch(PAGE_ID, values, curveText, werbestart);
  console.log(`[${new Date().toISOString()}] Notion page ${PAGE_ID} properties updated OK.`);

  try {
    await notionAddComment(PAGE_ID, commentWithMarker);
    console.log(`Audit comment posted (mit Direkt-Marker, ${rememberedDirect.size} IDs).`);
  } catch (err) {
    console.warn('Comment post failed (KPI write still succeeded):', err instanceof Error ? err.message : err);
  }
}

main().catch((err: unknown) => {
  console.error('MA 26-11 SYNC FAILED (nothing written):', err instanceof Error ? err.message : err);
  process.exit(1);
});
