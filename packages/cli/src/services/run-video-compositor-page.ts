/** What the compositor draws over one footage frame. */
export interface CompositorFrame {
  /** Where the footage is sought to, in seconds. */
  readonly seek: number;
  readonly cursor: {
    readonly glyphScale: number;
    readonly opacity: number;
    readonly ringOpacity: number;
    readonly ringScale: number;
    readonly x: number;
    readonly y: number;
  } | null;
  /** The fast-forward multiplier shown in the corner, such as "2x". */
  readonly badge: string | null;
}

/**
 * The page the compositor runs: the footage in a `<video>`, a canvas the
 * frame is drawn onto, and the drawing for the agent's cursor and the
 * fast-forward badge. The cursor matches the Workspace's: lucide's
 * `MousePointer2` at 20px, its tip on the point, blue-600 over the page
 * background, with the press ring beneath it.
 */
export const compositorPage = (
  width: number,
  height: number
): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head>
<body>
<video id="footage" muted preload="auto" src="/footage"></video>
<canvas id="frame" width="${width}" height="${height}"></canvas>
<script>
const WIDTH = ${width};
const HEIGHT = ${height};
const BLUE = "oklch(54.6% 0.245 262.881)";
const video = document.getElementById("footage");
const canvas = document.getElementById("frame");
const context = canvas.getContext("2d");
const glyph = new Path2D("M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z");
const GLYPH_SCALE = 20 / 24;
const ui = Math.min(2, Math.max(0.75, Math.min(WIDTH, HEIGHT) / 600));

window.footageReady = new Promise((resolve, reject) => {
  if (video.readyState >= 2) {
    resolve();
    return;
  }
  video.addEventListener("loadeddata", () => resolve(), { once: true });
  video.addEventListener("error", () => reject(new Error("The footage could not be decoded (" + (video.error && video.error.code) + ").")), { once: true });
});

// Seeking and presenting the decoded frame are separate signals: drawing on
// "seeked" alone can copy the previous frame on a loaded machine.
const seek = (seconds) => new Promise((resolve, reject) => {
  if (Math.abs(video.currentTime - seconds) < 0.0001) {
    resolve();
    return;
  }
  // Drawing without the presented frame would bring the stale frame back, so
  // a browser without this signal fails the frame instead of falling back.
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

const drawCursor = (cursor) => {
  context.save();
  context.translate(cursor.x, cursor.y);
  if (cursor.ringOpacity > 0) {
    context.save();
    // The ring is blue-600 at 25% before the press animates its opacity.
    context.globalAlpha = cursor.ringOpacity * 0.25;
    context.scale(cursor.ringScale, cursor.ringScale);
    context.beginPath();
    context.arc(0, 0, 12, 0, Math.PI * 2);
    context.fillStyle = BLUE;
    context.fill();
    context.restore();
  }
  context.globalAlpha = cursor.opacity;
  context.scale(cursor.glyphScale, cursor.glyphScale);
  context.translate(-3.4, -3.9);
  context.scale(GLYPH_SCALE, GLYPH_SCALE);
  context.shadowColor = "rgb(0 0 0 / 0.15)";
  context.shadowBlur = 2;
  context.shadowOffsetY = 1;
  context.fillStyle = "#ffffff";
  context.fill(glyph);
  context.shadowColor = "transparent";
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = BLUE;
  context.stroke(glyph);
  context.restore();
};

const drawBadge = (label) => {
  context.save();
  const font = "600 " + Math.round(15 * ui) + "px system-ui, -apple-system, sans-serif";
  context.font = font;
  const padding = 10 * ui;
  const arrow = 7 * ui;
  const gap = 6 * ui;
  const textWidth = context.measureText(label).width;
  const badgeWidth = padding * 2 + arrow * 2 + gap + textWidth;
  const badgeHeight = 30 * ui;
  const margin = 16 * ui;
  const left = WIDTH - margin - badgeWidth;
  const top = HEIGHT - margin - badgeHeight;
  context.fillStyle = "rgb(0 0 0 / 0.62)";
  context.beginPath();
  context.roundRect(left, top, badgeWidth, badgeHeight, badgeHeight / 2);
  context.fill();
  context.fillStyle = "#ffffff";
  const middle = top + badgeHeight / 2;
  const half = arrow * 0.8;
  for (const offset of [0, arrow]) {
    const start = left + padding + offset;
    context.beginPath();
    context.moveTo(start, middle - half);
    context.lineTo(start + arrow, middle);
    context.lineTo(start, middle + half);
    context.closePath();
    context.fill();
  }
  context.textBaseline = "middle";
  context.fillText(label, left + padding + arrow * 2 + gap, middle + ui);
  context.restore();
};

const encoded = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

window.composeFrame = async (frame) => {
  await seek(frame.seek);
  context.drawImage(video, 0, 0, WIDTH, HEIGHT);
  if (frame.cursor) {
    drawCursor(frame.cursor);
  }
  if (frame.badge) {
    drawBadge(frame.badge);
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) {
    throw new Error("The frame could not be encoded.");
  }
  return encoded(blob);
};
</script>
</body></html>`;
