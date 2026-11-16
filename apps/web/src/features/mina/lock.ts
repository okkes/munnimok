// while the tutorial runs, sheets refuse USER dismissal (backdrop tap, drag-down, Escape); programmatic closes pass
// leaf module: Sheet reads it, MinaTutorial writes it, no import cycle
let guarded = false;

export const setMinaSheetGuard = (next: boolean): void => {
  guarded = next;
};

export const isMinaSheetGuarded = (): boolean => guarded;
