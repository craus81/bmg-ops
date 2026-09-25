/**
 * The bottom bar's AI tab and the chat panel (AiChat) live in different
 * component trees, so they talk through two window events.
 */

/** Ask the chat panel to open, or close if it is already open. */
export const AI_CHAT_TOGGLE_EVENT = 'fleetsuite:ai-chat-toggle';

/** The chat panel announces open/closed so the AI tab can highlight. detail: { open: boolean } */
export const AI_CHAT_STATE_EVENT = 'fleetsuite:ai-chat-state';
