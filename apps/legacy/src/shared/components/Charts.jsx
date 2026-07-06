import React from 'react';
import { M } from '../../app/theme.jsx';

export function Sparkline({ data, width = 60, height = 20, color = M.ink, fill, strokeWidth = 1.5 }) {
  if (!data || data.length === 0) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => [i * stepX, height - ((v - min) / range) * height]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const fillD = fill ? `${d} L${width},${height} L0,${height} Z` : null;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', overflow: 'visible' }}>
      {fill && <path d={fillD} fill={fill} stroke="none"/>}
      <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function BarChart({ data, labels, width = 280, height = 96, highlightLast = true, color = M.ink, accent = M.sage, showValues = false, selected = -1, onSelect }) {
  const max = Math.max(...data, 1);
  const padding = 6;
  const valueH = showValues ? 14 : 0;
  const labelH = labels ? 14 : 0;
  const barAreaH = height - valueH - labelH;
  const barW = (width - padding * (data.length - 1)) / data.length;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * (barAreaH - 4));
        const x = i * (barW + padding);
        const y = valueH + barAreaH - h;
        const isLast = i === data.length - 1;
        const isSel = selected === i;
        const barColor = (selected >= 0 ? isSel : (highlightLast && isLast)) ? accent : color;
        const opacity = selected >= 0 ? (isSel ? 1 : 0.22) : (highlightLast && !isLast ? 0.22 : 0.92);
        return (
          <g key={i} style={{ cursor: onSelect ? 'pointer' : 'default' }} onClick={() => onSelect && onSelect(i)}>
            <rect x={x - 3} y={valueH} width={barW + 6} height={barAreaH} rx={0} fill="transparent"/>
            <rect x={x} y={y} width={barW} height={h} rx={3} fill={barColor} opacity={opacity}
              style={{ transformOrigin: `${x + barW/2}px ${valueH + barAreaH}px`, animation: `barRise 0.4s cubic-bezier(0.34,1.56,0.64,1) ${i * 0.04}s both` }}/>
            {showValues && v > 0 && (
              <text x={x + barW / 2} y={valueH - 2} fontSize="8" fill={isSel || (selected < 0 && isLast) ? accent : color} textAnchor="middle" fontFamily="-apple-system,system-ui" fontWeight="600" opacity={opacity < 0.5 ? 0.5 : 1}>
                {v >= 1000 ? `€${(v/1000).toFixed(1)}k` : `€${Math.round(v)}`}
              </text>
            )}
            {labels && <text x={x + barW / 2} y={height - 2} fontSize="8" fill={M.ink4} textAnchor="middle" fontFamily="-apple-system,system-ui" fontWeight="500">{labels[i]}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function BarChartScrollable({ data, labels, height = 100, accent = M.sage, color = M.ink2, onSelect, selected: extSel }) {
  const [internalSel, setInternalSel] = React.useState(data.length - 1);
  const sel = extSel !== undefined ? extSel : internalSel;
  const handleSelect = (i) => { setInternalSel(i); onSelect && onSelect(i); };
  const barW = 28, gap = 8, totalW = Math.max(300, data.length * (barW + gap));
  const containerRef = React.useRef(null);
  React.useEffect(() => {
    if (containerRef.current) containerRef.current.scrollLeft = containerRef.current.scrollWidth;
  }, []);
  return (
    <div ref={containerRef} style={{ overflowX:'auto', WebkitOverflowScrolling:'touch', marginLeft:-4, paddingLeft:4 }}>
      <div style={{ width: totalW, minWidth: '100%' }}>
        <BarChart data={data} labels={labels} width={totalW} height={height} highlightLast={false}
          accent={accent} color={color} showValues selected={sel} onSelect={handleSelect}/>
      </div>
    </div>
  );
}

export function Donut({ data, size = 130, thickness = 18, center }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  let acc = 0;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={M.line2} strokeWidth={thickness}/>
        {data.map((d, i) => {
          const dash = (d.value / total) * (2 * Math.PI * r);
          const offset = (acc / total) * (2 * Math.PI * r);
          acc += d.value;
          return (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none"
              stroke={d.color} strokeWidth={thickness}
              strokeDasharray={`${dash} ${2 * Math.PI * r}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"/>
          );
        })}
      </svg>
      {center && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
          {center}
        </div>
      )}
    </div>
  );
}

export function StackedBar({ segments, height = 8, radius = 999 }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div style={{
      display: 'flex', height, borderRadius: radius,
      overflow: 'hidden', background: M.line2,
    }}>
      {segments.map((s, i) => (
        <div key={i} style={{
          width: `${(s.value / total) * 100}%`,
          background: s.color,
          borderRight: i < segments.length - 1 ? `1.5px solid ${M.paper}` : 'none',
          transition: 'width 0.35s ease',
        }}/>
      ))}
    </div>
  );
}

export function LineChart({ data, width = 320, height = 120, color = M.sage, fill = 'rgba(74,106,79,0.10)', dots = false }) {
  if (!data || data.length === 0) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = (max - min) || 1;
  const padding = 4;
  const stepX = (width - padding * 2) / (data.length - 1);
  const pts = data.map((v, i) => [padding + i * stepX, padding + (height - padding * 2) * (1 - (v - min) / range)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const fillD = `${d} L${pts[pts.length - 1][0]},${height} L${pts[0][0]},${height} Z`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <path d={fillD} fill={fill} stroke="none"/>
      <path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"/>
      {dots && pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={i === pts.length - 1 ? 3 : 0} fill={color}/>
      ))}
    </svg>
  );
}