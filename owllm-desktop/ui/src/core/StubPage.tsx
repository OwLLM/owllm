// Generic "Not yet ported" page used by stubs for tabs whose React
// implementations haven't landed yet. Faithful in shape (HybridFrame
// inner background, owl PNG, brief description) but explicit about
// what it is so we never confuse a stub for a real implementation.

export type StubSpec = {
  icon: string;          // emoji shown in the header line
  ownlPng?: string;      // optional /Page_icons/owl_*.png to anchor the page
  title: string;         // visible h1
  blurb: string;         // 1-2 sentence description of what this page will do
  qtRef?: string;        // file:line reference to the PySide6 source
};

export default function StubPage({ spec }: { spec: StubSpec }) {
  return (
    <div style={{
      padding: "40px 48px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 18,
      background: "var(--bg-panel)",
      color: "var(--fg)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {spec.ownlPng && (
          <img
            src={spec.ownlPng}
            alt=""
            style={{ width: 44, height: 44, objectFit: "contain" }}
          />
        )}
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--fg-strong)" }}>
          {spec.icon} {spec.title}
        </div>
      </div>
      <div style={{
        background: "rgba(var(--accent-rgb), 0.06)",
        border: "1px solid rgba(var(--accent-rgb), 0.20)",
        borderRadius: 10,
        padding: "16px 20px",
        maxWidth: 720,
        fontSize: 13,
        lineHeight: 1.55,
      }}>
        <div style={{ fontWeight: 700, color: "var(--accent-ink)", marginBottom: 6 }}>
          Page not ported yet
        </div>
        <div>{spec.blurb}</div>
        {spec.qtRef && (
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--fg-muted)", fontFamily: "Consolas, monospace" }}>
            Qt source: {spec.qtRef}
          </div>
        )}
      </div>
    </div>
  );
}
