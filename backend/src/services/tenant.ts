import type { Request, Response, NextFunction } from "express";
import { DEFAULT_TENANT_ID, withTenantContext } from "./db";

export function tenantFromRequest(req: Request): string {
  const raw = req.header("x-tenant-id") || req.query.tenantId || req.body?.tenantId;
  const tenantId = typeof raw === "string" ? raw.trim() : "";
  return tenantId || DEFAULT_TENANT_ID;
}

export function withTenant(req: Request, _res: Response, next: NextFunction) {
  const tenantId = tenantFromRequest(req);
  void withTenantContext(tenantId, async () => {
    next();
  });
}
