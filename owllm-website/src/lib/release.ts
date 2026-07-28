import release from "../data/release.json";

export interface ReleaseMeta {
  version: string;
  url: string;
  publishedAt: string | null;
  assets?: Array<{
    name: string;
    browserDownloadUrl: string;
    size: number;
  }>;
}

export function loadReleaseMeta(): Promise<ReleaseMeta> {
  return Promise.resolve(release as ReleaseMeta);
}
