import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import type { TestScenarioInput } from '@shared/scenario.schema.ts';
import { extractSectionChannelEntries, resolveChannelFromConfig } from '../../utils/channels.ts';
import { formatDynamicValue, parseDynamicValue } from '../../utils/jsonValue.ts';
import { Accordion } from '../ui/Accordion.tsx';
import { Button } from '../ui/Button.tsx';
import { Input } from '../ui/Input.tsx';
import { JsonViewer } from '../ui/JsonViewer.tsx';
import { Select } from '../ui/Select.tsx';
import styles from './FormLayout.module.css';

const MODE_OPTIONS = [
    { value: 'atStart', label: 'Со старта теста' },
    { value: 'runtime', label: 'В рантайме (по триггеру)' },
];

const TRIGGER_OPTIONS = [
    { value: 'afterMs', label: 'По таймеру (afterMs)' },
    { value: 'onChannelSet', label: 'По команде на канал (onChannelSet)' },
];

const ACTION_OPTIONS = [
    { value: 'injectChannel', label: 'Запись в канал (injectChannel)' },
    { value: 'patchStates', label: 'Патч StatesController (patchStates)' },
    { value: 'patchEmulator', label: 'Сбой/таймаут эмулятора (patchEmulator)' },
];

const EMULATOR_FLAGS = [
    { key: 'silentAck', label: 'silentAck (нет ответа матрицы)' },
    { key: 'suppressLevelSensor', label: 'suppressLevelSensor (лифт без импульсов)' },
    { key: 'suppressTamperPulse', label: 'suppressTamperPulse (заклинивание спирали)' },
    { key: 'suppressBoxOpen', label: 'suppressBoxOpen (люк не открыт)' },
    { key: 'liftNoPower', label: 'liftNoPower (нет питания лифта)' },
    { key: 'liftShortOnStart', label: 'liftShortOnStart (КЗ лифта при старте)' },
    { key: 'spiralNoPower', label: 'spiralNoPower (нет питания спиралей)' },
    { key: 'spiralShortOnStep1', label: 'spiralShortOnStep1 (КЗ спирали на Step 1)' },
] as const;

