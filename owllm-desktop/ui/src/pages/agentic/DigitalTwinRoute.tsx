import { lazy, Suspense } from "react";

const DigitalTwinPage = lazy(() => import("./DigitalTwinPage"));

export default function DigitalTwinRoute() {
  return (
    <Suspense fallback={(
      <div aria-live="polite" style={{ height: "100%", display: "grid", placeItems: "center", background: "var(--bg-panel)", color: "var(--fg-muted)" }}>
        <div style={{ width: "min(460px, 70%)" }}>
          <div style={{ marginBottom: 12, fontSize: 13, fontWeight: 700 }}>Loading Digital Twin/3D workspace…</div>
          {[100, 78, 91].map((width) => (
            <div key={width} aria-hidden="true" style={{ width: `${width}%`, height: 13, marginBottom: 8, borderRadius: 6, background: "rgba(var(--accent-rgb), 0.12)" }} />
          ))}
        </div>
      </div>
    )}>
      <DigitalTwinPage />
    </Suspense>
  );
}
