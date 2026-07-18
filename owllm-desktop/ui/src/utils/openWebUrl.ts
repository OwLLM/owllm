import { invoke } from "@tauri-apps/api/core";

/**
 * Open a user-facing web link in OwLLM's persistent browser.
 *
 * Keep this as the only UI entry point for http(s) links. In particular, do
 * not fall back to window.open or an OS shell: on Linux that can route a URL
 * to a file handler, and on every OS it loses OwLLM's persistent login profile.
 */
export async function openWebUrl(url: string): Promise<string> {
  return invoke<string>("browser_open_url", { url });
}

/** Catch plain anchors added by future pages without interfering with file links. */
export function installOwllmWebLinkInterceptor(): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    let url: URL;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    openWebUrl(url.href).catch((error) => console.error("Could not open the OwLLM browser", error));
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
