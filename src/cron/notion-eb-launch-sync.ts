/**
 * Daily GHL -> Notion KPI sync for the "2026-09 EB-Launch" record (ExpertenBusiness).
 *
 * Sibling of notion-webinar-sync.ts (Money Alchemy). Same eight KPI fields in the same
 * Notion "Promotions" database, but ONE IMPORTANT DIFFERENCE in the calendar part:
 *
 *   Anmeldungen, Verkäufe            -> GHL PIPELINE "26-08 Experten Business Workshop"
 *   CC gebucht / CC geführt          -> GHL CALENDARS, restricted to pipeline contacts
 *   SC gebucht / SC geführt          -> GHL CALENDARS, restricted to pipeline contacts
 *   Follow-Up gebucht / geführt      -> GHL CALENDARS, restricted to pipeline contacts
 * (Notion "SC" == GHL "KG".)
 *
 * WHY the extra restriction (decided 2026-08-07): the pre-cutover ExpertenBusiness
 * calendar is NOT launch-specific — "Klarheitsgespräch - ExpertenBusiness" has been taking
 * bookings continuously since June (evergreen funnel). A pure time window (what the MA job
 * does, and what works there) therefore attributes foreign bookings to this launch: on
 * 2026-08-07 that calendar had 5 August slots, of which only 2 belonged to contacts in
 * this pipeline. Since Notion computes "No-Show SC" as 1 - geführt/gebucht, an inflated
 * "gebucht" produces a plausible-looking but wrong quota — the worst failure mode.
 *
 * The EB-prefixed calendars added later that day ARE launch-specific, which makes the
 * filter redundant for them — but it stays, for two reasons: the pre-cutover calendar is
 * still in the KG list, and the filter turns a mis-wired booking workflow into a visible
 * number ("nicht zugerechnet") instead of a wrong KPI. If that counter climbs while the
 * board shows bookings, the opportunity automation behind the new calendars is broken.
 *
 * So a booking counts only if the contact has an opportunity in THIS pipeline. Pipeline
 * membership (unlike stage membership) does not drain as the contact progresses, so this
 * also fixes the undercount a stage-based count would have: the one KG no-show sits in
 * stage "KG abgesagt / no show" and would be missing from "KG gebucht" entirely.
 *
 * Counted as DISTINCT CONTACTS (a reschedule = cancelled + rebooked counts once), slot
 * time from LAUNCH_START onward, excluding the account owner (test bookings).
 * "gebucht" = distinct contacts with any appointment; "geführt" = with >=1 CONFIRMED one.
 *
 * The Notion "No-Show CC/SC/FU" fields are FORMULAS (1 - geführt/gebucht, as %) and are
 * computed automatically by Notion - this job does not (and cannot) write them.
 *
 * All number fields use the never-decrease rule: written value = max(computed, current Notion).
 *
 * Run:      node dist/cron/notion-eb-launch-sync.js
 * Schedule: Railway cron "30 18 * * *" (= 20:30 Berlin summer time), own service
 *
 * Required env:
 *   GHL_API_KEY, GHL_LOCATION_ID, NOTION_TOKEN
 * Optional env:
 *   GHL_BASE_URL      (default https://services.leadconnectorhq.com)
 *   GHL_API_VERSION   (default 2023-02-21, used for the opportunities API)
 *   DRY_RUN=1         (compute + log, but do NOT write to Notion)
 */

const GHL_BASE = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_VERSION = process.env.GHL_API_VERSION || '2023-02-21';
const GHL_CAL_VERSION = '2021-04-15'; // calendars API expects this version
const GHL_KEY = process.env.GHL_API_KEY || '';
const LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const NOTION_VERSION = '2022-06-28';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const PIPELINE_ID = 'EKcP2CQvvVXJIdEXAb9y'; // "26-08 Experten Business Workshop"
const PAGE_ID = '394828f7-cb43-8144-92b0-dd806a645a28'; // "2026-09 EB-Launch", DB Promotions

