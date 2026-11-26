import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { confirmClose, confirmDialog } from '../src/close-dialog.ts';

for (const [button, expected] of [['cancel', false], ['discard', true]]) {
  test(`close dialog ${button} resolves ${expected}`, async () => {
    const { document } = new JSDOM('<body></body>').window;
    const shown = [];
    document.defaultView.HTMLDialogElement.prototype.showModal = function () { shown.push(this); };
    document.defaultView.HTMLDialogElement.prototype.close = function () { this.dispatchEvent(new document.defaultView.Event('close')); };
    const result = confirmClose(document, 'Unsaved work');
    assert.equal(shown.length, 1);
    assert.match(shown[0].textContent, /Unsaved work/);
    shown[0].querySelector(`[data-action="${button}"]`).click();
    assert.equal(await result, expected);
    assert.equal(document.querySelector('dialog'), null);
  });
}


test('shared confirmation uses action-specific labels and rejects overlapping dialogs', async () => {
  const { document } = new JSDOM('<body></body>').window;
  document.defaultView.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  document.defaultView.HTMLDialogElement.prototype.close = function () { this.dispatchEvent(new document.defaultView.Event('close')); };
  const first = confirmDialog(document, 'Replace disk contents?', { title: 'Overwrite?', acceptLabel: 'Overwrite' });
  assert.equal(document.querySelector('h2').textContent, 'Overwrite?');
  assert.equal(document.querySelector('[data-action="discard"]').textContent, 'Overwrite');
  assert.equal(await confirmClose(document, 'close?'), false);
  document.querySelector('[data-action="cancel"]').click();
  assert.equal(await first, false);
});

test('dialog display failure rejects and removes the dialog', async () => {
  const { document } = new JSDOM('<body></body>').window;
  document.defaultView.HTMLDialogElement.prototype.showModal = function () { throw new Error('unavailable'); };
  await assert.rejects(confirmClose(document, 'close?'), /unavailable/);
  assert.equal(document.querySelector('dialog'), null);
});
