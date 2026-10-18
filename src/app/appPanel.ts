// The app UI: the only controls a poster maker gets. Their details (name the PDF), framing
// (orbit/zoom/pan on the canvas plus a focal-length slider), the directions of key, fill and rim
// light, reset, and the PDF export.
// Plain DOM; styles live in index.html (.app-panel).

import { type LightName, SHOT_LIMITS } from '../config/shot';
import { type Student, missingFields, pdfFilename } from '../config/student';
import { focalFromFov } from '../render/passes';
import { saveStored } from '../viewer/storage';
import type { ShotController } from './shot';

export type ExportProgress =
  | { phase: 'render'; done: number; total: number }
  | { phase: 'pdf' }
  | { phase: 'done'; filename: string };

export const STUDENT_STORAGE_KEY = 'student.v1';

export interface AppPanelOptions {
  shot: ShotController;
  /** Live object: edited in place and persisted under STUDENT_STORAGE_KEY. */
  student: Student;
  /** e.g. "A2 · 420 × 594 mm" */
  formatLabel: string;
  exportPdf: (onProgress: (p: ExportProgress) => void) => Promise<unknown>;
}

const LIGHTS: Array<{ name: LightName; title: string; hint: string }> = [
  { name: 'key', title: 'Key light', hint: 'The main light. It carves the shadows.' },
  { name: 'fill', title: 'Fill light', hint: 'Softens the shadow side.' },
  { name: 'rim', title: 'Rim light', hint: 'Edge light from behind.' },
];

/** Focal slider position 0…1000 ↔ mm, logarithmic so wide and long lenses get equal room. */
const F = SHOT_LIMITS.focalMm;
const focalToPos = (mm: number) => (1000 * Math.log(mm / F.min)) / Math.log(F.max / F.min);
const posToFocal = (pos: number) => F.min * (F.max / F.min) ** (pos / 1000);

export class AppPanel {
  readonly el: HTMLElement;
  private refreshers: Array<() => void> = [];
  private exportBtn!: HTMLButtonElement;
  private progressEl!: HTMLElement;
  private progressBar!: HTMLElement;
  private progressText!: HTMLElement;
  private filenameEl!: HTMLElement;
  private exporting = false;

  constructor(
    parent: HTMLElement,
    private opts: AppPanelOptions,
  ) {
    this.el = h('aside', 'app-panel');
    this.el.append(
      this.header(),
      this.detailsSection(),
      this.framingSection(),
      this.lightSection(),
      this.footer(),
    );
    parent.append(this.el);
    opts.shot.onChange(() => this.refresh());
    this.refresh();
    this.updateExportState();
  }

  refresh() {
    for (const r of this.refreshers) r();
  }

  private header() {
    const head = h('header', 'app-head');
    head.append(h('div', 'app-title', 'David'), h('div', 'app-sub', `Poster · ${this.opts.formatLabel}`));
    return head;
  }

  private detailsSection() {
    const s = section('Your details');
    const st = this.opts.student;
    const field = (key: keyof Student, label: string, attrs: Record<string, string>) => {
      const row = h('label', 'app-field');
      const input = document.createElement('input');
      input.type = 'text';
      input.spellcheck = false;
      for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
      input.value = st[key];
      input.oninput = () => {
        st[key] = input.value;
        saveStored(STUDENT_STORAGE_KEY, st);
        this.updateExportState();
      };
      row.append(h('span', '', label), input);
      return row;
    };
    s.append(
      field('forename', 'Forename', { autocomplete: 'given-name' }),
      field('surname', 'Surname', { autocomplete: 'family-name' }),
      field('studentNumber', 'Student number', { inputmode: 'numeric', autocomplete: 'off' }),
    );
    this.filenameEl = h('p', 'app-hint app-filename');
    s.append(this.filenameEl);
    return s;
  }

  /** Export needs all three details; shows the resulting file name. */
  private updateExportState() {
    const missing = missingFields(this.opts.student);
    this.filenameEl.textContent = missing.length
      ? 'Enter your name and student number to export.'
      : `File: ${pdfFilename(this.opts.student)}`;
    this.filenameEl.classList.toggle('is-ready', missing.length === 0);
    this.exportBtn.disabled = this.exporting || missing.length > 0;
  }

