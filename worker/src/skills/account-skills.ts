/**
 * Durable Object holding one account's skills registry
 * (`MULTIX_SKILLS.getByName(accountId)`). The logic lives in SkillRegistry;
 * this class binds it to Durable Object storage. Callers pass the owner id
 * they addressed the object by, and the reading principal.
 */

import { DurableObject } from "cloudflare:workers";
import {
  type PublishInput,
  type RegistryStorage,
  type ServedSkill,
  SkillRegistry,
} from "./skill-registry.js";
import type { SkillAccess, SkillFile } from "./skill-types.js";

/** The registry calls the Worker makes; a test can pass a plain SkillRegistry. */
export interface SkillRegistryStub {
  served(ownerId: string, principal: string, name: string): Promise<ServedSkill | null>;
  listServed(ownerId: string, principal: string): Promise<ServedSkill[]>;
  readFile(
    ownerId: string,
    principal: string,
    name: string,
    path: string,
  ): Promise<{ file: SkillFile; bytes: Uint8Array } | null>;
  shares(): Promise<{ ownerId: string; name: string }[]>;
}

export interface AccountSkillsNamespace {
  getByName(name: string): SkillRegistryStub;
}

export class AccountSkills extends DurableObject implements SkillRegistryStub {
  private readonly registry = new SkillRegistry(this.ctx.storage as unknown as RegistryStorage);

  publish(input: PublishInput): Promise<ServedSkill> {
    return this.registry.publish(input);
  }

  grant(name: string, principal: string): Promise<SkillAccess> {
    return this.registry.grant(name, principal);
  }

  addShare(ownerId: string, name: string): Promise<void> {
    return this.registry.addShare(ownerId, name);
  }

  shares(): Promise<{ ownerId: string; name: string }[]> {
    return this.registry.shares();
  }

  served(ownerId: string, principal: string, name: string): Promise<ServedSkill | null> {
    return this.registry.served(ownerId, principal, name);
  }

  listServed(ownerId: string, principal: string): Promise<ServedSkill[]> {
    return this.registry.listServed(ownerId, principal);
  }

  readFile(
    ownerId: string,
    principal: string,
    name: string,
    path: string,
  ): Promise<{ file: SkillFile; bytes: Uint8Array } | null> {
    return this.registry.readFile(ownerId, principal, name, path);
  }
}
