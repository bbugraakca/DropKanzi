import type { Request, Response, NextFunction } from "express";
import { runWithTenantSync } from "./db";

export function tenantFromRequest(req: Request): string {
  const raw = req.header("x-tenant-id") || req.query.tenantId || req.body?.tenantId;
  const tenantId = typeof raw === "string" ? raw.trim() : "";
  return tenantId || "default";
}

export function withTenant(req: Request, _res: Response, next: NextFunction) {
  runWithTenantSync(tenantFromRequest(req), () => next());
}
