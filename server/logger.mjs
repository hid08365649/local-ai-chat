import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function createFileLogger(directory, output = console.info, reportError = console.error) {
  let pending = Promise.resolve();
  return (event) => {
    const entry = { timestamp: new Date().toISOString(), ...event };
    const line = JSON.stringify(entry);
    output(line);
    pending = pending.then(async () => {
      await mkdir(directory, { recursive: true });
      await appendFile(path.join(directory, `${entry.timestamp.slice(0, 10)}.jsonl`), `${line}\n`);
    }).catch(() => reportError('Writing the local request log failed.'));
    return pending;
  };
}
