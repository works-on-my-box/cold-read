// Names people know for the model IDs of the one-click run (MODEL_PREFERENCE in src/logic.js), for the line
// "Read by … via Forge LLMs" under the result. An ID that is not in the table is shown as it is.
const MODEL_NAMES = {
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
};

export const modelName = (id) => MODEL_NAMES[id] ?? String(id ?? '');
