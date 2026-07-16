/**
 * Entry point. Starts the local server and opens the UI in the default browser.
 *
 * The app is a browser page served from loopback rather than a native window:
 * the scraping has to happen in a local process (a web page can't fetch
 * google.com cross-origin), but the interface itself is just HTML, and shipping
 * a whole Chromium to render it would be absurd.
 */

import { exec } from 'node:child_process';
import { startServer } from './server.ts';
import { OUTPUT_DIR } from './jobs.ts';

const PREFERRED_PORT = 4317;

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${command} ${JSON.stringify(url)}`);
}

/** Try a few ports: a stale instance shouldn't stop a new one from starting. */
async function listen(): Promise<string> {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + 10; port++) {
    try {
      return await startServer(port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No free port between 4317 and 4326.');
}

const url = await listen();
console.log(`Places Scraper running at ${url}`);
console.log(`Exports go to ${OUTPUT_DIR}`);
if (!process.env.PROXY_URLS) {
  console.log('\nNo proxies configured — requests go out from this machine\'s IP.');
  console.log('Fine for small runs. For sustained use set PROXY_URLS.');
}
if (!process.env.NO_OPEN) openBrowser(url);
