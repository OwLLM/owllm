import {
  BufferTarget,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  canEncodeVideo,
} from "mediabunny";

export type FinalizedVideo = {
  blob: Blob;
  extension: "mp4" | "webm";
  label: string;
  mimeType: string;
};

export type FinalizedVideoRecorder = {
  label: string;
  extension: "mp4" | "webm";
  pause: () => void;
  resume: () => void;
  finalize: () => Promise<FinalizedVideo>;
  cancel: () => Promise<void>;
};

type VideoCandidate = {
  codec: "avc" | "vp9";
  extension: "mp4" | "webm";
  label: string;
  mimeType: string;
};

const VIDEO_CANDIDATES: readonly VideoCandidate[] = [
  { codec: "avc", extension: "mp4", label: "Finalized H.264 MP4", mimeType: "video/mp4" },
  { codec: "vp9", extension: "webm", label: "Finalized VP9 WebM", mimeType: "video/webm" },
];

// A display-capture track frequently reports no dimensions until its first frame
// arrives, and the encoder-capability probe needs *some* size. The recorded box
// is taken from the first real frame either way, so probing at a standard size
// keeps a perfectly good WebCodecs track from silently falling back to
// MediaRecorder's fragmented, unseekable output.
const PROBE_WIDTH = 1920;
const PROBE_HEIGHT = 1080;

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

/**
 * Record a MediaStreamTrack through WebCodecs into a finalized, indexed file.
 * MediaRecorder's MP4 output is fragmented (`moof`/`mdat`) and has no global
 * seek index in WebView2. Mediabunny writes a normal MP4/WebM and completes its
 * sample tables before the Blob is returned.
 *
 * `onEncoderError` fires the moment the encoder dies mid-recording, so the UI
 * can stop and say so instead of letting the user record for another hour into
 * a dead encoder and only discover the loss at save time.
 */
export async function createFinalizedVideoRecorder(
  track: MediaStreamTrack,
  fps: number,
  bitrate: number,
  onEncoderError?: (error: Error) => void,
): Promise<FinalizedVideoRecorder | null> {
  if (track.kind !== "video") return null;
  const settings = track.getSettings();
  const width = settings.width || PROBE_WIDTH;
  const height = settings.height || PROBE_HEIGHT;

  for (const candidate of VIDEO_CANDIDATES) {
    const encodingOptions = {
      width,
      height,
      bitrate,
      bitrateMode: "variable" as const,
      latencyMode: "quality" as const,
      contentHint: "detail",
    };
    if (!await canEncodeVideo(candidate.codec, encodingOptions).catch(() => false)) continue;

    const target = new BufferTarget();
    const format = candidate.extension === "mp4"
      ? new Mp4OutputFormat({ fastStart: "in-memory" })
      : new WebMOutputFormat();
    const output = new Output({ format, target });
    const source = new MediaStreamVideoTrackSource(
      track as ConstructorParameters<typeof MediaStreamVideoTrackSource>[0],
      {
        codec: candidate.codec,
        bitrate,
        bitrateMode: "variable",
        latencyMode: "quality",
        contentHint: "detail",
        keyFrameInterval: 2,
        // The captured surface changes size whenever the user resizes,
        // maximizes, or drags the window to a display with different scaling.
        // 'deny' threw at finalize and destroyed the whole recording; 'contain'
        // letterboxes the new size into the original box and keeps recording.
        sizeChangeBehavior: "contain",
      },
      { frameRate: fps },
    );
    let encoderError: unknown = null;
    let finalized = false;
    void source.errorPromise.catch((error) => {
      encoderError = error;
      // Closing the source during finalize/cancel is not a recording failure.
      if (!finalized) onEncoderError?.(asError(error, "The video encoder stopped unexpectedly."));
    });
    output.addVideoTrack(source);

    try {
      await output.start();
    } catch {
      finalized = true;
      await output.cancel().catch(() => {});
      continue;
    }

    return {
      label: candidate.label,
      extension: candidate.extension,
      pause: () => source.pause(),
      resume: () => source.resume(),
      finalize: async () => {
        if (finalized) throw new Error("This recording was already finalized.");
        finalized = true;
        source.close();
        await output.finalize();
        if (encoderError) {
          throw asError(encoderError, "The video encoder stopped unexpectedly.");
        }
        if (!target.buffer) throw new Error("The video muxer produced no output.");
        return {
          blob: new Blob([target.buffer], { type: candidate.mimeType }),
          extension: candidate.extension,
          label: candidate.label,
          mimeType: candidate.mimeType,
        };
      },
      cancel: async () => {
        if (finalized) return;
        finalized = true;
        source.close();
        await output.cancel();
      },
    };
  }

  return null;
}
