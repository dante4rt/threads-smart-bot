// Pre-publish editorial judgment. Scores estimate caption quality, not future reach.
import { score, TypeSafeClient } from '@typesafe-ai/sdk';
import type { Post } from './db.js';

const QUESTIONS = {
  hook: score('How strongly does `caption` earn attention in the first line for a Threads reader in Indonesia?', [
    'Generic opener or unclear subject; easy to scroll past.',
    'Understandable subject, but the opener is predictable or slow.',
    'Specific, clear opener with a reason to keep reading.',
    'Immediate, distinctive hook tied to a concrete thing or timely event.',
  ]),
  conversation: score('How likely is `caption` to invite a genuine reply from a stranger with relevant experience?', [
    'No opening for a real response, or only engagement bait.',
    'Some relatable topic, but the response would be generic.',
    'A concrete opinion or question gives readers something specific to answer.',
    'A clear, grounded tension or question makes a substantive reply easy.',
  ]),
  substance: score('How much concrete, useful, or interesting substance does `caption` give the reader?', [
    'Vague filler, empty assertion, or unsupported hype.',
    'A discernible idea, but little concrete detail.',
    'A specific observation, example, or useful take.',
    'Memorable insight or detail that stands on its own without exaggeration.',
  ]),
  novelty: score('Compared with `recent_posts`, how fresh is the caption topic and phrasing for this account?', [
    'Repeats a recent topic and sentence shape closely.',
    'Noticeably similar to a recent post.',
    'Some overlap, but the angle or phrasing feels fresh.',
    'Distinct angle and voice relative to recent posts.',
  ]),
} as const;

const WEIGHTS = { hook: 0.3, conversation: 0.3, substance: 0.25, novelty: 0.15 } as const;
type Dimension = keyof typeof WEIGHTS;

export interface JevAssessment {
  approved: boolean;
  score: number;
  dimensions: Record<Dimension, number>;
  weakDimensions: Dimension[];
}

export async function evaluateCaption(
  caption: string,
  recentPosts: Post[],
  successfulQueries: string[],
  apiKey: string,
  minScore: number,
): Promise<JevAssessment> {
  const client = new TypeSafeClient({ apiKey, defaultModel: 'jev-latest', timeout: 10_000, logLevel: 'error' });
  const { answers } = await client.systemOne({
    state: {
      caption,
      audience: 'Indonesian Threads readers; casual Bahasa Indonesia; replies matter more than passive likes.',
      source_topics: successfulQueries,
      recent_posts: recentPosts.slice(0, 10).map((post) => ({
        text: post.generated_text,
        views: post.views,
        likes: post.likes,
        replies: post.replies,
        reposts: post.reposts,
      })),
    },
    questions: QUESTIONS,
  });

  const dimensions = {} as Record<Dimension, number>;
  for (const dimension of Object.keys(WEIGHTS) as Dimension[]) {
    const value = answers[dimension].score / 3;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Invalid JEV ${dimension} score`);
    }
    dimensions[dimension] = value;
  }

  const composite = (Object.keys(WEIGHTS) as Dimension[])
    .reduce((sum, dimension) => sum + dimensions[dimension] * WEIGHTS[dimension], 0);
  const weakDimensions = (Object.keys(WEIGHTS) as Dimension[])
    .filter((dimension) => dimensions[dimension] < 2 / 3);

  return {
    approved: composite >= minScore,
    score: composite,
    dimensions,
    weakDimensions,
  };
}
