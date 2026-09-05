// Theme-aware inline SVG (per the plan: not an image asset). Uses
// currentColor + the token vars directly so it tracks light/dark with zero
// JS. Four boxes matching howItWorksSteps in content/site.ts, left to right
// on desktop, stacked on mobile via the surrounding flex-col/row switch.
export function HowItWorksDiagram() {
  return (
    <svg
      viewBox="0 0 880 160"
      className="w-full text-secondary"
      role="img"
      aria-label="Your gateway and SIMs connect over an encrypted tunnel to our hosted cloud software, which your agents reach from a browser."
    >
      {[
        { x: 10, label: "Your gateway + SIMs" },
        { x: 240, label: "Encrypted tunnel" },
        { x: 470, label: "Our cloud software" },
        { x: 700, label: "Your agents" },
      ].map((box, i) => (
        <g key={box.label}>
          <rect
            x={box.x}
            y={40}
            width={170}
            height={80}
            rx={12}
            fill="rgb(var(--surface))"
            stroke="rgb(var(--hairline-strong))"
          />
          <text
            x={box.x + 85}
            y={85}
            textAnchor="middle"
            fontSize={13}
            fill="rgb(var(--text-primary))"
          >
            {box.label}
          </text>
          {i < 3 ? (
            <line
              x1={box.x + 170}
              y1={80}
              x2={box.x + 230}
              y2={80}
              stroke="rgb(var(--accent))"
              strokeWidth={2}
              markerEnd="url(#arrow)"
            />
          ) : null}
        </g>
      ))}
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(var(--accent))" />
        </marker>
      </defs>
    </svg>
  );
}
