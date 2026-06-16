import crypto from "crypto";
import { assertEbayConfig, getEbayConfig } from "./ebayConfig";

function ebayBaseUrl() {
  const { sandbox } = getEbayConfig();
  return sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

function ebayAuthHost() {
  const { sandbox } = getEbayConfig();
  return sandbox ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";
}

const OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");

export function getEbayAuthorizeUrl(state: string) {
  assertEbayConfig();
  const { clientId, redirectUri } = getEbayConfig();

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    state,
  });

  return `${ebayAuthHost()}/oauth2/authorize?${params.toString()}`;
}

export function generateState() {
  return crypto.randomBytes(16).toString("hex");
}

export type EbayTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type: string;
};

export async function exchangeCodeForTokens(code: string): Promise<EbayTokenResponse> {
  assertEbayConfig();
  const { clientId, clientSecret, redirectUri } = getEbayConfig();

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch(`${ebayBaseUrl()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`eBay token exchange failed: ${res.status} ${text}`);
  }
  return JSON.parse(text) as EbayTokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<EbayTokenResponse> {
  assertEbayConfig();
  const { clientId, clientSecret } = getEbayConfig();

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: OAUTH_SCOPES,
  });

  const res = await fetch(`${ebayBaseUrl()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`eBay refresh failed: ${res.status} ${text}`);
  }
  return JSON.parse(text) as EbayTokenResponse;
}
