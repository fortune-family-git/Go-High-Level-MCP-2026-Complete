/**
 * Daily GHL -> Notion KPI sync for the "2026-09 Magnetic Me Webinar" record.
 *
 * Writes to the Notion page in the "Promotions" database. Source is the stage every
 * opportunity of the GHL pipeline "26-09 Event Frankfurt Webinar" currently sits in.
 * Structurally this pipeline mirrors the EB-Launch one (see notion-eb-launch-sync.ts),
 * so the same "ever booked / ever held" stage-union model is used here.
 *
 *   Anmeldungen, Verkäufe                        -> stage lists
 *   CC gebucht / CC geführt                      -> stage lists ("ever booked / ever held")
 *   SC gebucht / SC geführt                      -> stage lists   (Notion "SC" == GHL "KG")
 *   Follow-Up gebucht                            -> board FU stages (launch-specific, safe)
 *   Follow-Up geführt                            -> NOT answerable from the board yet, see below
 *
 * BUSINESS DECISIONS (confirmed by Annett, 2026-09-05, launch still in pre-phase, Live 12.09):
 *   - "Anmeldung" counts from stage "Lead" onward: BOTH "Landingpage View" and "Anmelde
 *     Seite" are pre-registration and are subtracted (see anmeldungenCount / SUBTRACT).
 *   - "MM Kontakt > KG" IS a KG/SC booking via the direct route (like "KG gebucht direkt"):
 *     it feeds the SC metrics and, like the direct route, must NEVER feed a CC metric.
 *   - "Sales Schnellzahlerin" IS a sale and is counted in Verkäufe alongside Vollzahlung
 *     and Anzahlung. The two "… pageview" stages are page views and never count.
 *
 * HOW "ever booked" IS MODELLED (same as EB): a stage is a POSITION and drains as a contact
 * advances, so a single stage can never answer "ever". Each metric is the union of every
 * stage a contact can only have reached BY having had that call — "gebucht" is the stage
 * itself plus everything downstream, "geführt" is the same minus the stages that mean the
 * call has not happened yet (still waiting, or no-show).
 *
 * FOLLOW-UP: this pipeline has "FU gebucht" and "FU abgesagt / no show" stages but NO
 * "FU geführt" stage, so the board can give "gebucht" but not "geführt". Follow-Up gebucht
 * is therefore taken from the board FU stages (launch-specific via pipeline membership, so
 * none of the shared-calendar contamination that hurt EB). Follow-Up geführt stays 0 until
 * the launch's own FU calendars are wired in (see FU_CALENDARS_TODO) — under the
 * never-decrease rule a 0 cannot bake a wrong value, and FU is 0 across the board today.
 *
 * Counted as DISTINCT CONTACTS, not opportunities. All opportunities are paged once and
 * every KPI is derived from that single snapshot, so the numbers are mutually consistent.
 *
 * All written fields use the never-decrease rule EXCEPT Anmeldungen and Verkäufe, which are
 * plain overwrites (snapshots/sums that do not drain).
 *
 * The Notion "No-Show CC/SC/FU" and "Conversion …" fields are FORMULAS computed by Notion —
 * this job does not (and cannot) write them.
 *
 * Run:      node dist/cron/notion-mm-frankfurt-sync.js
 * Schedule: Railway cron "0 19 * * *" (= 21:00 Berlin summer time), service
 *           ff-mm-frankfurt-notion-sync
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

const PIPELINE_ID = 'WEG4lkuRna6mo1D3J71z'; // "26-09 Event Frankfurt Webinar"
const PAGE_ID = '3a9828f7-cb43-810d-a0e1-f910b4fbab4c'; // "2026-09 Magnetic Me Webinar", DB Promotions

/**
 * Every stage of the pipeline, by ID. Names are the state on 2026-09-05 and are for reading
 * only — never match on them, they get renamed in production. Verify against the live
 * pipeline (scripts/count_stages.sh WEG4lkuRna6mo1D3J71z) before trusting this table.
 */
