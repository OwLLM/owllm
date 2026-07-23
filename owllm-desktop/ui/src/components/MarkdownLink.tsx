// Shared markdown <a> renderer for every chat surface.
//
// In a Tauri webview a plain `<a target="_blank">` does NOTHING — the runtime
// blocks the navigation and no browser window opens, so links pasted by agents
// looked dead. Route the click through OwLLM's persistent browser so the
// user's login session stays available to agents. Use this for react-markdown's `components.a` everywhere
// instead of re-declaring the override per chat component.

import { openWebUrl } from "../utils/openWebUrl";

export default function MarkdownLink(props: any) {
  const href: string | undefined = props.href;
  return (
    <a
      href={href}
      style={{ color: "var(--accent-ink)", textDecoration: "underline", cursor: "pointer" }}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (href) openWebUrl(href).catch((err) => console.error("open link failed", err));
      }}
    >
      {props.children}
    </a>
  );
}