// Pipeline stages used for Anmeldungen (registrations) and Verkäufe (sales).
// Every metric is a LIST even when it currently holds one stage — stages get split
// ("Kauf" -> Vollzahlung + Anzahlung), and a split must cost one line, not a bug hunt.
const STAGES = {
  // Subtracted from the pipeline total: opt-in page hits that never registered.
  landingpage: [
    '902fc1be-7e1a-42d9-9f5f-7bd9b64d0318', // Landingpage aufgerufen
  ],
  kauf: [
    '4997363c-28db-47a6-8b97-177a7a90bd3b', // Kauf Vollzahlung
    '19a918f2-52b9-48d8-8e87-f34e8d31146d', // Kauf Anzahlung
  ],
};
// Deliberately NOT counted as sales: "Zusage / Geldbeschaffung" (360edae7…, intent only),
// "Fehlkauf" (65781889…), "Absage" (ce66b09d…), "NO Fit" (2b6918c3…).

// Booking calendars per call type. Since 2026-08-07 this launch has its own EB-prefixed
// calendars (created mid-launch, all empty at cutover), so the lists below are the
// authoritative mapping rather than an analogy to the MA funnel.
//
// EVERY LIST MUST HOLD ALL CALENDARS OF ITS CALL TYPE — including the pre-cutover one.
// Counting is de-duplicated per CONTACT across the whole list, so a lead who rebooks from
// the old calendar to a new one, or switches from Kate to Bianca, counts once. Summing
// per-calendar counts instead would double-count exactly those cases. Conversely, dropping
// the old calendar from a list would silently lose the bookings already counted there —
// and the never-decrease rule would freeze the stale number in Notion instead of exposing
// the drop.
const CC_CALENDARS = [
  'Kp5IUHs4OPO9RfaVDvcM', // EB Business Talk Kate
  'qpsXHyABTFFUxx1rCFnf', // EB Business Talk Andjelina
  'xqyQ9YJAlrmHHZbfiCNs', // EB Business Talk Bianca
];
// Deliberately NOT in the CC list: "Dein Start in dein ExpertenBusiness" (q4qmXBET…,
// amXuGoX3…, FVY1csPM…) and the unprefixed "Business Talk" (B7nzSMe3…). Those were the
// placeholder guess before the EB calendars existed; they serve other funnels and had zero
// bookings from this pipeline's contacts, so nothing is lost by excluding them.
const KG_CALENDARS = [
  'gNufujucY7UJaWHLqo3p', // Klarheitsgespräch - ExpertenBusiness (pre-cutover; holds the first real bookings)
  'HTkugeU1qADzQsN8TgXE', // KG - EB - Feven
  'TN9blFDziggEpqOh4Svh', // KG - EB - Monika
];
const FU_CALENDARS = [
  'QrDTBB2EzMCREySHG5Pe', // EB Follow Up Feven Winde
  'oGGABGXQ1hPKpcZHr5Iy', // EB Follow Up Monika Beye
];
// The MA follow-up calendars (g3rHhuPk…, gCobK98d…) are NOT in the FU list anymore. They
// are read by notion-webinar-sync.ts; a contact in both pipelines would otherwise have
// been counted on both Notion pages. The EB-specific calendars remove that overlap at the
// source. The "Roadmap Follow Up" calendars belong to yet another funnel and stay out.

// Contacts excluded from calendar counts (account owner / test bookings).
const EXCLUDE_CONTACT_IDS = new Set<string>(['oJHByWHQvm7kYeT3o7d9']); // Annett Timinger

// Count window (slot time). The pipeline was created 2026-08-05 and took its first
// opportunities on 2026-08-07; 01.08. is a safe lower bound that still excludes the
// previous EB launch ("26-05 Experten-Business Workshop") on the same calendars.
const LAUNCH_START_MS = Date.parse('2026-07-31T22:00:00Z'); // 01.08.2026 00:00 Europe/Berlin
const WINDOW_END_MS = () => Date.now() + 200 * 24 * 60 * 60 * 1000; // +200 days, catches future slots