const S = {
  landingpage:   '7bf372cf-7491-4903-951f-565d50851f03', // Landingpage View        (pre-registration)
  anmeldeSeite:  '5b4479cc-7e61-4df1-9682-2cecb9b6080a', // Anmelde Seite           (pre-registration)
  lead:          'ad233726-13df-454f-959a-74b14ba04510', // Lead
  umfrage:       'b19d1874-9e32-4b04-89be-ee90839d0ccb', // Umfrage abgeschickt
  mmKontaktKG:   '9de89b3f-7d4f-47e6-8c59-e9079a9f0033', // MM Kontakt > KG          (direct KG booking, no CC)
  salesPage:     '83b35e82-3bab-4c43-b00c-2f759eb991d9', // Magnetic Me Sales Page   (page view, no call)
  kunden:        '9e87f0c7-b6a0-4aed-a770-f88f8344fc1e', // Kunden
  ehemKunden:    'd5f7a887-58a5-41b5-9295-301024f04b58', // ehem. Kunden
  ccGebucht:     'c476358d-3bf1-430f-99d6-15bd6238a0ca', // CC gebucht
  ccGefuehrt:    '59e1a9c8-86c4-4272-90ca-f8913779e034', // CC geführt - kein KG angeboten
  kgAusCC:       '9bb5f7b6-a526-47c5-b2f7-8416a9134248', // KG gebucht aus CC
  kgDirekt:      '4de61e23-9ee9-4a69-b2ce-2e70bf862dfe', // KG gebucht direkt        (direct KG booking, no CC)
  kgGefuehrt:    'd70c1b7f-9fbb-4106-b40d-3132da41ea73', // KG geführt - kein Angebot
  fuGebucht:     '6e620566-7758-4940-bc13-128a190c0bf9', // FU gebucht
  kaufVoll:      '058f65bd-b699-4efd-899e-eb4a2c308081', // Vollzahlung
  kaufAnz:       '0b8f78ef-2381-4a90-a9b3-245713d7ed22', // Anzahlung
  zusage:        '1b03c333-8e05-4183-b99b-519461486cad', // Zusage / Geldbeschaffung
  schnellzahler: '1c1eb551-8ccc-43a7-9424-7c7ae685acae', // Sales Schnellzahlerin    (a sale)
  absage:        '4c141ef2-506c-4989-9602-21eca2bde642', // Absage
  ccNoShow:      '2fa07f76-2464-47f6-887b-fa3a12139a49', // CC abgesagt / no show
  kgNoShow:      '85c6fe73-a633-42be-815c-1c3d0c6790d9', // KG abgesagt / no show
  fuNoShow:      'b610ffce-36ab-4af2-aa0b-2ee932f4b3bf', // FU abgesagt / no show
  schnellzPV:    '2c6d8b7c-5437-4175-8382-bd700c889254', // Sales Schnellzahlerin pageview (page view)
  anzahlungPV:   '62a9bb90-ce70-4cdb-9dbd-2ebc15b2541f', // Sales Anzahlung pageview       (page view)
  falscheNummer: 'febb6a2b-8ebc-48ae-8f8c-c441d2b7f511', // falsche Nummer
  noFit:         'c15eb941-7805-40d4-8657-b552d16e3049', // no fit
};

/**
 * Stages deliberately in NO call metric: `salesPage`, `schnellzPV`, `anzahlungPV` are page
 * views; `falscheNummer`, `noFit`, `absage`, `kunden`, `ehemKunden` can be set from anywhere
 * on the board and prove no call. `kgDirekt` and `mmKontaktKG` are the two routes into a KG
 * WITHOUT a CC — they feed SC, never CC, and their contacts are tracked across runs (see
 * DIRECT_MARKER_PREFIX) so a direct booker who advances into the shared downstream stages
 * does not silently inflate the CC metrics.
 */
