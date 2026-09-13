/**
 * Headless canvas stub. Vitest runs in jsdom, which has no 2D backend, so we
 * record draw calls instead of rasterising. That is enough to assert that the
 * chart paints the right *number* of primitives and never throws.
 */

export interface DrawOp {
  op: string;
  args: unknown[];
}

export interface FakeCtx {
  ops: DrawOp[];
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  font: string;
  textAlign: string;
  canvas: unknown;
  measureText: (text: string) => { width: number };
  counts: () => Record<string, number>;
}

export function installCanvasStub(): void {
  (globalThis as Record<string, unknown>).__canvasOps = [];
  const proto = (globalThis as unknown as { HTMLCanvasElement: { prototype: unknown } }).HTMLCanvasElement?.prototype;
  if (!proto) return;
  Object.defineProperty(proto, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement) {
      const ops: DrawOp[] = (globalThis as unknown as { __canvasOps: DrawOp[] }).__canvasOps;
      const ctx: Partial<FakeCtx> & Record<string, unknown> = {
        ops,
        canvas: this,
        fillStyle: '#000',
        strokeStyle: '#000',
        lineWidth: 1,
        font: '11px sans-serif',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        globalAlpha: 1,
      };
      const methods = [
        'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'rect',
        'arc', 'arcTo', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'clip',
        'save', 'restore', 'setTransform', 'transform', 'translate', 'scale', 'rotate', 'setLineDash',
        'fillText', 'strokeText', 'drawImage', 'createPattern', 'resetTransform',
      ];
      for (const name of methods) {
        ctx[name] = (...args: unknown[]) => {
          ops.push({ op: name, args });
          return undefined;
        };
      }
      ctx.measureText = (text: string) => ({ width: String(text).length * 6 });
      ctx.createLinearGradient = () => ({ addColorStop: () => undefined });
      ctx.createRadialGradient = () => ({ addColorStop: () => undefined });
      ctx.counts = () => {
        const out: Record<string, number> = {};
        for (const op of ops) out[op.op] = (out[op.op] ?? 0) + 1;
        return out;
      };
      return ctx as unknown as CanvasRenderingContext2D;
    },
  });
  Object.defineProperty(proto, 'toDataURL', {
    configurable: true,
    value: () => 'data:image/png;base64,',
  });
}

export function canvasOps(): DrawOp[] {
  return (globalThis as unknown as { __canvasOps: DrawOp[] }).__canvasOps;
}

export function resetCanvasOps(): void {
  const ops = (globalThis as unknown as { __canvasOps: DrawOp[] }).__canvasOps;
  ops.length = 0;
}
