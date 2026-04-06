/**
 * Platform adapter registry
 * Detects which AI platform the user is on and returns the appropriate adapter.
 */

export interface PlatformAdapter {
  name: string;
  getInputElement(): HTMLElement | null;
  getSubmitButton(): HTMLElement | null;
  getResponseContainer(): HTMLElement | null;
  extractInputText(el: HTMLElement): string;
  isResponseNode(node: Node): boolean;
  extractResponseText(el: HTMLElement): string;
}

// Claude.ai adapter
const claude: PlatformAdapter = {
  name: 'claude',
  getInputElement() {
    return document.querySelector<HTMLElement>(
      '[contenteditable="true"].ProseMirror, div[contenteditable="true"][data-placeholder]'
    );
  },
  getSubmitButton() {
    return document.querySelector<HTMLElement>(
      'button[aria-label="Send Message"], button[aria-label="Send message"], fieldset button[type="button"]:last-child'
    );
  },
  getResponseContainer() {
    return document.querySelector<HTMLElement>(
      '[data-testid="conversation-turn-list"], .font-claude-message, main'
    );
  },
  extractInputText(el: HTMLElement): string {
    return el.textContent?.trim() ?? '';
  },
  isResponseNode(node: Node): boolean {
    if (!(node instanceof HTMLElement)) return false;
    return node.matches?.('[data-is-streaming], .font-claude-message') ?? false;
  },
  extractResponseText(el: HTMLElement): string {
    return el.textContent?.trim() ?? '';
  },
};

// ChatGPT adapter
const chatgpt: PlatformAdapter = {
  name: 'chatgpt',
  getInputElement() {
    return document.querySelector<HTMLElement>(
      '#prompt-textarea, textarea[data-id="root"], div[contenteditable="true"][id="prompt-textarea"]'
    );
  },
  getSubmitButton() {
    return document.querySelector<HTMLElement>(
      'button[data-testid="send-button"], button[aria-label="Send prompt"]'
    );
  },
  getResponseContainer() {
    return document.querySelector<HTMLElement>(
      'main .flex.flex-col, [role="presentation"]'
    );
  },
  extractInputText(el: HTMLElement): string {
    if (el instanceof HTMLTextAreaElement) return el.value.trim();
    return el.textContent?.trim() ?? '';
  },
  isResponseNode(node: Node): boolean {
    if (!(node instanceof HTMLElement)) return false;
    return node.querySelector?.('[data-message-author-role="assistant"]') !== null;
  },
  extractResponseText(el: HTMLElement): string {
    const msg = el.querySelector('[data-message-author-role="assistant"]');
    return msg?.textContent?.trim() ?? el.textContent?.trim() ?? '';
  },
};

// Gemini adapter
const gemini: PlatformAdapter = {
  name: 'gemini',
  getInputElement() {
    return document.querySelector<HTMLElement>(
      '.ql-editor, rich-textarea .textarea, div[contenteditable="true"][aria-label]'
    );
  },
  getSubmitButton() {
    return document.querySelector<HTMLElement>(
      'button[aria-label="Send message"], .send-button, button.send'
    );
  },
  getResponseContainer() {
    return document.querySelector<HTMLElement>(
      '.conversation-container, message-list'
    );
  },
  extractInputText(el: HTMLElement): string {
    return el.textContent?.trim() ?? '';
  },
  isResponseNode(node: Node): boolean {
    if (!(node instanceof HTMLElement)) return false;
    return node.matches?.('model-response, .model-response-text') ?? false;
  },
  extractResponseText(el: HTMLElement): string {
    return el.textContent?.trim() ?? '';
  },
};

const adapters: PlatformAdapter[] = [claude, chatgpt, gemini];

export function detectPlatform(): PlatformAdapter | null {
  const host = location.hostname;
  if (host === 'claude.ai') return claude;
  if (host === 'chatgpt.com' || host === 'chat.openai.com') return chatgpt;
  if (host === 'gemini.google.com') return gemini;
  return null;
}
