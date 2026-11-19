import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConversationId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function createConversationStore(directory) {
  const fileFor = (id) => path.join(directory, `${id}.json`);

  async function get(id) {
    if (!isConversationId(id)) return null;
    try {
      return JSON.parse(await readFile(fileFor(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  return {
    get,
    async list() {
      let names;
      try {
        names = await readdir(directory);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const items = await Promise.all(names
        .filter((name) => name.endsWith('.json') && isConversationId(name.slice(0, -5)))
        .map(async (name) => {
          const conversation = await get(name.slice(0, -5));
          if (!conversation) return null;
          return {
            id: conversation.id,
            title: conversation.title,
            updatedAt: conversation.updatedAt,
            messageCount: conversation.messages.length,
          };
        }));
      return items.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async save(conversation) {
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `${conversation.id}.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(conversation, null, 2), { flag: 'wx' });
      await rename(temporary, fileFor(conversation.id));
    },
  };
}

export function newConversation(firstMessage) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: firstMessage.replace(/\s+/g, ' ').slice(0, 36),
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}
