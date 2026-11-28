const attemptLifetime = 15 * 60 * 1000;

export function consumeSocialAttempt<T extends { startedAt: number }>(
  key: string, matches: (attempt: T) => boolean,
): T | undefined {
  const attempt: T | null = JSON.parse(sessionStorage.getItem(key) ?? 'null');
  if (!attempt || !matches(attempt)) return;
  sessionStorage.removeItem(key);
  const age = Date.now() - attempt.startedAt;
  if (age >= 0 && age <= attemptLifetime) return attempt;
}
