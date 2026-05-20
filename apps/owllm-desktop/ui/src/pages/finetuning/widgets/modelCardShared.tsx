// Shared bits between ModelCard / DownloadedModelCard / TunedModelCard
// so we don't repeat family→icon and compatibility logic three times.

export type CompatColor = "green" | "orange" | "red" | "gray";

export type CompatibilityBadge = {
  color: CompatColor;
  text: string;
  tooltip?: string;
};

export function familyIcon(modelId: string): { icon: string; bg: string } {
  const m = modelId.toLowerCase();
  if (m.includes("llama"))    return { icon: "🦙", bg: "#4CAF50" };
  if (m.includes("qwen"))     return { icon: "💮", bg: "#9C27B0" };
  if (m.includes("mistral") || m.includes("mixtral")) return { icon: "🌬️", bg: "#FF9800" };
  if (m.includes("gemma") || m.includes("google"))    return { icon: "💎", bg: "#4285F4" };
  if (m.includes("phi") || m.includes("microsoft"))   return { icon: "Φ",  bg: "#00A4EF" };
  if (m.includes("deepseek")) return { icon: "🐳", bg: "#1e3a8a" };
  if (m.includes("nemotron")) return { icon: "🟦", bg: "#2563eb" };
  if (m.includes("webworld")) return { icon: "🌐", bg: "#7a4a2e" };
  if (m.includes("yi-"))      return { icon: "易", bg: "#16a34a" };
  if (m.includes("falcon"))   return { icon: "🦅", bg: "#b45309" };
  if (m.includes("stablelm")) return { icon: "🪨", bg: "#475569" };
  return { icon: "🤖", bg: "#3498db" };
}
