/**
 * Daily GHL -> Notion KPI sync for the "2026-09 EB-Launch" record (ExpertenBusiness).
 *
 * Writes to the Notion page in the "Promotions" database. Main source is the stage every
 * opportunity of the GHL pipeline "26-08 Experten Business Workshop" currently sits in;
 * Follow-Up comes from the launch's own calendars, and the "KG gebucht direkt" route is
 * remembered across runs because the board cannot answer it (see DIRECT_MARKER_PREFIX).
 *
 *   Anmeldungen, Verkäufe                        -> stage lists
 *   CC gebucht / CC geführt                      -> stage lists ("ever booked / ever held")
 *   SC gebucht / SC geführt                      -> stage lists   (Notion "SC" == GHL "KG")
 *   Follow-Up gebucht / geführt                  -> CALENDARS, see FU_CALENDARS
 *
 * Follow-Up is the deliberate exception: the board hardly tracks it (stage "FU gebucht"
 * held 1 contact on 14.08.2026). It is read from the two LAUNCH-SPECIFIC follow-up
 * calendars only — never from the shared general ones, which carry other programmes'
 * follow-ups for the same people (see FU_CALENDARS for what that cost).
 * Source per metric follows the data, not a preference for one system.
 *
 * WHY STAGES AND NOT CALENDARS (decided 14.08.2026, after the calendar version produced
 * badly wrong numbers): the KPI is "wer je ein CC gebucht hat". Two attempts to read that
 * from booking calendars failed, and the check that settled it: of 32 contacts sitting in
 * stages that can only be reached after a CC, 21 had NO appointment in any plausible CC
 * calendar at all. The calls are spread over many calendars (Money Alchemy KG, Fortune
 * Family Business Analyse, Roadmap, …) and the board is partly maintained by hand, so no
 * calendar set reproduces it. The board is the authority; calendars are not.
 *
 * HOW "ever booked" IS MODELLED: a stage is a POSITION and drains as a contact advances,
 * so a single stage can never answer "ever". Each metric is therefore the union of every
 * stage that a contact can only have reached BY having had that call — "gebucht" includes
 * the stage itself plus everything downstream, "geführt" is the same minus the stages that
 * mean the call has not happened yet (still waiting, or no-show). Verified against the
 * numbers given for 14.08. 11:36 (CC 25 booked / 14 held) and re-verified an hour later
 * when two contacts had advanced: the booked total held at 25 while held rose to 16 —
 * exactly what the metric must do.
 *
 * Counted as DISTINCT CONTACTS, not opportunities: a contact with two opportunities in the
 * pipeline must not count twice. All opportunities are paged once and every KPI is derived
 * from that single snapshot, so the numbers are mutually consistent.
 *
 * All written fields use the never-decrease rule: value = max(computed, current Notion).
 * That still matters with stage sums, because the four stages listed as OPEN below are
 * excluded, so a contact moving into one of them would otherwise lower a "ever" metric.
 *
 * The Notion "No-Show CC/SC/FU" and "Conversion …" fields are FORMULAS and are computed by
 * Notion — this job does not (and cannot) write them.
 *
 * Run:      node dist/cron/notion-eb-launch-sync.js
 * Schedule: Railway cron "30 18 * * *" (= 20:30 Berlin summer time), service
 *           ff-eb-launch-notion-sync
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

const PIPELINE_ID = 'EKcP2CQvvVXJIdEXAb9y'; // "26-08 Experten Business Workshop"
const PAGE_ID = '394828f7-cb43-8144-92b0-dd806a645a28'; // "2026-09 EB-Launch", DB Promotions

/**
 * Every stage of the pipeline, by ID. Names are the state on 14.08.2026 and are for
 * reading only — never match on them, they get renamed in production ("Angemeldet" ->
 * "Lead" happened in the sibling pipeline).
 */
