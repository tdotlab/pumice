/** Explicit in-document confirmation: WebKit window.confirm is not a safe guard. */
export function confirmDialog(document: Document, message: string, options: { title: string; acceptLabel: string }): Promise<boolean> {
  if (document.querySelector('dialog.close-dialog[open]')) return Promise.resolve(false);
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'close-dialog';
    dialog.setAttribute('aria-labelledby', 'close-dialog-title');
    const title = document.createElement('h2');
    title.id = 'close-dialog-title';
    title.textContent = options.title;
    const text = document.createElement('p');
    text.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'close-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    cancel.textContent = 'Cancel';
    cancel.autofocus = true;
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.dataset.action = 'discard';
    discard.textContent = options.acceptLabel;
    let accepted = false;
    cancel.addEventListener('click', () => dialog.close());
    discard.addEventListener('click', () => { accepted = true; dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(accepted); }, { once: true });
    actions.append(cancel, discard);
    dialog.append(title, text, actions);
    document.body.append(dialog);
    try { dialog.showModal(); } catch (error) { dialog.remove(); throw error; }
  });
}

export function confirmClose(document: Document, message: string): Promise<boolean> {
  return confirmDialog(document, message, { title: 'Discard unsaved changes?', acceptLabel: 'Discard and close' });
}
