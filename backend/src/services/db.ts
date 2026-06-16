import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

type TenantContext = { tenantId: string };
const tenantStorage = new AsyncLocalStorage<TenantContext>();

export const DEFAULT_TENANT_ID = "default";

export function withTenantContext<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const normalized = tenantId?.trim() || DEFAULT_TENANT_ID;
  return tenantStorage.run({ tenantId: normalized }, fn);
}

export function currentTenantId(): string {
  return tenantStorage.getStore()?.tenantId || DEFAULT_TENANT_ID;
}
