import type { ImgHTMLAttributes } from 'react';
import { usePicturePlate } from '@/lib/picturePlate';

const PLATE_COLOR = { light: 'var(--m-plate-light)', dark: 'var(--m-plate-dark)' } as const;

// #522: a see-through picture gets a plate where it would vanish into the theme's ground
// (a light plate under a dark logo in dark mode, and the reverse), measured once per picture
export function Picture({ src, alt = '', style, ...rest }: Readonly<ImgHTMLAttributes<HTMLImageElement> & { src: string }>) {
  const plate = usePicturePlate(src);
  return <img src={src} alt={alt} {...rest} data-plate={plate ?? undefined} style={plate ? { ...style, backgroundColor: PLATE_COLOR[plate] } : style} />;
}
