// Read-only star row for a 1-5 score. Rounds to the nearest whole star.
export function Stars({ score }: { score: number }) {
  const filled = Math.round(score);
  return (
    <span aria-label={`${score} out of 5`} className="font-mono text-signal">
      {"★".repeat(filled)}
      <span className="text-line">{"★".repeat(5 - filled)}</span>
    </span>
  );
}
