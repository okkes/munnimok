// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { gestureBelongsToContent } from './Sheet';

/** a sheet body with one child, returns [body, child] */
function bodyWith(html: string): [HTMLElement, HTMLElement] {
  const body = document.createElement('div');
  body.innerHTML = html;
  document.body.appendChild(body);
  return [body, body.querySelector('[data-probe]') as HTMLElement];
}

describe('#364: which gestures the sheet drag leaves to the content', () => {
  it('a text field, a textarea and plain content arm the drag — a pull-down from the amount input closes the sheet', () => {
    for (const html of [
      '<input data-probe type="text" />',
      '<input data-probe inputmode="decimal" />',
      '<textarea data-probe></textarea>',
      '<p data-probe>plain</p>',
    ]) {
      const [body, target] = bodyWith(html);
      expect(gestureBelongsToContent(target, body), html).toBe(false);
    }
  });

  it('a slider, a native picker and a self-handling element keep their own gesture', () => {
    for (const html of [
      '<input data-probe type="range" />',
      '<select data-probe><option>a</option></select>',
      '<div data-sheet-no-drag><span data-probe>wheel</span></div>',
      '<div contenteditable="true" data-probe>rich</div>',
    ]) {
      const [body, target] = bodyWith(html);
      expect(gestureBelongsToContent(target, body), html).toBe(true);
    }
  });

  it('a list scrolled away from its top scrolls; at the top it drags', () => {
    const [body, target] = bodyWith('<div data-probe style="overflow-y: auto"><p>row</p></div>');
    Object.defineProperty(target, 'scrollHeight', { value: 400, configurable: true });
    Object.defineProperty(target, 'clientHeight', { value: 100, configurable: true });
    target.scrollTop = 0;
    expect(gestureBelongsToContent(target, body)).toBe(false);
    Object.defineProperty(target, 'scrollTop', { value: 40, configurable: true });
    expect(gestureBelongsToContent(target, body)).toBe(true);
  });
});