const METRICS: Record<string, string[]> = {
  // Anmeldungen is NOT enumerated here — it is "everyone except the pre-registration hits"
  // and is computed by SUBTRACTING those stages (see SUBTRACT_FROM_ANMELDUNGEN). An
  // enumerated list silently drops any newly added stage.
  verkaeufe: [S.kaufVoll, S.kaufAnz, S.schnellzahler],

  // CC: booked = the CC stage itself, its no-show, and everything only reachable after a CC.
  ccGebucht: [
    S.ccGebucht, S.ccNoShow, S.kgAusCC, S.ccGefuehrt, S.kgGefuehrt, S.kgNoShow,
    S.fuGebucht, S.fuNoShow, S.zusage, S.kaufVoll, S.kaufAnz, S.schnellzahler,
  ],
  // held = the same, minus "still waiting for the CC" and "did not show up for it".
  ccGefuehrt: [
    S.kgAusCC, S.ccGefuehrt, S.kgGefuehrt, S.kgNoShow,
    S.fuGebucht, S.fuNoShow, S.zusage, S.kaufVoll, S.kaufAnz, S.schnellzahler,
  ],

  // SC (== GHL "KG"): all three routes into the KG (aus CC, direkt, MM Kontakt > KG), plus
  // everything only reachable after one.
  scGebucht: [
    S.kgAusCC, S.kgDirekt, S.mmKontaktKG, S.kgGefuehrt, S.kgNoShow,
    S.fuGebucht, S.fuNoShow, S.zusage, S.kaufVoll, S.kaufAnz, S.schnellzahler,
  ],
  // held = minus the "booked/waiting" routes (kgAusCC, kgDirekt, mmKontaktKG) and the no-show.
  scGefuehrt: [
    S.kgGefuehrt, S.fuGebucht, S.fuNoShow, S.zusage, S.kaufVoll, S.kaufAnz, S.schnellzahler,
  ],

  // Follow-Up gebucht: from the board FU stages only. "geführt" is not in this map — the
  // board has no FU-geführt stage (see the header comment); it stays 0 for now.
  fuGebucht: [S.fuGebucht, S.fuNoShow],
};

/** Pre-registration stages subtracted for Anmeldungen (confirmed: count from "Lead" on). */
const SUBTRACT_FROM_ANMELDUNGEN = [S.landingpage, S.anmeldeSeite];

/** The two no-CC routes into a KG: their contacts are remembered and kept out of CC. */
const DIRECT_STAGES = [S.kgDirekt, S.mmKontaktKG];

/** Stages that prove a CC actually happened (board correction wins over the remembered flag). */
const CC_ONLY_STAGES = [S.ccGebucht, S.ccNoShow, S.kgAusCC, S.ccGefuehrt];

// FU_CALENDARS_TODO: Follow-Up geführt needs this launch's OWN follow-up calendars (never the
// shared general ones — see notion-eb-launch-sync.ts for what shared calendars cost). None
// are wired in yet; add the launch-specific Magnetic-Me FU calendar IDs here and switch
// fuGefuehrt to the calendar logic once follow-ups actually start.

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

/** Metrics written with plain overwrite; everything else uses the never-decrease rule. */
const OVERWRITE_METRICS = new Set<string>(['anmeldungen', 'verkaeufe']);

/**
 * ---------------------------------------------------------------------------------------
 * Remembering the no-CC routes into a KG ("KG gebucht direkt" + "MM Kontakt > KG")
 * ---------------------------------------------------------------------------------------
 * The board distinguishes the routes into a KG exactly once — at booking. Everything behind
 * it is shared, so as soon as a direct booker advances, the stage no longer shows they never
 * had a CC, and they would inflate the CC metrics (built as "CC stage plus everything
 * downstream"). The route cannot be reconstructed afterwards (see the EB job for the four
 * approaches that were tried and rejected), so the job remembers the accumulated set of
 * contacts it has ever seen in a DIRECT_STAGE in its own Notion audit comment. Every run
 * rewrites the COMPLETE set; reading the newest marker back is enough.
 */
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

