import { useFormContext } from 'react-hook-form';
import type { TestScenarioInput } from '@shared/scenario.schema.ts';
import { Accordion } from '../ui/Accordion.tsx';
import { Input } from '../ui/Input.tsx';
import styles from './FormLayout.module.css';

export function InitialStateSection() {
    const { register } = useFormContext<TestScenarioInput>();

    return (
        <Accordion title="4. Дополнительные тайминги эмулятора (опционально)" defaultOpen={false}>
            <span className={styles.hint}>
                Если поля не заполнены, используются стандартные значения из схемы.
            </span>

            <div className={styles.grid3}>
                <Input
                    label="boxUnlockTimeoutSec"
                    type="number"
                    step="0.1"
                    placeholder="2"
                    {...register('emulator.boxUnlockTimeoutSec', {
                        setValueAs: (v) => (v === '' ? undefined : Number(v)),
                    })}
                />
                <Input
                    label="initialLiftLevel"
                    type="number"
                    placeholder="0"
                    {...register('emulator.initialLiftLevel', {
                        setValueAs: (v) => (v === '' ? undefined : Number(v)),
                    })}
                />
                <Input
                    label="driverError"
                    placeholder="null"
                    {...register('emulator.driverError', {
                        setValueAs: (v) => (v === '' ? null : v),
                    })}
                />
            </div>

            <div className={styles.grid4}>
                <Input
                    label="liftStartDelayMs"
                    type="number"
                    placeholder="40"
                    {...register('emulator.liftStartDelayMs', {
                        setValueAs: (v) => (v === '' ? undefined : Number(v)),
                    })}
                />
                <Input
                    label="liftStepIntervalMs"
                    type="number"
                    placeholder="30"
                    {...register('emulator.liftStepIntervalMs', {
                        setValueAs: (v) => (v === '' ? undefined : Number(v)),
                    })}
                />
                <Input
                    label="spiralFirstPulseDelayMs"
                    type="number"
                    placeholder="880"
                    {...register('emulator.spiralFirstPulseDelayMs', {
                        setValueAs: (v) => (v === '' ? undefined : Number(v)),
                    })}
                />
                <Input
                    label="boxOpenDelayMs"
                    type="number"
                    placeholder="60"
                    {...register('emulator.boxOpenDelayMs', {
                        setValueAs: (v) => (v === '' ? undefined : Number(v)),
                    })}
                />
            </div>
        </Accordion>
    );
}