function ghlHeaders(version: string): Record<string, string> {
  return {
    Authorization: `Bearer ${GHL_KEY}`,
    Version: version,
    Accept: 'application/json',
    // services.leadconnectorhq.com answers 403 / Cloudflare 1010 to default client UAs.
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  };
}

/** Exact opportunity count in a stage (or the whole pipeline if stageId is empty), via meta.total. */
async function ghlStageTotal(stageId: string): Promise<number> {
  const q = new URLSearchParams({ location_id: LOCATION_ID, pipeline_id: PIPELINE_ID, limit: '1' });
  if (stageId) q.set('pipeline_stage_id', stageId);
  const res = await fetch(`${GHL_BASE}/opportunities/search?${q.toString()}`, { headers: ghlHeaders(GHL_VERSION) });
  if (!res.ok) {
    throw new Error(`GHL search failed (${res.status}) for stage ${stageId || 'ALL'}: ${await res.text()}`);
  }
  const body: any = await res.json();
  const total = body?.meta?.total;
  if (typeof total !== 'number') {
    throw new Error(`GHL response missing numeric meta.total for stage ${stageId || 'ALL'}`);
  }
  return total;
}

/** Sum of the exact totals of several stages (a metric is always a list of stages). */
async function ghlStageSum(stageIds: string[]): Promise<number[]> {
  return Promise.all(stageIds.map(ghlStageTotal));
}

/**
 * Every contact that has an opportunity in this pipeline — the attribution basis for the
 * calendar counts. Paginated; fails loud rather than returning a partial set, because a
 * silently short set would under-count every calendar KPI.
 */
async function ghlPipelineContactIds(expectedTotal: number): Promise<Set<string>> {
  const contactIds = new Set<string>();
  let url =
    `${GHL_BASE}/opportunities/search?` +
    new URLSearchParams({ location_id: LOCATION_ID, pipeline_id: PIPELINE_ID, limit: '100' }).toString();
  let seen = 0;

  for (let page = 1; page <= 200; page++) {
    const res = await fetch(url, { headers: ghlHeaders(GHL_VERSION) });
    if (!res.ok) throw new Error(`GHL opportunity page ${page} failed (${res.status}): ${await res.text()}`);
    const body: any = await res.json();
    const opps: any[] = Array.isArray(body?.opportunities) ? body.opportunities : [];
    for (const o of opps) if (o?.contactId) contactIds.add(o.contactId as string);
    seen += opps.length;

    const next = body?.meta?.nextPageUrl;
    if (opps.length === 0 || !next || !body?.meta?.nextPage) break;
    url = next as string;
  }

  if (seen < expectedTotal) {
    throw new Error(`Pipeline paging incomplete: read ${seen} of ${expectedTotal} opportunities (aborting).`);
  }
  return contactIds;
}

interface CalEvent { id?: string; contactId?: string; appointmentStatus?: string; }

/** All appointment events of one calendar within the count window. */
async function ghlCalendarEvents(calendarId: string): Promise<CalEvent[]> {
  const q = new URLSearchParams({
    locationId: LOCATION_ID,
    calendarId,
    startTime: String(LAUNCH_START_MS),
    endTime: String(WINDOW_END_MS()),
  });
  const res = await fetch(`${GHL_BASE}/calendars/events?${q.toString()}`, { headers: ghlHeaders(GHL_CAL_VERSION) });
  if (!res.ok) {
    throw new Error(`GHL calendar events failed (${res.status}) for calendar ${calendarId}: ${await res.text()}`);
  }
  const body: any = await res.json();
  return Array.isArray(body?.events) ? (body.events as CalEvent[]) : [];
}

/**
 * Consolidate a call type across its calendars into distinct-contact counts, counting
 * only contacts that belong to this pipeline (see the file header for why).
 * gebucht  = distinct contacts with >=1 appointment (any status).
 * gefuehrt = distinct contacts with >=1 CONFIRMED appointment.
 * Reschedules (cancelled + rebooked) collapse to one contact; owner/test contacts excluded.
 */
