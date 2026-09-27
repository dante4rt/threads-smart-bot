import Database from 'better-sqlite3';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateCaption } from '../src/jev.js';
import { migrate } from '../src/db.js';
import { runPipeline } from '../src/pipeline.js';
import { OpenRouterClient } from '../src/openrouter.js';
import { ThreadsClient } from '../src/threads-api.js';
import type { Config } from '../src/config.js';

afterEach(() => vi.restoreAllMocks());

function jevAnswers(value: number) {
  const answer = { type: 'score', score: value * 3, confidence: 0.9, legend: {}, probabilities: {} };
  return { answers: { hook: answer, conversation: answer, substance: answer, novelty: answer }, model: 'jev-test', usage: { input_tokens: 1, output_tokens: 1 } };
}

function stubJev(...values: number[]) {
  const spy = vi.spyOn(TypeSafeClient.prototype, 'systemOne');
  for (const value of values) spy.mockResolvedValueOnce(jevAnswers(value) as never);
  return spy;
}

function setupPipeline() {
  const db = new Database(':memory:');
  migrate(db);
  const config = {
    threadsAppId: 'app-id', threadsAppSecret: 'app-secret', threadsUserId: '123',
    threadsAccessToken: 'access-token', threadsRedirectUri: 'https://localhost/callback',
    dbPath: ':memory:', openrouterApiKey: 'or-key', openrouterModel: 'test-model',
    llmBaseUrl: 'https://openrouter.ai/api/v1', llmMaxTokens: 1000,
    jevEnabled: true, typesafeApiKey: 'typesafe-key', jevMinScore: 0.65,
    searchQueries: ['trending'], categoryQueries: { general: ['trending'] },
    minSourcePosts: 1, minSourceQueries: 1, maxSourcePostsPerQuery: 1,
    postTimes: ['13:30'], timezone: 'Asia/Jakarta', topicTags: {}, defaultTopicTag: '',
    unsplashAccessKey: undefined, authorContext: '', excludedTopics: [], dryRun: false,
  } satisfies Config;
  vi.spyOn(ThreadsClient.prototype, 'maybeRefreshToken').mockResolvedValue(undefined);
  vi.spyOn(ThreadsClient.prototype, 'keywordSearch').mockResolvedValue([
    { id: 'source-1', text: 'Startup lokal bahas biaya langganan tools' },
  ]);
  vi.spyOn(ThreadsClient.prototype, 'createMediaContainer').mockResolvedValue('container-1');
  vi.spyOn(ThreadsClient.prototype, 'publishMediaContainer').mockResolvedValue('post-1');
  return { db, config };
}

describe('JEV caption gate', () => {
  it('sends the final caption and recent post context to Jev', async () => {
    const spy = stubJev(0.8);
    const result = await evaluateCaption('Biaya tools startup makin berat?', [], ['startup'], 'key', 0.65);
    expect(result.approved).toBe(true);
    expect(result.score).toBeCloseTo(0.8);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ caption: 'Biaya tools startup makin berat?', source_topics: ['startup'] }),
    }));
  });

  it('regenerates a rejected caption and publishes only the approved one', async () => {
    const { db, config } = setupPipeline();
    stubJev(0.3, 0.9);
    const chat = vi.spyOn(OpenRouterClient.prototype, 'chat')
      .mockResolvedValueOnce('Tools startup mahal.')
      .mockResolvedValueOnce('{"grounded":true,"violations":[]}')
      .mockResolvedValueOnce('Biaya tools startup sekarang jadi topik debat. Langganan mana yang paling cepat lo coret?')
      .mockResolvedValueOnce('{"grounded":true,"violations":[]}');
    try {
      const result = await runPipeline(config, db);
      expect(result).toMatchObject({ status: 'success', postId: 'post-1' });
      expect(result.generatedText).toContain('Langganan mana');
      expect(chat).toHaveBeenCalledTimes(4);
      expect(chat.mock.calls[2]?.[0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('previous caption was rejected') }),
      ]));
      expect(ThreadsClient.prototype.publishMediaContainer).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('keeps regenerating after consecutive rejections', async () => {
    const { db, config } = setupPipeline();
    const jev = stubJev(0.2, 0.4, 0.8);
    vi.spyOn(OpenRouterClient.prototype, 'chat')
      .mockResolvedValueOnce('Tools startup mahal.')
      .mockResolvedValueOnce('{"grounded":true,"violations":[]}')
      .mockResolvedValueOnce('Langganan tools terasa berat.')
      .mockResolvedValueOnce('{"grounded":true,"violations":[]}')
      .mockResolvedValueOnce('Langganan tools startup mana yang pertama lo coret kalau budget dipotong?')
      .mockResolvedValueOnce('{"grounded":true,"violations":[]}');
    try {
      const result = await runPipeline(config, db);
      expect(result).toMatchObject({ status: 'success', postId: 'post-1' });
      expect(jev).toHaveBeenCalledTimes(3);
      expect(ThreadsClient.prototype.createMediaContainer).toHaveBeenCalledTimes(1);
      expect(db.prepare('SELECT generated_text FROM posts').get()).toEqual({
        generated_text: 'Langganan tools startup mana yang pertama lo coret kalau budget dipotong?',
      });
    } finally {
      db.close();
    }
  });

  it('does not publish when the JEV service fails', async () => {
    const { db, config } = setupPipeline();
    vi.spyOn(TypeSafeClient.prototype, 'systemOne').mockRejectedValue(new Error('JEV unavailable'));
    vi.spyOn(OpenRouterClient.prototype, 'chat')
      .mockResolvedValueOnce('Tools startup mahal.')
      .mockResolvedValueOnce('{"grounded":true,"violations":[]}');
    try {
      const result = await runPipeline(config, db);
      expect(result).toMatchObject({ status: 'failed', error: 'JEV unavailable' });
      expect(ThreadsClient.prototype.createMediaContainer).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('regenerates when a length rewrite introduces an unsupported claim', async () => {
    const { db, config } = setupPipeline();
    const jev = stubJev(0.9);
    vi.spyOn(OpenRouterClient.prototype, 'chat')
      .mockResolvedValueOnce('Opini tentang tools startup. '.repeat(20))
      .mockResolvedValueOnce('{"grounded":true,"violations":[]}')
      .mockResolvedValueOnce('Brand X resmi menggratiskan semua tools startup.')
      .mockResolvedValueOnce('{"grounded":false,"violations":["unsupported Brand X announcement"]}')
      .mockResolvedValueOnce('Biaya tools startup makin rame dibahas. Langganan mana yang masih layak?')
      .mockResolvedValueOnce('{"grounded":true,"violations":[]}');
    try {
      const result = await runPipeline(config, db);
      expect(result).toMatchObject({ status: 'success', postId: 'post-1' });
      expect(result.generatedText).not.toContain('Brand X');
      expect(jev).toHaveBeenCalledTimes(1);
      expect(ThreadsClient.prototype.createMediaContainer).toHaveBeenCalledWith(
        result.generatedText, undefined, undefined,
      );
    } finally {
      db.close();
    }
  });
});
