// psychedelicMode.ts — the agentic page's "how loud should the cards be?" preference.
//
// The agentic cards (chat tiles + graph nodes) announce a RUNNING agent with a
// full psychedelic treatment: a spinning rainbow ring on the border-box, a
// team-coloured body gradient, and a violet/cyan halo that BREATHES with the
// dispatch pulse. That is deliberate — it is how you spot the working agent
// across a 10-card canvas. It is also a lot of motion to sit next to all day.
//
// So the treatment is now a user preference with two settings:
//   • "full"    — today's behaviour, and the DEFAULT (nothing changes unless
//                 the user asks for it).
//   • "reduced" — only the card FRAME keeps a psychedelic aura, and it is the
//                 subtle one the Coding page's chatbox already uses: the same
//                 rainbow ring, a CONSTANT soft halo (no breathing), and the
//                 card's normal fill. Same visual language, a quarter of the
//                 noise.
//
// Storage: pageSettings' single synced document under the `global` scope, so
// the choice survives page navigation AND app restart, and follows the user to
// their other machines like every other preference in that layer. It is a tiny,
// rarely-written scalar — exactly what that document is for.
//
// Reduced motion: BOTH modes route their animation through
// continuousUiAnimation(), so a user with `prefers-reduced-motion: reduce` gets
// a static rainbow frame in either mode. The preference chooses how MUCH glow;
// the OS setting still decides whether anything moves.

import { getSetting, setSetting, useSetting, scope } from "../../state/pageSettings";
import { continuousUiAnimation } from "../../runtime/renderingPolicy";

export type PsychedelicMode = "full" | "reduced";

/** Key inside the `global` scope of the synced settings document. */
export const PSYCHEDELIC_MODE_KEY = "agenticPsychedelic";

/** Default ON: the full treatment is what the page has always shipped. */
export const PSYCHEDELIC_DEFAULT: PsychedelicMode = "full";

export function isPsychedelicMode(v: unknown): v is PsychedelicMode {
  return v === "full" || v === "reduced";
}

/** Read the saved preference. Anything unset or corrupt falls back to full. */
export function getPsychedelicMode(): PsychedelicMode {
  const raw = getSetting<string>(scope.global(), PSYCHEDELIC_MODE_KEY);
  return isPsychedelicMode(raw) ? raw : PSYCHEDELIC_DEFAULT;
}

/** Persist the preference (synced document ⇒ survives restart). */
export function setPsychedelicMode(mode: PsychedelicMode): void {
  setSetting(scope.global(), PSYCHEDELIC_MODE_KEY, mode);
}

/** The other mode — what a click on the toggle lands on. */
export function nextPsychedelicMode(mode: PsychedelicMode): PsychedelicMode {
  return mode === "full" ? "reduced" : "full";
}

/** `const [mode, toggle] = usePsychedelicMode()` — re-renders every card that
 *  uses it when the preference changes here, in another tab, or on sync. */
export function usePsychedelicMode(): [PsychedelicMode, () => void] {
  const [raw, write] = useSetting<string>(scope.global(), PSYCHEDELIC_MODE_KEY, PSYCHEDELIC_DEFAULT);
  const mode = isPsychedelicMode(raw) ? raw : PSYCHEDELIC_DEFAULT;
  return [mode, () => write(nextPsychedelicMode(mode))];
}

// ---- The shared aura ---------------------------------------------------------
// One rainbow, one spin keyframe. `--owllm-aura-angle` / `owllm-aura-spin` are
// declared once per page (AgentsPage + CodePage each emit the @property block).
const AURA_STOPS = "#3cf26b, #ffd93c, #ff9a3c, #ff5c8a, #b07cff, #7fd4ff, #3cf26b";
export const PSYCHEDELIC_RING = `conic-gradient(from var(--owllm-aura-angle), ${AURA_STOPS}) border-box`;

/** The Coding page chatbox's halo: constant, soft, no pulse.
 *  Mirrors PSYCHEDELIC_AURA_HALO in CodePage.tsx — keep the two in step. */
export const REDUCED_AURA_HALO = "0 0 12px rgba(176,124,255,.22), 0 0 20px rgba(127,212,255,.14)";

export const PSYCHEDELIC_SPIN = "owllm-aura-spin 4s linear infinite";

/** An OPAQUE padding-box layer that sits under the card's (translucent) fill.
 *  The cards' own fill is semi-transparent — `rgba(accent,0.36)` over
 *  `rgba(20,23,31,0.95)` — so with only that layer clipped to padding-box the
 *  border-box conic ring shows straight THROUGH the card body and the whole
 *  tile reads as a rainbow wash. That is the loud "full" look; "reduced" must
 *  not have it, so reduced slips this opaque base between fill and ring and the
 *  rainbow survives on the 2px frame only — exactly the Coding chatbox's
 *  anatomy (see PSYCHEDELIC_AURA_FILL in CodePage.tsx: an OPAQUE colour, wrapped
 *  in a gradient because a bare colour is not a valid multi-layer background). */
export const REDUCED_AURA_BASE = "linear-gradient(var(--bg-card), var(--bg-card)) padding-box";

/** Accessible copy for the 🍄 toggle, so the button and its tests agree. */
export function psychedelicToggleLabel(mode: PsychedelicMode): string {
  return mode === "full"
    ? "Psychedelic card effects: on. Activate to reduce them to a subtle frame aura."
    : "Psychedelic card effects: reduced. Activate to restore the full effect.";
}

/**
 * The running-card style for the current mode.
 *
 * `fill` is the card's normal background (a padding-box-eligible layer). The
 * pulse numbers come from the dispatch heartbeat and are used by "full" only —
 * "reduced" deliberately ignores them, which is what makes it stop breathing.
 */
export function psychedelicActiveStyle(opts: {
  mode: PsychedelicMode;
  fill: string;
  /** Inner white-line alpha multiplier (full mode only). */
  alphaA: number;
  /** Halo alpha (full mode only). */
  alphaB: number;
  /** Halo spread in px added by the pulse (full mode only). */
  outerPx: number;
  /** Extra shadow layers the card wants regardless of mode (e.g. drop shadow). */
  extraShadow?: string;
}): { background: string; border: string; boxShadow: string; animation: string | undefined } {
  const { mode, fill, alphaA, alphaB, outerPx, extraShadow } = opts;
  const tail = extraShadow ? `, ${extraShadow}` : "";
  // Both modes paint the SAME ring on the border-box. They differ in what sits
  // between it and the viewer: "full" lets the card's translucent fill let the
  // rainbow bleed across the whole body; "reduced" backs that fill with an
  // opaque layer so the ring is visible on the FRAME only.
  const border = "2px solid transparent";
  const animation = continuousUiAnimation(PSYCHEDELIC_SPIN);
  if (mode === "reduced") {
    return {
      background: `${fill} padding-box, ${REDUCED_AURA_BASE}, ${PSYCHEDELIC_RING}`,
      border,
      boxShadow: `${REDUCED_AURA_HALO}${tail}`,
      animation,
    };
  }
  return {
    background: `${fill} padding-box, ${PSYCHEDELIC_RING}`,
    border,
    boxShadow:
      `0 0 0 1px rgba(255,255,255,${0.18 * alphaA}),`
      + ` 0 0 ${12 + outerPx}px rgba(176,124,255,${alphaB}),`
      + ` 0 0 ${22 + outerPx}px rgba(127,212,255,${alphaB * 0.6})${tail}`,
    animation,
  };
}