interface Opp { contactId?: string; pipelineStageId?: string; }

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
    for (const o of opps) out.push({ contactId: o?.contactId, pipelineStageId: o?.pipelineStageId });
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

/**
 * Distinct contacts holding at least one opportunity OUTSIDE the given stages.
 * Used for Anmeldungen: subtracting the pre-registration stages is robust against new
 * stages, an enumerated "all the others" list is not.
 */
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

/** Read the current numeric values of the given Notion number properties (for the max-rule). */
async function notionGetNumbers(pageId: string, names: string[]): Promise<Record<string, number>> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION },
  });
  if (!res.ok) throw new Error(`Notion read failed (${res.status}): ${await res.text()}`);
  const body: any = await res.json();
  const out: Record<string, number> = {};
  for (const name of names) {
    const prop = body?.properties?.[name];
    if (!prop) throw new Error(`Notion property not found: "${name}" (aborting, will not guess).`);
    if (prop.type !== 'number') throw new Error(`Notion property "${name}" is type ${prop.type}, expected number.`);
    out[name] = typeof prop.number === 'number' ? prop.number : 0;
  }
  return out;
}

/** Write number properties to the Notion page. */
async function notionPatchNumbers(pageId: string, values: Record<string, number>): Promise<void> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) properties[key] = { number: value };
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
  console.log(`[${new Date().toISOString()}] GHL->Notion Magnetic-Me sync start (DRY_RUN=${DRY_RUN})`);

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

  // Unknown stage IDs mean the pipeline was rebuilt. Warn loudly instead of quietly leaving
  // those contacts out of every metric.
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

  // 3. The no-CC routes into a KG: remember them, because the board forgets which route a
  //    contact took as soon as they advance (see the block above DIRECT_MARKER_PREFIX).
  let rememberedDirect = new Set<string>();
  let memoryReadable = true;
  try {
    rememberedDirect = parseDirectMarker(await notionGetComments(PAGE_ID));
  } catch (err) {
    memoryReadable = false;
    console.warn(
      'WARNUNG: Direkt-Marker nicht lesbar -> die gemerkte KG-direkt-Route faellt auf die ' +
      'aktuelle Stage-Belegung zurueck. CC kann dadurch Direktbucher mitzaehlen, die schon ' +
      'weitergezogen sind. Ursache: ' + (err instanceof Error ? err.message : String(err))
    );
  }
  const rememberedBefore = rememberedDirect.size;
  const currentDirect = contactsInStages(opps, DIRECT_STAGES);
  for (const cid of currentDirect) rememberedDirect.add(cid);

  // A contact the board NOW places in a CC-only stage did have a CC after all (someone
  // corrected the stage) — the current board wins over the remembered flag.
  const provenCC = contactsInStages(opps, CC_ONLY_STAGES);
  const excludeFromCC = new Set([...rememberedDirect].filter((cid) => !provenCC.has(cid)));
  console.log(
    `KG-direkt-Routen (kgDirekt + MM Kontakt > KG): aktuell in Stage=${currentDirect.size} · ` +
    `gemerkt (kumuliert)=${rememberedDirect.size} (vorher ${rememberedBefore}) · ` +
    `aus CC ausgeschlossen=${excludeFromCC.size} ` +
    `(per Board-Korrektur zurueckgeholt=${rememberedDirect.size - excludeFromCC.size})` +
    (memoryReadable ? '' : ' [GEDAECHTNIS NICHT LESBAR - nur aktuelle Stage]')
  );

  // 4. Metrics: everything from stages. Only the CC metrics get the direct-route exclusion —
  //    the SC ones must count the direct route.
  const CC_METRICS = new Set(['ccGebucht', 'ccGefuehrt']);
  const computed: Record<string, number> = {};
  for (const [metric, stageIds] of Object.entries(METRICS)) {
    computed[metric] = CC_METRICS.has(metric)
      ? distinctContacts(opps, stageIds, excludeFromCC)
      : distinctContacts(opps, stageIds);
  }
  for (const metric of CC_METRICS) {
    const ohne = distinctContacts(opps, METRICS[metric]);
    if (ohne !== computed[metric]) {
      console.log(`  ${metric}: ${ohne} ohne Bereinigung -> ${computed[metric]} nach Abzug der Direktbucher`);
    }
  }

  // Anmeldungen: everyone except the pre-registration stages, by subtraction not enumeration.
  computed.anmeldungen = distinctContactsOutside(opps, SUBTRACT_FROM_ANMELDUNGEN);

  // Follow-Up geführt is not answerable from the board (no FU-geführt stage). Stays 0 until
  // the launch's own FU calendars are wired in (FU_CALENDARS_TODO). Board "FU gebucht" comes
  // from METRICS.fuGebucht above.
  computed.fuGefuehrt = 0;
  console.log(
    `Follow-Up: gebucht (Board-Stages FU gebucht + FU no-show)=${computed.fuGebucht} · ` +
    `geführt=0 (Board hat keine FU-geführt-Stage; erst mit launch-eigenen FU-Kalendern belegbar)`
  );

  // 5. Current Notion values (needed for the never-decrease rule).
  const fieldNames = Object.values(NOTION_FIELDS) as string[];
  const cur = await notionGetNumbers(PAGE_ID, fieldNames);

  // 6. Target values + the full arithmetic in the log.
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
    `🔄 Railway-Sync MM ${berlinTimestamp()} — ` +
    `Anmeldungen ${values['Anmeldungen']} · Verkäufe ${values['Verkäufe']} · ` +
    `CC ${values['CC gebucht']}/${values['CC geführt']} · SC ${values['SC gebucht']}/${values['SC geführt']} · ` +
    `FU ${values['Follow-Up gebucht']}/${values['Follow-Up geführt']} (gebucht/geführt)`;

  // The marker carries the accumulated direct-KG set forward. Human-readable part first.
  const marker = buildDirectMarker(rememberedDirect);
  const commentWithMarker = `${commentText}
${marker}`;
  if (Buffer.byteLength(commentWithMarker, 'utf8') > NOTION_COMMENT_LIMIT - 128) {
    console.warn(
      `WARNUNG: Direkt-Marker mit ${rememberedDirect.size} IDs sprengt bald das Notion-Kommentarlimit ` +
      `(${Buffer.byteLength(commentWithMarker, 'utf8')} von ${NOTION_COMMENT_LIMIT} Bytes). ` +
      `Zustand braucht dann einen anderen Speicher (z.B. Railway-Volume oder GHL-Tag).`
    );
  }

  if (DRY_RUN) {
    console.log('DRY_RUN active -> nothing written to Notion.');
    console.log('DRY_RUN would post comment:', commentWithMarker);
    console.warn('DRY_RUN: Direkt-Marker wird NICHT geschrieben -> die gemerkte Route waechst nicht mit.');
    return;
  }
  await notionPatchNumbers(PAGE_ID, values);
  console.log(`[${new Date().toISOString()}] Notion page ${PAGE_ID} properties updated OK.`);

  try {
    await notionAddComment(PAGE_ID, commentWithMarker);
    console.log(`Audit comment posted (mit Direkt-Marker, ${rememberedDirect.size} IDs).`);
  } catch (err) {
    console.warn('Comment post failed (KPI write still succeeded):', err instanceof Error ? err.message : err);
  }
}

main().catch((err: unknown) => {
  console.error('MM SYNC FAILED (no partial write beyond fields already sent):', err instanceof Error ? err.message : err);
  process.exit(1);
});
