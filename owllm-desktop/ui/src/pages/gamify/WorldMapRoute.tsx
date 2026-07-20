import { lazy, Suspense } from "react";

const WorldMapPage = lazy(() => import("./WorldMapPage"));

export default function WorldMapRoute() {
  return (
    <Suspense fallback={(
      <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--fg-muted)", fontSize: 13 }}>
        Loading World Map…
      </div>
    )}>
      <WorldMapPage />
    </Suspense>
  );
}
