import type { Request, Response, NextFunction } from "express";

const PF_API_KEY = (process.env.PF_API_KEY || "").trim();

export function requirePfAuth(req: Request, res: Response, next: NextFunction) {
  if (!PF_API_KEY) return next();
  const token = String(req.header("x-api-key") || "").trim();
  if (token && token === PF_API_KEY) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
