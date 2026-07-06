// An inspection stamp — the vehicle's condition grade, marked like a WOF sticker.
export function GradeStamp({ grade }: { grade: string }) {
  return (
    <span className="inline-flex flex-col items-center rounded-md border border-signal/60 bg-ink/80 px-2.5 py-1 backdrop-blur-sm">
      <span className="font-mono text-[8px] font-semibold uppercase leading-none tracking-[0.2em] text-signal/80">
        Grade
      </span>
      <span className="font-display text-lg font-bold leading-tight text-chalk">
        {grade}
      </span>
    </span>
  );
}