const S = {
  landingpage:  '902fc1be-7e1a-42d9-9f5f-7bd9b64d0318', // Landingpage aufgerufen
  lead:         '8495fb19-48b9-4d85-a571-02d150bf3338', // Lead
  kunden:       'dab500c9-3e83-45e2-90dc-58db7052789a', // Kunden
  umfrage:      'e54ad887-4dd9-4c31-9bf2-93443716dc80', // Umfrage ausgefüllt
  ccGebucht:    '39fa403e-cafb-4981-8844-f9435d9c8208', // CC gebucht
  ccNoShow:     'da38a6c9-7141-4077-aac5-46735641efa0', // CC abgesagt / no show
  kgAusCC:      '71f1e3d3-30a3-4495-8a88-e056d5a3c469', // KG gebucht aus CC
  kgDirekt:     '9e617e01-9eaf-4f92-96bd-63ca74a42e6c', // KG gebucht direkt
  ccGefuehrt:   'df199572-f615-4a29-909c-91595292f5d1', // CC geführt / kein KG angeboten
  kgGefuehrt:   'd70a41a4-9f66-489e-8dcb-fb6524b4bae3', // KG geführt / kein Angebot
  kgNoShow:     '803c9e9a-9bed-4ff6-ad41-b7f17f8b2f5c', // KG abgesagt / no show
  fuGebucht:    '9f46c119-1938-48ea-98f1-11055b856768', // FU gebucht
  fuNoShow:     'ca522828-064c-4944-882b-c9196f5c7b20', // FU abgesagt / no show
  zusage:       '360edae7-d66c-438f-8bf4-d50a37fbbf7f', // Zusage / Geldbeschaffung
  kaufVoll:     '4997363c-28db-47a6-8b97-177a7a90bd3b', // Kauf Vollzahlung
  kaufAnz:      '19a918f2-52b9-48d8-8e87-f34e8d31146d', // Kauf Anzahlung
  fehlkauf:     '65781889-5bd5-4898-a8bf-7cb07857ebe5', // Fehlkauf
  absage:       'ce66b09d-2ea0-4cc8-8b36-c4e49fa02e03', // Absage
  noFit:        '2b6918c3-b0ac-4304-939d-2684f402c39d', // NO Fit
};

/**
 * OPEN, deliberately in no list (state 14.08.2026): `absage`, `noFit`, `kunden` can be set
 * from anywhere on the board, so they do not prove a call happened; `kgDirekt` is by
 * definition the route WITHOUT a CC, so it must never feed a CC metric (it does feed the SC
 * ones). Together they held 4 contacts, so including them would raise CC to 36/24 instead
 * of 32/20. Decide with the business side before adding any of them — and if `kgDirekt`
 * ever becomes non-zero, note that a contact who buys via that route lands in `kaufVoll`
 * and would then be counted as having had a CC.
 */
const METRICS: Record<string, string[]> = {
  // Everyone who registered = everyone except the pure landing-page hits.
  // Expressed as "all stages but landingpage" so a new stage cannot silently fall out.
  anmeldungen: [
    S.lead, S.kunden, S.umfrage, S.ccGebucht, S.ccNoShow, S.kgAusCC, S.kgDirekt,
    S.ccGefuehrt, S.kgGefuehrt, S.kgNoShow, S.fuGebucht, S.fuNoShow, S.zusage,
    S.kaufVoll, S.kaufAnz, S.fehlkauf, S.absage, S.noFit,
  ],
  verkaeufe: [S.kaufVoll, S.kaufAnz],

  // CC: booked = the CC stage itself, its no-show, and everything only reachable after a CC.
  ccGebucht: [
    S.ccGebucht, S.ccNoShow, S.kgAusCC, S.ccGefuehrt, S.kgGefuehrt, S.kgNoShow,
    S.fuGebucht, S.fuNoShow, S.zusage, S.kaufVoll, S.kaufAnz, S.fehlkauf,
  ],
  // held = the same, minus "still waiting for the CC" and "did not show up for it".
  ccGefuehrt: [
    S.kgAusCC, S.ccGefuehrt, S.kgGefuehrt, S.kgNoShow,
    S.fuGebucht, S.fuNoShow, S.zusage, S.kaufVoll, S.kaufAnz, S.fehlkauf,
  ],

  // SC (== GHL "KG"): both routes into the KG, plus everything only reachable after one.
  scGebucht: [
    S.kgAusCC, S.kgDirekt, S.kgGefuehrt, S.kgNoShow,
    S.fuGebucht, S.fuNoShow, S.zusage, S.kaufVoll, S.kaufAnz, S.fehlkauf,
  ],
  scGefuehrt: [
    S.kgGefuehrt, S.fuGebucht, S.fuNoShow, S.zusage, S.kaufVoll, S.kaufAnz, S.fehlkauf,
  ],

  // NOTE: Follow-Up is NOT in this map — it comes from calendars, see FU_CALENDARS below.
};

