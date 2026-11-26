/** Preserve invocation order: an older clean report must never arrive after an edit. */
export function createDirtyReporter(send: (dirty: boolean) => Promise<unknown>) {
  let pending: Promise<unknown> = Promise.resolve();
  const report = (dirty: boolean) => {
    pending = pending.catch(() => {}).then(() => send(dirty));
    // Observe failures so they do not become unhandled rejections.
    void pending.catch(error => console.error('Could not report editor state to native close guard', error));
  };
  report.flush = () => pending;
  return report;
}
