/**
 * Durable Object holding one account's usage ledger in its own SQLite
 * database (`MULTIX_USAGE.getByName(userId)`), so no query can read another
 * account's usage (ADR 001). The logic lives in UsageService; this class
 * forwards RPC calls to it and runs the daily housekeeping alarm.
 */

import { DurableObject } from "cloudflare:workers";
import { durableSqlPort } from "./sql-port.js";
import { UsageService } from "./usage-service.js";

const DAY = 86_400_000;

type Rpc = Omit<UsageService, "ledger" | "queries">;

/** RPC surface of AccountUsage: every UsageService method, awaited. */
export type AccountUsageStub = {
  [K in keyof Rpc]: Rpc[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : never;
};

export interface AccountUsageNamespace {
  getByName(name: string): AccountUsageStub;
}

export class AccountUsage extends DurableObject implements AccountUsageStub {
  private readonly service = new UsageService(durableSqlPort(this.ctx.storage));
  private alarmSet = false;

  /** Schedule the daily housekeeping once this account has written anything. */
  private async keepAlarm(): Promise<void> {
    if (this.alarmSet) return;
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + DAY);
    this.alarmSet = true;
  }

  override async alarm(): Promise<void> {
    this.service.prune();
    await this.ctx.storage.setAlarm(Date.now() + DAY);
  }

  async begin(...a: Parameters<Rpc["begin"]>) {
    await this.keepAlarm();
    return this.service.begin(...a);
  }
  async release(...a: Parameters<Rpc["release"]>) {
    return this.service.release(...a);
  }
  async settle(...a: Parameters<Rpc["settle"]>) {
    return this.service.settle(...a);
  }
  async importCli(...a: Parameters<Rpc["importCli"]>) {
    await this.keepAlarm();
    return this.service.importCli(...a);
  }
  async adjust(...a: Parameters<Rpc["adjust"]>) {
    return this.service.adjust(...a);
  }
  async summary(...a: Parameters<Rpc["summary"]>) {
    return this.service.summary(...a);
  }
  async digest(...a: Parameters<Rpc["digest"]>) {
    return this.service.digest(...a);
  }
  async events(...a: Parameters<Rpc["events"]>) {
    return this.service.events(...a);
  }
  async event(...a: Parameters<Rpc["event"]>) {
    return this.service.event(...a);
  }
  async exportEvents(...a: Parameters<Rpc["exportEvents"]>) {
    return this.service.exportEvents(...a);
  }
  async budgets() {
    return this.service.budgets();
  }
  async createBudget(...a: Parameters<Rpc["createBudget"]>) {
    return this.service.createBudget(...a);
  }
  async updateBudget(...a: Parameters<Rpc["updateBudget"]>) {
    return this.service.updateBudget(...a);
  }
  async deleteBudget(...a: Parameters<Rpc["deleteBudget"]>) {
    return this.service.deleteBudget(...a);
  }
  async activities(...a: Parameters<Rpc["activities"]>) {
    return this.service.activities(...a);
  }
  async verifyActivities() {
    return this.service.verifyActivities();
  }
  async recordActivity(...a: Parameters<Rpc["recordActivity"]>) {
    return this.service.recordActivity(...a);
  }
  async rateCard() {
    return this.service.rateCard();
  }
  async replaceRateCard(...a: Parameters<Rpc["replaceRateCard"]>) {
    return this.service.replaceRateCard(...a);
  }
  async balances() {
    return this.service.balances();
  }
  async saveBalances(...a: Parameters<Rpc["saveBalances"]>) {
    return this.service.saveBalances(...a);
  }
  async debugCaptureUntil() {
    return this.service.debugCaptureUntil();
  }
  async setDebugCapture(...a: Parameters<Rpc["setDebugCapture"]>) {
    return this.service.setDebugCapture(...a);
  }
  async readDebugLog(...a: Parameters<Rpc["readDebugLog"]>) {
    return this.service.readDebugLog(...a);
  }
  async deleteUsage(...a: Parameters<Rpc["deleteUsage"]>) {
    return this.service.deleteUsage(...a);
  }
  async prune() {
    return this.service.prune();
  }
}