/**
 * Follow-Up does NOT come from the board: the board barely tracks it (on 14.08.2026 the
 * stage "FU gebucht" held 1 contact). But it must come from the LAUNCH-SPECIFIC calendars
 * ONLY — the two below, nothing else.
 *
 * WHY ONLY THESE (reported by the business side on 25.08.2026, verified 03.09.2026): the
 * shared general "Follow Up Feven/Monika" calendars were in this list, and they carry
 * follow-ups from OTHER programmes. Many EB leads are also customers elsewhere, so the
 * pipeline-contact filter does not separate them: it counted 24 contacts as EB follow-ups,
 * 17 of them as held, when this launch had had none at all. The names were checkable and
 * all but two (Susanne Thiel, Larissa Lieder) had nothing to do with this launch.
 *
 * This is the exception to the "new calendars are additional, never a replacement" rule
 * from 11.08.2026. That rule holds where the old calendar serves the SAME funnel and the
 * booking flow simply has not moved yet (as with CC). It does NOT hold for a calendar that
 * is shared across programmes — there, including it imports foreign bookings, and pipeline
 * membership cannot filter them out. Ask which of the two cases applies before adding a
 * calendar to any list here.
 */
const FU_CALENDARS = [
  'QrDTBB2EzMCREySHG5Pe', // ExpertenBusiness Follow Up Feven Winde
  'oGGABGXQ1hPKpcZHr5Iy', // ExpertenBusiness Follow Up Monika Beye
];
// Deliberately OUT: 'g3rHhuPkT1kgeWQZ1Uy1' / 'gCobK98dVDnJI5g3mgHa' (general "Follow Up
// Feven/Monika", shared across programmes — see above) and the "Roadmap Follow Up" pair
// (different funnel). Do not re-add them to make the number look bigger.

const GHL_CAL_VERSION = '2021-04-15'; // calendars API expects this version
const EXCLUDE_CONTACT_IDS = new Set<string>(['oJHByWHQvm7kYeT3o7d9']); // account owner / test bookings
const FU_WINDOW_START_MS = Date.parse('2026-07-31T22:00:00Z'); // 01.08.2026 00:00 Europe/Berlin
const FU_WINDOW_END_MS = () => Date.now() + 200 * 24 * 60 * 60 * 1000;

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
 * Remembering the "KG gebucht direkt" route
 * ---------------------------------------------------------------------------------------
 * The board distinguishes the two ways into a KG exactly once — at the booking step
 * (`kgAusCC` vs `kgDirekt`). Everything behind it (`kgGefuehrt`, `kgNoShow`, `fuGebucht`,
 * `fuNoShow`, `zusage`, `kauf*`, `fehlkauf`) is shared, so as soon as a direct booker
 * advances, the stage no longer shows that they never had a CC — and they inflate the CC
 * metrics, which are built as "the CC stage plus everything downstream".
 *
 * Reconstructing the route afterwards is impossible from the data. All of this was tested
 * on 03.09.2026 against the two groups whose route IS known (`kgAusCC` = had a CC,
 * `kgDirekt` = had none):
 *   - No history/audit endpoint exists (404 on /opportunities/{id}/history|audit|timeline).
 *   - No contact tag separates them (tags describe webinar attendance, not the call route).
 *   - "has an appointment in a CC calendar": 67/77 vs 3/8 — wrong in both directions.
 *   - "attribution on the CC booking widget (business-analyse-fortune-family…)": perfectly
 *     specific (0/8 direct bookers, 0/770 leads) but only ~50% sensitive, so its ABSENCE
 *     proves nothing and it cannot be used to exclude anybody.
 * Upper bound of the error at that time: 32 of 269 (loose — most of those 32 likely did
 * have a CC).
 *
 * So the job has to remember. It stores the accumulated set of contacts it has ever seen in
 * `kgDirekt` in its own Notion audit comment, as a machine-readable marker. That needs no
 * extra infrastructure, writes nothing to the CRM, and stays auditable where the KPI lives.
 * Every run rewrites the COMPLETE set, so reading the newest marker is enough.
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

