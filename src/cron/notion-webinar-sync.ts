/**
 * Daily GHL -> Notion KPI sync for the "MA Webinar Juli 2026" record.
 *
 * Reads exact per-stage opportunity counts from the GHL pipeline
 * "MA LiveWebinar_072026" and writes five KPI fields to the Notion page in the
 * "Promotions" database. Read-only against GHL; writes only 5 Notion fields.
 *
 * Run:      node dist/cron/notion-webinar-sync.js
 * Schedule: Railway cron "0 20 * * *" with service TZ=Europe/Berlin
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

const PIPELINE_ID = '4jGCaouIb52BEEEba5id';
const PAGE_ID = '384828f7-cb43-8116-bcdf-e752d808c869';

// Stage IDs of pipeline MA LiveWebinar_072026 (hard-coded so a stage *rename* in
// GHL never breaks the mapping; only a stage *deletion* would, which we surface).
const STAGE = {
  landingpage: '402e2603-34ed-4f9e-b407-96847d86ae7c',
  ccGebucht: '93d561cc-5eba-41a4-955d-6bd2ae6dd789',
  kgGebucht: 'a78c6af6-549c-42cd-8204-9748dd828a62',
  fuGebucht: 'cc868107-b48f-46df-bb7f-95eb6ae3998f',
  // "Kauf" wurde in zwei Stages gesplittet -> Verkäufe = Summe beider.
  kaufVoll: 'e048ff58-0cc1-4deb-96c2-75783c9fee32',
  kaufRaten: 'f0c43ad3-0df4-4821-8e46-0b7f440346c9',
};

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

  // 1. Pull exact GHL counts (parallel).
  const [total, landingpage, ccStage, kgStage, fuStage, kaufVoll, kaufRaten] = await Promise.all([
    ghlStageTotal(''),
    ghlStageTotal(STAGE.landingpage),
    ghlStageTotal(STAGE.ccGebucht),
    ghlStageTotal(STAGE.kgGebucht),
    ghlStageTotal(STAGE.fuGebucht),
    ghlStageTotal(STAGE.kaufVoll),
    ghlStageTotal(STAGE.kaufRaten),
  ]);
  const kauf = kaufVoll + kaufRaten;
  console.log(`GHL counts: total=${total} landingpage=${landingpage} CC=${ccStage} KG=${kgStage} FU=${fuStage} Kauf=${kauf} (Voll ${kaufVoll} + Raten ${kaufRaten})`);

  // 2. Read current Notion values (needed for the never-decrease max-rule).
  const cur = await notionGetNumbers(PAGE_ID, ['CC gebucht', 'SC gebucht', 'Follow-Up gebucht']);

  // 3. Compute the five target values.
  const values: Record<string, number> = {
    Anmeldungen: total - landingpage,
    'CC gebucht': Math.max(ccStage, cur['CC gebucht']),
    'SC gebucht': Math.max(kgStage, cur['SC gebucht']),
    'Follow-Up gebucht': Math.max(fuStage, cur['Follow-Up gebucht']),
    'Verkäufe': kauf,
  };

  console.log('Field mapping:');
  console.log(`  Anmeldungen       = ${total} - ${landingpage} = ${values['Anmeldungen']}  (overwrite)`);
  console.log(`  CC gebucht        = max(GHL ${ccStage}, Notion ${cur['CC gebucht']}) = ${values['CC gebucht']}  (never-decrease)`);
  console.log(`  SC gebucht        = max(GHL KG ${kgStage}, Notion ${cur['SC gebucht']}) = ${values['SC gebucht']}  (never-decrease)`);
  console.log(`  Follow-Up gebucht = max(GHL FU ${fuStage}, Notion ${cur['Follow-Up gebucht']}) = ${values['Follow-Up gebucht']}  (never-decrease)`);
  console.log(`  Verkäufe          = GHL Kauf ${kauf} = ${values['Verkäufe']}  (overwrite)`);

  const commentText =
    `🔄 Railway-Sync ${berlinTimestamp()} — ` +
    `Anmeldungen ${values['Anmeldungen']} · CC gebucht ${values['CC gebucht']} · ` +
    `SC gebucht ${values['SC gebucht']} · Follow-Up gebucht ${values['Follow-Up gebucht']} · ` +
    `Verkäufe ${values['Verkäufe']}`;

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
