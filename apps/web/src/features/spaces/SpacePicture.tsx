import type { SpaceRow } from '@/db/types';
import { focusStyle } from '@/lib/imageFocus';
import { Picture } from '@/ui/Picture';

/** the round frame clips and the picture moves inside it, so a zoom never grows the circle */
export function SpacePicture({ space, className }: Readonly<{ space: Pick<SpaceRow, 'picture' | 'pictureFocus'>; className: string }>) {
  return (
    <span className={`inline-block shrink-0 overflow-hidden rounded-full ${className}`} data-testid="space-picture">
      <Picture src={space.picture ?? ''} className="h-full w-full object-cover" style={focusStyle(space.pictureFocus)} />
    </span>
  );
}
