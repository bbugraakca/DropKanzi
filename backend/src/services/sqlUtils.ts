/** Embed tenantId in raw SQL (avoids $1 collision with filter params). */
export function sqlTenantWhere(tenantId: string): string {
  const safe = tenantId.replace(/'/g, "''");
  return `"tenantId" = '${safe}'`;
}
