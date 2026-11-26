import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const INDEX_PATH = new URL('../../index.html', import.meta.url);

/**
 * Load the real shell markup into jsdom. Renderer modules are imported
 * directly by the tests because jsdom does not execute ES modules.
 */
export async function loadShellDom() {
  const html = await readFile(INDEX_PATH, 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
  return dom;
}
