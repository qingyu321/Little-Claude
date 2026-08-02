/**
 * Interview Provider Presets — pre-configured API settings for the
 * interview module's multi-modal pipeline.
 *
 * When mimo-v2.5-asr / mimo-v2.5-pro become unavailable, users can switch
 * to OpenAI GPT-4o Audio (single-hop) or a fully custom endpoint.
 */

export interface InterviewPreset {
  id: 'mimo' | 'openai' | 'custom';
  name: string;
  /** Answer (text) model name */
  model: string;
  /** ASR model name — empty for single-hop providers */
  asrModel: string;
  /** true = send audio + prompt in a single request (no separate ASR step) */
  isSingleHop: boolean;
  /** System prompt for the answer step */
  answerPrompt: string;
  maxTokens: number;
  temperature: number;
}

export const INTERVIEW_PRESETS: Record<string, InterviewPreset> = {
  mimo: {
    id: 'mimo',
    name: 'MIMO',
    model: 'mimo-v2.5-pro',
    asrModel: 'mimo-v2.5-asr',
    isSingleHop: false,
    answerPrompt:
      '你是一个面试助手。针对以下中文面试问题，用中文给出简洁清晰的答案（100字以内，适合口头作答）。',
    maxTokens: 512,
    temperature: 0,
  },
  openai: {
    id: 'openai',
    name: 'OpenAI GPT-4o Audio',
    model: 'gpt-4o-audio-preview',
    asrModel: '',
    isSingleHop: true,
    answerPrompt:
      'You are an interview assistant. Answer the following question briefly and clearly in Chinese (under 100 characters, suitable for oral delivery).',
    maxTokens: 512,
    temperature: 0.3,
  },
  custom: {
    id: 'custom',
    name: '自定义',
    model: '',
    asrModel: '',
    isSingleHop: false,
    answerPrompt:
      '你是一个面试助手。针对以下中文面试问题，用中文给出简洁清晰的答案（100字以内，适合口头作答）。',
    maxTokens: 512,
    temperature: 0,
  },
};

/** Apply preset values to a settings payload (skips id + name). */
export function applyPreset(
  preset: InterviewPreset,
): Omit<InterviewPreset, 'id' | 'name'> {
  const { id: _, name: __, ...fields } = preset;
  return fields;
}
