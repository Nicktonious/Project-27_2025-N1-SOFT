import { useFormContext, useWatch } from 'react-hook-form';
import type { TestScenarioInput } from '@shared/scenario.schema.ts';
import { Accordion } from '../ui/Accordion.tsx';
import { Button } from '../ui/Button.tsx';
import { JsonViewer } from '../ui/JsonViewer.tsx';
import styles from './FormLayout.module.css';

interface ConfigAndStatesSectionProps {
    baseStates: Record<string, unknown> | null;
    isLoadingStates: boolean;
    initError: string | null;
    onRetryInitStates: () => void;
    onClearMachineConfig: () => void;
}

export function ConfigAndStatesSection({
    baseStates,
    isLoadingStates,
    initError,
    onRetryInitStates,
    onClearMachineConfig,
}: ConfigAndStatesSectionProps) {
    const { control, setValue } = useFormContext<TestScenarioInput>();
    const machineConfig = useWatch({ control, name: 'machineConfig' }) as
        | Record<string, unknown>
        | undefined;
    const statesOverride = useWatch({ control, name: 'statesOverride' }) as
        | Record<string, unknown>
        | undefined;

    const handleMachineConfigChange = (nextCfg: Record<string, unknown>) => {
        setValue('machineConfig', nextCfg, { shouldDirty: true, shouldValidate: true });
        const sections = (nextCfg as { Sections?: Array<{ ID: string; Rows?: number; Cols?: number; PowerBus?: string; Type?: string }> }).Sections;
        const firstSpiral = sections?.find((s) => s.Type === 'SPIRAL') ?? sections?.[0];
        if (firstSpiral) {
            setValue('section.id', String(firstSpiral.ID));
            if (typeof firstSpiral.Rows === 'number') setValue('section.rows', firstSpiral.Rows);
            if (typeof firstSpiral.Cols === 'number') setValue('section.cols', firstSpiral.Cols);
            if (typeof firstSpiral.PowerBus === 'string') setValue('section.powerBus', firstSpiral.PowerBus);
        }
    };

    return (
        <>
            <Accordion title="Конфигурация аппарата (MachineConfig)" defaultOpen={false}>
                {machineConfig ? (
                    <>
                        <div className={styles.itemHeader}>
                            <span className={styles.hint}>Просмотр и редактирование загруженного MachineConfig.</span>
                            <Button
                                variant="danger"
                                size="sm"
                                onClick={onClearMachineConfig}
                            >
                                Очистить конфиг
                            </Button>
                        </div>
                        <JsonViewer value={machineConfig} collapsed={2} onChange={handleMachineConfigChange} />
                    </>
                ) : (
                    <span className={styles.hint}>
                        MachineConfig не загружен.
                    </span>
                )}
            </Accordion>

            <Accordion title="Начальное состояние (StatesController.States)" defaultOpen={false}>
                <div className={styles.itemHeader}>
                    <span className={styles.hint}>
                        {isLoadingStates
                            ? 'Инициализация StatesController на сервере...'
                            : 'Дерево StatesController.Machine.States, инициализированное из MachineConfig.'}
                    </span>
                    <div className={styles.row}>
                        {statesOverride && (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setValue('statesOverride', undefined, { shouldDirty: true })}
                            >
                                Сбросить изменения
                            </Button>
                        )}
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={isLoadingStates}
                            onClick={onRetryInitStates}
                        >
                            Переинициализировать
                        </Button>
                    </div>
                </div>
                {initError && <div className={styles.errorBox}>{initError}</div>}
                {baseStates || statesOverride ? (
                    <JsonViewer
                        value={statesOverride ?? baseStates ?? {}}
                        collapsed={2}
                        onChange={(next) =>
                            setValue('statesOverride', next, { shouldDirty: true, shouldValidate: true })
                        }
                    />
                ) : (
                    <span className={styles.hint}>
                        StatesController ещё не инициализирован. Запустите сервер API (`npm run hmi:server`) и нажмите «Переинициализировать».
                    </span>
                )}
            </Accordion>
        </>
    );
}