interface CalEvent { id?: string; contactId?: string; appointmentStatus?: string; startTime?: string; }

/** All appointment events of one calendar within the count window. */
async function ghlCalendarEvents(calendarId: string): Promise<CalEvent[]> {
  const q = new URLSearchParams({
    locationId: LOCATION_ID,
    calendarId,
    startTime: String(FU_WINDOW_START_MS),
    endTime: String(FU_WINDOW_END_MS()),
  });
  const res = await fetch(`${GHL_BASE}/calendars/events?${q.toString()}`, {
    headers: { ...ghlHeaders(), Version: GHL_CAL_VERSION },
  });
  if (!res.ok) {
    throw new Error(`GHL calendar events failed (${res.status}) for calendar ${calendarId}: ${await res.text()}`);
  }
  const body: any = await res.json();
  return Array.isArray(body?.events) ? (body.events as CalEvent[]) : [];
}

/**
 * Follow-Up counts from the calendars, restricted to contacts of this pipeline.
 * gebucht  = distinct contacts with >=1 appointment (any status; a cancelled one was booked).
 * geführt  = distinct contacts with >=1 CONFIRMED appointment whose slot is IN THE PAST.
 *
 * The past-slot condition is not a detail. This location has no "showed" status: a held call
 * stays `confirmed`, a missed one is set to `noshow` by hand. So `confirmed` alone means
 * "booked and not cancelled" — just as true for a slot next week. Counting those as geführt
 * inflated the KPI badly and, via the never-decrease rule, permanently.
 */
