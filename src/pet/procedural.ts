/**
 * Procedural canvas pet — the license-safe default renderer.
 * Draws a small orange cat in the frame's logical coordinate space, with a
 * pose per animation state and frame-index-driven motion (bob, hop, wave…).
 * Used when no spritesheet is shipped; a real atlas takes over automatically.
 */

import type { PetStateCfg, PetStateKey } from "./petEngine";

const BODY = "#E8A75D";
const BODY_DARK = "#C98B45";
const BELLY = "#F7D7AE";
const EAR_INNER = "#F4B183";
const INK = "#2B2B2B";
const CHEEK = "#F2A9A2";

interface Pose {
  /** Vertical bob offset (px, negative = higher). */
  bob: number;
  /** Horizontal lean (px). */
  lean: number;
  /** Eye style. */
  eyes: "open" | "wide" | "closed" | "happy" | "x" | "scan" | "sleep";
  /** Mouth style. */
  mouth: "smile" | "open" | "o" | "flat" | "frown";
  /** Paw raised (0 none, 1 left, 2 right). */
  paw?: 0 | 1 | 2;
  /** Sweat / tear drop. */
  drop?: boolean;
  /** "..." or "Zzz" floats. */
  float?: "dots" | "zzz";
}

function poseFor(state: PetStateKey, frame: number): Pose {
  switch (state) {
    case "run":
    case "running":
      return { bob: 0, lean: 4, eyes: "open", mouth: "open" };
    case "wave":
      return { bob: -2, lean: 0, eyes: "happy", mouth: "smile", paw: 2 };
    case "jump": {
      const arc = Math.sin((frame / 6) * Math.PI); // 0..1..0 over the jump
      return { bob: -arc * 26, lean: 0, eyes: "happy", mouth: "open" };
    }
    case "failed":
      return { bob: 2, lean: 3, eyes: "x", mouth: "frown", drop: true };
    case "waiting":
      return { bob: 0, lean: -2, eyes: "wide", mouth: "o", float: "dots" };
    case "review":
      return { bob: 0, lean: 0, eyes: "scan", mouth: "flat" };
    case "sleep":
      return { bob: 6, lean: 0, eyes: "sleep", mouth: "smile", float: "zzz" };
    case "idle":
    default: {
      const bob = Math.round(Math.sin((frame / 8) * Math.PI * 2) * 2);
      return { bob, lean: 0, eyes: "open", mouth: "smile" };
    }
  }
}

