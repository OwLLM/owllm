// StubPage — placeholder for tabs we haven't built yet. Keeps the
// nav functional so the user can see the full app shape; clicking a
// stub tab shows what's planned for it instead of dead-air.
import React from "react";

export default function StubPage({ label, hint }: { label: string; hint: string }) {
  return (
    <div style={{ padding: "40px 32px", color: "#9aa0a6" }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: "#dadcdf", marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 14, marginBottom: 24, opacity: 0.85 }}>{hint}</div>
      <div style={{
        display: "inline-block",
        padding: "10px 16px",
        borderRadius: 8,
        border: "1px dashed rgba(127,223,255,0.45)",
        color: "#7fdfff",
        fontSize: 12,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.8,
      }}>
        Not yet implemented
      </div>
    </div>
  );
}
