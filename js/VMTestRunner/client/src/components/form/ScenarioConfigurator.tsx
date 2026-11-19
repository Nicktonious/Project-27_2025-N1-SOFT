import { useState } from 'react';
import { FormProvider, type UseFormReturn } from 'react-hook-form';
import type { TestScenarioInput } from '@shared/scenario.schema.ts';
import { Button } from '../ui/Button.tsx';
import { BasicSection } from './BasicSection.tsx';
import { ConfigAndStatesSection } from './ConfigAndStatesSection.tsx';
import { FaultsBuilder } from './FaultsBuilder.tsx';
import { InitialStateSection } from './InitialStateSection.tsx';
import { OrderSection } from './OrderSection.tsx';
import { RawJsonEditor } from './RawJsonEditor.tsx';
import styles from './ScenarioConfigurator.module.css';

interface ScenarioConfiguratorProps {
    form: UseFormReturn<TestScenarioInput>;
    presetKeys: Array<{ key: string; label: string }>;
    selectedPreset: string;
    restPayload: Record<string, unknown>;
    validationErrors: Array<{ path: string; message: string }>;
    baseStates: Record<string, unknown> | null;
    isLoadingStates: boolean;
    initError: string | null;
    onSelectPreset: (key: string) => void;
    onResetPreset: () => void;
    onRetryInitStates: () => void;
    onClearMachineConfig: () => void;
}

export function ScenarioConfigurator({
    form,
    presetKeys,
    selectedPreset,
    restPayload,
    validationErrors,
    baseStates,
    isLoadingStates,
    initError,
    onSelectPreset,
    onResetPreset,
    onRetryInitStates,
    onClearMachineConfig,
}: ScenarioConfiguratorProps) {
    const [mode, setMode] = useState<'form' | 'json'>('form');

    return (
        <FormProvider {...form}>
            <div className={styles.wrapper}>
                <div className={styles.toolbar}>
                    <span className={styles.title}>Конфигуратор сценария</span>
                    <div className={styles.tabs}>
                        <Button
                            size="sm"
                            variant={mode === 'form' ? 'primary' : 'secondary'}
                            onClick={() => setMode('form')}
                        >
                            Форма
                        </Button>
                        <Button
                            size="sm"
                            variant={mode === 'json' ? 'primary' : 'secondary'}
                            onClick={() => setMode('json')}
                        >
                            Raw JSON
                        </Button>
                    </div>
                </div>

                {mode === 'form' ? (
                    <div className={styles.sections}>
                        <BasicSection
                            presetKeys={presetKeys}
                            selectedPreset={selectedPreset}
                            onSelectPreset={onSelectPreset}
                            onResetPreset={onResetPreset}
                        />
                        <OrderSection />
                        <ConfigAndStatesSection
                            baseStates={baseStates}
                            isLoadingStates={isLoadingStates}
                            initError={initError}
                            onRetryInitStates={onRetryInitStates}
                            onClearMachineConfig={onClearMachineConfig}
                        />
                        <FaultsBuilder />
                        <InitialStateSection />
                    </div>
                ) : (
                    <RawJsonEditor payload={restPayload} errors={validationErrors} />
                )}
            </div>
        </FormProvider>
    );
}
