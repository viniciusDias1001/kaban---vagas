/** Molas compartilhadas: curtas, interrompíveis e sem quique exagerado. */
export const spring = { type: 'spring', stiffness: 460, damping: 38, mass: 0.9 } as const;
export const springSoft = { type: 'spring', stiffness: 320, damping: 34, mass: 1 } as const;
export const springSnap = { type: 'spring', stiffness: 700, damping: 40, mass: 0.8 } as const;
