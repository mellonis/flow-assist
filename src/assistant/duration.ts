// A duration the person reads, never a fraction of a second: under a second reads as
// `<1s`; under a minute floors to whole seconds (`12s`); a minute or more is minutes
// and seconds (`3m 5s`, `2m 0s`); an hour or more is hours and minutes (`1h 2m`). No
// space between a number and its unit, one space between the two parts of a pair.
export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
