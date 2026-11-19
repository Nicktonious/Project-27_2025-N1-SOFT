import { useMemo, useState, type ReactNode } from 'react';
import type { SectionMeta, SectionType } from '@shared/api.contract.ts';
import { SectionContext, type SectionContextValue } from '../hooks/useSectionContext.ts';

const SECTIONS_REGISTRY: SectionMeta[] = [
    {
        type: 'SPIRAL',
        label: 'Спиральная секция (SPIRAL)',
        supported: true,
        commands: ['GetItem', 'SetLiftLevel', 'RotateSpiral', 'OpenDeliveryBox'],
        availableChannels: [
            'Door.Sensor',
            'DeliveryBox.Lock',
            'DeliveryBox.Optic',
            'Lift.MotorCtrl',
            'Lift.LevelSensor',
            'Lift.BottomTamper',
            'Lift.TopTamper',
            'Storage.MatrixCtrl',
            'Power.Current',
            'Power.Voltage',
            'Power.PsuWork',
            'Power.Short',
        ],
    },
    {
        type: 'CELL',
        label: 'Ячеечная секция / Постамат (CELL)',
        supported: false,
        commands: [],
        availableChannels: [],
    },
];

export function SectionProvider({ children }: { children: ReactNode }) {
    const [selectedSectionType, setSelectedSectionType] = useState<SectionType>('SPIRAL');

    const value = useMemo<SectionContextValue>(() => {
        const currentSectionMeta =
            SECTIONS_REGISTRY.find((s) => s.type === selectedSectionType) ?? SECTIONS_REGISTRY[0];
        return {
            sections: SECTIONS_REGISTRY,
            selectedSectionType,
            setSelectedSectionType,
            currentSectionMeta,
        };
    }, [selectedSectionType]);

    return <SectionContext.Provider value={value}>{children}</SectionContext.Provider>;
}
