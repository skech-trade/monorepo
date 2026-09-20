/**
 * Getting a file out of the browser: a download, the share sheet, the
 * clipboard, a recording off a canvas. Nothing here knows what a round is.
 */

export type Clip = { blob: Blob; ext: "mp4" | "webm" };

/** The first container this browser can write. MP4 travels better; Safari has no WebM. */
function videoType(): { mime: string; ext: Clip["ext"] } | null {
  if (typeof MediaRecorder === "undefined") return null;
  const tries: { mime: string; ext: Clip["ext"] }[] = [
    { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
    { mime: "video/mp4;codecs=avc1", ext: "mp4" },
    { mime: "video/mp4", ext: "mp4" },
    { mime: "video/webm;codecs=vp9", ext: "webm" },
    { mime: "video/webm;codecs=vp8", ext: "webm" },
    { mime: "video/webm", ext: "webm" },
  ];
  return tries.find((t) => MediaRecorder.isTypeSupported(t.mime)) ?? null;
}

export function canRecordVideo(): boolean {
  return typeof HTMLCanvasElement !== "undefined" && "captureStream" in HTMLCanvasElement.prototype && videoType() !== null;
}

/**
 * Record `paint(frame)` for `seconds`, frame running 0 to 1, then hold the
 * last frame for `holdMs`. The canvas is attached out of sight while it
 * records: some browsers only feed the stream from a canvas in the document.
 */
export async function recordCanvas(canvas: HTMLCanvasElement, paint: (frame: number) => void, seconds: number, holdMs = 1200): Promise<Clip> {
  const picked = videoType();
  if (!picked || !("captureStream" in HTMLCanvasElement.prototype)) throw new Error("unsupported");
  canvas.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(canvas);
  try {
    paint(0);
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: picked.mime, videoBitsPerSecond: 5_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const done = new Promise<Blob>((resolve, reject) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: picked.mime }));
      rec.onerror = () => reject(new Error("recorder"));
    });
    rec.start(200);
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        const f = Math.min(1, (now - start) / (seconds * 1000));
        paint(f);
        if (f < 1) requestAnimationFrame(tick);
        else setTimeout(resolve, holdMs);
      };
      requestAnimationFrame(tick);
    });
    rec.stop();
    for (const track of stream.getTracks()) track.stop();
    const blob = await done;
    if (blob.size === 0) throw new Error("empty");
    return { blob, ext: picked.ext };
  } finally {
    canvas.remove();
  }
}

/** Save the way a download does. Needs no permission and no fresh click. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 4000);
}

/** Whether the share sheet would take this file. */
export function canShareFile(blob: Blob, filename: string): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([blob], filename, { type: blob.type })] });
  } catch {
    return false;
  }
}

/** Whether the current click is still fresh enough for the share sheet to open. */
function clickIsFresh(): boolean {
  return (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true;
}

/**
 * Put a picture on the clipboard. Takes the promise, not the blob: the
 * clipboard has to be asked inside the click, and painting takes a moment.
 */
export async function copyPicture(png: Promise<Blob>): Promise<boolean> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Share sheet where there is one and the click is fresh, else a download.
 * Throws AbortError when the sheet was dismissed, so the caller can say nothing.
 */
export async function shareOrSave(blob: Blob, filename: string, text: string): Promise<"shared" | "saved"> {
  if (clickIsFresh() && canShareFile(blob, filename)) {
    try {
      await navigator.share({ files: [new File([blob], filename, { type: blob.type })], text });
      return "shared";
    } catch (e) {
      if ((e as DOMException).name === "AbortError") throw e;
    }
  }
  saveBlob(blob, filename);
  return "saved";
}

/** X's compose window, prefilled. Text only: X takes no file by link. */
export function xPostUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
