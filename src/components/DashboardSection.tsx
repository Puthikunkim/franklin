export function DashboardSection({ title, count, empty, children }: {
  title: string; count: number; empty: string; children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <span className="text-sm text-zinc-500">{count}</span>
      </div>
      {count === 0 ? <p className="text-sm text-zinc-500">{empty}</p> : <div className="space-y-2">{children}</div>}
    </section>
  );
}