async function followUpCounts(
  pipelineContacts: Set<string>,
): Promise<{ gebucht: number; gefuehrt: number; offen: number; foreign: number }> {
  const events = (await Promise.all(FU_CALENDARS.map(ghlCalendarEvents))).flat();
  const nowMs = Date.now();
  const seenAppt = new Set<string>();
  const heldByContact = new Map<string, boolean>();
  const upcoming = new Set<string>();
  const foreign = new Set<string>();

  for (const e of events) {
    const cid = e.contactId;
    if (!cid || EXCLUDE_CONTACT_IDS.has(cid)) continue;
    if (!pipelineContacts.has(cid)) { foreign.add(cid); continue; }
    if (e.id) {
      if (seenAppt.has(e.id)) continue; // de-dupe identical appointment objects
      seenAppt.add(e.id);
    }
    const confirmed = e.appointmentStatus === 'confirmed';
    const ts = e.startTime ? Date.parse(e.startTime) : NaN;
    const held = confirmed && Number.isFinite(ts) && ts < nowMs;
    heldByContact.set(cid, heldByContact.get(cid) === true || held);
    if (confirmed && !held) upcoming.add(cid);
  }

  let gefuehrt = 0;
  for (const held of heldByContact.values()) if (held) gefuehrt++;
  let offen = 0;
  for (const cid of upcoming) if (heldByContact.get(cid) !== true) offen++;
  return { gebucht: heldByContact.size, gefuehrt, offen, foreign: foreign.size };
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
  console.log(`[${new Date().toISOString()}] GHL->Notion EB-Launch sync start (DRY_RUN=${DRY_RUN})`);

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

  // 3. The direct-KG route: remember it, because the board forgets it (see the block above
  //    DIRECT_MARKER_PREFIX for why nothing else works).
  //    Reading the marker needs the integration's "read comments" capability. It writes
  //    comments but may not be allowed to read them (verified 03.09.2026: HTTP 403). That
  //    must NOT kill the whole sync, but it must not pass silently either: without the
  //    memory only the contacts CURRENTLY in kgDirekt are excluded, so a direct booker who
  //    has already advanced starts inflating CC again.
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
  const currentDirect = contactsInStages(opps, [S.kgDirekt]);
  for (const cid of currentDirect) rememberedDirect.add(cid);

  // A contact the board NOW places in a CC-only stage did have a CC after all (someone
  // corrected the stage) — the current board wins over the remembered flag.
  const CC_ONLY_STAGES = [S.ccGebucht, S.ccNoShow, S.kgAusCC, S.ccGefuehrt];
  const provenCC = contactsInStages(opps, CC_ONLY_STAGES);
  const excludeFromCC = new Set([...rememberedDirect].filter((cid) => !provenCC.has(cid)));
  console.log(
    `KG-direkt-Route: aktuell in der Stage=${currentDirect.size} · gemerkt (kumuliert)=${rememberedDirect.size} ` +
    `(vorher ${rememberedBefore}) · aus den CC-Kennzahlen ausgeschlossen=${excludeFromCC.size} ` +
    `(davon per Board-Korrektur zurueckgeholt=${rememberedDirect.size - excludeFromCC.size})` +
    (memoryReadable ? '' : ' [GEDAECHTNIS NICHT LESBAR - nur aktuelle Stage]')
  );

  // 4. Metrics: everything from stages, except Follow-Up which comes from the calendars.
  //    Only the CC metrics get the exclusion — the SC ones must count the direct route.
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
  const fu = await followUpCounts(allContacts);
  computed.fuGebucht = fu.gebucht;
  computed.fuGefuehrt = fu.gefuehrt;
  console.log(
    `Follow-Up aus Kalendern (Kontakte dieser Pipeline): gebucht=${fu.gebucht} geführt=${fu.gefuehrt} ` +
    `noch offen=${fu.offen} | nicht zugerechnet (kein Opp in dieser Pipeline)=${fu.foreign} · ` +
    `Board-Stage "FU gebucht"=${distinctContacts(opps, [S.fuGebucht])} (bewusst nicht verwendet, siehe Kommentar)`
  );

  // 4. Current Notion values (needed for the never-decrease rule).
  const fieldNames = Object.values(NOTION_FIELDS) as string[];
  const cur = await notionGetNumbers(PAGE_ID, fieldNames);

  // 5. Target values + the full arithmetic in the log.
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
    `🔄 Railway-Sync EB ${berlinTimestamp()} — ` +
    `Anmeldungen ${values['Anmeldungen']} · Verkäufe ${values['Verkäufe']} · ` +
    `CC ${values['CC gebucht']}/${values['CC geführt']} · SC ${values['SC gebucht']}/${values['SC geführt']} · ` +
    `FU ${values['Follow-Up gebucht']}/${values['Follow-Up geführt']} (gebucht/geführt)`;

  // The marker carries the accumulated direct-KG set forward. It is appended to the comment
  // the job posts anyway; the next run reads the newest one back. Human-readable part first.
  const marker = buildDirectMarker(rememberedDirect);
  const commentWithMarker = `${commentText}
${marker}`;
  if (Buffer.byteLength(commentWithMarker, 'utf8') > NOTION_COMMENT_LIMIT - 128) {
    // Never silently drop the memory: a truncated marker would look like "route forgotten"
    // and the CC metrics would quietly start over-counting again.
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
  console.error('EB SYNC FAILED (no partial write beyond fields already sent):', err instanceof Error ? err.message : err);
  process.exit(1);
});
