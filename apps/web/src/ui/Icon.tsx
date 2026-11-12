import type { CSSProperties } from 'react';
import { useUserInk } from './userInk';

interface IconProps {
  name: string;
  size?: number;
  color?: string;
  style?: CSSProperties;
}

/** Material Design Icons glyph (self-hosted @mdi/font). */
export function Icon({ name, size = 20, color, style }: IconProps) {
  // a picked colour is ink here: on the dark surface a dark one is lifted (#592)
  const ink = useUserInk();
  return (
    <i
      aria-hidden
      className={`mdi mdi-${name || 'help-circle-outline'}`}
      style={{
        fontSize: size,
        color: ink(color) ?? 'currentColor',
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
