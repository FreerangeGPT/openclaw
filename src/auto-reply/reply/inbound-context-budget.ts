export type PromptContextText = {
  text: string;
  truncated: boolean;
  omittedChars: number;
  originalChars: number;
  maxChars: number;
};

export const DEFAULT_INBOUND_CONTEXT_BLOCK_MAX_CHARS = 24_000;
export const DEFAULT_INBOUND_CONTEXT_TOTAL_MAX_CHARS = 48_000;
export const DEFAULT_INBOUND_HISTORY_ENTRY_MAX_CHARS = 8_000;
export const DEFAULT_INBOUND_HISTORY_TOTAL_MAX_CHARS = 24_000;
export const DEFAULT_INBOUND_HISTORY_MAX_ENTRIES = 12;
export const DEFAULT_INBOUND_FILE_CONTEXT_ENTRY_MAX_CHARS = 16_000;
export const DEFAULT_INBOUND_FILE_CONTEXT_TOTAL_MAX_CHARS = 48_000;
export const DEFAULT_INBOUND_MEDIA_OUTPUT_ENTRY_MAX_CHARS = 16_000;
export const DEFAULT_INBOUND_MEDIA_OUTPUT_TOTAL_MAX_CHARS = 48_000;

const MIN_PROMPT_CONTEXT_LIMIT = 1_000;

export function resolvePromptContextLimit(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_PROMPT_CONTEXT_LIMIT) {
    return fallback;
  }
  return parsed;
}

export function truncatePromptContextText(
  value: string,
  params: {
    maxChars: number;
    label: string;
  },
): PromptContextText {
  const originalChars = value.length;
  if (originalChars <= params.maxChars) {
    return {
      text: value,
      truncated: false,
      omittedChars: 0,
      originalChars,
      maxChars: params.maxChars,
    };
  }
  const buildMarker = (omittedChars: number) =>
    `[OpenClaw truncated ${omittedChars.toLocaleString()} chars from ${params.label} to keep the prompt cache bounded.]`;
  let marker = buildMarker(originalChars - params.maxChars);
  let headMaxChars = Math.max(0, params.maxChars - marker.length - 2);
  let head = value.slice(0, headMaxChars).trimEnd();
  let omittedChars = Math.max(0, originalChars - head.length);
  marker = buildMarker(omittedChars);
  headMaxChars = Math.max(0, params.maxChars - marker.length - 2);
  head = value.slice(0, headMaxChars).trimEnd();
  omittedChars = Math.max(0, originalChars - head.length);
  const text = head ? [head, marker].join("\n\n") : marker.slice(0, params.maxChars);
  return {
    text,
    truncated: true,
    omittedChars,
    originalChars,
    maxChars: params.maxChars,
  };
}

export function truncatePromptContextEntries(
  entries: string[],
  params: {
    entryMaxChars: number;
    totalMaxChars: number;
    label: string;
  },
): {
  entries: PromptContextText[];
  omittedEntries: number;
  totalOmittedChars: number;
} {
  const outputReversed: PromptContextText[] = [];
  let remaining = params.totalMaxChars;
  let omittedEntries = 0;
  let totalOmittedChars = 0;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] ?? "";
    if (remaining <= 0) {
      omittedEntries += 1;
      totalOmittedChars += entry.length;
      continue;
    }
    const maxChars = Math.min(params.entryMaxChars, remaining);
    const truncated = truncatePromptContextText(entry, {
      maxChars,
      label: `${params.label} ${i + 1}`,
    });
    outputReversed.push(truncated);
    remaining = Math.max(0, remaining - truncated.text.length);
    totalOmittedChars += truncated.omittedChars;
  }

  return {
    entries: outputReversed.toReversed(),
    omittedEntries,
    totalOmittedChars,
  };
}
