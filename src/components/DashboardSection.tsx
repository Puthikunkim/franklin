export function DashboardSection({ title, count, empty, children }: {
  title: string; count: number; empty: string; children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="font-display text-lg font-semibold text-chalk">{title}</h2>
        <span className="font-mono text-sm text-fog">{count}</span>
      </div>
      {count === 0 ? <p className="text-sm text-fog">{empty}</p> : <div className="space-y-2">{children}</div>}
    </section>
  );
}
