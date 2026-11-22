import { AGENT_CURSOR_GLYPH } from "@contingency/protocol";

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
 * fast-forward badge. The cursor matches the Workspace's: the shared
 * `AGENT_CURSOR_GLYPH`, outlined in amber over a translucent amber fill, its
 * tip on the point, with the press ring beneath it.
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
const BRAND = "#ffc400";
const BRAND_FILL = "rgb(255 196 0 / 0.6)";
const video = document.getElementById("footage");
const canvas = document.getElementById("frame");
const context = canvas.getContext("2d");
const glyph = new Path2D(${JSON.stringify(AGENT_CURSOR_GLYPH.path)});
const GLYPH_SCALE = ${AGENT_CURSOR_GLYPH.size} / 24;
const GLYPH_TIP = ${JSON.stringify(AGENT_CURSOR_GLYPH.tip)};
const GLYPH_STROKE = ${AGENT_CURSOR_GLYPH.stroke};
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
    // The ring is amber at 45% before the press animates its opacity.
    context.globalAlpha = cursor.ringOpacity * 0.45;
    context.scale(cursor.ringScale, cursor.ringScale);
    context.beginPath();
    context.arc(0, 0, 15, 0, Math.PI * 2);
    context.fillStyle = BRAND;
    context.fill();
    context.restore();
  }
  context.globalAlpha = cursor.opacity;
  context.scale(cursor.glyphScale, cursor.glyphScale);
  context.scale(GLYPH_SCALE, GLYPH_SCALE);
  context.translate(-GLYPH_TIP.x, -GLYPH_TIP.y);
  context.lineWidth = GLYPH_STROKE / GLYPH_SCALE;
  context.lineJoin = "round";
  context.fillStyle = BRAND_FILL;
  context.fill(glyph);
  context.shadowColor = "rgb(0 0 0 / 0.35)";
  context.shadowBlur = 2;
  context.shadowOffsetY = 1;
  context.strokeStyle = BRAND;
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
