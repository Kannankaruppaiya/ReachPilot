import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { withWorkspace } from '@/db/rls';

/** One node from the campaign builder (a linear sequence, waits + one branch). */
type BuilderNode = {
  kind: 'invite' | 'message' | 'email' | 'view' | 'follow' | 'wait' | 'branch';
  days?: number; // wait nodes
  body?: string;
  subject?: string;
  condition?: string; // branch nodes (condition_type)
  elseAction?: { kind: 'email' | 'message'; body?: string; subject?: string };
};

type CreateDto = {
  name: string;
  dailyCap?: number;
  steps?: BuilderNode[];
  leadIds?: string[];
  launch?: boolean;
};

/** Builder node kind → durable action_type. */
const NODE_ACTION: Record<string, string> = {
  invite: 'connect_request',
  message: 'linkedin_message',
  email: 'send_email',
  view: 'visit_profile',
  follow: 'follow',
};

/** A compiled step with links expressed as indices into the compiled array. */
type Compiled = {
  kind: 'action' | 'condition';
  action: string | null;
  condition: string | null;
  delay_hours: number;
  params: Record<string, unknown>;
  next: number | null;
  onTrue: number | null;
  onFalse: number | null;
};

const statusToApi = (s: string): string =>
  s === 'paused' ? 'Paused' : s === 'active' ? 'Active' : s === 'archived' ? 'Archived' : 'Draft';

const statusToDb = (s: string): string => {
  const m: Record<string, string> = {
    Active: 'active',
    Paused: 'paused',
    Draft: 'draft',
    Archived: 'archived',
    active: 'active',
    paused: 'paused',
    draft: 'draft',
    archived: 'archived',
  };
  return m[s] || 'paused';
};

@Injectable()
export class CampaignsService {
  // ── Reads ────────────────────────────────────────────────────────────────

