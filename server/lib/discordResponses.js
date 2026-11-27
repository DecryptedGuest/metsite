// Normalise Discord interaction responses so command output always uses a
// restrained Metropolitan Police Service embed rather than bare chat text.
const COLOURS = {
  error: 0xb94141,
  success: 0x287a55,
  warning: 0xb07a27,
  info: 0x34495e,
};

function classify(text) {
  const value = String(text || '').trim();
  if (/^(?:❌|⛔|🚫|<:[^:]+:\d+>\s*(?:error|denied|failed|could not|couldn't|cannot|not allowed))/i.test(value)
      || /\b(?:failed|could not|couldn't|not authorised|not authorized|denied|cannot be used|went wrong|error)\b/i.test(value)) return 'error';
  if (/^(?:✅|☑️|<:[^:]+:\d+>\s*(?:success|approved|completed|filed))/i.test(value)
      || /\b(?:successfully|has been submitted|approved|completed|was filed)\b/i.test(value)) return 'success';
  if (/^(?:⚠️|⏳|<:[^:]+:\d+>\s*(?:warning|pending))/i.test(value)
      || /\b(?:warning|pending|please try again|still processing)\b/i.test(value)) return 'warning';
  return 'info';
}

function toEmbedPayload(payload, method) {
  if (typeof payload === 'string') payload = { content: payload };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('content' in payload)) return payload;

  const content = payload.content;
  if (typeof content !== 'string' || !content.trim()) return payload;

  const embeds = Array.isArray(payload.embeds) ? [...payload.embeds] : [];
  const description = content.length > 4096 ? content.slice(0, 4093) + '...' : content;
  const kind = classify(content);
  const embed = {
    color: COLOURS[kind],
    description,
    footer: { text: 'Metropolitan Police Service' },
  };

  if (method === 'update' && embeds.length) embeds.push(embed);
  else embeds.push(embed);

  return { ...payload, content: null, embeds };
}

function installEmbedResponses(interaction) {
  if (!interaction || interaction.__mpsEmbedResponses) return interaction;
  Object.defineProperty(interaction, '__mpsEmbedResponses', { value: true });
  for (const method of ['reply', 'editReply', 'followUp', 'update']) {
    if (typeof interaction[method] !== 'function') continue;
    const original = interaction[method].bind(interaction);
    interaction[method] = (payload, ...rest) => original(toEmbedPayload(payload, method), ...rest);
  }
  return interaction;
}

module.exports = { installEmbedResponses, toEmbedPayload };
