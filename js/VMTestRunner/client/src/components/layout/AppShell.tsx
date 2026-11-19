import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { TestScenarioSchema, type TestScenarioInput } from '@shared/scenario.schema.ts';
import { HMI_PRESETS } from '../../../../server/js/presets.ts';
import { useSectionContext } from '../../hooks/useSectionContext.ts';
import { useTestRun } from '../../hooks/useTestRun.ts';
import { resolveScenarioChannels } from '../../utils/channels.ts';
import { MachineConfigLoader } from '../form/MachineConfigLoader.tsx';
import { ScenarioConfigurator } from '../form/ScenarioConfigurator.tsx';
import { ResultsPanel } from '../results/ResultsPanel.tsx';
import { HeaderBar } from './HeaderBar.tsx';
import styles from './AppShell.module.css';

const PRESET_ENTRIES = Object.entries(HMI_PRESETS).map(([key, val]) => ({
    key,
    label: val.name ?? key,
}));

const DEFAULT_PRESET_KEY = 'test1_1';

export function AppShell() {
    const { selectedSectionType } = useSectionContext();
    const [selectedPreset, setSelectedPreset] = useState(DEFAULT_PRESET_KEY);
    const [baseStates, setBaseStates] = useState<Record<string, unknown> | null>(null);
    const [isLoadingStates, setIsLoadingStates] = useState(false);
    const [initError, setInitError] = useState<string | null>(null);
    const testRun = useTestRun();

    const form = useForm<TestScenarioInput>({
        resolver: zodResolver(TestScenarioSchema) as Resolver<TestScenarioInput>,
        defaultValues: HMI_PRESETS[DEFAULT_PRESET_KEY],
        mode: 'onChange',
    });

    const values = useWatch({ control: form.control });
    const parsedCheck = TestScenarioSchema.safeParse(values);
    const machineConfig = values.machineConfig as Record<string, unknown> | undefined;

    const initStatesFromConfig = async (cfg: Record<string, unknown>) => {
        setIsLoadingStates(true);
        setInitError(null);
        try {
            const response = await fetch('/api/states/init', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ machineConfig: cfg }),
            });
            if (!response.ok) {
                const text = await response.text();
                throw new Error(text || `HTTP ${response.status}`);
            }
            const data = (await response.json()) as { states?: Record<string, unknown> };
            setBaseStates(data.states ?? null);
        } catch (err) {
            setBaseStates(null);
            setInitError(
                `Не удалось инициализировать StatesController: ${err instanceof Error ? err.message : String(err)}`,
            );
        } finally {
            setIsLoadingStates(false);
        }
    };

    const handleSelectPreset = (key: string) => {
        const preset = HMI_PRESETS[key];
        if (!preset) return;
        setSelectedPreset(key);
        form.reset(resolveScenarioChannels(preset, machineConfig));
    };

    const handleResetPreset = () => {
        const preset = HMI_PRESETS[selectedPreset];
        if (!preset) return;
        form.reset(resolveScenarioChannels(preset, machineConfig));
    };

    const handleLoadMachineConfig = (cfg: Record<string, unknown>) => {
        const resolved = resolveScenarioChannels(form.getValues(), cfg);
        form.reset(resolved);
        form.setValue('statesOverride', undefined, { shouldDirty: false, shouldValidate: false });
        const sections = (
            cfg as {
                Sections?: Array<{ ID: string; Rows?: number; Cols?: number; PowerBus?: string; Type?: string }>;
            }
        ).Sections;
        const firstSpiral = sections?.find((s) => s.Type === 'SPIRAL') ?? sections?.[0];
        if (firstSpiral) {
            form.setValue('section.id', String(firstSpiral.ID));
            if (typeof firstSpiral.Rows === 'number') form.setValue('section.rows', firstSpiral.Rows);
            if (typeof firstSpiral.Cols === 'number') form.setValue('section.cols', firstSpiral.Cols);
            if (typeof firstSpiral.PowerBus === 'string') form.setValue('section.powerBus', firstSpiral.PowerBus);
        }
        void initStatesFromConfig(cfg);
    };

    const handleClearMachineConfig = () => {
        testRun.resetRun();
        form.setValue('machineConfig', undefined, { shouldDirty: true });
        form.setValue('statesOverride', undefined, { shouldDirty: false });
        setBaseStates(null);
        setInitError(null);
    };

    const handleStartRun = () => {
        if (!parsedCheck.success) return;
        void testRun.startRun({
            sectionType: selectedSectionType,
            scenario: parsedCheck.data,
        });
    };

    const restPayload = {
        sectionType: selectedSectionType,
        scenario: parsedCheck.success ? parsedCheck.data : values,
    };

    const validationErrors = parsedCheck.success
        ? []
        : parsedCheck.error.issues.map((i) => ({
              path: i.path.join('.') || 'root',
              message: i.message,
          }));

    return (
        <div className={styles.shell}>
            <HeaderBar
                isValid={parsedCheck.success}
                hasMachineConfig={Boolean(machineConfig)}
                runStatus={testRun.status}
                onStartRun={handleStartRun}
                onAbortRun={() => void testRun.abortRun()}
            />

            {!machineConfig ? (
                <main className={styles.emptyMain}>
                    <MachineConfigLoader
                        onLoadConfig={handleLoadMachineConfig}
                        isLoading={isLoadingStates}
                        error={initError}
                    />
                </main>
            ) : (
                <main className={styles.main}>
                    <div className={styles.pane}>
                        <ScenarioConfigurator
                            form={form}
                            presetKeys={PRESET_ENTRIES}
                            selectedPreset={selectedPreset}
                            restPayload={restPayload}
                            validationErrors={validationErrors}
                            baseStates={baseStates}
                            isLoadingStates={isLoadingStates}
                            initError={initError}
                            onSelectPreset={handleSelectPreset}
                            onResetPreset={handleResetPreset}
                            onRetryInitStates={() => void initStatesFromConfig(machineConfig)}
                            onClearMachineConfig={handleClearMachineConfig}
                        />
                    </div>

                    <aside className={styles.pane}>
                        <ResultsPanel
                            runId={testRun.runId}
                            status={testRun.status}
                            timeline={testRun.timeline}
                            report={testRun.report}
                            error={testRun.error}
                        />
                    </aside>
                </main>
            )}
        </div>
    );
}
