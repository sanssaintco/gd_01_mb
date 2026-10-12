// Side panel that shows a rendered gray image (print preview / full render / seam diff) with a
// caption. Display only; the PDF uses the raw gray buffer.

export class PrintPanel {
  private el: HTMLDivElement;
  private body: HTMLDivElement;
  private caption: HTMLPreElement;
  private actions: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'print-panel';
    this.el.hidden = true;
    const close = document.createElement('button');
    close.textContent = '×';
    close.className = 'print-panel-close';
    close.onclick = () => (this.el.hidden = true);
    this.body = document.createElement('div');
    this.body.className = 'print-panel-body';
    this.caption = document.createElement('pre');
    this.actions = document.createElement('div');
    this.el.append(close, this.body, this.caption, this.actions);
    parent.append(this.el);
  }

  show(content: HTMLCanvasElement | HTMLImageElement, caption: string, actions: Record<string, () => void> = {}) {
    this.body.replaceChildren(content);
    this.caption.textContent = caption;
    this.actions.replaceChildren(
      ...Object.entries(actions).map(([label, fn]) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = fn;
        return b;
      }),
    );
    this.el.hidden = false;
  }

  message(text: string) {
    this.body.replaceChildren();
    this.caption.textContent = text;
    this.actions.replaceChildren();
    this.el.hidden = false;
  }
}
