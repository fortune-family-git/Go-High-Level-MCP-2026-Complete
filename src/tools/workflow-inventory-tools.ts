/**
 * Workflow Inventory Tool (Fortune Family)
 *
 * One read-only call that returns every workflow with its triggers, a compact
 * view of its actions, and lookup tables (forms, calendars, surveys, custom
 * fields, users, links, pipelines, products) to resolve IDs to names.
 *
 * Used by the monthly workflow documentation run. Never writes anything.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { WorkflowBuilderClient } from '../clients/workflow-builder-client.js';

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const KEEP_ATTRS = [
  'tags', 'workflow_id', 'fields', 'pipeline_id', 'pipelineId', 'pipeline_stage_id', 'url', 'method',
  'spreadsheet', 'account', 'channel', 'user_list', 'updateField', 'selectField', 'calendarId',
  'subject', 'title', 'groupId', 'offer_id', 'operators', 'value', 'database_id', 'templateId',
  'dnd_direction', 'dnd_contact', 'action', 'integration',
];

const PUBLIC_API = 'https://services.leadconnectorhq.com';

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

function compactAction(a: any): Record<string, unknown> {
  const at = (a && a.attributes) || {};
  const o: Record<string, unknown> = { t: a.type };
  if (a.name) o.n = a.name;
  const picked: Record<string, unknown> = {};
  for (const k of KEEP_ATTRS) {
    const v = at[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v) picked[k] = (v as any).name;
    else if (k === 'fields' && Array.isArray(v)) picked[k] = v.map((f: any) => ({ field: f.field, title: f.title }));
    else picked[k] = v;
  }
  if (Object.keys(picked).length) o.a = picked;
  return o;
}

function compactTrigger(t: any): Record<string, unknown> {
  return {
    name: t.name,
    type: t.type,
    active: t.active !== false,
    conditions: (t.conditions || []).map((c: any) => ({ field: c.field, operator: c.operator, value: c.value })),
  };
}

export class WorkflowInventoryTools {
  private client: WorkflowBuilderClient | null = null;
  private initError: string | null = null;

  constructor() {
    try {
      this.client = WorkflowBuilderClient.fromEnv();
    } catch (err: any) {
      this.initError = err.message;
    }
  }

  getTools(): Tool[] {
    return [
      {
        name: 'ghl_workflow_inventory',
        description:
          'Read-only. Returns all workflows of the location with triggers (from the internal trigger API), ' +
          'a compact list of actions per workflow, and lookup tables to resolve IDs (forms, calendars, calendar groups, ' +
          'surveys, custom fields, users, trigger links, pipelines, products). Use for documentation and audits. ' +
          'Large output; use offset/limit to page through workflows (lookups are only included when offset is 0).',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['published', 'draft', 'all'], description: 'Workflow status filter (default published)' },
            offset: { type: 'number', description: 'Workflow offset for paging (default 0)' },
            limit: { type: 'number', description: 'Max workflows to return (default all)' },
          },
        },
      },
    ];
  }

  private async publicGet(path: string, version = '2021-07-28'): Promise<any> {
    const key = process.env.GHL_API_KEY || '';
    try {
      const res = await fetch(`${PUBLIC_API}${path}`, {
        headers: { Authorization: `Bearer ${key}`, Version: version, Accept: 'application/json' },
      });
      if (!res.ok) return { __error: `${res.status} ${path}` };
      return await res.json();
    } catch (err: any) {
      return { __error: `${err.message} ${path}` };
    }
  }

  private async pagedPublic(path: string, listKey: string, pageSize = 50): Promise<any[]> {
    const all: any[] = [];
    for (let skip = 0; skip < 2000; skip += pageSize) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await this.publicGet(`${path}${sep}limit=${pageSize}&skip=${skip}`);
      const rows = (r && (r[listKey] || (r.data && r.data[listKey]))) || [];
      all.push(...rows);
      if (rows.length < pageSize) break;
    }
    return all;
  }

  private async lookups(locationId: string): Promise<Record<string, Record<string, string>>> {
    const pick = (rows: any[], name = 'name') =>
      Object.fromEntries((rows || []).filter((r) => r && r.id).map((r) => [r.id, r[name] ?? '']));
    const [forms, surveys, calendars, groups, fields, users, links, pipelines, products] = await Promise.all([
      this.pagedPublic(`/forms/?locationId=${locationId}`, 'forms'),
      this.pagedPublic(`/surveys/?locationId=${locationId}`, 'surveys'),
      this.publicGet(`/calendars/?locationId=${locationId}`, '2021-04-15'),
      this.publicGet(`/calendars/groups?locationId=${locationId}`, '2021-04-15'),
      this.publicGet(`/locations/${locationId}/customFields`),
      this.publicGet(`/users/?locationId=${locationId}`),
      this.publicGet(`/links/?locationId=${locationId}`),
      this.publicGet(`/opportunities/pipelines?locationId=${locationId}`),
      this.publicGet(`/products/?locationId=${locationId}&limit=500`),
    ]);
    const stages: Record<string, string> = {};
    for (const p of pipelines?.pipelines || []) for (const s of p.stages || []) stages[s.id] = `${p.name} / ${s.name}`;
    const errors = [calendars, groups, fields, users, links, pipelines, products]
      .filter((x) => x && x.__error).map((x) => x.__error);
    return {
      forms: pick(forms),
      surveys: pick(surveys),
      calendars: pick(calendars?.calendars),
      calendarGroups: pick(groups?.groups),
      customFields: pick(fields?.customFields),
      users: pick(users?.users),
      links: pick(links?.links),
      pipelines: pick(pipelines?.pipelines),
      pipelineStages: stages,
      products: Object.fromEntries((products?.products || []).map((p: any) => [p._id || p.id, p.name])),
      ...(errors.length ? { _errors: Object.fromEntries(errors.map((e: string, i: number) => [String(i), e])) } : {}),
    };
  }

  async executeInventoryTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    if (name !== 'ghl_workflow_inventory') return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
    if (!this.client) {
      return { content: [{ type: 'text', text: `Workflow builder not initialized: ${this.initError}` }], isError: true };
    }
    const status = (params.status as string) || 'published';
    const offset = Number(params.offset ?? 0);
    const limit = params.limit !== undefined ? Number(params.limit) : Infinity;
    const locationId = this.client.getLocationId();

    const listed: any[] = [];
    for (let off = 0; off < 5000; off += 100) {
      const page = await this.client.listWorkflows({ limit: 100, offset: off });
      listed.push(...(page.rows || []));
      if (!page.rows || page.rows.length < 100) break;
    }
    const filtered = listed
      .filter((w) => status === 'all' || w.status === status)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const slice = filtered.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);

    const errors: Record<string, string> = {};
    const workflows = await mapLimit(slice, 6, async (w: any) => {
      const id = w._id || w.id;
      let actions: any[] = [];
      let triggers: any[] = [];
      try {
        const full = await this.client!.getWorkflow(id);
        actions = (full.workflowData?.templates || []).filter((a: any) => a.type !== 'transition').map(compactAction);
      } catch (err: any) { errors[id] = `actions: ${err.message}`; }
      try {
        triggers = (await this.client!.getWorkflowTriggers(id)).filter((t: any) => !t.deleted).map(compactTrigger);
      } catch (err: any) { errors[id] = `${errors[id] ? errors[id] + '; ' : ''}triggers: ${err.message}`; }
      return {
        id, name: w.name, status: w.status, version: w.version,
        createdAt: w.createdAt, updatedAt: w.updatedAt, triggers, actions,
      };
    });

    const result: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      locationId,
      statusFilter: status,
      total: filtered.length,
      totalAllStatuses: listed.length,
      offset,
      count: workflows.length,
      workflows,
    };
    if (Object.keys(errors).length) result.errors = errors;
    if (offset === 0) result.lookups = await this.lookups(locationId);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
}
