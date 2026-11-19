import { createContext, useContext } from 'react';
import type { SectionMeta, SectionType } from '@shared/api.contract.ts';

export interface SectionContextValue {
    sections: SectionMeta[];
    selectedSectionType: SectionType;
    setSelectedSectionType: (type: SectionType) => void;
    currentSectionMeta: SectionMeta;
}

export const SectionContext = createContext<SectionContextValue | null>(null);

export function useSectionContext(): SectionContextValue {
    const ctx = useContext(SectionContext);
    if (!ctx) throw new Error('useSectionContext must be used inside SectionProvider');
    return ctx;
}
