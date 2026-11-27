export const sampleEvents = [
  { name: 'Warning', time: '00:08', title: 'Drowsiness observed', durationSeconds: 2 },
  { name: 'Pause', time: '00:16', title: 'Monitoring paused', reason: 'The camera view became obstructed' },
] as const;

export const sampleTrends = [
  { name: 'Session 1', count: 0 },
  { name: 'Session 2', count: 2 },
  { name: 'This session', count: 1 },
] as const;
