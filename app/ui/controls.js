// Drehregler und Schieberegler. set() aktualisiert nur die Anzeige (für Automation),
// onInput feuert nur bei Bedienung durch den Nutzer.

const NS = 'http://www.w3.org/2000/svg';
const ARC_START = -135;
const ARC_END = 135;

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx, cy, r, from, to) {
  if (Math.abs(to - from) < 0.5) return '';
  const [x1, y1] = polar(cx, cy, r, Math.min(from, to));
  const [x2, y2] = polar(cx, cy, r, Math.max(from, to));
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2}`;
}

export class Knob {
  /**
   * @param opts { label, min, max, center (Wert bei 12 Uhr), value, onInput, format }
   */
  constructor(opts) {
    Object.assign(this, { min: -1, max: 1, center: 0, value: 0, ...opts });
    this.def = this.value;
    this.el = document.createElement('div');
    this.el.className = 'knob';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    const mk = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      svg.appendChild(e);
      return e;
    };
    mk('path', { class: 'track', d: arcPath(20, 20, 17, ARC_START, ARC_END), fill: 'none', 'stroke-width': 2 });
    this.valArc = mk('path', { class: 'val', fill: 'none', 'stroke-width': 2 });
    mk('circle', { class: 'body', cx: 20, cy: 20, r: 12.5, 'stroke-width': 1 });
    this.ptr = mk('line', { class: 'ptr', x1: 20, y1: 20, x2: 20, y2: 10, 'stroke-width': 2, 'stroke-linecap': 'round' });
    this.el.appendChild(svg);
    const lab = document.createElement('label');
    lab.textContent = this.label;
    this.el.appendChild(lab);
    this.el.title = this.label;
    this._bind();
    this.set(this.value);
  }

  _angle(v) {
    const { min, max, center } = this;
    let n;
    if (v < center) n = 0.5 * ((v - min) / (center - min));
    else n = 0.5 + 0.5 * ((v - center) / (max - center || 1));
    return ARC_START + Math.max(0, Math.min(1, n)) * (ARC_END - ARC_START);
  }

  _fromNorm(n) {
    const { min, max, center } = this;
    n = Math.max(0, Math.min(1, n));
    return n < 0.5 ? min + (n / 0.5) * (center - min) : center + ((n - 0.5) / 0.5) * (max - center);
  }

  _norm(v) {
    return (this._angle(v) - ARC_START) / (ARC_END - ARC_START);
  }

  set(v) {
    if (this.dragging) return;
    this._draw(v);
  }

  _draw(v) {
    this.value = v;
    const ang = this._angle(v);
    this.valArc.setAttribute('d', arcPath(20, 20, 17, 0, ang));
    this.ptr.setAttribute('transform', `rotate(${ang} 20 20)`);
    this.el.classList.toggle('killed', this.killAt !== undefined && v <= this.killAt);
    this.el.title = `${this.label}: ${this.format ? this.format(v) : v.toFixed(2)}`;
  }

  _emit(v) {
    // an der Mitte leicht einrasten
    if (Math.abs(this._norm(v) - 0.5) < 0.015) v = this.center;
    this._draw(v);
    this.onInput?.(v);
  }

  _bind() {
    let startY = 0;
    let startN = 0;
    this.el.addEventListener('pointerdown', (e) => {
      this.el.setPointerCapture(e.pointerId);
      this.dragging = true;
      startY = e.clientY;
      startN = this._norm(this.value);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const fine = e.shiftKey ? 0.25 : 1;
      this._emit(this._fromNorm(startN + ((startY - e.clientY) / 160) * fine));
    });
    const end = () => (this.dragging = false);
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    this.el.addEventListener('dblclick', () => this._emit(this.def));
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._emit(this._fromNorm(this._norm(this.value) - Math.sign(e.deltaY) * 0.03));
    }, { passive: false });
  }
}

export class Slider {
  /** @param el Container (.slider.v oder .slider.h), opts { value 0..1, onInput } */
  constructor(el, opts = {}) {
    this.el = el;
    this.vertical = el.classList.contains('v');
    this.onInput = opts.onInput;
    this.def = opts.value ?? 0.5;
    el.innerHTML = '<div class="rail"></div><div class="cap"></div>';
    this.cap = el.querySelector('.cap');
    this.set(this.def);
    const move = (e) => {
      const r = el.getBoundingClientRect();
      const pad = 4;
      const n = this.vertical
        ? 1 - (e.clientY - r.top - pad) / (r.height - 2 * pad)
        : (e.clientX - r.left - pad) / (r.width - 2 * pad);
      this._emit(Math.max(0, Math.min(1, n)));
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.dragging = true;
      move(e);
    });
    el.addEventListener('pointermove', (e) => this.dragging && move(e));
    el.addEventListener('pointerup', () => (this.dragging = false));
    el.addEventListener('pointercancel', () => (this.dragging = false));
    el.addEventListener('dblclick', () => this._emit(this.def));
  }

  set(v) {
    if (this.dragging) return;
    this._draw(v);
  }

  _draw(v) {
    this.value = v;
    const pct = `calc(4px + (100% - 8px) * ${this.vertical ? 1 - v : v})`;
    if (this.vertical) this.cap.style.top = pct;
    else this.cap.style.left = pct;
  }

  _emit(v) {
    if (!this.vertical && Math.abs(v - 0.5) < 0.02) v = 0.5;
    this._draw(v);
    this.onInput?.(v);
  }
}
