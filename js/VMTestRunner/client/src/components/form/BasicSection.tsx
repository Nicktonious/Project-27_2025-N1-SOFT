import { useFormContext } from 'react-hook-form';
import type { TestScenarioInput } from '@shared/scenario.schema.ts';
import { Accordion } from '../ui/Accordion.tsx';
import { Button } from '../ui/Button.tsx';
import { Input } from '../ui/Input.tsx';
import { Select } from '../ui/Select.tsx';
import styles from './FormLayout.module.css';

interface BasicSectionProps {
    presetKeys: Array<{ key: string; label: string }>;
    selectedPreset: string;
    onSelectPreset: (key: string) => void;
    onResetPreset: () => void;
}

export function BasicSection({
    presetKeys,
    selectedPreset,
    onSelectPreset,
    onResetPreset,
}: BasicSectionProps) {
    const {
        register,
        formState: { errors },
    } = useFormContext<TestScenarioInput>();

    return (
        <Accordion title="1. Основные параметры" defaultOpen>
            <div className={styles.row}>
                <div className={styles.grow}>
                    <Select
                        label="Пресет сценария"
                        value={selectedPreset}
                        onChange={(e) => onSelectPreset(e.target.value)}
                        options={presetKeys.map((p) => ({ value: p.key, label: p.label }))}
                    />
                </div>
                <Button variant="secondary" onClick={onResetPreset}>
                    Сбросить пресет
                </Button>
            </div>

            <div className={styles.grid2}>
                <Input label="Название сценария" error={errors.name?.message} {...register('name')} />
                <Input
                    label="Watchdog-таймаут (мс)"
                    type="number"
                    error={errors.timeoutMs?.message}
                    {...register('timeoutMs', { valueAsNumber: true })}
                />
            </div>
            <Input label="Описание" error={errors.description?.message} {...register('description')} />
        </Accordion>
    );
}