  async list(workspaceId: string): Promise<any[]> {
    return withWorkspace(workspaceId, async (db) => {
      const rows = await db
        .selectFrom('campaigns')
        .leftJoin('campaign_stats', 'campaign_stats.campaign_id', 'campaigns.id')
        .select([
          'campaigns.id',
          'campaigns.name',
          'campaigns.status',
          'campaigns.daily_cap',
          'campaigns.created_at',
          'campaign_stats.leads',
          'campaign_stats.sent',
          'campaign_stats.accepted_pct',
          'campaign_stats.replied_pct',
        ])
        .where('campaigns.workspace_id', '=', workspaceId)
        .orderBy('campaigns.created_at', 'desc')
        .execute();

      const trends = await this.trendsByCampaign(db, workspaceId);

      return rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        status: statusToApi(r.status),
        leads: Number(r.leads || 0),
        sent: Number(r.sent || 0),
        acceptedPct: Number(r.accepted_pct || 0),
        repliedPct: Number(r.replied_pct || 0),
        dailyCap: Number(r.daily_cap || 15),
        trend: trends.get(r.id) || [],
        createdAt: r.created_at,
      }));
    });
  }

  async get(workspaceId: string, id: string): Promise<any> {
    return withWorkspace(workspaceId, async (db) => {
      const c = await db
        .selectFrom('campaigns')
        .leftJoin('campaign_stats', 'campaign_stats.campaign_id', 'campaigns.id')
        .select([
          'campaigns.id',
          'campaigns.name',
          'campaigns.status',
          'campaigns.daily_cap',
          'campaigns.entry_step_id',
          'campaigns.created_at',
          'campaign_stats.leads',
          'campaign_stats.sent',
          'campaign_stats.accepted_pct',
          'campaign_stats.replied_pct',
        ])
        .where('campaigns.workspace_id', '=', workspaceId)
        .where('campaigns.id', '=', id)
        .executeTakeFirst();

      if (!c) throw new NotFoundException('Campaign not found.');

      const stepRows = await db
        .selectFrom('campaign_steps')
        .selectAll()
        .where('campaign_id', '=', id)
        .execute();
      const steps = this.orderSteps(stepRows, (c as any).entry_step_id);
      const builderNodes = this.decompile(stepRows, (c as any).entry_step_id);

      const enrolled = await db
        .selectFrom('enrollments')
        .innerJoin('leads', 'leads.id', 'enrollments.lead_id')
        .select([
          'enrollments.id as enrollmentId',
          'enrollments.status as enrollmentStatus',
          'enrollments.current_step_id as currentStepId',
          'enrollments.next_run_at as nextRunAt',
          'leads.id as leadId',
          'leads.full_name as name',
          'leads.title as title',
          'leads.company as company',
          'leads.status as leadStatus',
        ])
        .where('enrollments.campaign_id', '=', id)
        .orderBy('enrollments.enrolled_at', 'desc')
        .execute();

      const trends = await this.trendsByCampaign(db, workspaceId, id);

      const sent = Number((c as any).sent || 0);
      const acceptedPct = Number((c as any).accepted_pct || 0);
      const repliedPct = Number((c as any).replied_pct || 0);

      return {
        id: (c as any).id,
        name: (c as any).name,
        status: statusToApi((c as any).status),
        dailyCap: Number((c as any).daily_cap || 15),
        leads: Number((c as any).leads || 0),
        sent,
        acceptedPct,
        repliedPct,
        trend: trends.get(id) || [],
        createdAt: (c as any).created_at,
        steps,
        builderNodes,
        enrollments: enrolled.map((e: any) => ({
          enrollmentId: e.enrollmentId,
          enrollmentStatus: e.enrollmentStatus,
          leadId: e.leadId,
          name: e.name,
          title: e.title,
          company: e.company,
          leadStatus: e.leadStatus,
          nextRunAt: e.nextRunAt,
        })),
      };
    });
  }

  /** Order a campaign's steps by walking the chain from the entry step. */
  private orderSteps(rows: any[], entryId: string | null): any[] {
    const byId = new Map<string, any>(rows.map((r) => [r.id, r]));
    const ordered: any[] = [];
    const seen = new Set<string>();
    let cur = entryId;
    while (cur && byId.has(cur) && !seen.has(cur)) {
      const s = byId.get(cur);
      seen.add(cur);
      ordered.push(this.mapStep(s));
      cur = s.kind === 'condition' ? s.on_true_step_id : s.next_step_id;
    }
    // Append any orphan/branch steps not on the main line (e.g. else-fallback).
    for (const r of rows) if (!seen.has(r.id)) ordered.push(this.mapStep(r));
    return ordered;
  }

  private mapStep(s: any) {
    const params = (typeof s.params === 'string' ? JSON.parse(s.params) : s.params) || {};
    return {
      id: s.id,
      kind: s.kind,
      action: s.action,
      condition: s.condition,
      delayHours: Number(s.delay_hours || 0),
      body: params.body || '',
      subject: params.subject || '',
    };
  }

  /**
   * Per-campaign send trend (last 14 days, count of 'sent' jobs per day). One
   * query grouped by campaign+day, returned as a map of campaignId → number[].
   */
  private async trendsByCampaign(
    db: any,
    workspaceId: string,
    campaignId?: string,
  ): Promise<Map<string, number[]>> {
    const DAYS = 14;
    const since = new Date();
    since.setDate(since.getDate() - (DAYS - 1));
    since.setHours(0, 0, 0, 0);

    let q = db
      .selectFrom('jobs')
      .select((eb: any) => [
        'campaign_id',
        eb.fn('count', ['id']).as('n'),
        eb.fn('to_char', [eb.ref('sent_at'), eb.val('YYYY-MM-DD')]).as('day'),
      ])
      .where('workspace_id', '=', workspaceId)
      .where('campaign_id', 'is not', null)
      .where('status', '=', 'sent')
      .where('sent_at', '>=', since.toISOString() as any)
      .groupBy(['campaign_id', 'day']);
    if (campaignId) q = q.where('campaign_id', '=', campaignId);

    const rows = await q.execute();

    // Build the day axis.
    const axis: string[] = [];
    for (let i = 0; i < DAYS; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      axis.push(d.toISOString().slice(0, 10));
    }
    const out = new Map<string, number[]>();
    for (const r of rows) {
      const cid = r.campaign_id as string;
      if (!out.has(cid)) out.set(cid, new Array(DAYS).fill(0));
      const idx = axis.indexOf(r.day as string);
      if (idx >= 0) out.get(cid)![idx] = Number(r.n || 0);
    }
    return out;
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async create(workspaceId: string, dto: CreateDto): Promise<any> {
    const name = (dto.name || '').trim();
    if (!name) throw new BadRequestException('Campaign name is required.');

    const campaign = await withWorkspace(workspaceId, async (db) => {
      const linkedinAcct = await db
        .selectFrom('linkedin_accounts')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .limit(1)
        .executeTakeFirst();
      const emailAcct = await db
        .selectFrom('email_accounts')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .limit(1)
        .executeTakeFirst();

      const created = await db
        .insertInto('campaigns')
        .values({
          workspace_id: workspaceId,
          name,
          status: dto.launch ? 'active' : 'draft',
          daily_cap: dto.dailyCap || 15,
          linkedin_account_id: linkedinAcct?.id || null,
          email_account_id: emailAcct?.id || null,
        })
        .returning(['id', 'name', 'status', 'daily_cap', 'created_at'])
        .executeTakeFirstOrThrow();

      const entryStepId = await this.persistSteps(db, created.id, dto.steps || []);

      await db
        .insertInto('activity')
        .values({ workspace_id: workspaceId, text: `Campaign "${created.name}" created`, tone: 'accent' })
        .execute();

      return { ...created, entry_step_id: entryStepId };
    });

    // Enroll the chosen audience, then (if launching) kick the enrollments so the
    // runner picks them up on its next tick.
    if (dto.leadIds?.length && campaign.entry_step_id) {
      await this.enroll(workspaceId, campaign.id, dto.leadIds, dto.launch ? 'active' : 'paused');
    }

    return {
      id: campaign.id,
      name: campaign.name,
      status: statusToApi(campaign.status),
      dailyCap: Number(campaign.daily_cap || 15),
      leads: dto.leadIds?.length || 0,
      sent: 0,
      acceptedPct: 0,
      repliedPct: 0,
      trend: [] as number[],
      createdAt: campaign.created_at,
    };
  }

  /**
   * Compile a linear builder node list into campaign_steps:
   *   - `wait` nodes fold their days into the delay_hours of the NEXT real step.
   *   - a `branch` becomes a condition step: on_true continues the main line, and
   *     an optional else-action becomes a one-shot fallback step (on_false).
   */
  private compile(nodes: BuilderNode[]): { list: Compiled[]; entry: number } {
    const list: Compiled[] = [];
    const primary: number[] = [];
    let pendingDelay = 0;

    for (const node of nodes) {
      if (node.kind === 'wait') {
        pendingDelay += Math.round((Number(node.days) || 0) * 24);
        continue;
      }
      const idx = list.length;
      if (node.kind === 'branch') {
        list.push({
          kind: 'condition',
          action: null,
          condition: node.condition || 'if_connected',
          delay_hours: pendingDelay,
          params: {},
          next: null,
          onTrue: null,
          onFalse: null,
        });
        primary.push(idx);
        pendingDelay = 0;
        if (node.elseAction) {
          const fIdx = list.length;
          list.push({
            kind: 'action',
            action: node.elseAction.kind === 'email' ? 'send_email' : 'linkedin_message',
            condition: null,
            delay_hours: 0,
            params: { body: node.elseAction.body || '', subject: node.elseAction.subject || '' },
            next: null,
            onTrue: null,
            onFalse: null,
          });
          list[idx].onFalse = fIdx;
        }
      } else {
        const action = NODE_ACTION[node.kind];
        if (!action) continue;
        list.push({
          kind: 'action',
          action,
          condition: null,
          delay_hours: pendingDelay,
          params: { body: node.body || '', subject: node.subject || '' },
          next: null,
          onTrue: null,
          onFalse: null,
        });
        primary.push(idx);
        pendingDelay = 0;
      }
    }

    // Link the main line: each primary step points at the next primary step.
    for (let p = 0; p < primary.length; p++) {
      const idx = primary[p];
      const nextIdx = p + 1 < primary.length ? primary[p + 1] : null;
      if (list[idx].kind === 'condition') list[idx].onTrue = nextIdx;
      else list[idx].next = nextIdx;
    }

    return { list, entry: primary.length ? primary[0] : 0 };
  }

  /**
   * Replace a campaign's whole sequence: drop the existing steps, recompile the
   * builder nodes, insert + wire the links, and set the entry step. Shared by
   * create and update (editing). Returns the new entry step id (or null).
   */
  private async persistSteps(db: any, campaignId: string, nodes: BuilderNode[]): Promise<string | null> {
    // FK campaign_steps.* and campaigns.entry_step_id are ON DELETE SET NULL, so
    // dropping the rows detaches enrollments/entry safely.
    await db.deleteFrom('campaign_steps').where('campaign_id', '=', campaignId).execute();

    const compiled = this.compile(nodes);
    if (!compiled.list.length) {
      await db.updateTable('campaigns').set({ entry_step_id: null }).where('id', '=', campaignId).execute();
      return null;
    }

    const ids: string[] = [];
    for (const s of compiled.list) {
      const row = await db
        .insertInto('campaign_steps')
        .values({
          campaign_id: campaignId,
          kind: s.kind as any,
          action: (s.action as any) || null,
          condition: (s.condition as any) || null,
          params: JSON.stringify(s.params),
          delay_hours: s.delay_hours,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids.push(row.id);
    }
    for (let i = 0; i < compiled.list.length; i++) {
      const s = compiled.list[i];
      await db
        .updateTable('campaign_steps')
        .set({
          next_step_id: s.next !== null ? ids[s.next] : null,
          on_true_step_id: s.onTrue !== null ? ids[s.onTrue] : null,
          on_false_step_id: s.onFalse !== null ? ids[s.onFalse] : null,
        })
        .where('id', '=', ids[i])
        .execute();
    }
    const entryStepId = ids[compiled.entry];
    await db.updateTable('campaigns').set({ entry_step_id: entryStepId }).where('id', '=', campaignId).execute();
    return entryStepId;
  }

  /**
   * Turn a persisted step graph back into linear builder nodes so the UI can edit
   * an existing campaign. Inverse of compile(): delays become wait nodes, and a
   * condition's on_false fallback step collapses back into the branch's elseAction.
   */
  private decompile(stepRows: any[], entryStepId: string | null): BuilderNode[] {
    const byId = new Map<string, any>(stepRows.map((r) => [r.id, r]));
    const REVERSE: Record<string, BuilderNode['kind']> = {
      visit_profile: 'view',
      connect_request: 'invite',
      linkedin_message: 'message',
      send_email: 'email',
      follow: 'follow',
    };
    const nodes: BuilderNode[] = [];
    const seen = new Set<string>();
    // Steps reached only as a branch's on_false fallback — don't emit them twice.
    const fallbackIds = new Set(
      stepRows.filter((r) => r.kind === 'condition' && r.on_false_step_id).map((r) => r.on_false_step_id),
    );
    const paramsOf = (s: any) => (typeof s.params === 'string' ? JSON.parse(s.params || '{}') : s.params || {});

    let cur = entryStepId;
    while (cur && byId.has(cur) && !seen.has(cur)) {
      const s = byId.get(cur);
      seen.add(cur);
      const delayHours = Number(s.delay_hours || 0);
      if (delayHours > 0) nodes.push({ kind: 'wait', days: Math.round(delayHours / 24) });

      if (s.kind === 'condition') {
        const branch: BuilderNode = { kind: 'branch', condition: s.condition || 'if_connected' };
        const fb = s.on_false_step_id ? byId.get(s.on_false_step_id) : null;
        if (fb) {
          const p = paramsOf(fb);
          branch.elseAction = {
            kind: fb.action === 'send_email' ? 'email' : 'message',
            body: p.body || '',
            subject: p.subject || '',
          };
        }
        nodes.push(branch);
        cur = s.on_true_step_id;
      } else {
        const kind = REVERSE[s.action || ''];
        if (kind) {
          const p = paramsOf(s);
          const node: BuilderNode = { kind };
          if (kind === 'email') node.subject = p.subject || '';
          if (p.body) node.body = p.body;
          nodes.push(node);
        }
        cur = s.next_step_id;
      }
    }
    // Safety: nothing should be left, but never drop a real step silently.
    for (const r of stepRows) {
      if (seen.has(r.id) || fallbackIds.has(r.id)) continue;
      const kind = r.kind === 'condition' ? 'branch' : REVERSE[r.action || ''];
      if (kind) nodes.push({ kind } as BuilderNode);
    }
    return nodes;
  }

  /** Enroll leads at the campaign's entry step (idempotent per campaign+lead). */
  async enroll(
    workspaceId: string,
    campaignId: string,
    leadIds: string[],
    initialStatus: 'active' | 'paused' = 'active',
  ): Promise<{ enrolled: number }> {
    if (!leadIds?.length) return { enrolled: 0 };
    return withWorkspace(workspaceId, async (db) => {
      const campaign = await db
        .selectFrom('campaigns')
        .select(['entry_step_id'])
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', campaignId)
        .executeTakeFirst();
      if (!campaign) throw new NotFoundException('Campaign not found.');
      if (!campaign.entry_step_id)
        throw new BadRequestException('Campaign has no sequence to enroll into.');

      const nowIso = new Date().toISOString();
      let enrolled = 0;
      for (const leadId of leadIds) {
        const res = await db
          .insertInto('enrollments')
          .values({
            workspace_id: workspaceId,
            campaign_id: campaignId,
            lead_id: leadId,
            current_step_id: campaign.entry_step_id,
            status: initialStatus,
            step_entered_at: nowIso as any,
            next_run_at: initialStatus === 'active' ? (nowIso as any) : null,
          })
          .onConflict((oc: any) =>
            oc.columns(['campaign_id', 'lead_id']).doUpdateSet({
              status: initialStatus,
              current_step_id: campaign.entry_step_id,
              step_entered_at: nowIso as any,
              next_run_at: initialStatus === 'active' ? (nowIso as any) : null,
              finished_at: null,
            }),
          )
          .execute();
        enrolled += Number((res as any)[0]?.numInsertedOrUpdatedRows ?? 1);
      }
      await db
        .insertInto('activity')
        .values({ workspace_id: workspaceId, text: `${leadIds.length} lead(s) enrolled`, tone: 'accent' })
        .execute();
      return { enrolled: leadIds.length };
    });
  }

  /** Set a campaign live: status→active and (re)activate its enrollments. */
  async launch(workspaceId: string, id: string): Promise<any> {
    await withWorkspace(workspaceId, async (db) => {
      const campaign = await db
        .selectFrom('campaigns')
        .select(['entry_step_id'])
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!campaign) throw new NotFoundException('Campaign not found.');
      if (!campaign.entry_step_id)
        throw new BadRequestException('Add at least one step before launching.');

      await db.updateTable('campaigns').set({ status: 'active' }).where('id', '=', id).execute();
      // Wake any parked/paused enrollments so the runner drives them this tick.
      await db
        .updateTable('enrollments')
        .set({ status: 'active', next_run_at: new Date().toISOString() as any })
        .where('campaign_id', '=', id)
        .where('status', 'in', ['paused', 'waiting'] as any)
        .execute();
      await db
        .insertInto('activity')
        .values({ workspace_id: workspaceId, text: 'Campaign launched', tone: 'success' })
        .execute();
    });
    return this.get(workspaceId, id);
  }

  async update(workspaceId: string, id: string, data: any): Promise<any> {
    return withWorkspace(workspaceId, async (db) => {
      const campaign = await db
        .selectFrom('campaigns')
        .selectAll()
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!campaign) throw new NotFoundException('Campaign not found.');

      const updates: Record<string, any> = {};
      if (data.name !== undefined) updates.name = String(data.name).trim();
      if (data.status !== undefined) updates.status = statusToDb(data.status);
      if (data.dailyCap !== undefined) updates.daily_cap = Number(data.dailyCap);

      if (Object.keys(updates).length > 0) {
        await db.updateTable('campaigns').set(updates).where('id', '=', id).execute();

        // Pausing a campaign parks its live enrollments; resuming wakes them.
        if (updates.status === 'paused') {
          await db
            .updateTable('enrollments')
            .set({ status: 'paused' })
            .where('campaign_id', '=', id)
            .where('status', 'in', ['active', 'waiting'] as any)
            .execute();
        } else if (updates.status === 'active') {
          await db
            .updateTable('enrollments')
            .set({ status: 'active', next_run_at: new Date().toISOString() as any })
            .where('campaign_id', '=', id)
            .where('status', '=', 'paused')
            .execute();
        }
      }

      // Editing the sequence: rebuild steps and restart enrolled leads from the
      // new entry (their old step is gone). Cancel pending jobs so a stale-step
      // job never fires.
      if (Array.isArray(data.steps)) {
        const newEntry = await this.persistSteps(db, id, data.steps);
        await db
          .updateTable('jobs')
          .set({ status: 'canceled', last_error: 'sequence_edited' })
          .where('campaign_id', '=', id)
          .where('status', 'in', ['scheduled', 'queued', 'running'] as any)
          .execute();
        const nowIso = new Date().toISOString();
        const activeCampaign = (updates.status || campaign.status) === 'active';
        if (newEntry) {
          await db
            .updateTable('enrollments')
            .set({
              current_step_id: newEntry,
              status: activeCampaign ? 'active' : 'paused',
              step_entered_at: nowIso as any,
              next_run_at: activeCampaign ? (nowIso as any) : null,
              finished_at: null,
            })
            .where('campaign_id', '=', id)
            .where('status', '!=', 'stopped')
            .execute();
        }
        await db
          .insertInto('activity')
          .values({ workspace_id: workspaceId, text: 'Campaign sequence updated', tone: 'accent' })
          .execute();
      }

      const stats = await db
        .selectFrom('campaign_stats')
        .selectAll()
        .where('campaign_id', '=', id)
        .executeTakeFirst();
      const updated = await db
        .selectFrom('campaigns')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      return {
        id: updated.id,
        name: updated.name,
        status: statusToApi(updated.status as string),
        dailyCap: Number(updated.daily_cap || 15),
        leads: Number(stats?.leads || 0),
        sent: Number(stats?.sent || 0),
        acceptedPct: Number(stats?.accepted_pct || 0),
        repliedPct: Number(stats?.replied_pct || 0),
        trend: [] as number[],
      };
    });
  }

  /** Delete a campaign (cascades steps + enrollments) after cancelling its jobs. */
  async remove(workspaceId: string, id: string): Promise<{ deleted: boolean }> {
    return withWorkspace(workspaceId, async (db) => {
      const campaign = await db
        .selectFrom('campaigns')
        .select(['id', 'name'])
        .where('workspace_id', '=', workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!campaign) throw new NotFoundException('Campaign not found.');

      await db
        .updateTable('jobs')
        .set({ status: 'canceled', last_error: 'campaign_deleted' })
        .where('campaign_id', '=', id)
        .where('status', 'in', ['scheduled', 'queued', 'running'] as any)
        .execute();
      await db.deleteFrom('campaigns').where('id', '=', id).execute();
      await db
        .insertInto('activity')
        .values({ workspace_id: workspaceId, text: `Campaign "${campaign.name}" deleted`, tone: 'muted' })
        .execute();
      return { deleted: true };
    });
  }

  /** Pause or resume a single enrolled lead without touching the rest. */
  async setEnrollmentStatus(
    workspaceId: string,
    campaignId: string,
    enrollmentId: string,
    action: 'pause' | 'resume',
  ): Promise<{ ok: true }> {
    return withWorkspace(workspaceId, async (db) => {
      const enr = await db
        .selectFrom('enrollments')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('campaign_id', '=', campaignId)
        .where('id', '=', enrollmentId)
        .executeTakeFirst();
      if (!enr) throw new NotFoundException('Enrollment not found.');

      if (action === 'pause') {
        await db.updateTable('enrollments').set({ status: 'paused' }).where('id', '=', enrollmentId).execute();
        await db
          .updateTable('jobs')
          .set({ status: 'canceled', last_error: 'enrollment_paused' })
          .where('enrollment_id', '=', enrollmentId)
          .where('status', 'in', ['scheduled', 'queued'] as any)
          .execute();
      } else {
        await db
          .updateTable('enrollments')
          .set({ status: 'active', next_run_at: new Date().toISOString() as any })
          .where('id', '=', enrollmentId)
          .execute();
      }
      return { ok: true as const };
    });
  }

  /** Remove a lead from a campaign entirely (cancels its pending jobs). */
  async removeEnrollment(
    workspaceId: string,
    campaignId: string,
    enrollmentId: string,
  ): Promise<{ removed: boolean }> {
    return withWorkspace(workspaceId, async (db) => {
      await db
        .updateTable('jobs')
        .set({ status: 'canceled', last_error: 'enrollment_removed' })
        .where('enrollment_id', '=', enrollmentId)
        .where('status', 'in', ['scheduled', 'queued', 'running'] as any)
        .execute();
      const res = await db
        .deleteFrom('enrollments')
        .where('workspace_id', '=', workspaceId)
        .where('campaign_id', '=', campaignId)
        .where('id', '=', enrollmentId)
        .execute();
      return { removed: Number((res as any)[0]?.numDeletedRows ?? 0) > 0 };
    });
  }
}