async function calendarCounts(
  calendarIds: string[],
  pipelineContactIds: Set<string>,
): Promise<{ gebucht: number; gefuehrt: number; foreign: number }> {
  const events = (await Promise.all(calendarIds.map(ghlCalendarEvents))).flat();
  const seenAppt = new Set<string>();
  const confirmedByContact = new Map<string, boolean>();
  const foreignContacts = new Set<string>();

  for (const e of events) {
    const cid = e.contactId;
    if (!cid || EXCLUDE_CONTACT_IDS.has(cid)) continue;
    if (!pipelineContactIds.has(cid)) {
      foreignContacts.add(cid); // logged, not counted: booking from another funnel/launch
      continue;
    }
    if (e.id) {
      if (seenAppt.has(e.id)) continue; // de-dupe identical appointment objects
      seenAppt.add(e.id);
    }
    const wasConfirmed = confirmedByContact.get(cid) === true;
    confirmedByContact.set(cid, wasConfirmed || e.appointmentStatus === 'confirmed');
  }

  let gefuehrt = 0;
  for (const isConfirmed of confirmedByContact.values()) if (isConfirmed) gefuehrt++;
  return { gebucht: confirmedByContact.size, gefuehrt, foreign: foreignContacts.size };
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

/** Post an audit comment on the Notion page. Requires the integration to have "insert comment" capability. */
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
  const start = new Date().toISOString();
  console.log(`[${start}] GHL->Notion EB-Launch sync start (DRY_RUN=${DRY_RUN})`);

  const requiredEnv: Record<string, string> = { GHL_API_KEY: GHL_KEY, GHL_LOCATION_ID: LOCATION_ID, NOTION_TOKEN };
  for (const [name, value] of Object.entries(requiredEnv)) {
    if (!value) throw new Error(`Missing required env var: ${name}`);
  }

  // 1. Pipeline counts for Anmeldungen + Verkäufe.
  const [total, landingpageParts, kaufParts] = await Promise.all([
    ghlStageTotal(''),
    ghlStageSum(STAGES.landingpage),
    ghlStageSum(STAGES.kauf),
  ]);
  const landingpage = landingpageParts.reduce((a, b) => a + b, 0);
  const kauf = kaufParts.reduce((a, b) => a + b, 0);
  const anmeldungen = total - landingpage;

  // 2. Attribution basis + calendar counts.
  const pipelineContacts = await ghlPipelineContactIds(total);
  const [cc, kg, fu] = await Promise.all([
    calendarCounts(CC_CALENDARS, pipelineContacts),
    calendarCounts(KG_CALENDARS, pipelineContacts),
    calendarCounts(FU_CALENDARS, pipelineContacts),
  ]);

  console.log(
    `Pipeline: total=${total} landingpage=${landingpage} -> Anmeldungen=${anmeldungen} | ` +
    `Kauf=${kauf} (${kaufParts.join(' + ')}) | Kontakte in Pipeline=${pipelineContacts.size}`
  );
  console.log(
    `Kalender (distinkte Kontakte AUS DIESER PIPELINE): CC ${cc.gebucht}/${cc.gefuehrt} | ` +
    `KG ${kg.gebucht}/${kg.gefuehrt} | FU ${fu.gebucht}/${fu.gefuehrt}  (gebucht/geführt)`
  );
  console.log(
    `  nicht zugerechnet (Termin ohne Opportunity in dieser Pipeline): ` +
    `CC ${cc.foreign} · KG ${kg.foreign} · FU ${fu.foreign} Kontakte`
  );

  // 3. Read current Notion values (needed for the never-decrease max-rule on all number fields).
  const cur = await notionGetNumbers(PAGE_ID, [
    'Anmeldungen', 'Verkäufe',
    'CC gebucht', 'CC geführt', 'SC gebucht', 'SC geführt', 'Follow-Up gebucht', 'Follow-Up geführt',
  ]);

  // 4. Compute the target values. Every field is never-decrease: max(computed, current Notion).
  const values: Record<string, number> = {
    Anmeldungen: Math.max(anmeldungen, cur['Anmeldungen']),
    'Verkäufe': Math.max(kauf, cur['Verkäufe']),
    'CC gebucht': Math.max(cc.gebucht, cur['CC gebucht']),
    'CC geführt': Math.max(cc.gefuehrt, cur['CC geführt']),
    'SC gebucht': Math.max(kg.gebucht, cur['SC gebucht']),
    'SC geführt': Math.max(kg.gefuehrt, cur['SC geführt']),
    'Follow-Up gebucht': Math.max(fu.gebucht, cur['Follow-Up gebucht']),
    'Follow-Up geführt': Math.max(fu.gefuehrt, cur['Follow-Up geführt']),
  };

  console.log('Field mapping (all never-decrease):');
  console.log(`  Anmeldungen       = max(${total} - ${landingpage} = ${anmeldungen}, Notion ${cur['Anmeldungen']}) = ${values['Anmeldungen']}`);
  console.log(`  Verkäufe          = max(Kauf ${kauf}, Notion ${cur['Verkäufe']}) = ${values['Verkäufe']}`);
  console.log(`  CC gebucht        = max(Kal ${cc.gebucht}, Notion ${cur['CC gebucht']}) = ${values['CC gebucht']}`);
  console.log(`  CC geführt        = max(Kal ${cc.gefuehrt}, Notion ${cur['CC geführt']}) = ${values['CC geführt']}`);
  console.log(`  SC gebucht        = max(Kal ${kg.gebucht}, Notion ${cur['SC gebucht']}) = ${values['SC gebucht']}`);
  console.log(`  SC geführt        = max(Kal ${kg.gefuehrt}, Notion ${cur['SC geführt']}) = ${values['SC geführt']}`);
  console.log(`  Follow-Up gebucht = max(Kal ${fu.gebucht}, Notion ${cur['Follow-Up gebucht']}) = ${values['Follow-Up gebucht']}`);
  console.log(`  Follow-Up geführt = max(Kal ${fu.gefuehrt}, Notion ${cur['Follow-Up geführt']}) = ${values['Follow-Up geführt']}`);
  console.log('  (No-Show CC/SC/FU sind Notion-Formeln = 1 - geführt/gebucht, werden automatisch berechnet.)');

  const commentText =
    `🔄 Railway-Sync EB ${berlinTimestamp()} — ` +
    `Anmeldungen ${values['Anmeldungen']} · Verkäufe ${values['Verkäufe']} · ` +
    `CC ${values['CC gebucht']}/${values['CC geführt']} · SC ${values['SC gebucht']}/${values['SC geführt']} · ` +
    `FU ${values['Follow-Up gebucht']}/${values['Follow-Up geführt']} (gebucht/geführt)`;

  // 5. Write (unless dry run).
  if (DRY_RUN) {
    console.log('DRY_RUN active -> nothing written to Notion.');
    console.log('DRY_RUN would post comment:', commentText);
    return;
  }
  await notionPatchNumbers(PAGE_ID, values);
  console.log(`[${new Date().toISOString()}] Notion page ${PAGE_ID} properties updated OK.`);

  // 6. Audit comment. Non-fatal: the KPI write already succeeded, so a comment
  //    failure (e.g. integration lacks comment capability) must not fail the run.
  try {
    await notionAddComment(PAGE_ID, commentText);
    console.log('Audit comment posted.');
  } catch (err) {
    console.warn('Comment post failed (KPI write still succeeded):', err instanceof Error ? err.message : err);
  }
}

main().catch((err: unknown) => {
  console.error('EB SYNC FAILED (no partial write beyond fields already sent):', err instanceof Error ? err.message : err);
  process.exit(1);
});
