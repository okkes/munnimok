// The wizard page is one file; these read it the way a browser would meet it.
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../setup/index.html', import.meta.url), 'utf8');
const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = css
  .split('}')
  .map((rule) => rule.split('{')[0])
  .flatMap((list) => list.split(','))
  .map((selector) => selector.trim())
  .filter((selector) => selector && !selector.startsWith('@'));

test('#625: a state the stepper puts on a step as a class has no rule of its own — a to-do LIST once restyled every step that was "todo"', () => {
  const states = /const chips = \{([^}]*)\}/.exec(html)?.[1].match(/\b[a-z]+(?=:)/g) ?? [];
  assert.deepEqual(states, ['done', 'progress', 'todo', 'none'], 'the stepper names its states in `chips`');
  for (const state of states) {
    const bare = new RegExp(String.raw`(^|[\s>+~])\.${state}(?![\w-])`);
    const hits = selectors.filter((selector) => bare.test(selector));
    assert.deepEqual(hits, [], `.${state} is styled on its own; scope the rule to its component (ul.${state}, .step.${state})`);
  }
});
