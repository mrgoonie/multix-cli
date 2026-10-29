/**
 * Durable Object holding one account's skills registry
 * (`MULTIX_SKILLS.getByName(accountId)`). The logic lives in SkillRegistry;
 * this class binds it to Durable Object storage, refuses calls that name
 * another account than the one it is addressed by, and runs every write
 * inside blockConcurrencyWhile (writes read, then write across awaits).
 *
 * Owner calls take the owner's account id first. The two grantee calls
 * (`addShare`, `removeShare`) take the grantee's id, the object's own, and so
 * do the workflow calls: authorizations and runs belong to the running account.
 */

import { DurableObject } from "cloudflare:workers";
import {
  type DraftInput,
  type PublishDraftInput,
  type PublishInput,
  type RegistryStorage,
  type ServedSkill,
  SkillRegistry,
  type SkillSettings,
} from "./skill-registry.js";
import type {
  Skill,
  SkillAccess,
  SkillDraft,
  SkillFile,
  SkillRevision,
  SkillShare,
} from "./skill-types.js";
import {
  type WorkflowAuthorization,
  type WorkflowRun,
  type WorkflowRunSummary,
  WorkflowStore,
} from "./workflow-store.js";

type OwnFile = { file: SkillFile; bytes: Uint8Array } | null;

/** The registry calls the catalog makes (reading). */
export interface SkillRegistryStub {
  served(
    ownerId: string,
    principal: string,
    name: string,
    grantId?: string,
  ): Promise<ServedSkill | null>;
  listServed(ownerId: string, principal: string): Promise<ServedSkill[]>;
  readFile(ownerId: string, principal: string, name: string, path: string): Promise<OwnFile>;
  shares(): Promise<SkillShare[]>;
}

/** The running account's workflow authorizations and runs (see workflow-store.ts). */
export interface WorkflowStoreStub {
  workflowAuthorization(
    accountId: string,
    ownerId: string,
    name: string,
  ): Promise<WorkflowAuthorization | null>;
  workflowAuthorizations(accountId: string): Promise<WorkflowAuthorization[]>;
  putWorkflowAuthorization(accountId: string, auth: WorkflowAuthorization): Promise<boolean>;
  deleteWorkflowAuthorization(accountId: string, ownerId: string, name: string): Promise<boolean>;
  workflowRun(accountId: string, runId: string): Promise<WorkflowRun | null>;
  workflowRuns(accountId: string): Promise<WorkflowRunSummary[]>;
  createWorkflowRun(accountId: string, run: WorkflowRun): Promise<boolean>;
  saveWorkflowRun(accountId: string, run: WorkflowRun): Promise<WorkflowRun | null>;
}

/** Every call of an account's registry, reading and authoring. */
export interface SkillAuthoringStub extends SkillRegistryStub, WorkflowStoreStub {
  publish(input: PublishInput): Promise<ServedSkill>;
  saveDraft(input: DraftInput): Promise<SkillDraft>;
  draft(ownerId: string, name: string): Promise<SkillDraft | null>;
  discardDraft(ownerId: string, name: string, expectedDigest?: string): Promise<boolean>;
  publishDraft(input: PublishDraftInput): Promise<ServedSkill>;
  ownSkills(ownerId: string): Promise<{ skills: Skill[]; drafts: string[] }>;
  skill(ownerId: string, name: string): Promise<Skill | null>;
  revisions(ownerId: string, name: string): Promise<SkillRevision[]>;
  revision(ownerId: string, name: string, revision: number): Promise<SkillRevision>;
  ownFile(ownerId: string, name: string, from: "draft" | number, path: string): Promise<OwnFile>;
  setCurrent(
    ownerId: string,
    name: string,
    revision: number,
    expectedRevision?: number | null,
  ): Promise<ServedSkill>;
  unpublish(ownerId: string, name: string, expectedRevision?: number | null): Promise<Skill>;
  deleteRevision(ownerId: string, name: string, revision: number): Promise<void>;
  updateSettings(
    ownerId: string,
    name: string,
    settings: SkillSettings,
    expectedRevision?: number | null,
  ): Promise<{ skill: Skill; revoked: string[] }>;
  deleteSkill(ownerId: string, name: string): Promise<{ revoked: string[] }>;
  grant(ownerId: string, name: string, principal: string): Promise<SkillAccess>;
  revoke(ownerId: string, name: string, principal: string): Promise<boolean>;
  grants(ownerId: string, name: string): Promise<SkillAccess[]>;
  access(ownerId: string, name: string, principal: string): Promise<SkillAccess | null>;
  addShare(principal: string, ownerId: string, name: string, grantId: string): Promise<SkillShare>;
  removeShare(principal: string, ownerId: string, name: string): Promise<boolean>;
}

