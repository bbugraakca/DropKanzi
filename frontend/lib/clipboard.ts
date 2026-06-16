import { toast } from "sonner";

/** Copy text to the clipboard with a toast, falling back for older browsers. */
export async function copyToClipboard(
  text: string,
  successLabel = "Copied to clipboard",
  options?: { silent?: boolean }
): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    if (!options?.silent) toast.success(successLabel);
  } catch {
    toast.error("Copy failed");
  }
}
