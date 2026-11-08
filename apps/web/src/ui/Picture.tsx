import type { ImgHTMLAttributes } from 'react';
import { usePicturePlate } from '@/lib/picturePlate';

const PLATE_COLOR = { light: 'var(--m-plate-light)', dark: 'var(--m-plate-dark)' } as const;

/**
 * #522 (user): a picture the person brought (a logo, an upload, a brand
 * mark) as every screen shows it. A see-through one gets a backdrop where
 * it would vanish into the theme's ground — a light plate under a dark logo
 * in dark mode, a dark plate under a light one in light mode — measured
 * once per picture. Opaque pictures and logos that already read stay bare.
 */
export function Picture({ src, alt = '', style, ...rest }: Readonly<ImgHTMLAttributes<HTMLImageElement> & { src: string }>) {
  const plate = usePicturePlate(src);
  return <img src={src} alt={alt} {...rest} data-plate={plate ?? undefined} style={plate ? { ...style, backgroundColor: PLATE_COLOR[plate] } : style} />;
}
