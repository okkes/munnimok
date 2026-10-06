import type { SpaceRow } from '@/db/types';
import { focusStyle } from '@/lib/imageFocus';

/**
 * The space's own picture as the circle every list draws it in — at its
 * stored focus and zoom (user 2026-10-06). The round frame clips and the
 * picture moves inside it, so a zoom never grows the circle itself.
 */
export function SpacePicture({ space, className }: Readonly<{ space: Pick<SpaceRow, 'picture' | 'pictureFocus'>; className: string }>) {
  return (
    <span className={`inline-block shrink-0 overflow-hidden rounded-full ${className}`} data-testid="space-picture">
      <img src={space.picture} alt="" className="h-full w-full object-cover" style={focusStyle(space.pictureFocus)} />
    </span>
  );
}
