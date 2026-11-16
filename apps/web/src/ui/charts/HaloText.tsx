/**
 * Words written over a chart's marks, haloed in the surface colour so a line
 * or a bar under them never swallows them (#375). The halo is its own copy
 * underneath: WebKit paints an outlined text letter by letter, so each
 * letter's outline cut into the letter before it.
 */
export function HaloText({
  x,
  y,
  anchor,
  size,
  fill,
  text,
  testId,
}: Readonly<{ x: number; y: number; anchor: 'start' | 'middle' | 'end'; size: number; fill: string; text: string; testId?: string }>) {
  const at = { x, y, textAnchor: anchor, fontSize: size };
  return (
    <>
      <text {...at} fill="var(--m-surface)" stroke="var(--m-surface)" strokeWidth={3} strokeLinejoin="round" aria-hidden>
        {text}
      </text>
      <text {...at} fill={fill} data-testid={testId}>
        {text}
      </text>
    </>
  );
}
