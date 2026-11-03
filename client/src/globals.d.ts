declare module "*.css";

interface Window {
  /** Original asset keys mapped only to verified local /blobs/ or /media/ URLs. */
  __DIRECTOR_LOCAL_MEDIA__?: Record<string, string | undefined>;
}