function drawEye(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  style: Pose["eyes"],
  frame: number,
) {
  ctx.save();
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  switch (style) {
    case "wide":
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "closed":
    case "sleep":
      ctx.beginPath();
      ctx.moveTo(x - 3.4, y);
      ctx.quadraticCurveTo(x, y + 2.4, x + 3.4, y);
      ctx.stroke();
      break;
    case "happy":
      ctx.beginPath();
      ctx.moveTo(x - 3.4, y + 1);
      ctx.quadraticCurveTo(x, y - 2.6, x + 3.4, y + 1);
      ctx.stroke();
      break;
    case "x":
      ctx.beginPath();
      ctx.moveTo(x - 2.6, y - 2.6);
      ctx.lineTo(x + 2.6, y + 2.6);
      ctx.moveTo(x + 2.6, y - 2.6);
      ctx.lineTo(x - 2.6, y + 2.6);
      ctx.stroke();
      break;
    case "scan":
      // eyes shift side to side
      ctx.beginPath();
      ctx.arc(x + (Math.floor(frame / 4) % 2 === 0 ? 1.6 : -1.6), y, 2, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "open":
    default:
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(x - 1, y - 1, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK;
      break;
  }
  ctx.restore();
}

function drawMouth(ctx: CanvasRenderingContext2D, x: number, y: number, style: Pose["mouth"]) {
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.beginPath();
  switch (style) {
    case "open":
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
      break;
    case "o":
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fillStyle = INK;
      ctx.fill();
      break;
    case "frown":
      ctx.moveTo(x - 3, y + 0.5);
      ctx.quadraticCurveTo(x, y + 3.5, x + 3, y + 0.5);
      ctx.stroke();
      break;
    case "flat":
      ctx.moveTo(x - 3, y);
      ctx.lineTo(x + 3, y);
      ctx.stroke();
      break;
    case "smile":
    default:
      ctx.moveTo(x - 3, y);
      ctx.quadraticCurveTo(x, y + 3, x + 3, y);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

export function drawProceduralPet(
  ctx: CanvasRenderingContext2D,
  state: PetStateKey,
  frame: number,
  _cfg: PetStateCfg,
  w: number,
  h: number,
) {
  const pose = poseFor(state, frame);
  const cx = w / 2 + pose.lean;
  const cy = h * 0.62 + pose.bob;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((pose.lean / 100) * 0.4);

  // Tail (behind body)
  ctx.save();
  ctx.strokeStyle = BODY_DARK;
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  const sway = Math.sin((frame / 8) * Math.PI * 2) * 4;
  ctx.beginPath();
  ctx.moveTo(-w * 0.22, h * 0.06);
  ctx.quadraticCurveTo(-w * 0.34, -h * 0.08, -w * 0.26 + sway, -h * 0.18 + sway * 0.6);
  ctx.stroke();
  ctx.restore();

  // Body
  ctx.fillStyle = BODY;
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.27, h * 0.19, 0, 0, Math.PI * 2);
  ctx.fill();
  // Belly
  ctx.fillStyle = BELLY;
  ctx.beginPath();
  ctx.ellipse(0, h * 0.06, w * 0.16, h * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();

  // Paws
  ctx.fillStyle = BODY_DARK;
  const legSwing = state === "run" || state === "running" ? (frame % 2 === 0 ? 3 : -3) : 0;
  ctx.beginPath();
  ctx.ellipse(-w * 0.13 + legSwing, h * 0.15, 5, 3.4, 0, 0, Math.PI * 2);
  ctx.ellipse(w * 0.13 - legSwing, h * 0.15, 5, 3.4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Head (in front of body, slightly up)
  const headY = -h * 0.14;
  ctx.fillStyle = BODY;
  ctx.beginPath();
  ctx.arc(0, headY, h * 0.145, 0, Math.PI * 2);
  ctx.fill();

  // Ears
  ctx.fillStyle = BODY;
  ctx.beginPath();
  ctx.moveTo(-h * 0.11, headY - h * 0.09);
  ctx.lineTo(-h * 0.13, headY - h * 0.19);
  ctx.lineTo(-h * 0.02, headY - h * 0.14);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(h * 0.11, headY - h * 0.09);
  ctx.lineTo(h * 0.13, headY - h * 0.19);
  ctx.lineTo(h * 0.02, headY - h * 0.14);
  ctx.closePath();
  ctx.fill();
  // Ear inner
  ctx.fillStyle = EAR_INNER;
  ctx.beginPath();
  ctx.moveTo(-h * 0.095, headY - h * 0.1);
  ctx.lineTo(-h * 0.105, headY - h * 0.165);
  ctx.lineTo(-h * 0.035, headY - h * 0.135);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(h * 0.095, headY - h * 0.1);
  ctx.lineTo(h * 0.105, headY - h * 0.165);
  ctx.lineTo(h * 0.035, headY - h * 0.135);
  ctx.closePath();
  ctx.fill();

  // Cheeks
  ctx.fillStyle = CHEEK;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(-h * 0.1, headY + h * 0.03, 3.2, 0, Math.PI * 2);
  ctx.arc(h * 0.1, headY + h * 0.03, 3.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Eyes
  const eyeY = headY - h * 0.02;
  drawEye(ctx, -h * 0.055, eyeY, pose.eyes, frame);
  drawEye(ctx, h * 0.055, eyeY, pose.eyes, frame);

  // Mouth
  drawMouth(ctx, 0, headY + h * 0.05, pose.mouth);

  // Raised paw
  if (pose.paw) {
    const dir = pose.paw === 2 ? 1 : -1;
    const raised = Math.sin((frame / 6) * Math.PI) * 3;
    ctx.fillStyle = BODY;
    ctx.beginPath();
    ctx.arc(dir * h * 0.13, headY + h * 0.04 - h * 0.1 + raised, 4.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Tear / sweat drop
  if (pose.drop) {
    ctx.fillStyle = "#7FB8E8";
    ctx.beginPath();
    ctx.arc(-h * 0.1, headY + h * 0.08, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Float text
  if (pose.float) {
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(43,43,43,0.75)";
    if (pose.float === "dots") {
      ctx.fillText("···", 0, headY - h * 0.2);
    } else {
      const bobZ = Math.sin((frame / 6) * Math.PI * 2) * 2;
      ctx.fillText("Z", h * 0.14, headY - h * 0.16 + bobZ);
      ctx.fillText("z", h * 0.2, headY - h * 0.1 + bobZ);
    }
  }

  ctx.restore();
}
