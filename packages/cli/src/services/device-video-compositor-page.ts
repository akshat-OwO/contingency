/** What the device compositor draws for one moment of the video. */
export interface DeviceCompositorFrame {
  /** The footage chunk to show, or `null` for a card with no footage. */
  readonly chunk: number | null;
  /** Where that chunk is sought to, in seconds. */
  readonly seek: number;
  /** A full-frame card in place of footage. */
  readonly card: "hidden" | "missing" | null;
  /** Marks a capture gap held on its last frame. */
  readonly gap: boolean;
  /** The fast-forward multiplier, such as "2x", over an Idle Gap. */
  readonly badge: string | null;
}

/**
 * The page the device compositor runs: one `<video>` that is pointed at each
 * footage chunk in turn, and a canvas of the video's fixed size. Footage of
 * another shape, such as after a rotation, is letterboxed into it. A Hidden
 * Interval and a span with no footage are drawn as cards that say so.
 */
export const deviceCompositorPage = (
  width: number,
  height: number
): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head>
<body>
<video id="footage" muted preload="auto"></video>
<canvas id="frame" width="${width}" height="${height}"></canvas>
<script>
const WIDTH = ${width};
const HEIGHT = ${height};
const video = document.getElementById("footage");
const canvas = document.getElementById("frame");
const context = canvas.getContext("2d");
const ui = Math.min(2, Math.max(0.75, Math.min(WIDTH, HEIGHT) / 600));
let loaded = null;

const load = (chunk) => new Promise((resolve, reject) => {
  if (loaded === chunk) {
    resolve();
    return;
  }
  const done = () => {
    video.removeEventListener("error", failed);
    loaded = chunk;
    resolve();
  };
  const failed = () => {
    video.removeEventListener("loadeddata", done);
    reject(new Error("The footage could not be decoded (" + (video.error && video.error.code) + ")."));
  };
  video.addEventListener("loadeddata", done, { once: true });
  video.addEventListener("error", failed, { once: true });
  video.src = "/footage/" + chunk;
});

// Seeking and presenting the decoded frame are separate signals: drawing on
// "seeked" alone can copy the previous frame on a loaded machine.
const seek = (seconds) => new Promise((resolve, reject) => {
  if (Math.abs(video.currentTime - seconds) < 0.0001) {
    resolve();
    return;
  }
  if (typeof video.requestVideoFrameCallback !== "function") {
    reject(new Error("The footage cannot report presented frames."));
    return;
  }
  let sought = false;
  let presented = false;
  const settle = () => {
    if (sought && presented) {
      video.removeEventListener("error", failed);
      resolve();
    }
  };
  const done = () => { sought = true; settle(); };
  const frame = video.requestVideoFrameCallback(() => { presented = true; settle(); });
  const failed = () => {
    video.removeEventListener("seeked", done);
    video.cancelVideoFrameCallback(frame);
    reject(new Error("The footage could not be sought."));
  };
  video.addEventListener("seeked", done, { once: true });
  video.addEventListener("error", failed, { once: true });
  video.currentTime = seconds;
});

const pill = (label, right) => {
  context.save();
  context.font = "600 " + Math.round(15 * ui) + "px system-ui, -apple-system, sans-serif";
  const padding = 10 * ui;
  const badgeHeight = 30 * ui;
  const margin = 16 * ui;
  const badgeWidth = padding * 2 + context.measureText(label).width;
  const left = right ? WIDTH - margin - badgeWidth : margin;
  const top = HEIGHT - margin - badgeHeight;
  context.fillStyle = "rgb(0 0 0 / 0.62)";
  context.beginPath();
  context.roundRect(left, top, badgeWidth, badgeHeight, badgeHeight / 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  context.fillText(label, left + padding, top + badgeHeight / 2 + ui);
  context.restore();
};

const card = (title, detail) => {
  context.save();
  context.fillStyle = "#171717";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#ffffff";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "600 " + Math.round(22 * ui) + "px system-ui, -apple-system, sans-serif";
  context.fillText(title, WIDTH / 2, HEIGHT / 2 - 14 * ui);
  context.fillStyle = "#a3a3a3";
  context.font = Math.round(15 * ui) + "px system-ui, -apple-system, sans-serif";
  context.fillText(detail, WIDTH / 2, HEIGHT / 2 + 18 * ui);
  context.restore();
};

const encoded = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

window.composeFrame = async (frame) => {
  if (frame.card === "hidden") {
    card("Secure screen hidden", "This screen is left out of the recording on purpose.");
  } else if (frame.card === "missing" || frame.chunk === null) {
    card("No footage", "The device recorded nothing for this moment.");
  } else {
    await load(frame.chunk);
    await seek(frame.seek);
    context.fillStyle = "#000000";
    context.fillRect(0, 0, WIDTH, HEIGHT);
    const scale = Math.min(WIDTH / video.videoWidth, HEIGHT / video.videoHeight);
    const drawWidth = video.videoWidth * scale;
    const drawHeight = video.videoHeight * scale;
    context.drawImage(video, (WIDTH - drawWidth) / 2, (HEIGHT - drawHeight) / 2, drawWidth, drawHeight);
    if (frame.gap) {
      pill("Capture gap", false);
    }
  }
  if (frame.badge) {
    pill("\\u25B6\\u25B6 " + frame.badge, true);
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) {
    throw new Error("The frame could not be encoded.");
  }
  return encoded(blob);
};
</script>
</body></html>`;
