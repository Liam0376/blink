"use client";

import { CUR_SYM, fmtMoney } from "@/lib/format";
import type { Currency } from "@/lib/db";
import { FLOW_COLORS } from "@/lib/palette";

function fmtShort(amount: number, currency: Currency): string {
  const sym = CUR_SYM[currency] ?? "$";
  const n = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(amount);
  return `${sym}${n}`;
}

export function Bars({
  data,
  currency = "MXN",
  totalIn = 0,
  totalOut = 0,
  deltaOut = 0,
  subtitle = "",
}: {
  data: { label: string; expense: number; income: number }[];
  currency?: Currency;
  totalIn?: number;
  totalOut?: number;
  /** vs previous equal-length window, signed */
  deltaOut?: number;
  subtitle?: string;
}) {
  const max = Math.max(0, ...data.flatMap((d) => [d.expense, d.income]));
  const ticks = max > 0 ? [max, max / 2, 0] : [0];
  const aria = `Income ${fmtMoney(totalIn, currency)}, expenses ${fmtMoney(totalOut, currency)}${subtitle ? `, ${subtitle}` : ""}`;
  return (
    <div>
      <div className="flex gap-2">
        <div className="flex flex-col justify-between h-28 text-[10px] text-right w-10 shrink-0 py-0.5" style={{ color: "var(--muted)" }} aria-hidden>
          {ticks.map((t, i) => (
            <span key={i}>{t === 0 ? "0" : fmtShort(t, currency)}</span>
          ))}
        </div>
        <div className="flex items-end gap-1.5 h-28 flex-1 min-w-0 relative" role="img" aria-label={aria}>
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="border-t" style={{ borderColor: "var(--card-border)" }} />
            ))}
          </div>
          {data.map((d, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
              <div className="flex items-end gap-[3px] h-24 w-full justify-center">
                <div
                  className="w-2 rounded-t transition-all"
                  style={{ background: `linear-gradient(to top, ${FLOW_COLORS.income}, ${FLOW_COLORS.income}cc)`, height: max > 0 ? `${(d.income / max) * 100}%` : "0%" }}
                />
                <div
                  className="w-2 rounded-t transition-all"
                  style={{ background: `linear-gradient(to top, ${FLOW_COLORS.expense}, ${FLOW_COLORS.expense}cc)`, height: max > 0 ? `${(d.expense / max) * 100}%` : "0%" }}
                />
              </div>
              <span className="text-[10px] truncate w-full text-center" style={{ color: "var(--muted)" }}>
                {d.label}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between mt-2 gap-2 flex-wrap">
        <div className="flex gap-3 text-xs" style={{ color: "var(--muted)" }}>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: FLOW_COLORS.income }} /> Income
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: FLOW_COLORS.expense }} /> Expenses
          </span>
        </div>
        <p className="text-xs font-bold">
          {fmtMoney(totalOut, currency)}{" "}
          <span className="font-semibold" style={{ color: deltaOut > 0 ? "#fb7185" : deltaOut < 0 ? "var(--accent)" : "var(--muted)" }}>
            {deltaOut === 0 ? "· same as before" : `${deltaOut > 0 ? "▲ +" : "▼ "}${fmtMoney(Math.abs(deltaOut), currency)} vs before`}
          </span>
        </p>
      </div>
      {subtitle ? <p className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>{subtitle}</p> : null}
    </div>
  );
}

export function Donut({
  slices,
  currency = "MXN",
  emptyNote = "No spending in this currency and period.",
}: {
  slices: { label: string; value: number; color: string; icon?: string }[];
  currency?: Currency;
  emptyNote?: string;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total <= 0) {
    return (
      <div className="flex items-center justify-center text-sm py-8 text-center px-4" style={{ color: "var(--muted)" }}>
        {emptyNote}
      </div>
    );
  }
  // Cumulative bounds computed functionally (no render-time reassignment):
  // cum[i] = total value of slices before i.
  const cum = slices.reduce<number[]>((a, s) => [...a, a[a.length - 1] + s.value], [0]);
  const stops = slices.map(
    (s, i) => `${s.color} ${(cum[i] / total) * 100}% ${(cum[i + 1] / total) * 100}%`
  );
  const size = 168;
  const aria = slices.map((s) => `${s.label}: ${fmtMoney(s.value, currency)}`).join(", ");
  return (
    <div className="flex items-center gap-4">
      <div
        className="rounded-full shrink-0"
        role="img"
        aria-label={`Spending by category, total ${fmtMoney(total, currency)}. ${aria}`}
        style={{ width: size, height: size, background: `conic-gradient(${stops.join(",")})` }}
      >
        <div className="w-full h-full flex items-center justify-center">
          <div
            className="rounded-full flex flex-col items-center justify-center"
            style={{ width: size * 0.62, height: size * 0.62, background: "var(--card)" }}
          >
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>Total</span>
            <span className="text-sm font-bold">{fmtMoney(total, currency)}</span>
          </div>
        </div>
      </div>
      <ul className="flex-1 space-y-1.5 min-w-0">
        {slices.map((s, i) => {
          const pct = (s.value / total) * 100;
          return (
            <li key={i} className="flex items-center gap-2 text-xs min-w-0">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} aria-hidden />
              <span className="truncate flex-1">
                {s.icon} {s.label}
              </span>
              <span className="whitespace-nowrap" style={{ color: "var(--muted)" }}>{fmtMoney(s.value, currency)}</span>
              <span className="font-semibold whitespace-nowrap w-11 text-right">
                {pct < 5 ? pct.toFixed(1) : Math.round(pct)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Progress({
  pct,
  spent,
  limit,
  currency = "MXN",
}: {
  pct: number;
  spent?: number;
  limit?: number;
  currency?: Currency;
}) {
  const v = Math.max(0, Math.min(100, pct));
  const over = pct > 100;
  const label =
    spent != null && limit != null
        ? over
        ? `▲ +${Math.round(pct - 100)}% over the limit (${fmtMoney(spent, currency)} of ${fmtMoney(limit, currency)})`
        : `${fmtMoney(spent, currency)} of ${fmtMoney(limit, currency)}`
      : undefined;
  return (
    <div>
      <div
        className="h-2 rounded-full overflow-hidden"
        style={{ background: "var(--surface)" }}
        role="progressbar"
        aria-valuenow={Math.round(Math.min(pct, 999))}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? `Progress ${Math.round(pct)}%`}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${v}%`, background: over ? "linear-gradient(to right, #f43f5e, #e11d48)" : "var(--accent)" }}
        />
      </div>
      {label && (
        <p className="text-[11px] mt-1.5 font-medium" style={{ color: over ? "#e11d48" : "var(--muted)" }}>{label}</p>
      )}
    </div>
  );
}
