import React from "react";

export type ActionIconName =
  | "arrow-left" | "bolt" | "bug" | "camera" | "check" | "chevron-down"
  | "chevron-right" | "chevron-up" | "circle" | "clipboard" | "clock" | "close"
  | "code" | "copy" | "external-link" | "help" | "link" | "loader" | "monitor"
  | "note" | "play" | "plus" | "rotate" | "send" | "shield-off" | "sliders"
  | "target" | "text-larger" | "text-smaller" | "trash" | "wand" | "workflow";

type ActionIconProps = {
  name: ActionIconName;
  size?: number;
  label?: string;
  className?: string;
  style?: React.CSSProperties;
};

// Product-owned, dependency-free SVG icons. Keeping action glyphs here avoids
// platform emoji/font differences while giving every surface one visual system.
export default function ActionIcon({ name, size = 16, label, className, style }: ActionIconProps) {
  const paths: Record<ActionIconName, React.ReactNode> = {
    "arrow-left": <><path d="m15 18-6-6 6-6" /><path d="M9 12h10" /></>,
    bolt: <path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" />,
    bug: <><path d="M8 9h8a3 3 0 0 1 3 3v2a7 7 0 0 1-14 0v-2a3 3 0 0 1 3-3Z" /><path d="M12 9V4m-3 2 3-2 3 2M5 13H2m20 0h-3M5 17H2m20 0h-3M8 9 6 7m10 2 2-2M12 9v12" /></>,
    camera: <><path d="M14.5 5 16 8h3a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h3l1.5-3h5Z" /><circle cx="12" cy="14" r="4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    "chevron-down": <path d="m7 10 5 5 5-5" />,
    "chevron-right": <path d="m10 7 5 5-5 5" />,
    "chevron-up": <path d="m7 14 5-5 5 5" />,
    circle: <circle cx="12" cy="12" r="8" />,
    clipboard: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5A2.5 2.5 0 0 1 11.5 2h1A2.5 2.5 0 0 1 15 4.5V6H9V4.5Zm0 6h6m-6 4h6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    code: <path d="m8 9-4 3 4 3m8-6 4 3-4 3m-2-9-4 12" />,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    "external-link": <><path d="M14 4h6v6m0-6-9 9" /><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9a2.6 2.6 0 1 1 3.7 2.35c-.9.45-1.3 1-1.3 1.9V14" /><path d="M12 18h.01" /></>,
    link: <><path d="m10 13 4-4" /><path d="M8.5 16.5 6 19a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0" /><path d="m15.5 7.5 2.5-2.5a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" /></>,
    loader: <><path d="M21 12a9 9 0 1 1-6.2-8.55" /><path d="M15 3h4v4" /></>,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
    note: <><path d="M5 3h11l3 3v15H5V3Z" /><path d="M15 3v4h4M8 11h8m-8 4h8" /></>,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    rotate: <><path d="M4 4v6h6" /><path d="M5.5 9A8 8 0 1 1 4 15" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></>,
    "shield-off": <><path d="M12 22s8-4 8-10V5l-8-3-5 1.9M4 5v7c0 4.4 4.7 7.7 7 9" /><path d="m3 3 18 18" /></>,
    sliders: <><path d="M4 6h8m4 0h4M4 12h3m4 0h9M4 18h10m4 0h2" /><circle cx="14" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="16" cy="18" r="2" /></>,
    target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 3V1m0 22v-2M3 12H1m22 0h-2" /></>,
    // Text-size controls (CAD/office convention): a capital "A" plus an up
    // arrow to grow the size, a down arrow to shrink it.
    "text-larger": <><path d="M3 18 8 5l5 13M5 13.5h6" /><path d="M18 18V7m-3 3 3-3 3 3" /></>,
    "text-smaller": <><path d="M3 18 8 5l5 13M5 13.5h6" /><path d="M18 7v11m-3-3 3 3 3-3" /></>,
    trash: <><path d="M4 7h16m-10 4v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3" /></>,
    wand: <><path d="m4 20 11-11 4 4L8 24 4 20Z" /><path d="m14 4 1-3 1 3 3 1-3 1-1 3-1-3-3-1 3-1Zm6 12 .7-2 .7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z" /></>,
    workflow: <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" /><path d="M9 6h4a3 3 0 0 1 3 3v6M8 18H6a3 3 0 0 1-3-3v-2" /></>,
  };

  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={className}
      style={{ display: "block", flexShrink: 0, ...style }} role={label ? "img" : undefined}
      aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      {paths[name]}
    </svg>
  );
}
