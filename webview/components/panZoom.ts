/** Pan, zoom and fit for an SVG canvas: the transform state and the wheel / drag handlers both diagram views share. */
import { useRef, useState } from 'preact/hooks';
import { fitTransform } from '../diagram';

export interface Transform {
  k: number;
  x: number;
  y: number;
}

export interface PanZoom {
  tf: Transform;
  setTf: (tf: Transform) => void;
  /** scale by `factor` around a viewport point (default: the centre) */
  zoom: (factor: number, cx?: number, cy?: number) => void;
  /** fit a laid-out graph into the viewport, never below `minScale`: an axis that then overflows aligns to the top / left */
  fitTo: (graph: { width: number; height: number }) => void;
  /** fit the width, align the top */
  fitWidth: (graph: { width: number; height: number }) => void;
  onWheel: (e: WheelEvent) => void;
  /** starts a pan unless the press lands inside an element matching `ignore` */
  onMouseDown: (e: MouseEvent) => void;
}

/** the transform of an empty canvas, and of a graph without a size */
const HOME: Transform = { k: 1, x: 20, y: 20 };

export function usePanZoom(size: { width: number; height: number }, ignore: string, opts: { minScale?: number } = {}): PanZoom {
  const [tf, setTf] = useState<Transform>(HOME);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const zoom = (factor: number, cx?: number, cy?: number) => {
    setTf((t) => {
      const k = Math.max(0.1, Math.min(4, t.k * factor));
      const px = cx ?? size.width / 2;
      const py = cy ?? size.height / 2;
      return { k, x: px - ((px - t.x) * k) / t.k, y: py - ((py - t.y) * k) / t.k };
    });
  };

  const fitTo = (graph: { width: number; height: number }) => {
    if (graph.width <= 0 || graph.height <= 0) {
      setTf(HOME);
      return;
    }
    const f = fitTransform(graph, size.width, size.height);
    const k = Math.max(opts.minScale ?? 0, f.k);
    // when the graph fits this is plain centring; when the clamp raised the scale, the overflowing
    // axis starts at the margin instead, so a long script reads from its first statement
    setTf({ k, x: Math.max(20, (size.width - graph.width * k) / 2), y: Math.max(20, (size.height - graph.height * k) / 2) });
  };

  const fitWidth = (graph: { width: number; height: number }) => {
    if (graph.width <= 0 || graph.height <= 0) {
      setTf(HOME);
      return;
    }
    const k = Math.min(1.5, Math.max(opts.minScale ?? 0.1, (size.width - 40) / graph.width));
    setTf({ k, x: Math.max(20, (size.width - graph.width * k) / 2), y: 20 });
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
  };

  const onMouseDown = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(ignore)) return;
    drag.current = { x: e.clientX, y: e.clientY, tx: tf.x, ty: tf.y };
    const move = (ev: MouseEvent) => {
      if (!drag.current) return;
      setTf((t) => ({ ...t, x: drag.current!.tx + ev.clientX - drag.current!.x, y: drag.current!.ty + ev.clientY - drag.current!.y }));
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return { tf, setTf, zoom, fitTo, fitWidth, onWheel, onMouseDown };
}
