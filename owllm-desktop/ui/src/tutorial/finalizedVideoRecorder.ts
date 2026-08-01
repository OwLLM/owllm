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

/**
 * Record a MediaStreamTrack through WebCodecs into a finalized, indexed file.
 * MediaRecorder's MP4 output is fragmented (`moof`/`mdat`) and has no global
 * seek index in WebView2. Mediabunny writes a normal MP4/WebM and completes its
 * sample tables before the Blob is returned.
 */
export async function createFinalizedVideoRecorder(
  track: MediaStreamVideoTrack,
  fps: number,
  bitrate: number,
): Promise<FinalizedVideoRecorder | null> {
  const settings = track.getSettings();
  const width = settings.width;
  const height = settings.height;
  if (!width || !height) return null;

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
    const source = new MediaStreamVideoTrackSource(track, {
      codec: candidate.codec,
      bitrate,
      bitrateMode: "variable",
      latencyMode: "quality",
      contentHint: "detail",
      keyFrameInterval: 2,
      sizeChangeBehavior: "deny",
    }, { frameRate: fps });
    let encoderError: unknown = null;
    void source.errorPromise.catch((error) => {
      encoderError = error;
    });
    output.addVideoTrack(source);

    try {
      await output.start();
    } catch {
      await output.cancel().catch(() => {});
      continue;
    }

    let finalized = false;
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
          throw encoderError instanceof Error
            ? encoderError
            : new Error("The video encoder stopped unexpectedly.");
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
