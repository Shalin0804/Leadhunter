import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

const AXIS = { fontSize: 11, fill: '#6b7688' };
const GRID = '#eef1f6';
export const PALETTE = ['#2563eb', '#0ea5e9', '#6366f1', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#10b981', '#ec4899', '#64748b'];

export const BarChartBox = ({ data, xKey, yKey, name, color = '#2563eb', horizontal = false }) => (
  <ResponsiveContainer width="100%" height="100%">
    <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 6, right: 12, bottom: 4, left: horizontal ? 8 : 0 }}>
      <CartesianGrid stroke={GRID} vertical={!horizontal} horizontal={horizontal} />
      {horizontal ? (
        <>
          <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey={xKey} tick={AXIS} axisLine={false} tickLine={false} width={110} />
        </>
      ) : (
        <>
          <XAxis dataKey={xKey} tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} width={30} />
        </>
      )}
      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e9f0' }} />
      <Bar dataKey={yKey} name={name} fill={color} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={38} />
    </BarChart>
  </ResponsiveContainer>
);

export const LineChartBox = ({ data, xKey, yKey, name, color = '#2563eb' }) => (
  <ResponsiveContainer width="100%" height="100%">
    <LineChart data={data} margin={{ top: 6, right: 12, bottom: 4, left: 0 }}>
      <CartesianGrid stroke={GRID} vertical={false} />
      <XAxis dataKey={xKey} tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" />
      <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} width={30} />
      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e9f0' }} />
      <Line type="monotone" dataKey={yKey} name={name} stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
    </LineChart>
  </ResponsiveContainer>
);

export const DonutChartBox = ({ data, nameKey, valueKey }) => (
  <ResponsiveContainer width="100%" height="100%">
    <PieChart>
      <Pie data={data} dataKey={valueKey} nameKey={nameKey} innerRadius={52} outerRadius={80} paddingAngle={2}>
        {data.map((_, i) => (
          <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
        ))}
      </Pie>
      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e9f0' }} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
    </PieChart>
  </ResponsiveContainer>
);
