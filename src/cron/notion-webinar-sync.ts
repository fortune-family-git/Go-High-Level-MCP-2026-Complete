/**
 * Daily GHL -> Notion KPI sync for the "MA Webinar Juli 2026" record.
 *
 * Writes eight KPI number fields to the Notion page in the "Promotions" database:
 *   Anmeldungen, Verkäufe            -> from the GHL PIPELINE "MA LiveWebinar_072026"
 *   CC gebucht / CC geführt          -> from the GHL CALENDARS (Money Talk group)
 *   SC gebucht / SC geführt          -> from the GHL CALENDARS (Money Alchemy KG group)
 *   Follow-Up gebucht / geführt      -> from the GHL CALENDARS (Follow Up group)
 * (Notion "SC" == GHL "KG".)
 *
 * Calendar KPIs are counted as DISTINCT CONTACTS (a reschedule = cancelled + rebooked
 * counts once), slot time from LAUNCH_START onward, excluding the account owner
 * (test bookings). "gebucht" = distinct contacts with any appointment; "geführt" =
 * distinct contacts with at least one CONFIRMED appointment.
 *
 * The Notion "No-Show CC/SC/FU" fields are FORMULAS (1 - geführt/gebucht, as %) and are
 * computed automatically by Notion - this job does not (and cannot) write them.
 *
 * All number fields use the never-decrease rule: written value = max(computed, current Notion).
 *
 * Run:      node dist/cron/notion-webinar-sync.js
 * Schedule: Railway cron "0 20 * * *" with service TZ=Europe/Berlin
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

const PIPELINE_ID = '4jGCaouIb52BEEEba5id';
const PAGE_ID = '384828f7-cb43-8116-bcdf-e752d808c869';

// Pipeline stages still used for Anmeldungen (registrations) and Verkäufe (sales).
const STAGE = {
  landingpage: '402e2603-34ed-4f9e-b407-96847d86ae7c',
  kaufVoll: 'e048ff58-0cc1-4deb-96c2-75783c9fee32',
  kaufRaten: 'f0c43ad3-0df4-4821-8e46-0b7f440346c9',
};

// Booking calendars per call type (group "Kennenlern-Gespräche" / "Für mehr Klarheit" /
// "Follow Up Gespräche"). Round-robin + the two setter calendars each.
const CC_CALENDARS = [
  'Bt5nEvAmncnQ5bo5Yga6', // Money Talk (Round Robin)
  'Nz8MsaIXcA91BwmVe07Y', // Money Talk Feven
  '2ESxCK6tSwBwfCPsZvys', // Money Talk Monika
];
const KG_CALENDARS = [
  'Ln7kRNXs1oP7kB9q3pn0', // Money Alchemy – Deine Zeit ist JETZT 💫 (Round Robin)
  'fqMEAJyPUY4l66pa0SPa', // Money Alchemy – Deine Zeit ist JETZT ⭐ (Feven)
  '5avoEvTgWZAb4U0cl5tC', // Money Alchemy – Deine Zeit ist JETZT ⭐ (MB, Monika)
];
const FU_CALENDARS = [
  'g3rHhuPkT1kgeWQZ1Uy1', // Follow Up Feven Winde
  'gCobK98dVDnJI5g3mgHa', // Follow Up Monika Beye
];

// Contacts excluded from calendar counts (account owner / test bookings).
const EXCLUDE_CONTACT_IDS = new Set<string>(['oJHByWHQvm7kYeT3o7d9']); // Annett Timinger

// Count window (slot time). Launch of the July-2026 webinar; open-ended into the future.
const LAUNCH_START_MS = Date.parse('2026-07-07T22:00:00Z'); // 08.07.2026 00:00 Europe/Berlin
const WINDOW_END_MS = () => Date.now() + 200 * 24 * 60 * 60 * 1000; // +200 days, catches future slots

/** Exact opportunity count in a stage (or the whole pipeline if stageId is empty), via meta.total. */
async function ghlStageTotal(stageId: string): Promise<number> {
  const q = new URLSearchParams({ location_id: LOCATION_ID, pipeline_id: PIPELINE_ID, limit: '1' });
  if (stageId) q.set('pipeline_stage_id', stageId);
  const res = await fetch(`${GHL_BASE}/opportunities/search?${q.toString()}`, {
    headers: { Authorization: `Bearer ${GHL_KEY}`, Version: GHL_VERSION, Accept: 'application/json' },
  });
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

interface CalEvent { id?: string; contactId?: string; appointmentStatus?: string; }

/** All appointment events of one calendar within the count window. */
async function ghlCalendarEvents(calendarId: string): Promise<CalEvent[]> {
  const q = new URLSearchParams({
    locationId: LOCATION_ID,
    calendarId,
    startTime: String(LAUNCH_START_MS),
    endTime: String(WINDOW_END_MS()),
  });
  const res = await fetch(`${GHL_BASE}/calendars/events?${q.toString()}`, {
    headers: { Authorization: `Bearer ${GHL_KEY}`, Version: GHL_CAL_VERSION, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GHL calendar events failed (${res.status}) for calendar ${calendarId}: ${await res.text()}`);
  }
  const body: any = await res.json();
  return Array.isArray(body?.events) ? (body.events as CalEvent[]) : [];
}

/**
 * Consolidate a call type across its calendars into distinct-contact counts.
 * gebucht  = distinct contacts with >=1 appointment (any status).
 * gefuehrt = distinct contacts with >=1 CONFIRMED appointment.
 * Reschedules (cancelled + rebooked) collapse to one contact; owner/test contacts excluded.
 */
async function calendarCounts(calendarIds: string[]): Promise<{ gebucht: number; gefuehrt: number }> {
  const events = (await Promise.all(calendarIds.map(ghlCalendarEvents))).flat();
  const seenAppt = new Set<string>();
  const confirmedByContact = new Map<string, boolean>();
  for (const e of events) {
    const cid = e.contactId;
    if (!cid || EXCLUDE_CONTACT_IDS.has(cid)) continue;
    if (e.id) {
      if (seenAppt.has(e.id)) continue; // de-dupe identical appointment objects
      seenAppt.add(e.id);
    }
    const wasConfirmed = confirmedByContact.get(cid) === true;
    confirmedByContact.set(cid, wasConfirmed || e.appointmentStatus === 'confirmed');
  }
  let gefuehrt = 0;
  for (const isConfirmed of confirmedByContact.values()) if (isConfirmed) gefuehrt++;
  return { gebucht: confirmedByContact.size, gefuehrt };
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
  console.log(`[${start}] GHL->Notion sync start (DRY_RUN=${DRY_RUN})`);

  const requiredEnv: Record<string, string> = { GHL_API_KEY: GHL_KEY, GHL_LOCATION_ID: LOCATION_ID, NOTION_TOKEN };
  for (const [name, value] of Object.entries(requiredEnv)) {
    if (!value) throw new Error(`Missing required env var: ${name}`);
  }

  // 1. Pipeline counts for Anmeldungen + Verkäufe, and calendar counts for CC/KG/FU (parallel).
  const [total, landingpage, kaufVoll, kaufRaten, cc, kg, fu] = await Promise.all([
    ghlStageTotal(''),
    ghlStageTotal(STAGE.landingpage),
    ghlStageTotal(STAGE.kaufVoll),
    ghlStageTotal(STAGE.kaufRaten),
    calendarCounts(CC_CALENDARS),
    calendarCounts(KG_CALENDARS),
    calendarCounts(FU_CALENDARS),
  ]);
  const kauf = kaufVoll + kaufRaten;
  const anmeldungen = total - landingpage;
  console.log(
    `Pipeline: total=${total} landingpage=${landingpage} -> Anmeldungen=${anmeldungen} | ` +
    `Kauf=${kauf} (Voll ${kaufVoll} + Raten ${kaufRaten})`
  );
  console.log(
    `Kalender (distinkte Kontakte): CC ${cc.gebucht}/${cc.gefuehrt} | ` +
    `KG ${kg.gebucht}/${kg.gefuehrt} | FU ${fu.gebucht}/${fu.gefuehrt}  (gebucht/geführt)`
  );

  // 2. Read current Notion values (needed for the never-decrease max-rule on all number fields).
  const cur = await notionGetNumbers(PAGE_ID, [
    'Anmeldungen', 'Verkäufe',
    'CC gebucht', 'CC geführt', 'SC gebucht', 'SC geführt', 'Follow-Up gebucht', 'Follow-Up geführt',
  ]);

  // 3. Compute the target values. Every field is never-decrease: max(computed, current Notion).
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
  console.log(`  Anmeldungen       = max(${anmeldungen}, Notion ${cur['Anmeldungen']}) = ${values['Anmeldungen']}`);
  console.log(`  Verkäufe          = max(Kauf ${kauf}, Notion ${cur['Verkäufe']}) = ${values['Verkäufe']}`);
  console.log(`  CC gebucht        = max(Kal ${cc.gebucht}, Notion ${cur['CC gebucht']}) = ${values['CC gebucht']}`);
  console.log(`  CC geführt        = max(Kal ${cc.gefuehrt}, Notion ${cur['CC geführt']}) = ${values['CC geführt']}`);
  console.log(`  SC gebucht        = max(Kal ${kg.gebucht}, Notion ${cur['SC gebucht']}) = ${values['SC gebucht']}`);
  console.log(`  SC geführt        = max(Kal ${kg.gefuehrt}, Notion ${cur['SC geführt']}) = ${values['SC geführt']}`);
  console.log(`  Follow-Up gebucht = max(Kal ${fu.gebucht}, Notion ${cur['Follow-Up gebucht']}) = ${values['Follow-Up gebucht']}`);
  console.log(`  Follow-Up geführt = max(Kal ${fu.gefuehrt}, Notion ${cur['Follow-Up geführt']}) = ${values['Follow-Up geführt']}`);
  console.log('  (No-Show CC/SC/FU sind Notion-Formeln = 1 - geführt/gebucht, werden automatisch berechnet.)');

  const commentText =
    `🔄 Railway-Sync ${berlinTimestamp()} — ` +
    `Anmeldungen ${values['Anmeldungen']} · Verkäufe ${values['Verkäufe']} · ` +
    `CC ${values['CC gebucht']}/${values['CC geführt']} · SC ${values['SC gebucht']}/${values['SC geführt']} · ` +
    `FU ${values['Follow-Up gebucht']}/${values['Follow-Up geführt']} (gebucht/geführt)`;

  // 4. Write (unless dry run).
  if (DRY_RUN) {
    console.log('DRY_RUN active -> nothing written to Notion.');
    console.log('DRY_RUN would post comment:', commentText);
    return;
  }
  await notionPatchNumbers(PAGE_ID, values);
  console.log(`[${new Date().toISOString()}] Notion page ${PAGE_ID} properties updated OK.`);

  // 5. Audit comment. Non-fatal: the KPI write already succeeded, so a comment
  //    failure (e.g. integration lacks comment capability) must not fail the run.
  try {
    await notionAddComment(PAGE_ID, commentText);
    console.log('Audit comment posted.');
  } catch (err) {
    console.warn('Comment post failed (KPI write still succeeded):', err instanceof Error ? err.message : err);
  }
}

main().catch((err: unknown) => {
  console.error('SYNC FAILED (no partial write beyond fields already sent):', err instanceof Error ? err.message : err);
  process.exit(1);
});
