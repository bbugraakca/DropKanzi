export type EbayConfigStatus = {
  ok: boolean;
  sandbox: boolean;
  issues: string[];
  redirectUri: string;
  clientIdPreview: string;
};

export function getEbayConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  sandbox: boolean;
} {
  return {
    clientId: (process.env.EBAY_CLIENT_ID || "").trim(),
    clientSecret: (process.env.EBAY_CLIENT_SECRET || "").trim(),
    redirectUri: (
      process.env.EBAY_REDIRECT_URI ||
      process.env.EBAY_RU_NAME ||
      ""
    ).trim(),
    sandbox: (process.env.EBAY_SANDBOX || "false").toLowerCase() === "true",
  };
}

export function validateEbayConfig(): EbayConfigStatus {
  const { clientId, clientSecret, redirectUri, sandbox } = getEbayConfig();
  const issues: string[] = [];

  if (!clientId) {
    issues.push(
      "EBAY_CLIENT_ID is missing. Use the App ID (Client ID) from your eBay Developer keyset."
    );
  } else if (clientId.length < 10) {
    issues.push("EBAY_CLIENT_ID looks too short — copy the full App ID from developer.ebay.com.");
  }

  if (!clientSecret) {
    issues.push(
      "EBAY_CLIENT_SECRET is missing. Use the Cert ID (Client Secret) from the same keyset."
    );
  }

  if (!redirectUri) {
    issues.push(
      "EBAY_REDIRECT_URI is missing. Set it to your RuName (NOT the http URL), e.g. YourName-YourApp-PRD-abc123."
    );
  } else if (redirectUri.startsWith("http://") || redirectUri.startsWith("https://")) {
    issues.push(
      "EBAY_REDIRECT_URI must be your eBay RuName string, not a full URL. In Developer Portal → User Tokens → RuName, copy the RuName value and set Auth Accepted URL to http://localhost:3001/api/auth/ebay/callback"
    );
  }

  return {
    ok: issues.length === 0,
    sandbox,
    issues,
    redirectUri: redirectUri || "(not set)",
    clientIdPreview: clientId
      ? `${clientId.slice(0, 6)}…${clientId.slice(-4)}`
      : "(not set)",
  };
}

export function assertEbayConfig() {
  const status = validateEbayConfig();
  if (!status.ok) {
    throw new Error(status.issues.join(" "));
  }
}
