// Inline SVG brand logos for AccountsPage. Each component takes
// optional size + color props so the ProviderCard can tint with the
// brand accent. SVG paths are simplified mark-only versions (no
// wordmarks) — small, recognisable at 32 px, and free of trademarks
// requiring attribution beyond the brand itself.
//
// Sources: SimpleIcons (CC0) where available; hand-traced fallbacks
// for brands not yet in SimpleIcons (or where their mark is too
// complex to render cleanly at 32 px). All are nominative use of the
// brand to identify the corresponding provider in our UI.

import React from "react";

type Props = { size?: number; color?: string };
const defaults = { size: 32, color: "currentColor" };

const Wrap: React.FC<Props & { children: React.ReactNode; viewBox?: string }> = ({
  size = defaults.size, color = defaults.color, children, viewBox = "0 0 24 24",
}) => (
  <svg
    width={size}
    height={size}
    viewBox={viewBox}
    fill={color}
    xmlns="http://www.w3.org/2000/svg"
    style={{ display: "block" }}
  >
    {children}
  </svg>
);

// Anthropic "A" mark — two angled triangles forming a stylised A.
export const AnthropicLogo: React.FC<Props> = (p) => (
  <Wrap {...p}>
    <path d="M13.827 3.52h3.603L24 20.48h-3.603L13.827 3.52zM7.21 3.52h3.603L17.39 20.48h-3.69l-1.318-3.394H6.07L4.736 20.48H1.045L7.21 3.52zm.027 11.51h4.225L9.345 9.182l-2.108 5.85z" />
  </Wrap>
);

// OpenAI hexagonal flower mark.
export const OpenAILogo: React.FC<Props> = (p) => (
  <Wrap {...p}>
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z" />
  </Wrap>
);

// Moonshot / Kimi — crescent moon.
export const MoonshotLogo: React.FC<Props> = (p) => (
  <Wrap {...p}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </Wrap>
);

// Google Gemini — diamond / sparkle.
export const GeminiLogo: React.FC<Props> = (p) => (
  <Wrap {...p}>
    <path d="M12 2L13.5 8.5L20 10L13.5 11.5L12 18L10.5 11.5L4 10L10.5 8.5L12 2zM18 18l.75 3.25L22 22l-3.25.75L18 26l-.75-3.25L14 22l3.25-.75L18 18z" transform="scale(0.92) translate(0.5,0)" />
  </Wrap>
);

// DeepSeek — stylised whale.
export const DeepSeekLogo: React.FC<Props> = (p) => (
  <Wrap {...p}>
    <path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.351-.2-.031-.278.137-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.636 2.58 1.84 3.392.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 0 1-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 0 0-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 0 1-.465.137 9.597 9.597 0 0 0-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 0 0 1.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 0 1 1.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 0 1 .415-.287.302.302 0 0 1 .2.288.306.306 0 0 1-.31.307.303.303 0 0 1-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 0 1-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 0 1 .016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 0 1-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.617.408 1.001.781.392.452.463.577.685.917.176.265.336.537.445.848.067.195-.019.354-.25.452z" />
  </Wrap>
);

// xAI — the X mark.
export const XaiLogo: React.FC<Props> = (p) => (
  <Wrap {...p}>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </Wrap>
);

// Groq — stylised "G" with a horizontal cut.
export const GroqLogo: React.FC<Props> = (p) => (
  <Wrap {...p}>
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm5-9h-6v2h4c-.39 1.74-1.94 3-3.78 3-2.21 0-4-1.79-4-4s1.79-4 4-4c1.05 0 2 .4 2.74 1.05L15.41 7.6C14.45 6.61 13.29 6 12 6c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6c0-.34-.03-.67-.09-1z" />
  </Wrap>
);

// Perplexity — abstract search/citation mark.
export const PerplexityLogo: React.FC<Props> = (p) => (
  <Wrap {...p}>
    <path d="M22.398 11.7v6.27h-2.207V13.06l-6.157 5.61v3.92h-2.058v-3.92l-6.157-5.61v4.91H3.612v-6.27l8.366 7.624L20.34 4.077v6.293zM2 11.7l8.366-7.623 8.367 7.624v.005H16.49V8.998L10.366 3.41 4.243 8.998v2.707H2z" />
  </Wrap>
);

// Mistral — stripey hexagonal mark (simplified to 3 horizontal bars).
export const MistralLogo: React.FC<Props> = (p) => (
  <Wrap {...p} viewBox="0 0 24 24">
    <rect x="2" y="4"  width="20" height="3" rx="0.5" />
    <rect x="2" y="10.5" width="20" height="3" rx="0.5" />
    <rect x="2" y="17" width="20" height="3" rx="0.5" />
  </Wrap>
);

// Together AI — interlocking puzzle / two squares.
export const TogetherLogo: React.FC<Props> = (p) => (
  <Wrap {...p}>
    <rect x="2"  y="2"  width="9" height="9" rx="2" />
    <rect x="13" y="13" width="9" height="9" rx="2" />
    <rect x="13" y="2"  width="9" height="9" rx="2" fillOpacity="0.55" />
    <rect x="2"  y="13" width="9" height="9" rx="2" fillOpacity="0.55" />
  </Wrap>
);
