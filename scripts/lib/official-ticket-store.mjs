import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';

export const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
export const officialTicketStore = 'data/official-ticket-offers.json';

export async function updateOfficialTicketStore(update) {
  const lockPath = officialTicketStore + '.lock';
  const tmpPath = officialTicketStore + '.tmp';
  const lock = await open(lockPath, 'wx');
  try {
    const current = await readJSON(officialTicketStore);
    const next = await update(current);
    if (next !== current) {
      await writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n');
      await rename(tmpPath, officialTicketStore);
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
