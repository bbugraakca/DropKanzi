type ProductLike = {
  asin: string;
  title?: string | null;
  description?: string | null;
  aboutText?: string | null;
  bulletPoints?: string[];
};

export function applyListingTemplate(
  product: ProductLike,
  listingTitle: string,
  template?: Record<string, unknown> | null
): { title: string; description: string; categoryId?: string } {
  const prefix = String(template?.titlePrefix || "");
  const suffix = String(template?.titleSuffix || "");
  let title = `${prefix}${listingTitle}${suffix}`.trim().slice(0, 80);

  const bullets = (product.bulletPoints || [])
    .map((b) => `<li>${b}</li>`)
    .join("");
  const bulletBlock = bullets ? `<ul>${bullets}</ul>` : "";

  const vars: Record<string, string> = {
    title: product.title || listingTitle,
    description: product.description || product.aboutText || "",
    bullet_points: bulletBlock,
    asin: product.asin,
  };

  let html = String(
    template?.descriptionHtml ||
      template?.description ||
      "<p>{{title}}</p>{{bullet_points}}"
  );
  for (const [key, val] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, val);
  }

  const categoryId = template?.categoryId
    ? String(template.categoryId)
    : undefined;

  return { title, description: html, categoryId };
}
