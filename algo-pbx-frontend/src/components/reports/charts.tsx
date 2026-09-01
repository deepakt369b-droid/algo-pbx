"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Chart palette — CSS vars from globals.css so charts follow the Apple-black
// light/dark theme with no hardcoded hex.
const C = {
  accent: "rgb(var(--accent))",
  success: "rgb(var(--success))",
  warning: "rgb(var(--warning))",
  danger: "rgb(var(--danger))",
  grid: "rgb(var(--text-tertiary))",
};

const axisProps = {
  stroke: C.grid,
  tick: { fill: C.grid, fontSize: 11 },
  tickLine: false,
} as const;

const tooltipStyle = {
  contentStyle: {
    background: "rgb(var(--surface))",
    border: "1px solid rgb(var(--hairline))",
    borderRadius: 10,
    fontSize: 12,
    color: "rgb(var(--text-primary))",
  },
  labelStyle: { color: "rgb(var(--text-secondary))" },
} as const;

const mmdd = (d: string) => d.slice(5);

interface VolumeRow {
  day: string;
  answered: number;
  total: number;
  answerRate: number;
}

export function CallVolumeChart({ rows }: { rows: VolumeRow[] }) {
  const data = rows.map((r) => ({
    day: r.day,
    Answered: r.answered,
    Missed: Math.max(0, r.total - r.answered),
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.grid} strokeOpacity={0.2} />
        <XAxis dataKey="day" tickFormatter={mmdd} {...axisProps} />
        <YAxis allowDecimals={false} {...axisProps} />
        <Tooltip {...tooltipStyle} />
        <Area
          type="monotone"
          dataKey="Answered"
          stackId="1"
          stroke={C.success}
          fill={C.success}
          fillOpacity={0.25}
        />
        <Area
          type="monotone"
          dataKey="Missed"
          stackId="1"
          stroke={C.danger}
          fill={C.danger}
          fillOpacity={0.2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function AnswerRateChart({ rows }: { rows: VolumeRow[] }) {
  const data = rows.map((r) => ({ day: r.day, "Answer rate %": r.answerRate }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.grid} strokeOpacity={0.2} />
        <XAxis dataKey="day" tickFormatter={mmdd} {...axisProps} />
        <YAxis domain={[0, 100]} {...axisProps} />
        <Tooltip {...tooltipStyle} />
        <Area
          type="monotone"
          dataKey="Answer rate %"
          stroke={C.accent}
          fill={C.accent}
          fillOpacity={0.2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  INTERESTED: "Interested",
  CALLBACK: "Callback",
  NOT_INTERESTED: "Not interested",
  DNC: "Do not call",
};
const OUTCOME_COLOR: Record<string, string> = {
  INTERESTED: C.success,
  CALLBACK: C.warning,
  NOT_INTERESTED: C.grid,
  DNC: C.danger,
};

export function DispositionsChart({
  rows,
}: {
  rows: { outcome: string; count: number }[];
}) {
  const data = rows.map((r) => ({
    name: OUTCOME_LABEL[r.outcome] ?? r.outcome,
    count: r.count,
    color: OUTCOME_COLOR[r.outcome] ?? C.accent,
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.grid} strokeOpacity={0.2} vertical={false} />
        <XAxis dataKey="name" {...axisProps} />
        <YAxis allowDecimals={false} {...axisProps} />
        <Tooltip {...tooltipStyle} cursor={{ fill: "rgb(var(--text-tertiary) / 0.1)" }} />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DncTrendChart({
  rows,
}: {
  rows: { day: string; total: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.grid} strokeOpacity={0.2} vertical={false} />
        <XAxis dataKey="day" tickFormatter={mmdd} {...axisProps} />
        <YAxis allowDecimals={false} {...axisProps} />
        <Tooltip {...tooltipStyle} cursor={{ fill: "rgb(var(--text-tertiary) / 0.1)" }} />
        <Bar dataKey="total" name="Added" fill={C.danger} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
