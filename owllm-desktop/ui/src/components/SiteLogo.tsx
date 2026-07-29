// The real mark of a website/service, wherever OwLLM names one.
//
// Resolution order is deliberate: the vendor's own SVG mark (crisp at any
// size, works offline), else a lettermark tinted with the brand colour. We
// never draw a stand-in "logo" — see utils/siteLogos.ts for why.
import React from "react";
import { siteHost, siteInitial, siteLogoById, siteLogoForUrl } from "../utils/siteLogos";

type Props = {
  /// Page/service URL — the primary key, so custom services resolve too.
  url?: string;
  /// Our own service id, tried first (ASSISTANT_SERVICES ids match SITE_LOGOS).
  id?: string;
  size?: number;
  /// Used for the lettermark when the URL is unknown.
  label?: string;
};

export const SiteLogo: React.FC<Props> = ({ url, id, size = 18, label }) => {
  const logo = (id ? siteLogoById(id) : null) ?? (url ? siteLogoForUrl(url) : null);
  if (logo?.path) {
    // `solid` brands ship their glyph knocked out of a brand-colour field, so
    // the tile carries the colour and the path is white. Everything else is the
    // vendor's coloured glyph on whatever sits behind it.
    const svg = (
      <svg
        width={logo.solid ? Math.round(size * 0.68) : size}
        height={logo.solid ? Math.round(size * 0.68) : size}
        viewBox="0 0 24 24"
        fill={logo.solid ? "#fff" : logo.hex}
        aria-label={logo.title}
        role="img"
        style={{ display: "block", flex: "none" }}
      >
        <path d={logo.path} />
      </svg>
    );
    if (!logo.solid) return svg;
    return (
      <span
        style={{
          display: "flex", flex: "none", alignItems: "center", justifyContent: "center",
          width: size, height: size, borderRadius: Math.round(size * 0.28),
          background: logo.hex,
        }}
      >
        {svg}
      </span>
    );
  }
  const tint = logo?.hex ?? "#6b7280";
  const initial = siteInitial(logo?.title || label || siteHost(url || "") || "?");
  return (
    <span
      aria-label={logo?.title || label || initial}
      role="img"
      style={{
        display: "flex", flex: "none", alignItems: "center", justifyContent: "center",
        width: size, height: size, borderRadius: Math.round(size * 0.28),
        background: tint, color: "#fff",
        fontSize: Math.round(size * 0.6), fontWeight: 800, lineHeight: 1,
      }}
    >
      {initial}
    </span>
  );
};

export default SiteLogo;
