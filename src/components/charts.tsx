// Tiny inline-SVG charts (no chart library). Each has a visually hidden table for screen readers.

export interface Bar {
  label: string;
  value: number;
  /** Optional background total (e.g. scheduled), drawn behind the value. */
  total?: number;
}

export function BarChart({ bars, title, unit = '' }: { bars: Bar[]; title: string; unit?: string }) {
  const max = Math.max(1, ...bars.map((b) => Math.max(b.value, b.total ?? 0)));
  const w = 280;
  const h = 120;
  const gap = 8;
  const bw = (w - gap * (bars.length - 1)) / bars.length;
  return (
    <figure class="chart">
      <svg viewBox={`0 0 ${w} ${h + 18}`} role="img" aria-label={title} preserveAspectRatio="xMidYMid meet">
        {bars.map((b, i) => {
          const x = i * (bw + gap);
          const th = ((b.total ?? 0) / max) * h;
          const vh = (b.value / max) * h;
          return (
            <g key={b.label}>
              {b.total !== undefined && <rect class="chart-total" x={x} y={h - th} width={bw} height={th} rx="4" />}
              <rect class="chart-bar" x={x} y={h - vh} width={bw} height={vh} rx="4" />
              <text class="chart-label" x={x + bw / 2} y={h + 14} text-anchor="middle">
                {b.label}
              </text>
            </g>
          );
        })}
      </svg>
      <table class="sr-only">
        <caption>{title}</caption>
        <tbody>
          {bars.map((b) => (
            <tr key={b.label}>
              <th scope="row">{b.label}</th>
              <td>
                {b.value}
                {unit}
                {b.total !== undefined ? ` of ${b.total}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Horizontal bars with labels, for categories. */
export function HBars({ rows, title }: { rows: { label: string; done: number; total: number }[]; title: string }) {
  return (
    <ul class="hbars" aria-label={title}>
      {rows.map((r) => {
        const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
        return (
          <li key={r.label}>
            <span class="hbar-label">{r.label}</span>
            <svg class="hbar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <rect class="chart-total" width="100" height="10" rx="5" />
              <rect class="chart-bar" width={pct} height="10" rx="5" />
            </svg>
            <span class="hbar-value">
              {r.done}/{r.total}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
