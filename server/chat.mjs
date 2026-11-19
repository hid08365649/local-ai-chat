export const MAX_MESSAGES = 20;
export const MAX_MESSAGE_LENGTH = 4000;
export function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    return { ok: false, error: `messages must contain 1-${MAX_MESSAGES} items` };
  }

  const messages = [];
  for (const item of value) {
    if (
      !item ||
      !['user', 'assistant'].includes(item.role) ||
      typeof item.content !== 'string' ||
      item.content.trim().length === 0 ||
      item.content.length > MAX_MESSAGE_LENGTH
    ) {
      return { ok: false, error: 'Each message needs a supported role and non-empty text' };
    }
    messages.push({ role: item.role, content: item.content });
  }

  if (messages.at(-1).role !== 'user') {
    return { ok: false, error: 'The last message must be from the user' };
  }

  return { ok: true, messages };
}