  private framingSection() {
    const s = section('Framing');
    s.append(h('p', 'app-hint', 'Drag to orbit · scroll to zoom · right-drag to pan'));
    const shot = this.opts.shot;
    s.append(
      this.slider({
        label: 'Focal length',
        min: 0,
        max: 1000,
        step: 1,
        get: () => focalToPos(this.focal()),
        set: (v) => shot.setFocal(posToFocal(v)),
        format: () => `${Math.round(this.focal())} mm`,
      }),
    );
    return s;
  }

  private lightSection() {
    const s = section('Light');
    const shot = this.opts.shot;
    for (const l of LIGHTS) {
      const group = h('div', 'app-light');
      group.append(h('h3', '', l.title), h('p', 'app-hint', l.hint));
      group.append(
        this.slider({
          label: 'Direction',
          ...SHOT_LIMITS.azimuthDeg,
          step: 1,
          get: () => shot.get().lights[l.name].azimuthDeg,
          set: (v) => shot.setLight(l.name, 'azimuthDeg', v),
          format: (v) => `${Math.round(v)}°`,
        }),
        this.slider({
          label: 'Height',
          ...SHOT_LIMITS.elevationDeg,
          step: 1,
          get: () => shot.get().lights[l.name].elevationDeg,
          set: (v) => shot.setLight(l.name, 'elevationDeg', v),
          format: (v) => `${Math.round(v)}°`,
        }),
      );
      s.append(group);
    }
    return s;
  }

  private footer() {
    const f = h('footer', 'app-foot');
    this.exportBtn = h('button', 'app-btn app-btn-primary', 'Export PDF') as HTMLButtonElement;
    this.exportBtn.onclick = () => this.runExport();
    const reset = h('button', 'app-btn app-btn-ghost', 'Reset shot') as HTMLButtonElement;
    reset.onclick = () => this.opts.shot.reset();
    this.progressEl = h('div', 'app-progress');
    this.progressEl.hidden = true;
    this.progressBar = h('div', 'app-progress-bar');
    const track = h('div', 'app-progress-track');
    track.append(this.progressBar);
    this.progressText = h('div', 'app-progress-text');
    this.progressEl.append(track, this.progressText);
    f.append(this.exportBtn, reset, this.progressEl);
    f.append(h('p', 'app-hint', 'Print-ready PDF/X-4 (CMYK, FOGRA39) with 3 mm bleed. Rendering takes about a minute.'));
    return f;
  }

  private async runExport() {
    if (missingFields(this.opts.student).length) return;
    this.exporting = true;
    this.updateExportState();
    this.progressEl.hidden = false;
    this.progressEl.classList.remove('is-error');
    const show = (fraction: number, text: string) => {
      this.progressBar.style.width = `${Math.round(fraction * 100)}%`;
      this.progressText.textContent = text;
    };
    show(0, 'Preparing…');
    try {
      await this.opts.exportPdf((p) => {
        if (p.phase === 'render') show((0.9 * p.done) / p.total, `Rendering poster… ${Math.round((100 * p.done) / p.total)} %`);
        else if (p.phase === 'pdf') show(0.95, 'Building PDF…');
        else show(1, `Saved ${p.filename}`);
      });
    } catch (err) {
      this.progressEl.classList.add('is-error');
      show(1, `Export failed: ${(err as Error).message}`);
    } finally {
      this.exporting = false;
      this.updateExportState();
    }
  }

  private focal() {
    return focalFromFov(this.opts.shot.get().camera.printFovDeg);
  }

  private slider(o: {
    label: string;
    min: number;
    max: number;
    step: number;
    get: () => number;
    set: (v: number) => void;
    format: (v: number) => string;
  }) {
    const row = h('label', 'app-slider');
    const top = h('div', 'app-slider-top');
    const out = h('output', 'app-slider-value');
    top.append(h('span', '', o.label), out);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(o.min);
    input.max = String(o.max);
    input.step = String(o.step);
    input.oninput = () => {
      o.set(Number(input.value));
      out.textContent = o.format(o.get());
    };
    row.append(top, input);
    this.refreshers.push(() => {
      const v = o.get();
      if (document.activeElement !== input) input.value = String(v);
      out.textContent = o.format(v);
    });
    return row;
  }
}

function h(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function section(title: string) {
  const s = h('section', 'app-section');
  s.append(h('h2', '', title));
  return s;
}
