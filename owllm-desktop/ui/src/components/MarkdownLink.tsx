// Shared markdown <a> renderer for every chat surface.
//
// In a Tauri webview a plain `<a target="_blank">` does NOTHING — the runtime
// blocks the navigation and no browser window opens, so links pasted by agents
// looked dead. Route the click through the existing `shell_open_url` Rust
// command (the same one Accounts / MCP pages use) so it opens in the user's
// default browser. Use this for react-markdown's `components.a` everywhere
// instead of re-declaring the override per chat component.

import { invoke } from "@tauri-apps/api/core";

export default function MarkdownLink(props: any) {
  const href: string | undefined = props.href;
  return (
    <a
      href={href}
      style={{ color: "var(--accent)", textDecoration: "underline", cursor: "pointer" }}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (href) invoke("shell_open_url", { url: href }).catch((err) => console.error("open link failed", err));
      }}
    >
      {props.children}
    </a>
  );
}