export interface AccountSkillsNamespace {
  getByName(name: string): SkillAuthoringStub;
}

export class AccountSkills extends DurableObject implements SkillAuthoringStub {
  private readonly registry: SkillRegistry;
  private readonly workflows: WorkflowStore;

  /** `now` is for tests; the runtime constructs the object with (ctx, env). */
  constructor(ctx: DurableObjectState, env: unknown, now: () => number = Date.now) {
    super(ctx, env as never);
    this.registry = new SkillRegistry(ctx.storage as unknown as RegistryStorage, now);
    this.workflows = new WorkflowStore(ctx.storage as unknown as RegistryStorage);
  }

  /**
   * The object is addressed by its account id; refuse a call that names
   * another account so a wrong argument cannot mislabel or expose skills.
   */
  private owner(accountId: string): void {
    const name = this.ctx.id.name;
    if (name !== undefined && name !== accountId) {
      throw new Error("Skill registry owner does not match the addressed account");
    }
  }

  /** Run one write alone: revision numbers, digests and blob references read then write. */
  private async write<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    this.owner(accountId);
    return await this.ctx.blockConcurrencyWhile(fn);
  }

  async publish(input: PublishInput): Promise<ServedSkill> {
    return this.write(input.ownerId, () => this.registry.publish(input));
  }

  async saveDraft(input: DraftInput): Promise<SkillDraft> {
    return this.write(input.ownerId, () => this.registry.saveDraft(input));
  }

  async draft(ownerId: string, name: string): Promise<SkillDraft | null> {
    this.owner(ownerId);
    return await this.registry.draft(name);
  }

  async discardDraft(ownerId: string, name: string, expectedDigest?: string): Promise<boolean> {
    return this.write(ownerId, () => this.registry.discardDraft(name, expectedDigest));
  }

  async publishDraft(input: PublishDraftInput): Promise<ServedSkill> {
    return this.write(input.ownerId, () => this.registry.publishDraft(input));
  }

  async ownSkills(ownerId: string): Promise<{ skills: Skill[]; drafts: string[] }> {
    this.owner(ownerId);
    return await this.registry.ownSkills();
  }

  async skill(ownerId: string, name: string): Promise<Skill | null> {
    this.owner(ownerId);
    return await this.registry.skill(name);
  }

  async revisions(ownerId: string, name: string): Promise<SkillRevision[]> {
    this.owner(ownerId);
    return await this.registry.revisions(name);
  }

  async revision(ownerId: string, name: string, revision: number): Promise<SkillRevision> {
    this.owner(ownerId);
    return await this.registry.revision(name, revision);
  }

  async ownFile(
    ownerId: string,
    name: string,
    from: "draft" | number,
    path: string,
  ): Promise<OwnFile> {
    this.owner(ownerId);
    return await this.registry.ownFile(name, from, path);
  }

  async setCurrent(
    ownerId: string,
    name: string,
    revision: number,
    expectedRevision?: number | null,
  ): Promise<ServedSkill> {
    return this.write(ownerId, () => this.registry.setCurrent(name, revision, expectedRevision));
  }

  async unpublish(ownerId: string, name: string, expectedRevision?: number | null): Promise<Skill> {
    return this.write(ownerId, () => this.registry.unpublish(name, expectedRevision));
  }

  async deleteRevision(ownerId: string, name: string, revision: number): Promise<void> {
    return this.write(ownerId, () => this.registry.deleteRevision(name, revision));
  }

  async updateSettings(
    ownerId: string,
    name: string,
    settings: SkillSettings,
    expectedRevision?: number | null,
  ): Promise<{ skill: Skill; revoked: string[] }> {
    return this.write(ownerId, () =>
      this.registry.updateSettings(name, settings, expectedRevision),
    );
  }

  async deleteSkill(ownerId: string, name: string): Promise<{ revoked: string[] }> {
    return this.write(ownerId, () => this.registry.deleteSkill(name));
  }

  async grant(ownerId: string, name: string, principal: string): Promise<SkillAccess> {
    return this.write(ownerId, () => this.registry.grant(name, principal));
  }

  async revoke(ownerId: string, name: string, principal: string): Promise<boolean> {
    return this.write(ownerId, () => this.registry.revoke(name, principal));
  }

  async grants(ownerId: string, name: string): Promise<SkillAccess[]> {
    this.owner(ownerId);
    return await this.registry.grants(name);
  }

  async access(ownerId: string, name: string, principal: string): Promise<SkillAccess | null> {
    this.owner(ownerId);
    return await this.registry.access(name, principal);
  }

  async addShare(
    principal: string,
    ownerId: string,
    name: string,
    grantId: string,
  ): Promise<SkillShare> {
    return this.write(principal, () => this.registry.addShare(ownerId, name, grantId));
  }

  async removeShare(principal: string, ownerId: string, name: string): Promise<boolean> {
    return this.write(principal, () => this.registry.removeShare(ownerId, name));
  }

  async shares(): Promise<SkillShare[]> {
    return await this.registry.shares();
  }

  async served(
    ownerId: string,
    principal: string,
    name: string,
    grantId?: string,
  ): Promise<ServedSkill | null> {
    this.owner(ownerId);
    return await this.registry.served(ownerId, principal, name, grantId);
  }

  async listServed(ownerId: string, principal: string): Promise<ServedSkill[]> {
    this.owner(ownerId);
    return await this.registry.listServed(ownerId, principal);
  }

  async readFile(ownerId: string, principal: string, name: string, path: string): Promise<OwnFile> {
    this.owner(ownerId);
    return await this.registry.readFile(ownerId, principal, name, path);
  }

  async workflowAuthorization(
    accountId: string,
    ownerId: string,
    name: string,
  ): Promise<WorkflowAuthorization | null> {
    this.owner(accountId);
    return await this.workflows.authorization(ownerId, name);
  }

  async workflowAuthorizations(accountId: string): Promise<WorkflowAuthorization[]> {
    this.owner(accountId);
    return await this.workflows.authorizations();
  }

  async putWorkflowAuthorization(accountId: string, auth: WorkflowAuthorization): Promise<boolean> {
    return this.write(accountId, () => this.workflows.putAuthorization(auth));
  }

  async deleteWorkflowAuthorization(
    accountId: string,
    ownerId: string,
    name: string,
  ): Promise<boolean> {
    return this.write(accountId, () => this.workflows.deleteAuthorization(ownerId, name));
  }

  async workflowRun(accountId: string, runId: string): Promise<WorkflowRun | null> {
    this.owner(accountId);
    return await this.workflows.run(runId);
  }

  async workflowRuns(accountId: string): Promise<WorkflowRunSummary[]> {
    this.owner(accountId);
    return await this.workflows.runs();
  }

  async createWorkflowRun(accountId: string, run: WorkflowRun): Promise<boolean> {
    return this.write(accountId, () => this.workflows.createRun(run));
  }

  async saveWorkflowRun(accountId: string, run: WorkflowRun): Promise<WorkflowRun | null> {
    return this.write(accountId, () => this.workflows.saveRun(run));
  }
}
