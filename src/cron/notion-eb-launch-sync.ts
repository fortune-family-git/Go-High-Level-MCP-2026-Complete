/**
 * Daily GHL -> Notion KPI sync for the "2026-09 EB-Launch" record (ExpertenBusiness).
 *
 * Writes to the Notion page in the "Promotions" database, all from ONE source:
 * the stage every opportunity of the GHL pipeline "26-08 Experten Business Workshop"
 * currently sits in.
 *
 *   Anmeldungen, Verkäufe                        -> stage lists
 *   CC gebucht / CC geführt                      -> stage lists ("ever booked / ever held")
 *   SC gebucht / SC geführt                      -> stage lists   (Notion "SC" == GHL "KG")
 *   Follow-Up gebucht                            -> stage list
 *   Follow-Up geführt                            -> NOT written, see below
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

  // FU: only the two FU stages prove a follow-up was booked. Anyone who had an FU and then
  // moved on to Zusage/Kauf is indistinguishable from someone who got there straight from
  // the KG, so this is a floor, not a total.
  fuGebucht: [S.fuGebucht, S.fuNoShow],
};

/**
 * "Follow-Up geführt" is deliberately NOT written: the board has no stage meaning "FU held"
 * (there is `fuGebucht` and `fuNoShow`, but nothing behind them), so there is nothing to
 * derive it from. Leaving it to manual upkeep is correct; inventing a value would feed the
 * "No-Show FU" formula a number nobody can check. If it should be automatic, the board
 * needs an "FU geführt" stage — then add it here.
 */
const NOTION_FIELDS = {
  anmeldungen: 'Anmeldungen',
  verkaeufe: 'Verkäufe',
  ccGebucht: 'CC gebucht',
  ccGefuehrt: 'CC geführt',
  scGebucht: 'SC gebucht',
  scGefuehrt: 'SC geführt',
  fuGebucht: 'Follow-Up gebucht',
} as const;

/** Metrics written with plain overwrite; everything else uses the never-decrease rule. */
const OVERWRITE_METRICS = new Set<string>(['anmeldungen', 'verkaeufe']);

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
function distinctContacts(opps: Opp[], stageIds: string[]): number {
  const wanted = new Set(stageIds);
  const contacts = new Set<string>();
  for (const o of opps) {
    if (!o.contactId || !o.pipelineStageId) continue;
    if (wanted.has(o.pipelineStageId)) contacts.add(o.contactId);
  }
  return contacts.size;
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

  // 3. Metrics.
  const computed: Record<string, number> = {};
  for (const [metric, stageIds] of Object.entries(METRICS)) {
    computed[metric] = distinctContacts(opps, stageIds);
  }

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
  console.log('  Follow-Up geführt  = nicht geschrieben (keine Stage dafür, manuell gepflegt)');
  console.log('  (No-Show + Conversion sind Notion-Formeln und werden dort berechnet.)');

  const commentText =
    `🔄 Railway-Sync EB ${berlinTimestamp()} — ` +
    `Anmeldungen ${values['Anmeldungen']} · Verkäufe ${values['Verkäufe']} · ` +
    `CC ${values['CC gebucht']}/${values['CC geführt']} · SC ${values['SC gebucht']}/${values['SC geführt']} · ` +
    `FU gebucht ${values['Follow-Up gebucht']}`;

  if (DRY_RUN) {
    console.log('DRY_RUN active -> nothing written to Notion.');
    console.log('DRY_RUN would post comment:', commentText);
    return;
  }
  await notionPatchNumbers(PAGE_ID, values);
  console.log(`[${new Date().toISOString()}] Notion page ${PAGE_ID} properties updated OK.`);

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