export function FaultsBuilder() {
    const { register, control, setValue } = useFormContext<TestScenarioInput>();
    const { fields, append, remove } = useFieldArray({ control, name: 'faults' });

    const faults = useWatch({ control, name: 'faults' }) ?? [];
    const machineConfig = useWatch({ control, name: 'machineConfig' }) as Record<string, unknown> | undefined;
    const sectionId = useWatch({ control, name: 'section.id' });

    const channelEntries = extractSectionChannelEntries(machineConfig, sectionId);
    const channelOptions = channelEntries.map((e) => ({
        value: e.channel,
        label: `${e.path} (${e.channel})`,
    }));

    const defaultTriggerChannel = resolveChannelFromConfig('Lift.MotorCtrl', machineConfig, sectionId);
    const defaultActionChannel = resolveChannelFromConfig('Door.Sensor', machineConfig, sectionId);

    const handleAddFault = () => {
        append({
            id: `fault-${fields.length + 1}`,
            enabled: true,
            mode: 'runtime',
            when: { type: 'onChannelSet', channel: defaultTriggerChannel, match: 'UP', occurrence: 1 },
            delayMs: 50,
            action: { type: 'injectChannel', channel: defaultActionChannel, value: 0, samples: 1 },
        });
    };

    return (
        <Accordion title={`3. Аварии и сбои (${fields.length})`} defaultOpen>
            <div className={styles.itemHeader}>
                <span className={styles.hint}>Аварии можно активировать сразу со старта или по триггеру в рантайме.</span>
                <Button size="sm" onClick={handleAddFault}>
                    + Добавить аварию
                </Button>
            </div>

            {fields.map((field, idx) => {
                const rule = faults[idx];
                const mode = rule?.mode ?? 'runtime';
                const whenType = rule?.when?.type ?? 'afterMs';
                const actionType = rule?.action?.type ?? 'injectChannel';
                const emuPatch = rule?.action?.type === 'patchEmulator' ? rule.action.patch : {};

                return (
                    <div key={field.id} className={styles.itemCard}>
                        <div className={styles.itemHeader}>
                            <label className={styles.checkLabel}>
                                <input type="checkbox" {...register(`faults.${idx}.enabled`)} />
                                Включено
                            </label>
                            <div className={styles.grow}>
                                <Input placeholder="ID правила" {...register(`faults.${idx}.id`)} />
                            </div>
                            <Button variant="danger" size="sm" onClick={() => remove(idx)}>
                                Удалить
                            </Button>
                        </div>

                        <Select
                            label="Режим срабатывания"
                            options={MODE_OPTIONS}
                            value={mode}
                            onChange={(e) => {
                                const nextMode = e.target.value as 'atStart' | 'runtime';
                                setValue(`faults.${idx}.mode`, nextMode, { shouldDirty: true });
                                if (nextMode === 'runtime' && !rule?.when) {
                                    setValue(`faults.${idx}.when`, { type: 'afterMs', ms: 100 });
                                }
                            }}
                        />

                        {mode === 'runtime' && (
                            <>
                                <div className={styles.grid2}>
                                    <Select
                                        label="Триггер (when)"
                                        options={TRIGGER_OPTIONS}
                                        value={whenType}
                                        onChange={(e) => {
                                            if (e.target.value === 'afterMs') {
                                                setValue(`faults.${idx}.when`, { type: 'afterMs', ms: 100 });
                                            } else {
                                                setValue(`faults.${idx}.when`, {
                                                    type: 'onChannelSet',
                                                    channel: defaultTriggerChannel,
                                                    match: 'UP',
                                                    occurrence: 1,
                                                });
                                            }
                                        }}
                                    />
                                    <Input
                                        label="Задержка (delayMs)"
                                        type="number"
                                        {...register(`faults.${idx}.delayMs`, { valueAsNumber: true })}
                                    />
                                </div>

                                {whenType === 'afterMs' ? (
                                    <Input
                                        label="Через сколько мс (when.ms)"
                                        type="number"
                                        {...register(`faults.${idx}.when.ms`, { valueAsNumber: true })}
                                    />
                                ) : (
                                    <div className={styles.grid3}>
                                        <Select
                                            label="Канал (when.channel)"
                                            options={channelOptions}
                                            {...register(`faults.${idx}.when.channel`)}
                                        />
                                        <Input
                                            label="Совпадение (match)"
                                            defaultValue={formatDynamicValue(
                                                rule?.when?.type === 'onChannelSet' ? rule.when.match : ''
                                            )}
                                            onBlur={(e) =>
                                                setValue(
                                                    `faults.${idx}.when.match`,
                                                    e.target.value ? parseDynamicValue(e.target.value) : undefined
                                                )
                                            }
                                        />
                                        <Input
                                            label="Срабатывание №"
                                            type="number"
                                            {...register(`faults.${idx}.when.occurrence`, { valueAsNumber: true })}
                                        />
                                    </div>
                                )}
                            </>
                        )}

                        <Select
                            label="Действие (action)"
                            options={ACTION_OPTIONS}
                            value={actionType}
                            onChange={(e) => {
                                const next = e.target.value;
                                if (next === 'injectChannel') {
                                    setValue(`faults.${idx}.action`, {
                                        type: 'injectChannel',
                                        channel: defaultActionChannel,
                                        value: 0,
                                        samples: 1,
                                    });
                                } else if (next === 'patchStates') {
                                    setValue(`faults.${idx}.action`, {
                                        type: 'patchStates',
                                        patch: { Bus: { 0: { Voltage: 'FAULT' } } },
                                    });
                                } else {
                                    setValue(`faults.${idx}.action`, {
                                        type: 'patchEmulator',
                                        patch: { silentAck: true },
                                    });
                                }
                            }}
                        />

                        {actionType === 'injectChannel' && (
                            <div className={styles.grid3}>
                                <Select
                                    label="Канал"
                                    options={channelOptions}
                                    {...register(`faults.${idx}.action.channel`)}
                                />
                                <Input
                                    label="Значение (value)"
                                    defaultValue={formatDynamicValue(
                                        rule?.action?.type === 'injectChannel' ? rule.action.value : 0
                                    )}
                                    onBlur={(e) =>
                                        setValue(`faults.${idx}.action.value`, parseDynamicValue(e.target.value))
                                    }
                                />
                                <Input
                                    label="Сэмплов (samples)"
                                    type="number"
                                    {...register(`faults.${idx}.action.samples`, { valueAsNumber: true })}
                                />
                            </div>
                        )}

                        {actionType === 'patchStates' && (
                            <JsonViewer
                                value={rule?.action?.type === 'patchStates' ? rule.action.patch : {}}
                                collapsed={1}
                                onChange={(next) =>
                                    setValue(`faults.${idx}.action.patch`, next, { shouldDirty: true })
                                }
                            />
                        )}

                        {actionType === 'patchEmulator' && (
                            <div className={styles.checkGrid}>
                                {EMULATOR_FLAGS.map((flag) => (
                                    <label key={flag.key} className={styles.checkLabel}>
                                        <input
                                            type="checkbox"
                                            checked={Boolean(emuPatch[flag.key])}
                                            onChange={(e) =>
                                                setValue(
                                                    `faults.${idx}.action.patch`,
                                                    { ...emuPatch, [flag.key]: e.target.checked },
                                                    { shouldDirty: true }
                                                )
                                            }
                                        />
                                        {flag.label}
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </Accordion>
    );
}
