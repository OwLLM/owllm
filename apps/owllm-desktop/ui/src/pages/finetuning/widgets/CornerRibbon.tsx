// CornerRibbon — diagonal triangle badge in the bottom-right corner of
// a card. Matches LLM/desktop_app/model_card_widget.py RibbonWidget
// (1:1 port): 86×86 right-triangle filled with #4CAF50, white bold
// text rotated -45° along the hypotenuse.

import React from "react";

export type CornerRibbonProps = {
  text?: string;        // "READY" by default
  size?: number;        // 86 px to match Qt
  bg?: string;          // #4CAF50 (Qt READY green)
  fg?: string;          // white text
};

export default function CornerRibbon(props: CornerRibbonProps) {
  const size = props.size ?? 86;
  const bg   = props.bg   ?? "#4CAF50";
  const fg   = props.fg   ?? "#ffffff";
  const text = props.text ?? "READY";

  // CSS triangle in the bottom-right corner. The text container is
  // rotated -45° from horizontal so the label runs along the
  // hypotenuse, same as Qt's painter.translate / rotate path.
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        right: 0,
        bottom: 0,
        width: size,
        height: size,
        pointerEvents: "none",
        // Use clip-path to draw the triangle (top-right, bottom-right,
        // bottom-left). Same three vertices as Qt's QPolygonF.
        clipPath: "polygon(100% 0, 100% 100%, 0 100%)",
        background: bg,
        // Light edge highlight matches Qt's 1 px darker pen.
        boxShadow: "inset 1px 1px 0 rgba(255,255,255,0.18), inset -1px -1px 0 rgba(0,0,0,0.25)",
      }}
    >
      <div
        style={{
          position: "absolute",
          // Qt centers text at (2/3 w, 2/3 h) of the triangle's bbox.
          left: (2 * size) / 3,
          top:  (2 * size) / 3,
          transform: "translate(-50%, -50%) rotate(-45deg)",
          transformOrigin: "center center",
          color: fg,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          whiteSpace: "nowrap",
          textShadow: "0 1px 0 rgba(0,0,0,0.25)",
        }}
      >
        {text}
      </div>
    </div>
  );
}
