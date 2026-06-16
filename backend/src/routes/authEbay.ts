import { Router } from "express";
import { validateEbayConfig } from "../services/ebayConfig";
import { generateState, getEbayAuthorizeUrl } from "../services/ebayOAuth";

export const authEbayRouter = Router();

// GET /api/auth/ebay/config -> diagnose missing eBay OAuth env
authEbayRouter.get("/ebay/config", (_req, res) => {
  return res.json(validateEbayConfig());
});

// GET /api/auth/ebay -> redirect to eBay OAuth
authEbayRouter.get("/ebay", async (_req, res) => {
  const state = generateState();
  // NOTE: In production you would persist + verify state. For now this is minimal.
  return res.redirect(getEbayAuthorizeUrl(state));
});

const frontendUrl = () =>
  process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// GET /api/auth/ebay/url -> { url } for frontend OAuth button
authEbayRouter.get("/ebay/url", (_req, res) => {
  const status = validateEbayConfig();
  if (!status.ok) {
    return res.status(503).json({
      error: status.issues.join(" "),
      config: status,
    });
  }
  try {
    const state = generateState();
    return res.json({ url: getEbayAuthorizeUrl(state) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(503).json({ error: message, config: status });
  }
});

// GET /api/auth/ebay/callback?code=...
authEbayRouter.get("/ebay/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const error = String(req.query.error || "");

    if (error) {
      return res.redirect(
        `${frontendUrl()}/stores/oauth?error=${encodeURIComponent(error)}`
      );
    }

    if (!code) {
      return res.redirect(`${frontendUrl()}/stores/oauth?error=missing_code`);
    }

    // Redirect to frontend to collect username/country then POST connect-ebay
    return res.redirect(
      `${frontendUrl()}/stores/oauth?code=${encodeURIComponent(code)}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] ebay callback`, message);
    return res.redirect(
      `${frontendUrl()}/stores/oauth?error=${encodeURIComponent(message)}`
    );
  }
});

