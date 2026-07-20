/**
 * Native desktop notifications, so a days-long build reports its milestones
 * without anyone keeping a browser tab open. macOS only (osascript); on other
 * platforms this is a silent no-op rather than a failure.
 */

import { exec } from 'node:child_process';

export function notify(title: string, message: string): void {
  if (process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  exec(
    `osascript -e "display notification \\"${esc(message)}\\" with title \\"${esc(title)}\\""`,
    () => {
      // Notification failure is never worth surfacing.
    },
  );
}
